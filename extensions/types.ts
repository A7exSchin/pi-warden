// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export type Action = "block" | "allow";
export type MatchType = "substring" | "regex";
/** Which operations a path rule guards. */
export type PathScope = "read" | "write" | "any";
/** What a path rule does on match (adds an interactive "confirm" tier). */
export type PathAction = "block" | "allow" | "confirm";
/** Resolved operation kind for a candidate path. */
export type PathOp = "read" | "write";

export interface CommandRule {
	id: string;
	/** How `value` is interpreted. Default: "substring". */
	match?: MatchType;
	/** The string/pattern that triggers this rule. */
	value: string;
	/** Case-sensitive matching. Default: false. */
	case_sensitive?: boolean;
	/** On match. Default: opposite of the section's `default`. */
	action?: Action;
	/** Feedback for the LLM when blocked. */
	reason?: string;
	/** When false, the rule is skipped during compilation. Default: true (enabled). */
	enabled?: boolean;
}

export interface PathRule {
	id: string;
	/** Protected directory (~, .., symlinks resolved). Containment-matched. */
	dir: string;
	/** Operations this rule guards: "read", "write", or "any" (default). */
	on?: PathScope;
	/** On match: "block", "allow", or "confirm" (ask the user). Default: opposite of `default`. */
	action?: PathAction;
	reason?: string;
	/** When false, the rule is skipped during compilation. Default: true (enabled). */
	enabled?: boolean;
}

export interface Section<R> {
	/** "allow" = blacklist, "block" = whitelist. */
	default: Action;
	rules: R[];
}

export interface GateConfig {
	commands: Section<CommandRule>;
	paths: Section<PathRule>;
}

// ---------------------------------------------------------------------------
// Compiled types
// ---------------------------------------------------------------------------

export interface CompiledCommandRule {
	id: string;
	action: Action;
	reason: string;
	test: (s: string) => boolean;
}

export interface CompiledPathRule {
	id: string;
	action: PathAction;
	on: PathScope;
	reason: string;
	dirResolved: string;
}

export interface CompiledSet {
	commandDefault: Action;
	commands: CompiledCommandRule[];
	pathDefault: Action;
	paths: CompiledPathRule[];
	warnings: string[];
}

// ---------------------------------------------------------------------------
// Evaluation types
// ---------------------------------------------------------------------------

export interface Decision {
	action: "allow" | "block" | "confirm";
	reason?: string;
	ruleId?: string;
	/** Resolved path that triggered a path decision (shown in confirm prompts). */
	target?: string;
}

// ---------------------------------------------------------------------------
// Helpers on core types
// ---------------------------------------------------------------------------

/** Return the implicit action for a rule that doesn't specify one. */
export function fallback(def: Action): Action {
	return def === "allow" ? "block" : "allow";
}
