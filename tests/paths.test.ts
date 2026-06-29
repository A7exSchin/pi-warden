import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { expandHome, resolvePathSafe, isPathUnder, extractPathTokens } from "../extensions/paths.js";

describe("expandHome", () => {
	it("expands bare ~", () => {
		expect(expandHome("~")).toBe(os.homedir());
	});

	it("expands ~/subpath", () => {
		expect(expandHome("~/foo/bar")).toBe(path.join(os.homedir(), "foo/bar"));
	});

	it("leaves absolute paths unchanged", () => {
		expect(expandHome("/usr/bin")).toBe("/usr/bin");
	});

	it("leaves relative paths unchanged", () => {
		expect(expandHome("foo/bar")).toBe("foo/bar");
	});
});

describe("resolvePathSafe", () => {
	it("resolves an existing absolute path", () => {
		const result = resolvePathSafe("/tmp", "/");
		// /tmp may be a symlink (e.g. to /private/tmp on macOS)
		expect(path.isAbsolute(result)).toBe(true);
	});

	it("resolves a relative path against cwd", () => {
		const result = resolvePathSafe("foo", "/tmp");
		expect(result).toContain("foo");
		expect(path.isAbsolute(result)).toBe(true);
	});

	it("resolves ~ paths", () => {
		const result = resolvePathSafe("~/.config", "/");
		expect(result).toContain(".config");
		expect(path.isAbsolute(result)).toBe(true);
	});

	it("handles non-existent paths by resolving the existing prefix", () => {
		const result = resolvePathSafe("/tmp/nonexistent-xyz-12345/deep/file.txt", "/");
		expect(result).toContain("nonexistent-xyz-12345");
		expect(result).toContain("file.txt");
		expect(path.isAbsolute(result)).toBe(true);
	});
});

describe("isPathUnder", () => {
	it("returns true for exact match", () => {
		expect(isPathUnder("/foo/bar", "/foo/bar")).toBe(true);
	});

	it("returns true for child path", () => {
		expect(isPathUnder("/foo/bar/baz", "/foo/bar")).toBe(true);
	});

	it("returns false for sibling with shared prefix", () => {
		expect(isPathUnder("/foo/bar-extra", "/foo/bar")).toBe(false);
	});

	it("returns false for parent", () => {
		expect(isPathUnder("/foo", "/foo/bar")).toBe(false);
	});

	it("returns false for unrelated paths", () => {
		expect(isPathUnder("/other/path", "/foo/bar")).toBe(false);
	});
});

describe("extractPathTokens", () => {
	it("extracts paths from a simple command", () => {
		const tokens = extractPathTokens("cat /etc/passwd");
		expect(tokens).toContain("/etc/passwd");
	});

	it("extracts ~ paths", () => {
		const tokens = extractPathTokens("ls ~/.ssh");
		expect(tokens).toContain("~/.ssh");
	});

	it("extracts multiple paths", () => {
		const tokens = extractPathTokens("cp /src/file /dst/file");
		expect(tokens).toContain("/src/file");
		expect(tokens).toContain("/dst/file");
	});

	it("handles piped commands", () => {
		const tokens = extractPathTokens("cat /etc/hosts | grep localhost");
		expect(tokens).toContain("/etc/hosts");
	});

	it("handles && chains", () => {
		const tokens = extractPathTokens("cd /foo && cat /bar/baz");
		expect(tokens).toContain("/foo");
		expect(tokens).toContain("/bar/baz");
	});

	it("ignores non-path tokens", () => {
		const tokens = extractPathTokens("echo hello world");
		expect(tokens).toHaveLength(0);
	});
});
