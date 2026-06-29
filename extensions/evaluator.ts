import type { CompiledSet, Decision, PathAction, PathOp } from "./types.js";
import { resolvePathSafe, isPathUnder, extractPathTokens } from "./paths.js";

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
export function composeReason(reason?: string): string {
	return reason ? `${BLOCK_PREAMBLE}\n\nReason: ${reason}` : BLOCK_PREAMBLE;
}

/** Commands section: block-wins; explicit allow is a carve-out. */
function evaluateCommands(input: Record<string, unknown>, set: CompiledSet): Decision {
	const cmd = typeof input.command === "string" ? input.command : null;
	if (cmd === null) return { action: "allow" }; // nothing command-shaped to govern
	let hasAllow = false;
	for (const r of set.commands) {
		if (!r.test(cmd)) continue;
		if (r.action === "block") return { action: "block", reason: r.reason, ruleId: r.id };
		hasAllow = true;
	}
	if (hasAllow) return { action: "allow" };
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
		let rule: (typeof set.paths)[number] | null = null;
		for (const r of set.paths) {
			if (r.on !== "any" && r.on !== cand.op) continue;
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
export function evaluate(
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
