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

/** Unquoted characters that terminate a token (whitespace handled separately). */
const SHELL_DELIMS = new Set([";", "|", "&", "(", ")", "<", ">", "=", "`"]);

/**
 * Best-effort extraction of path-like tokens from a shell command. Walks the
 * string with quote state so a quoted path containing spaces stays one token,
 * then keeps tokens that look like paths (contain "/" or start with "~").
 *
 * Quote characters are consumed as state changes and never emitted, so
 * `cat "/my dir/file"` yields `/my dir/file`. The previous implementation split
 * *on* quote characters, fragmenting that into `/my` + `dir/file` — neither of
 * which resolves to the real path, which let a quoted path bypass any rule
 * whose directory contains a space.
 *
 * An unterminated quote flushes at EOF, so a malformed command still yields
 * candidates rather than silently dropping them (fail toward more checks).
 *
 * NOTE: quoted spans are intentionally preserved here, unlike stripQuoted in
 * evaluator.ts, which blanks them for write-verb detection. Quoting is the
 * normal way to pass a path containing spaces, so discarding quoted text would
 * hide real paths from the path rules. The two must not be unified: write
 * intent needs unquoted metacharacters like `>` to survive, which tokenizing
 * discards.
 *
 * SCOPE LIMIT: heuristic — see the header. Variable expansion ($HOME), command
 * substitution ($(...)) and encoded payloads are not resolved.
 */
export function extractPathTokens(cmd: string): string[] {
	const src = cmd.slice(0, MAX_TEST_LEN);
	const tokens: string[] = [];
	let cur = "";
	let started = false; // distinguishes "" (an empty quoted token) from no token
	let quote: '"' | "'" | null = null;

	const flush = (): void => {
		if (started) tokens.push(cur);
		cur = "";
		started = false;
	};

	for (let i = 0; i < src.length; i++) {
		const ch = src[i] as string;

		if (quote === "'") {
			// Single quotes are literal in POSIX sh: no escapes, ends only at '.
			if (ch === "'") quote = null;
			else cur += ch;
			continue;
		}

		if (quote === '"') {
			if (ch === "\\" && i + 1 < src.length) {
				cur += src[++i] as string; // \" and \\ keep the next char literally
			} else if (ch === '"') {
				quote = null;
			} else {
				cur += ch;
			}
			continue;
		}

		if (ch === "\\" && i + 1 < src.length) {
			cur += src[++i] as string; // escaped space etc. joins the token
			started = true;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
			continue;
		}
		if (/\s/.test(ch) || SHELL_DELIMS.has(ch)) {
			flush();
			continue;
		}
		cur += ch;
		started = true;
	}
	flush(); // unterminated quote: keep what we have

	return tokens.filter((t) => t.length > 0 && (t.includes("/") || t.startsWith("~")));
}
