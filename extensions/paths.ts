import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Cap tested strings so a pathological regex can't stall on huge inputs. */
export const MAX_TEST_LEN = 100_000;

export function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/**
 * Resolve `p` (relative to `cwd`, after ~ expansion) to an absolute path with
 * symlinks resolved on the longest existing prefix. The non-existent tail (e.g.
 * a not-yet-created file) is appended verbatim so writes to new paths resolve.
 */
export function resolvePathSafe(p: string, cwd: string): string {
	let cur = path.resolve(cwd, expandHome(p));
	const tail: string[] = [];
	for (;;) {
		try {
			const real = fs.realpathSync.native(cur);
			return tail.length ? path.join(real, ...tail) : real;
		} catch {
			const parent = path.dirname(cur);
			if (parent === cur) return path.join(cur, ...tail);
			tail.unshift(path.basename(cur));
			cur = parent;
		}
	}
}

/** True if `child` is `dir` itself or lives inside it. */
export function isPathUnder(child: string, dir: string): boolean {
	if (child === dir) return true;
	return child.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

/**
 * Best-effort extraction of path-like tokens from a shell command. Splits on
 * whitespace and shell metacharacters, then keeps tokens that look like paths
 * (contain "/" or start with "~"). Heuristic — see SCOPE LIMIT in the header.
 */
export function extractPathTokens(cmd: string): string[] {
	return cmd
		.slice(0, MAX_TEST_LEN)
		.split(/[\s;|&()<>"'`=]+/)
		.filter((t) => t.length > 0 && (t.includes("/") || t.startsWith("~")));
}
