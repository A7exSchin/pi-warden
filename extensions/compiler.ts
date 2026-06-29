import type { GateConfig, CompiledCommandRule, CompiledPathRule, CompiledSet } from "./types.js";
import { fallback } from "./types.js";
import { resolvePathSafe, MAX_TEST_LEN } from "./paths.js";

export function compile(config: GateConfig, cwd: string): CompiledSet {
	const warnings: string[] = [];

	const cmdFallback = fallback(config.commands.default);
	const commands: CompiledCommandRule[] = [];
	for (const r of config.commands.rules) {
		if (r.enabled === false) continue;
		let test: (s: string) => boolean;
		if (r.match === "regex") {
			try {
				const re = new RegExp(r.value, r.case_sensitive ? "" : "i");
				test = (s) => re.test(s.slice(0, MAX_TEST_LEN));
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
			dirResolved: resolvePathSafe(r.dir, cwd),
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
