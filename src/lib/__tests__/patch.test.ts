import { describe, it, expect } from "vitest";
import { parsePatch, applyPatch } from "@/lib/patch";

describe("parsePatch", () => {
  it("parses a single block", () => {
    const text = `<<<<<<< SEARCH
const x = 1;
=======
const x = 2;
>>>>>>> REPLACE`;
    const blocks = parsePatch(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("const x = 1;");
    expect(blocks[0].replace).toBe("const x = 2;");
  });

  it("parses multiple blocks", () => {
    const text = `<<<<<<< SEARCH
foo
=======
FOO
>>>>>>> REPLACE
some prose between
<<<<<<< SEARCH
bar
=======
BAR
>>>>>>> REPLACE`;
    const blocks = parsePatch(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].replace).toBe("FOO");
    expect(blocks[1].replace).toBe("BAR");
  });

  it("tolerates 7 or 8 marker chars", () => {
    const text = `<<<<<<<<< SEARCH
a
=========
b
>>>>>>>>> REPLACE`;
    const blocks = parsePatch(text);
    expect(blocks).toHaveLength(1);
  });

  it("returns empty array when no blocks found", () => {
    expect(parsePatch("just some text")).toEqual([]);
  });

  it("parses block with empty SEARCH (append mode)", () => {
    const text = `<<<<<<< SEARCH

=======
new code
>>>>>>> REPLACE`;
    const blocks = parsePatch(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("");
    expect(blocks[0].replace).toBe("new code");
  });
});

describe("applyPatch", () => {
  it("applies a unique single-line replacement", () => {
    const original = "line 1\nconst x = 1;\nline 3\n";
    const result = applyPatch(original, [
      { search: "const x = 1;", replace: "const x = 99;" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("line 1\nconst x = 99;\nline 3\n");
    expect(result.blocksApplied).toBe(1);
  });

  it("applies multiple blocks in order", () => {
    const original = "a\nb\nc\n";
    const result = applyPatch(original, [
      { search: "a", replace: "A" },
      { search: "c", replace: "C" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("A\nb\nC\n");
    expect(result.blocksApplied).toBe(2);
  });

  it("appends when SEARCH is empty", () => {
    const original = "existing code\n";
    const result = applyPatch(original, [
      { search: "", replace: "new helper" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("existing code");
    expect(result.content).toContain("new helper");
  });

  it("fails when SEARCH text not found", () => {
    const result = applyPatch("hello\n", [
      { search: "missing", replace: "found" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not found/);
  });

  it("fails when SEARCH matches multiple locations (ambiguous)", () => {
    const original = "x\nx\n";
    const result = applyPatch(original, [{ search: "x", replace: "y" }]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/multiple/);
  });

  it("fails when zero blocks provided", () => {
    const result = applyPatch("file", []);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no SEARCH/);
  });

  it("preserves whitespace exactly", () => {
    const original = "  if (a) {\n    foo();\n  }\n";
    const result = applyPatch(original, [
      { search: "    foo();", replace: "    bar();\n    baz();" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("  if (a) {\n    bar();\n    baz();\n  }\n");
  });

  it("fuzzy-matches when indentation differs", () => {
    const original = "  if (a) {\n    foo();\n  }\n";
    // Model emits without indentation
    const result = applyPatch(original, [
      { search: "foo();", replace: "bar();" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("bar();");
  });

  it("fuzzy-matches when whitespace runs differ", () => {
    const original = "const x  =  1;\n";
    const result = applyPatch(original, [
      { search: "const x = 1;", replace: "const x = 99;" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("99");
  });
});
