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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GateConfig, CompiledSet } from "./types.js";
import { loadConfig, CONFIG_PATH } from "./config.js";
import { compile } from "./compiler.js";
import { evaluate, composeReason } from "./evaluator.js";
import { listRules } from "./commands.js";

export default function piWarden(pi: ExtensionAPI) {
	let config: GateConfig;
	let warn: string | null;
	let compiled: CompiledSet;

	// Session-local governance toggle: when true, path protections (block + confirm)
	// are bypassed for this session. Command rules always apply. Resets on /reload.
	let governanceUnlocked = false;

	function reload(): void {
		({ config, warn } = loadConfig());
		compiled = compile(config, process.cwd());
		governanceUnlocked = false;
	}

	// Initial load
	reload();

	function showStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const gov = governanceUnlocked ? " · GOV-UNLOCKED" : "";
		const label = warn
			? ctx.ui.theme.fg("dim", "pi-warden: inactive (config missing/invalid)")
			: ctx.ui.theme.fg("dim", `pi-warden: ${compiled.commands.length} cmd / ${compiled.paths.length} path rule(s)${gov}`);
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
				ctx.ui.notify(warn ? `pi-warden: ${warn}` : listRules(config, compiled, governanceUnlocked), warn ? "warning" : "info");
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
