import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GateConfig, CommandRule, PathRule, Section } from "./types.js";

export const EMPTY_CONFIG: GateConfig = {
	commands: { default: "allow", rules: [] },
	paths: { default: "allow", rules: [] },
};

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent");
export const CONFIG_PATH = process.env.PI_WARDEN_RULES ?? path.join(AGENT_DIR, "pi-warden.rules.json");

export interface LoadResult {
	config: GateConfig;
	warn: string | null;
}

function coerceSection<R extends { id?: unknown }>(raw: unknown, requiredFields: string[] = []): Section<R> {
	const s = (raw ?? {}) as { default?: unknown; rules?: unknown };
	const def = s.default === "block" ? "block" : "allow";
	const rules = Array.isArray(s.rules)
		? (s.rules.filter((r) => {
				if (!r || typeof r.id !== "string") return false;
				for (const f of requiredFields) {
					if (typeof (r as Record<string, unknown>)[f] !== "string") return false;
				}
				return true;
			}) as R[])
		: [];
	return { default: def, rules } as Section<R>;
}

export function loadConfig(configPath: string = CONFIG_PATH): LoadResult {
	let raw: string;
	try {
		raw = fs.readFileSync(configPath, "utf-8");
	} catch {
		return { config: EMPTY_CONFIG, warn: `No config found (${configPath}) — pi-warden is inactive.` };
	}
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch (e) {
		return { config: EMPTY_CONFIG, warn: `Config is not valid JSON (${configPath}): ${String(e)}` };
	}
	const d = data as { commands?: unknown; paths?: unknown };
	return {
		config: {
			commands: coerceSection<CommandRule>(d.commands, ["value"]),
			paths: coerceSection<PathRule>(d.paths, ["dir"]),
		},
		warn: null,
	};
}
