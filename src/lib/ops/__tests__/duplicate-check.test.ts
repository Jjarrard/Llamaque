import { describe, it, expect } from "vitest";
import {
  findDuplicateSymbols,
  formatDuplicateIssue,
} from "@/lib/ops/duplicate-check";

describe("findDuplicateSymbols", () => {
  it("flags duplicate function declarations", () => {
    const code = `
function foo() { return 1; }
function bar() { return 2; }
function foo() { return 3; }
`;
    const issues = findDuplicateSymbols("a.ts", code);
    expect(issues).toHaveLength(1);
    expect(issues[0].name).toBe("foo");
    expect(issues[0].kind).toBe("function");
    expect(issues[0].firstLine).toBe(2);
    expect(issues[0].secondLine).toBe(4);
  });

  it("flags duplicate const declarations", () => {
    const code = `
const seconds = 60;
const minutes = 60;
const seconds = 30;
`;
    const issues = findDuplicateSymbols("a.tsx", code);
    expect(issues).toHaveLength(1);
    expect(issues[0].name).toBe("seconds");
  });

  it("flags arrow function variable assigned twice", () => {
    const code = `
const countNeighbors = (g: number[][]) => 0;
const otherFn = () => 1;
const countNeighbors = (g: number[][], r: number) => 1;
`;
    const issues = findDuplicateSymbols("g.ts", code);
    expect(issues).toHaveLength(1);
    expect(issues[0].name).toBe("countNeighbors");
  });

  it("does not flag interfaces (they can merge)", () => {
    const code = `
interface Props { a: string }
interface Props { b: number }
`;
    expect(findDuplicateSymbols("a.ts", code)).toEqual([]);
  });

  it("returns empty for clean files", () => {
    const code = `
function foo() {}
const bar = 1;
class Baz {}
`;
    expect(findDuplicateSymbols("a.ts", code)).toEqual([]);
  });

  it("returns empty for non-code files", () => {
    expect(findDuplicateSymbols("README.md", "duplicate duplicate")).toEqual(
      [],
    );
  });

  it("does not flag locals inside functions", () => {
    const code = `
function outer() {
  const x = 1;
  return x;
}
function other() {
  const x = 2;
  return x;
}
`;
    expect(findDuplicateSymbols("a.ts", code)).toEqual([]);
  });

  it("formats issue as a clear instruction string", () => {
    const issue = {
      name: "foo",
      firstLine: 5,
      secondLine: 20,
      kind: "function",
    };
    expect(formatDuplicateIssue(issue)).toContain("foo");
    expect(formatDuplicateIssue(issue)).toContain("5");
    expect(formatDuplicateIssue(issue)).toContain("20");
  });
});
