import { describe, it, expect } from "vitest";
import { fallback } from "../extensions/types.js";

describe("fallback", () => {
	it("returns 'block' for 'allow' default", () => {
		expect(fallback("allow")).toBe("block");
	});

	it("returns 'allow' for 'block' default", () => {
		expect(fallback("block")).toBe("allow");
	});
});
