/**
 * pi-warden — command + path filtering for Pi tool calls.
 *
 * Inspects every `tool_call` BEFORE execution and decides allow/block. The
 * config is split by the two things you actually protect:
 *
 *   commands : CONTENT rules (substring/regex) matched against a bash command.
 *              Precedence: block-wins (any block match blocks; allow is a
 *              carve-out, relevant mainly in whitelist mode).
 *
 *   paths    : PATH rules matched against any filesystem path a tool resolves —
 *              the `path` field of read/write/edit AND paths found inside a bash
 *              command. Each protected `dir` is compared by containment after
 *              resolving ~, .., and symlinks. Precedence: longest-prefix wins
 *              (the most specific dir decides), so you can block ~/.ssh and
 *              allow ~/.ssh/known_hosts. Each rule has a scope `on` ("read" |
 *              "write" | "any", default "any") for read/write asymmetry — e.g.
 *              block WRITES to a rulebook while leaving reads free — and an
 *              `action` of "block", "allow", or "confirm" (ask the user
 *              interactively, proceed only if approved; fail closed with no UI).
 *              For bash, read-vs-write intent is inferred heuristically.
 *              `/pi-warden governance unlock` bypasses ALL path protections for
 *              the session (command rules stay active); `lock` re-enables them.
 *
 * A call is blocked if EITHER section blocks it (block-wins across sections).
 *
 * Each section has its own `default` action: "allow" = blacklist (block only
 * matches), "block" = whitelist (block everything not explicitly allowed).
 *
 * SCOPE LIMIT — read before trusting as isolation:
 *   For read/write/edit the path is a clean field and `paths` is robust. For
 *   `bash`, paths are extracted heuristically from the command text; this
 *   catches plain usage (cat ~/.ssh/x, cd ~/.ssh && cat id_rsa) but NOT
 *   obfuscation ($HOME, vars, base64, quote-splitting). Shell is open-ended;
 *   for true folder isolation enforce it below this layer (sandbox/container
 *   without the folder mounted, or a user lacking permission). pi-warden is
 *   a guardrail, not a sandbox.
 *
 * Config: JSON at ~/.pi/agent/pi-warden.rules.json (override via env
 * PI_WARDEN_RULES). See `pi-warden.rules.example.json`.
 *
 * Commands: /pi-warden [status|list|reload|governance [unlock|lock]].
 *
 * Every block feeds a fixed policy preamble back to the model (BLOCK_PREAMBLE):
 * it states this is the user's policy and instructs the agent not to route
 * around it but to stop and discuss. This cannot be guaranteed (see SCOPE
 * LIMIT) — it is an instruction, not an enforcement boundary.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

type Action = "block" | "allow";
type MatchType = "substring" | "regex";
/** Which operations a path rule guards. */
type PathScope = "read" | "write" | "any";
/** What a path rule does on match (adds an interactive "confirm" tier). */
type PathAction = "block" | "allow" | "confirm";
/** Resolved operation kind for a candidate path. */
type PathOp = "read" | "write";

interface CommandRule {
	id: string;
	/** How `value` is interpreted. Default: "substring". */
	match?: MatchType;
	/** The string/pattern that triggers this rule. */
	value: string;
	/** Case-sensitive matching. Default: false. */
	case_sensitive?: boolean;
	/** On match. Default: opposite of the section's `default`. */
	action?: Action;
	/** Feedback for the LLM when blocked. */
	reason?: string;
	/** Disable without deleting. Default: true. */
	enabled?: boolean;
}

interface PathRule {
	id: string;
	/** Protected directory (~, .., symlinks resolved). Containment-matched. */
	dir: string;
	/** Operations this rule guards: "read", "write", or "any" (default). */
	on?: PathScope;
	/** On match: "block", "allow", or "confirm" (ask the user). Default: opposite of `default`. */
	action?: PathAction;
	reason?: string;
	enabled?: boolean;
}

interface Section<R> {
	/** "allow" = blacklist, "block" = whitelist. */
	default: Action;
	rules: R[];
}

