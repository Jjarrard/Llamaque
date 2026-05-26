import { describe, it, expect } from "vitest";
import { detectTruncation } from "@/lib/ops/truncation-check";

describe("detectTruncation", () => {
  it("flags unbalanced braces", () => {
    const code = `function foo() {\n  if (true) {\n    return 1;\n`;
    const reasons = detectTruncation("a.ts", code);
    expect(reasons.some((r) => /unclosed brace/.test(r))).toBe(true);
  });

  it("flags trailing operator", () => {
    const code = `const foo = 1;\nconst bar =`;
    expect(
      detectTruncation("a.ts", code).some((r) => /trailing operator/.test(r)),
    ).toBe(true);
  });

  it("flags bare identifier on last line", () => {
    const code = `function foo() {\n  return 1;\n}\n\nsto`;
    expect(
      detectTruncation("a.ts", code).some((r) => /bare identifier/.test(r)),
    ).toBe(true);
  });

  it("flags open paren ending", () => {
    const code = `const fn = (`;
    expect(detectTruncation("a.ts", code).some((r) => /unclosed/.test(r))).toBe(
      true,
    );
  });

  it("returns empty for clean balanced code", () => {
    const code = `function foo(): number {\n  return 1;\n}\n`;
    expect(detectTruncation("a.ts", code)).toEqual([]);
  });

  it("does not count braces inside strings", () => {
    const code = `const s = "{ unclosed in string";\nconst t = "{";\n`;
    expect(detectTruncation("a.ts", code)).toEqual([]);
  });

  it("does not count braces inside template literals", () => {
    const code = `const s = \`hello { world }\`;\n`;
    expect(detectTruncation("a.ts", code)).toEqual([]);
  });

  it("does not count braces inside comments", () => {
    const code = `// here is a { brace\n/* and another { */\nconst x = 1;\n`;
    expect(detectTruncation("a.ts", code)).toEqual([]);
  });

  it("respects minExpectedLines for size sanity", () => {
    const code = `const x = 1;\n`;
    const reasons = detectTruncation("a.ts", code, { minExpectedLines: 50 });
    expect(reasons.some((r) => /1 lines/.test(r) || /lines/.test(r))).toBe(
      true,
    );
  });

  it("returns empty for non-code files", () => {
    expect(detectTruncation("README.md", "incomplete...")).toEqual([]);
  });
});
