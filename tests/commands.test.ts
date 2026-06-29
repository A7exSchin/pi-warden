import { describe, it, expect } from "vitest";
import type { GateConfig, CompiledSet } from "../extensions/types.js";
import { compile } from "../extensions/compiler.js";
import { listRules } from "../extensions/commands.js";

const CWD = "/tmp";

function makeConfig(overrides: Partial<GateConfig> = {}): GateConfig {
	return {
		commands: { default: "allow", rules: [], ...overrides.commands },
		paths: { default: "allow", rules: [], ...overrides.paths },
	};
}

describe("listRules", () => {
	it("shows (none) when there are no rules", () => {
		const config = makeConfig();
		const compiled = compile(config, CWD);
		const output = listRules(config, compiled, false);
		expect(output).toContain("(none)");
		// Should appear twice — once for commands, once for paths
		expect(output.match(/\(none\)/g)?.length).toBe(2);
	});

	it("lists command rules with status indicators", () => {
		const config = makeConfig({
			commands: {
				default: "allow",
				rules: [
					{ id: "no-rm", value: "rm -rf", action: "block" },
					{ id: "disabled", value: "foo", enabled: false },
				],
			},
		});
		const compiled = compile(config, CWD);
		const output = listRules(config, compiled, false);
		expect(output).toContain("● no-rm");
		expect(output).toContain("[BLOCK]");
		expect(output).toContain("○ disabled");
	});

	it("lists path rules", () => {
		const config = makeConfig({
			paths: {
				default: "allow",
				rules: [{ id: "ssh", dir: "~/.ssh", on: "any", action: "block" }],
			},
		});
		const compiled = compile(config, CWD);
		const output = listRules(config, compiled, false);
		expect(output).toContain("● ssh");
		expect(output).toContain("[BLOCK]");
		expect(output).toContain("on=any");
		expect(output).toContain("dir=~/.ssh");
	});

	it("shows GOV-UNLOCKED when governance is unlocked", () => {
		const config = makeConfig();
		const compiled = compile(config, CWD);
		const output = listRules(config, compiled, true);
		expect(output).toContain("GOV-UNLOCKED");
	});

	it("does not show GOV-UNLOCKED when governance is locked", () => {
		const config = makeConfig();
		const compiled = compile(config, CWD);
		const output = listRules(config, compiled, false);
		expect(output).not.toContain("GOV-UNLOCKED");
	});

	it("shows (none) for commands but lists path rules when only paths exist", () => {
		const config = makeConfig({
			paths: {
				default: "allow",
				rules: [{ id: "tmp", dir: "/tmp", action: "block" }],
			},
		});
		const compiled = compile(config, CWD);
		const output = listRules(config, compiled, false);
		const lines = output.split("\n");
		// Commands section should have (none)
		const cmdIdx = lines.findIndex((l) => l.startsWith("commands"));
		expect(lines[cmdIdx + 1]).toContain("(none)");
		// Paths section should have a rule
		expect(output).toContain("● tmp");
	});
});