interface GateConfig {
	commands: Section<CommandRule>;
	paths: Section<PathRule>;
}

const EMPTY_CONFIG: GateConfig = {
	commands: { default: "allow", rules: [] },
	paths: { default: "allow", rules: [] },
};

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent");
const CONFIG_PATH = process.env.PI_WARDEN_RULES ?? path.join(AGENT_DIR, "pi-warden.rules.json");

interface LoadResult {
	config: GateConfig;
	warn: string | null;
}

function coerceSection<R extends { id?: unknown }>(raw: unknown): Section<R> {
	const s = (raw ?? {}) as { default?: unknown; rules?: unknown };
	const def: Action = s.default === "block" ? "block" : "allow";
	const rules = Array.isArray(s.rules) ? (s.rules.filter((r) => r && typeof r.id === "string") as R[]) : [];
	return { default: def, rules };
}

function loadConfig(): LoadResult {
	let raw: string;
	try {
		raw = fs.readFileSync(CONFIG_PATH, "utf-8");
	} catch {
		return { config: EMPTY_CONFIG, warn: `No config found (${CONFIG_PATH}) — pi-warden is inactive.` };
	}
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch (e) {
		return { config: EMPTY_CONFIG, warn: `Config is not valid JSON (${CONFIG_PATH}): ${String(e)}` };
	}
	const d = data as { commands?: unknown; paths?: unknown };
	return {
		config: {
			commands: coerceSection<CommandRule>(d.commands),
			paths: coerceSection<PathRule>(d.paths),
		},
		warn: null,
	};
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Cap tested strings so a pathological regex can't stall on huge inputs. */
const MAX_TEST_LEN = 100_000;

function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/**
 * Resolve `p` (relative to `cwd`, after ~ expansion) to an absolute path with
 * symlinks resolved on the longest existing prefix. The non-existent tail (e.g.
 * a not-yet-created file) is appended verbatim so writes to new paths resolve.
 */
function resolvePathSafe(p: string, cwd: string): string {
	let cur = path.resolve(cwd, expandHome(p));
	const tail: string[] = [];
	for (;;) {
		try {
			const real = fs.realpathSync.native(cur);
			return tail.length ? path.join(real, ...tail) : real;
		} catch {
			const parent = path.dirname(cur);
			if (parent === cur) return path.join(cur, ...tail);
			tail.unshift(path.basename(cur));
			cur = parent;
		}
	}
}

/** True if `child` is `dir` itself or lives inside it. */
function isPathUnder(child: string, dir: string): boolean {
	if (child === dir) return true;
	return child.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

/**
 * Best-effort extraction of path-like tokens from a shell command. Splits on
 * whitespace and shell metacharacters, then keeps tokens that look like paths
 * (contain "/" or start with "~"). Heuristic — see SCOPE LIMIT in the header.
 */
function extractPathTokens(cmd: string): string[] {
	return cmd
		.slice(0, MAX_TEST_LEN)
		.split(/[\s;|&()<>"'`=]+/)
		.filter((t) => t.length > 0 && (t.includes("/") || t.startsWith("~")));
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

interface CompiledCommandRule {
	id: string;
	action: Action;
	reason: string;
	test: (s: string) => boolean;
}

interface CompiledPathRule {
	id: string;
	action: PathAction;
	on: PathScope;
	reason: string;
	dirResolved: string;
}

interface CompiledSet {
	commandDefault: Action;
	commands: CompiledCommandRule[];
	pathDefault: Action;
	paths: CompiledPathRule[];
	warnings: string[];
}

function fallback(def: Action): Action {
	return def === "allow" ? "block" : "allow";
}

function compile(config: GateConfig): CompiledSet {
	const warnings: string[] = [];

	const cmdFallback = fallback(config.commands.default);
	const commands: CompiledCommandRule[] = [];
	for (const r of config.commands.rules) {
		if (r.enabled === false) continue;
		let test: (s: string) => boolean;
		if (r.match === "regex") {
			try {
				const re = new RegExp(r.value, r.case_sensitive ? "" : "i");
				test = (s) => re.test(s);
			} catch (e) {
				warnings.push(`command rule "${r.id}": invalid regex, skipped (${String(e)})`);
				continue;
			}
		} else if (r.case_sensitive) {
			const needle = r.value;
			test = (s) => s.includes(needle);
		} else {
			const needle = r.value.toLowerCase();
			test = (s) => s.toLowerCase().includes(needle);
		}
		commands.push({
			id: r.id,
			action: r.action ?? cmdFallback,
			reason: r.reason ?? `Blocked by pi-warden command rule "${r.id}".`,
			test,
		});
	}

	const pathFallback = fallback(config.paths.default);
	const paths: CompiledPathRule[] = [];
	for (const r of config.paths.rules) {
		if (r.enabled === false) continue;
		if (typeof r.dir !== "string" || !r.dir) {
			warnings.push(`path rule "${r.id}": missing "dir", skipped`);
			continue;
		}
		paths.push({
			id: r.id,
			action: r.action ?? pathFallback,
			on: r.on === "read" || r.on === "write" ? r.on : "any",
			reason: r.reason ?? `Blocked by pi-warden path rule "${r.id}".`,
			dirResolved: resolvePathSafe(r.dir, process.cwd()),
		});
	}

	return {
		commandDefault: config.commands.default,
		commands,
		pathDefault: config.paths.default,
		paths,
		warnings,
	};
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

interface Decision {
	action: "allow" | "block" | "confirm";
	reason?: string;
	ruleId?: string;
	/** Resolved path that triggered a path decision (shown in confirm prompts). */
	target?: string;
}

/** Heuristic: does a shell command appear to WRITE (vs only read)? Best-effort. */
const BASH_WRITE_INTENT =
	/(>>?|\btee\b|\bsed\b\s+-i|\bmv\b|\bcp\b|\brm\b|\brmdir\b|\bdd\b|\btruncate\b|\bchmod\b|\bchown\b|\bln\b|\bmkdir\b|\btouch\b|\binstall\b)/;

/**
 * Prepended to every block reason fed back to the model. It cannot *guarantee*
 * compliance (a denylist over an open-ended shell language is theoretically
 * leaky), but it states intent: this is the user's policy, do not route around
 * it — stop and talk to the user.
 */
const BLOCK_PREAMBLE =
	"This tool call was blocked by pi-warden, per the user's explicit configuration. " +
	"Do NOT attempt to bypass, disable, rephrase, or otherwise work around this block, and " +
	"do NOT try to reach the same result through another tool, path, or command. " +
	"Stop here and discuss with the user how to proceed.";

/** Compose the final reason shown to the model: policy preamble + rule detail. */
function composeReason(reason?: string): string {
	return reason ? `${BLOCK_PREAMBLE}\n\nReason: ${reason}` : BLOCK_PREAMBLE;
}

/** Commands section: block-wins; explicit allow is a carve-out. */
function evaluateCommands(input: Record<string, unknown>, set: CompiledSet): Decision {
	const cmd = typeof input.command === "string" ? input.command : null;
	if (cmd === null) return { action: "allow" }; // nothing command-shaped to govern
	const matched = set.commands.filter((r) => r.test(cmd));
	const blocker = matched.find((r) => r.action === "block");
	if (blocker) return { action: "block", reason: blocker.reason, ruleId: blocker.id };
	if (matched.some((r) => r.action === "allow")) return { action: "allow" };
	if (set.commandDefault === "block") {
		return {
			action: "block",
			reason: "Blocked by pi-warden commands policy (whitelist): command not in the allow-list.",
			ruleId: "commands:(default)",
		};
	}
	return { action: "allow" };
}

/**
 * Paths section: longest-prefix wins per candidate, filtered by operation scope
 * (read vs write). Strongest decision across candidates wins: block > confirm >
 * allow. For bash, read/write intent is inferred heuristically from the command.
 */
function evaluatePaths(toolName: string, input: Record<string, unknown>, set: CompiledSet, cwd: string): Decision {
	const candidates: { raw: string; op: PathOp }[] = [];
	if (typeof input.path === "string") {
		const op: PathOp = toolName === "write" || toolName === "edit" ? "write" : "read";
		candidates.push({ raw: input.path, op });
	}
	if (typeof input.command === "string") {
		const op: PathOp = BASH_WRITE_INTENT.test(input.command) ? "write" : "read";
		for (const t of extractPathTokens(input.command)) candidates.push({ raw: t, op });
	}
	if (candidates.length === 0) return { action: "allow" };

	const rank = (a: PathAction): number => (a === "block" ? 2 : a === "confirm" ? 1 : 0);
	let best: Decision = { action: "allow" };
	for (const cand of candidates) {
		let resolved: string;
		try {
			resolved = resolvePathSafe(cand.raw, cwd);
		} catch {
			continue;
		}
		let rule: CompiledPathRule | null = null;
		for (const r of set.paths) {
			if (r.on !== "any" && r.on !== cand.op) continue; // scope filter (read/write asymmetry)
			if (isPathUnder(resolved, r.dirResolved) && (!rule || r.dirResolved.length > rule.dirResolved.length)) {
				rule = r;
			}
		}
		const action: PathAction = rule ? rule.action : set.pathDefault;
		if (action === "allow") continue;
		if (rank(action) > rank(best.action)) {
			best = rule
				? { action, reason: rule.reason, ruleId: rule.id, target: resolved }
				: {
						action,
						reason: "Blocked by pi-warden paths policy (whitelist): path not in an allowed directory.",
						ruleId: "paths:(default)",
						target: resolved,
					};
		}
	}
	return best;
}

/**
 * Combine sections. Commands block-wins first (a command block beats any path
 * decision). When `bypassPaths` is set (governance unlock), path protections are
 * skipped but command rules still apply.
 */
function evaluate(
	toolName: string,
	input: Record<string, unknown>,
	set: CompiledSet,
	cwd: string,
	bypassPaths: boolean,
): Decision {
	const c = evaluateCommands(input, set);
	if (c.action === "block") return c;
	if (bypassPaths) return { action: "allow" };
	return evaluatePaths(toolName, input, set, cwd);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function piWarden(pi: ExtensionAPI) {
	let { config, warn } = loadConfig();
	let compiled = compile(config);
	// Session-local governance toggle: when true, path protections (block + confirm)
	// are bypassed for this session. Command rules always apply. Resets on /reload.
	let governanceUnlocked = false;

	function reload(): void {
		({ config, warn } = loadConfig());
		compiled = compile(config);
	}

	function showStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const gov = governanceUnlocked ? " · GOV-UNLOCKED" : "";
		const label = warn
			? "pi-warden: inactive (config missing/invalid)"
			: `pi-warden: ${compiled.commands.length} cmd / ${compiled.paths.length} path rule(s)${gov}`;
		ctx.ui.setStatus("pi-warden", label);
	}

	pi.on("session_start", async (_event, ctx) => {
		reload();
		showStatus(ctx);
		if (ctx.hasUI) {
			if (warn) ctx.ui.notify(`pi-warden: ${warn}`, "warning");
			if (compiled.warnings.length) ctx.ui.notify(`pi-warden: ${compiled.warnings.join("; ")}`, "warning");
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		const dec = evaluate(
			event.toolName,
			event.input as Record<string, unknown>,
			compiled,
			ctx.cwd,
			governanceUnlocked,
		);
		if (dec.action === "block") {
			if (ctx.hasUI) ctx.ui.notify(`pi-warden: BLOCKED ${event.toolName} (${dec.ruleId ?? "?"})`, "warning");
			return { block: true, reason: composeReason(dec.reason) };
		}
		if (dec.action === "confirm") {
			if (!ctx.hasUI) {
				// No way to ask — fail closed, but tell the model how the user can authorize it.
				return {
					block: true,
					reason: composeReason(
						`${dec.reason ?? "Protected path."} There is no interactive prompt available to confirm; ` +
							"if the user authorizes this, they can run /pi-warden governance unlock.",
					),
				};
			}
			const ok = await ctx.ui.confirm(
				`pi-warden: allow ${event.toolName} on a protected path?`,
				`${dec.target ?? ""}\n\n${dec.reason ?? ""}\n\nProceed only if you intend this change.`,
			);
			if (!ok) {
				ctx.ui.notify(`pi-warden: declined ${event.toolName} (${dec.ruleId ?? "?"})`, "info");
				return {
					block: true,
					reason: composeReason(`${dec.reason ?? "Protected path."} The user declined the confirmation.`),
				};
			}
			ctx.ui.notify(`pi-warden: confirmed ${event.toolName} (${dec.ruleId ?? "?"})`, "info");
			return undefined;
		}
		return undefined;
	});

	function listRules(): string {
		const lines: string[] = [];
		lines.push(`commands (default=${config.commands.default}):`);
		if (compiled.commands.length === 0) lines.push("  (none)");
		for (const r of config.commands.rules) {
			const on = r.enabled === false ? "○" : "●";
			const act = (r.action ?? fallback(config.commands.default)).toUpperCase();
			const m = r.match ?? "substring";
			const cs = r.case_sensitive ? " cs" : "";
			lines.push(`  ${on} ${r.id}  [${act}]  ${m}${cs}  "${r.value}"`);
		}
		lines.push(`paths (default=${config.paths.default})${governanceUnlocked ? " — GOV-UNLOCKED (bypassed)" : ""}:`);
		if (compiled.paths.length === 0) lines.push("  (none)");
		for (const r of config.paths.rules) {
			const mark = r.enabled === false ? "○" : "●";
			const act = (r.action ?? fallback(config.paths.default)).toUpperCase();
			lines.push(`  ${mark} ${r.id}  [${act}]  on=${r.on ?? "any"}  dir=${r.dir}`);
		}
		return lines.join("\n");
	}

	pi.registerCommand("pi-warden", {
		description:
			"pi-warden: status / list / reload / governance. Usage: /pi-warden [status|list|reload|governance [unlock|lock]]",
		handler: async (args, ctx) => {
			const toks = args.trim().split(/\s+/).filter(Boolean);
			const sub = (toks[0] ?? "").toLowerCase();
			if (sub === "governance") {
				const g = (toks[1] ?? "").toLowerCase();
				if (g === "unlock") {
					governanceUnlocked = true;
					ctx.ui.notify(
						"pi-warden: governance UNLOCKED for this session — path protections (block + confirm) are bypassed. " +
							"Command rules still apply. Re-lock with /pi-warden governance lock.",
						"warning",
					);
				} else if (g === "lock") {
					governanceUnlocked = false;
					ctx.ui.notify("pi-warden: governance locked — path protections active.", "info");
				} else {
					ctx.ui.notify(
						`pi-warden: governance is ${governanceUnlocked ? "UNLOCKED (path protections bypassed)" : "locked"}. ` +
							"Usage: /pi-warden governance unlock|lock",
						"info",
					);
				}
				showStatus(ctx);
				return;
			}
			if (sub === "reload") reload();
			if (sub === "list") {
				ctx.ui.notify(warn ? `pi-warden: ${warn}` : listRules(), warn ? "warning" : "info");
				return;
			}
			showStatus(ctx);
			ctx.ui.notify(
				warn
					? `pi-warden: ${warn}`
					: `pi-warden: ${compiled.commands.length} command rule(s) (default=${config.commands.default}), ` +
							`${compiled.paths.length} path rule(s) (default=${config.paths.default})` +
							`${governanceUnlocked ? ", GOV-UNLOCKED" : ""}. Source: ${CONFIG_PATH}.`,
				warn ? "warning" : "info",
			);
		},
	});
}
