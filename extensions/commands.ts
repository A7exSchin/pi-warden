import type { GateConfig, CompiledSet } from "./types.js";
import { fallback } from "./types.js";

/**
 * Format all rules (enabled + disabled) for the `/pi-warden list` output.
 */
export function listRules(config: GateConfig, compiled: CompiledSet, governanceUnlocked: boolean): string {
	const lines: string[] = [];
	lines.push(`commands (default=${config.commands.default}):`);
	if (config.commands.rules.length === 0) lines.push("  (none)");
	for (const r of config.commands.rules) {
		const on = r.enabled === false ? "○" : "●";
		const act = (r.action ?? fallback(config.commands.default)).toUpperCase();
		const m = r.match ?? "substring";
		const cs = r.case_sensitive ? " cs" : "";
		lines.push(`  ${on} ${r.id}  [${act}]  ${m}${cs}  "${r.value}"`);
	}
	lines.push(`paths (default=${config.paths.default})${governanceUnlocked ? " — GOV-UNLOCKED (bypassed)" : ""}:`);
	if (config.paths.rules.length === 0) lines.push("  (none)");
	for (const r of config.paths.rules) {
		const mark = r.enabled === false ? "○" : "●";
		const act = (r.action ?? fallback(config.paths.default)).toUpperCase();
		lines.push(`  ${mark} ${r.id}  [${act}]  on=${r.on ?? "any"}  dir=${r.dir}`);
	}
	return lines.join("\n");
}
