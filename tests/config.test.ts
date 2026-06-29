import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig } from "../extensions/config.js";

let tmpDir: string;
let configPath: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-warden-test-"));
	configPath = path.join(tmpDir, "pi-warden.rules.json");
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(data: unknown) {
	fs.writeFileSync(configPath, typeof data === "string" ? data : JSON.stringify(data));
}

describe("loadConfig", () => {
	it("returns a warning when config file is missing", () => {
		const { config, warn } = loadConfig(configPath);
		expect(warn).toContain("No config found");
		expect(config.commands.rules).toHaveLength(0);
		expect(config.paths.rules).toHaveLength(0);
	});

	it("returns a warning for invalid JSON", () => {
		writeConfig("not json {{{");
		const { warn } = loadConfig(configPath);
		expect(warn).toContain("not valid JSON");
	});

	it("loads a valid config", () => {
		writeConfig({
			commands: {
				default: "allow",
				rules: [{ id: "no-rm", match: "substring", value: "rm -rf", action: "block" }],
			},
			paths: {
				default: "allow",
				rules: [{ id: "ssh", dir: "~/.ssh", action: "block" }],
			},
		});
		const { config, warn } = loadConfig(configPath);
		expect(warn).toBeNull();
		expect(config.commands.rules).toHaveLength(1);
		expect(config.commands.rules[0].id).toBe("no-rm");
		expect(config.paths.rules).toHaveLength(1);
		expect(config.paths.rules[0].id).toBe("ssh");
	});

	it("drops command rules missing 'value'", () => {
		writeConfig({
			commands: {
				default: "allow",
				rules: [
					{ id: "valid", value: "rm -rf" },
					{ id: "no-value" },
				],
			},
			paths: { default: "allow", rules: [] },
		});
		const { config } = loadConfig(configPath);
		expect(config.commands.rules).toHaveLength(1);
		expect(config.commands.rules[0].id).toBe("valid");
	});

	it("drops path rules missing 'dir'", () => {
		writeConfig({
			commands: { default: "allow", rules: [] },
			paths: {
				default: "allow",
				rules: [
					{ id: "valid", dir: "/tmp" },
					{ id: "no-dir" },
				],
			},
		});
		const { config } = loadConfig(configPath);
		expect(config.paths.rules).toHaveLength(1);
		expect(config.paths.rules[0].id).toBe("valid");
	});

	it("drops rules without an id", () => {
		writeConfig({
			commands: {
				default: "allow",
				rules: [{ value: "rm" }, { id: "ok", value: "rm" }],
			},
			paths: { default: "allow", rules: [] },
		});
		const { config } = loadConfig(configPath);
		expect(config.commands.rules).toHaveLength(1);
		expect(config.commands.rules[0].id).toBe("ok");
	});

	it("defaults section default to 'allow' for unknown values", () => {
		writeConfig({
			commands: { default: "banana", rules: [] },
			paths: { default: 42, rules: [] },
		});
		const { config } = loadConfig(configPath);
		expect(config.commands.default).toBe("allow");
		expect(config.paths.default).toBe("allow");
	});
});
