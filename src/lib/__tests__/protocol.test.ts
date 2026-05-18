/**
 * TTM Protocol parser tests — PLAN and SUMMARY blocks added in Items 1 & 7.
 * Tests cover the new block types plus edge-case behaviour of the parser.
 */

import { describe, it, expect } from "vitest";
import { parseTTM, PlanBlock, SummaryBlock } from "@/lib/protocol";

// ─── PLAN block ───────────────────────────────────────────────────────────────

describe("parseTTM — PLAN block", () => {
  it("parses a well-formed PLAN block with bullet points", () => {
    const raw = `>>PLAN
- const [items, setItems] = useState([])
- handleAdd handler
- handleDelete(id) handler
>>END`;
    const block = parseTTM(raw);
    expect(block).not.toBeNull();
    expect(block!.command).toBe("PLAN");
    const plan = block as PlanBlock;
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0]).toBe("const [items, setItems] = useState([])");
    expect(plan.steps[1]).toBe("handleAdd handler");
  });

  it("parses numbered list items", () => {
    const raw = `>>PLAN
1. export function fetchData()
2. const cache: Map<string, Data>
3. import axios
>>END`;
    const block = parseTTM(raw) as PlanBlock;
    expect(block?.command).toBe("PLAN");
    expect(block.steps).toHaveLength(3);
    expect(block.steps[0]).toBe("export function fetchData()");
  });

  it("parses asterisk list items", () => {
    const raw = `>>PLAN
* useState([todos, setTodos])
* handleToggle(id)
>>END`;
    const block = parseTTM(raw) as PlanBlock;
    expect(block?.command).toBe("PLAN");
    expect(block.steps).toHaveLength(2);
  });

  it("caps at 5 steps", () => {
    const raw = `>>PLAN
- step 1
- step 2
- step 3
- step 4
- step 5
- step 6
- step 7
>>END`;
    const block = parseTTM(raw) as PlanBlock;
    expect(block.steps).toHaveLength(5);
  });

  it("returns null for an empty PLAN body", () => {
    const raw = `>>PLAN
>>END`;
    expect(parseTTM(raw)).toBeNull();
  });

  it("returns null for a PLAN with only non-bullet lines", () => {
    const raw = `>>PLAN
This is just prose without bullet points.
>>END`;
    expect(parseTTM(raw)).toBeNull();
  });

  it("strips the bullet marker from each step", () => {
    const raw = `>>PLAN
- export default function App()
>>END`;
    const block = parseTTM(raw) as PlanBlock;
    expect(block.steps[0]).not.toMatch(/^[-*]\s/);
    expect(block.steps[0]).toBe("export default function App()");
  });
});

// ─── SUMMARY block ────────────────────────────────────────────────────────────

describe("parseTTM — SUMMARY block", () => {
  it("parses a well-formed SUMMARY block with quoted context", () => {
    const raw = `>>SUMMARY
context: "TodoList.tsx: exports TodoList; state [todos, setTodos]; handlers handleAdd, handleDelete"
>>END`;
    const block = parseTTM(raw) as SummaryBlock;
    expect(block?.command).toBe("SUMMARY");
    expect(block.context).toContain("TodoList.tsx");
    expect(block.context).toContain("handleAdd");
  });

  it("parses SUMMARY without quotes around context value", () => {
    const raw = `>>SUMMARY
context: App.tsx: exports App; state [count, setCount]
>>END`;
    const block = parseTTM(raw) as SummaryBlock;
    expect(block?.command).toBe("SUMMARY");
    expect(block.context).toContain("App.tsx");
  });

  it("falls back to using the whole body as context when no field key", () => {
    const raw = `>>SUMMARY
TodoItem.tsx: exports TodoItem default; state none; handlers onDelete
>>END`;
    const block = parseTTM(raw) as SummaryBlock;
    expect(block?.command).toBe("SUMMARY");
    expect(block.context).toContain("TodoItem.tsx");
  });

  it("returns null for an empty SUMMARY body", () => {
    const raw = `>>SUMMARY
>>END`;
    expect(parseTTM(raw)).toBeNull();
  });
});

// ─── Parser robustness ────────────────────────────────────────────────────────

describe("parseTTM — robustness", () => {
  it("handles missing >>END (uses end of string)", () => {
    const raw = `>>PLAN
- step 1
- step 2`;
    const block = parseTTM(raw) as PlanBlock;
    expect(block?.command).toBe("PLAN");
    expect(block.steps).toHaveLength(2);
  });

  it("is case-insensitive for command names", () => {
    const raw = `>>plan
- step 1
>>END`;
    const block = parseTTM(raw) as PlanBlock;
    expect(block?.command).toBe("PLAN");
  });

  it("returns null for unknown command", () => {
    const raw = `>>UNKNOWNCMD
some content
>>END`;
    expect(parseTTM(raw)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseTTM("")).toBeNull();
  });
});
