import { describe, it, expect } from "vitest";
import type { GateConfig } from "../extensions/types.js";
import { compile } from "../extensions/compiler.js";

const CWD = "/tmp";

function makeConfig(overrides: Partial<GateConfig> = {}): GateConfig {
	return {
		commands: { default: "allow", rules: [], ...overrides.commands },
		paths: { default: "allow", rules: [], ...overrides.paths },
	};
}

describe("compile — command rules", () => {
	it("compiles a substring rule (case-insensitive by default)", () => {
		const config = makeConfig({
			commands: {
				default: "allow",
				rules: [{ id: "no-rm", value: "rm -rf", action: "block" }],
			},
		});
		const set = compile(config, CWD);
		expect(set.commands).toHaveLength(1);
		expect(set.commands[0].test("rm -rf /")).toBe(true);
		expect(set.commands[0].test("RM -RF /")).toBe(true);
		expect(set.commands[0].test("ls")).toBe(false);
	});

	it("compiles a case-sensitive substring rule", () => {
		const config = makeConfig({
			commands: {
				default: "allow",
				rules: [{ id: "cs", value: "DELETE", case_sensitive: true, action: "block" }],
			},
		});
		const set = compile(config, CWD);
		expect(set.commands[0].test("DELETE")).toBe(true);
		expect(set.commands[0].test("delete")).toBe(false);
	});

	it("compiles a regex rule", () => {
		const config = makeConfig({
			commands: {
				default: "allow",
				rules: [{ id: "re", match: "regex", value: "rm\\s+-rf", action: "block" }],
			},
		});
		const set = compile(config, CWD);
		expect(set.commands[0].test("rm  -rf /")).toBe(true);
		expect(set.commands[0].test("rm-rf")).toBe(false);
	});

	it("skips disabled rules", () => {
		const config = makeConfig({
			commands: {
				default: "allow",
				rules: [{ id: "off", value: "rm", enabled: false }],
			},
		});
		const set = compile(config, CWD);
		expect(set.commands).toHaveLength(0);
	});

	it("warns on invalid regex and skips the rule", () => {
		const config = makeConfig({
			commands: {
				default: "allow",
				rules: [{ id: "bad", match: "regex", value: "[invalid((" }],
			},
		});
		const set = compile(config, CWD);
		expect(set.commands).toHaveLength(0);
		expect(set.warnings).toHaveLength(1);
		expect(set.warnings[0]).toContain("bad");
		expect(set.warnings[0]).toContain("invalid regex");
	});

	it("defaults action to fallback of section default", () => {
		const config = makeConfig({
			commands: { default: "allow", rules: [{ id: "x", value: "foo" }] },
		});
		const set = compile(config, CWD);
		expect(set.commands[0].action).toBe("block"); // fallback of "allow" is "block"
	});
});

describe("compile — path rules", () => {
	it("compiles a path rule with resolved dir", () => {
		const config = makeConfig({
			paths: {
				default: "allow",
				rules: [{ id: "tmp", dir: "/tmp", action: "block" }],
			},
		});
		const set = compile(config, CWD);
		expect(set.paths).toHaveLength(1);
		expect(set.paths[0].id).toBe("tmp");
	});

	it("skips disabled path rules", () => {
		const config = makeConfig({
			paths: {
				default: "allow",
				rules: [{ id: "off", dir: "/tmp", enabled: false }],
			},
		});
		const set = compile(config, CWD);
		expect(set.paths).toHaveLength(0);
	});

	it("warns on missing dir and skips the rule", () => {
		const config = makeConfig({
			paths: {
				default: "allow",
				rules: [{ id: "bad", dir: "" }],
			},
		});
		const set = compile(config, CWD);
		expect(set.paths).toHaveLength(0);
		expect(set.warnings).toHaveLength(1);
		expect(set.warnings[0]).toContain("bad");
	});

	it("defaults 'on' to 'any'", () => {
		const config = makeConfig({
			paths: {
				default: "allow",
				rules: [{ id: "x", dir: "/tmp" }],
			},
		});
		const set = compile(config, CWD);
		expect(set.paths[0].on).toBe("any");
	});

	it("preserves read/write scope", () => {
		const config = makeConfig({
			paths: {
				default: "allow",
				rules: [
					{ id: "r", dir: "/tmp", on: "read" },
					{ id: "w", dir: "/tmp", on: "write" },
				],
			},
		});
		const set = compile(config, CWD);
		expect(set.paths[0].on).toBe("read");
		expect(set.paths[1].on).toBe("write");
	});
});

describe("compile — metadata", () => {
	it("carries section defaults through", () => {
		const config = makeConfig({
			commands: { default: "block", rules: [] },
			paths: { default: "block", rules: [] },
		});
		const set = compile(config, CWD);
		expect(set.commandDefault).toBe("block");
		expect(set.pathDefault).toBe("block");
	});
});
