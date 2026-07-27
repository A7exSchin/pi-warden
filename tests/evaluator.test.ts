import { describe, it, expect } from "vitest";
import * as path from "node:path";
import type { GateConfig, CompiledSet } from "../extensions/types.js";
import { compile } from "../extensions/compiler.js";
import { evaluate, composeReason, stripQuoted } from "../extensions/evaluator.js";

// Use /tmp as cwd — on macOS it symlinks to /private/tmp, resolvePathSafe
// handles that, so we use the resolved form in path rules.
const CWD = "/tmp";

function compileConfig(overrides: Partial<GateConfig> = {}): CompiledSet {
	const config: GateConfig = {
		commands: { default: "allow", rules: [], ...overrides.commands },
		paths: { default: "allow", rules: [], ...overrides.paths },
	};
	return compile(config, CWD);
}

// ---------------------------------------------------------------------------
// composeReason
// ---------------------------------------------------------------------------

describe("composeReason", () => {
	it("includes preamble without a reason", () => {
		const r = composeReason();
		expect(r).toContain("blocked by pi-warden");
		expect(r).not.toContain("Reason:");
	});

	it("appends reason after preamble", () => {
		const r = composeReason("dangerous command");
		expect(r).toContain("blocked by pi-warden");
		expect(r).toContain("Reason: dangerous command");
	});
});

// ---------------------------------------------------------------------------
// Command evaluation
// ---------------------------------------------------------------------------

describe("evaluate — commands", () => {
	it("allows when no rules match (blacklist mode)", () => {
		const set = compileConfig({
			commands: {
				default: "allow",
				rules: [{ id: "no-rm", value: "rm -rf", action: "block" }],
			},
		});
		const dec = evaluate("bash", { command: "ls -la" }, set, CWD, false);
		expect(dec.action).toBe("allow");
	});

	it("blocks when a rule matches", () => {
		const set = compileConfig({
			commands: {
				default: "allow",
				rules: [{ id: "no-rm", value: "rm -rf", action: "block", reason: "no rm" }],
			},
		});
		const dec = evaluate("bash", { command: "rm -rf /" }, set, CWD, false);
		expect(dec.action).toBe("block");
		expect(dec.ruleId).toBe("no-rm");
	});

	it("block wins over allow when both match", () => {
		const set = compileConfig({
			commands: {
				default: "allow",
				rules: [
					{ id: "allow-ls", value: "ls", action: "allow" },
					{ id: "block-all", value: "ls", action: "block" },
				],
			},
		});
		const dec = evaluate("bash", { command: "ls" }, set, CWD, false);
		expect(dec.action).toBe("block");
	});

	it("blocks unmatched commands in whitelist mode", () => {
		const set = compileConfig({
			commands: {
				default: "block",
				rules: [{ id: "allow-ls", value: "ls", action: "allow" }],
			},
		});
		const dec = evaluate("bash", { command: "cat /etc/passwd" }, set, CWD, false);
		expect(dec.action).toBe("block");
		expect(dec.ruleId).toBe("commands:(default)");
	});

	it("allows matched commands in whitelist mode", () => {
		const set = compileConfig({
			commands: {
				default: "block",
				rules: [{ id: "allow-ls", value: "ls", action: "allow" }],
			},
		});
		const dec = evaluate("bash", { command: "ls -la" }, set, CWD, false);
		expect(dec.action).toBe("allow");
	});

	it("allows non-bash tools with no command field", () => {
		const set = compileConfig({
			commands: {
				default: "block",
				rules: [],
			},
		});
		const dec = evaluate("read", { path: "/tmp/foo" }, set, CWD, false);
		expect(dec.action).toBe("allow");
	});
});

// ---------------------------------------------------------------------------
// Path evaluation
// ---------------------------------------------------------------------------

describe("evaluate — paths", () => {
	it("allows when no path rules match", () => {
		const set = compileConfig({
			paths: {
				default: "allow",
				rules: [{ id: "ssh", dir: "~/.ssh", action: "block" }],
			},
		});
		const dec = evaluate("read", { path: "/tmp/foo" }, set, CWD, false);
		expect(dec.action).toBe("allow");
	});

	it("blocks a read tool on a protected path", () => {
		const set = compileConfig({
			paths: {
				default: "allow",
				rules: [{ id: "tmp-block", dir: "/tmp", action: "block", reason: "no tmp" }],
			},
		});
		// resolvePathSafe resolves /tmp → /private/tmp on macOS, and the rule's dir
		// is also resolved at compile time, so containment works on both platforms.
		const dec = evaluate("read", { path: "/tmp/secret" }, set, CWD, false);
		expect(dec.action).toBe("block");
		expect(dec.ruleId).toBe("tmp-block");
	});

	it("respects write-only scope (allows reads)", () => {
		const set = compileConfig({
			paths: {
				default: "allow",
				rules: [{ id: "write-only", dir: "/tmp", on: "write", action: "block" }],
			},
		});
		const readDec = evaluate("read", { path: "/tmp/foo" }, set, CWD, false);
		expect(readDec.action).toBe("allow");

		const writeDec = evaluate("write", { path: "/tmp/foo" }, set, CWD, false);
		expect(writeDec.action).toBe("block");
	});

	it("longest prefix wins (carve-out)", () => {
		const set = compileConfig({
			paths: {
				default: "allow",
				rules: [
					{ id: "block-tmp", dir: "/tmp", action: "block" },
					{ id: "allow-sub", dir: "/tmp/safe", action: "allow" },
				],
			},
		});
		const blockedDec = evaluate("read", { path: "/tmp/other" }, set, CWD, false);
		expect(blockedDec.action).toBe("block");

		const allowedDec = evaluate("read", { path: "/tmp/safe/file.txt" }, set, CWD, false);
		expect(allowedDec.action).toBe("allow");
	});

	it("returns confirm for confirm-action rules", () => {
		const set = compileConfig({
			paths: {
				default: "allow",
				rules: [{ id: "confirm-tmp", dir: "/tmp", action: "confirm" }],
			},
		});
		const dec = evaluate("write", { path: "/tmp/foo" }, set, CWD, false);
		expect(dec.action).toBe("confirm");
	});

	it("extracts paths from bash commands", () => {
		const set = compileConfig({
			paths: {
				default: "allow",
				rules: [{ id: "block-tmp", dir: "/tmp", action: "block" }],
			},
		});
		const dec = evaluate("bash", { command: "cat /tmp/secret" }, set, CWD, false);
		expect(dec.action).toBe("block");
	});

	it("infers write intent from bash commands for write-scoped rules", () => {
		const set = compileConfig({
			paths: {
				default: "allow",
				rules: [{ id: "write-tmp", dir: "/tmp", on: "write", action: "block" }],
			},
		});
		// cp triggers BASH_WRITE_INTENT
		const writeDec = evaluate("bash", { command: "cp /src /tmp/dest" }, set, CWD, false);
		expect(writeDec.action).toBe("block");

		// cat does not trigger write intent
		const readDec = evaluate("bash", { command: "cat /tmp/file" }, set, CWD, false);
		expect(readDec.action).toBe("allow");
	});

	it("does not infer write intent from verbs inside quotes", () => {
		const set = compileConfig({
			paths: {
				default: "allow",
				rules: [{ id: "write-tmp", dir: "/tmp", on: "write", action: "block" }],
			},
		});
		// Regression: \bmv\b matched inside the quoted literal, flagging a read as a write.
		expect(evaluate("bash", { command: 'grep -c "... mv-command" /tmp/datei' }, set, CWD, false).action).toBe(
			"allow",
		);
		// Second false-positive class: a write verb as an ordinary English word.
		expect(evaluate("bash", { command: `grep 'install the app' /tmp/notes.txt` }, set, CWD, false).action).toBe(
			"allow",
		);
		// Unquoted write verbs are still detected.
		expect(evaluate("bash", { command: 'mv /tmp/a /tmp/b # "note"' }, set, CWD, false).action).toBe("block");
	});

	it("still governs paths that appear inside quotes", () => {
		const set = compileConfig({
			paths: { default: "allow", rules: [{ id: "block-tmp", dir: "/tmp", action: "block" }] },
		});
		// Quote-stripping must not leak into path extraction.
		expect(evaluate("bash", { command: 'cat "/tmp/secret"' }, set, CWD, false).action).toBe("block");
	});

	it("documented trade-off: a write verb hidden in quotes is not detected", () => {
		const set = compileConfig({
			paths: {
				default: "allow",
				rules: [{ id: "write-tmp", dir: "/tmp", on: "write", action: "block" }],
			},
		});
		// Accepted cost of the fix — pinned so it stays a conscious choice.
		expect(evaluate("bash", { command: 'bash -c "mv /tmp/a /tmp/b"' }, set, CWD, false).action).toBe("allow");
		// ...but command rules are unaffected by quoting.
		const withCmdRule = compileConfig({
			commands: { default: "allow", rules: [{ id: "no-rm", value: "rm -rf", action: "block" }] },
		});
		expect(evaluate("bash", { command: 'bash -c "rm -rf /tmp/x"' }, withCmdRule, CWD, false).action).toBe("block");
	});
});

// ---------------------------------------------------------------------------
// stripQuoted
// ---------------------------------------------------------------------------

describe("stripQuoted", () => {
	it("blanks double- and single-quoted spans", () => {
		expect(stripQuoted('grep -c "... mv-command" datei')).toBe("grep -c   datei");
		expect(stripQuoted("grep 'mv x' datei")).toBe("grep   datei");
	});

	it("replaces with a space so fragments cannot fuse into a phantom verb", () => {
		expect(stripQuoted('foo"x"mv')).toBe("foo mv");
	});

	it("leaves unquoted commands untouched", () => {
		expect(stripQuoted("mv /a /b")).toBe("mv /a /b");
	});
});

// ---------------------------------------------------------------------------
// Cross-section and governance
// ---------------------------------------------------------------------------

describe("evaluate — cross-section", () => {
	it("command block trumps path allow", () => {
		const set = compileConfig({
			commands: {
				default: "allow",
				rules: [{ id: "no-rm", value: "rm -rf", action: "block" }],
			},
			paths: {
				default: "allow",
				rules: [{ id: "allow-tmp", dir: "/tmp", action: "allow" }],
			},
		});
		const dec = evaluate("bash", { command: "rm -rf /tmp/foo" }, set, CWD, false);
		expect(dec.action).toBe("block");
		expect(dec.ruleId).toBe("no-rm");
	});
});

describe("evaluate — governance bypass", () => {
	it("bypasses path protections when governance is unlocked", () => {
		const set = compileConfig({
			paths: {
				default: "allow",
				rules: [{ id: "block-tmp", dir: "/tmp", action: "block" }],
			},
		});
		const dec = evaluate("read", { path: "/tmp/secret" }, set, CWD, true);
		expect(dec.action).toBe("allow");
	});

	it("still enforces command rules when governance is unlocked", () => {
		const set = compileConfig({
			commands: {
				default: "allow",
				rules: [{ id: "no-rm", value: "rm -rf", action: "block" }],
			},
		});
		const dec = evaluate("bash", { command: "rm -rf /" }, set, CWD, true);
		expect(dec.action).toBe("block");
	});
});
