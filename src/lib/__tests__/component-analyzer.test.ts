import { describe, it, expect } from "vitest";
import {
  analyzeComponent,
  extractButtonTexts,
  extractRolesTree,
  formatAnalysisForPrompt,
} from "@/lib/ops/component-analyzer";

// ─── analyzeComponent ────────────────────────────────────────────────────────

describe("analyzeComponent", () => {
  it("extracts required and optional props from interface", () => {
    const src = `
interface HabitProps {
  name: string;
  streak: number;
  onDelete?: () => void;
}
export default function HabitItem({ name, streak, onDelete }: HabitProps) {
  return <div>{name}</div>;
}`;
    const r = analyzeComponent(src);
    expect(r.requiredProps).toContain("name: string");
    expect(r.requiredProps).toContain("streak: number");
    expect(r.optionalProps).toContain("onDelete?: () => void");
  });

  it("returns empty props arrays when no Props interface exists", () => {
    const src = `export default function App() { return <div>Hello</div>; }`;
    const r = analyzeComponent(src);
    expect(r.requiredProps).toEqual([]);
    expect(r.optionalProps).toEqual([]);
  });

  it("detects text input", () => {
    const src = `<input type="text" placeholder="Add habit" />`;
    expect(analyzeComponent(src).hasInput).toBe(true);
  });

  it("reports no input when none present", () => {
    const src = `<button onClick={fn}>Click</button>`;
    expect(analyzeComponent(src).hasInput).toBe(false);
  });

  it("extracts placeholder values", () => {
    const src = `<input placeholder="Enter habit name" />`;
    expect(analyzeComponent(src).inputPlaceholders).toContain(
      "Enter habit name",
    );
  });

  it("extracts aria-label values", () => {
    const src = `<button aria-label="delete item">×</button>`;
    expect(analyzeComponent(src).ariaLabels).toContain("delete item");
  });

  it("extracts heading texts", () => {
    const src = `<h1>Habit Tracker</h1><h2>Today</h2>`;
    const r = analyzeComponent(src);
    expect(r.headingTexts).toContain("Habit Tracker");
    expect(r.headingTexts).toContain("Today");
  });

  it("skips headings with dynamic content", () => {
    const src = `<h1>{title}</h1>`;
    expect(analyzeComponent(src).headingTexts).toEqual([]);
  });
});

// ─── extractButtonTexts ───────────────────────────────────────────────────────

describe("extractButtonTexts", () => {
  it("extracts literal button text", () => {
    const src = `<button onClick={fn}>Add</button>`;
    expect(extractButtonTexts(src)).toContain("Add");
  });

  it("extracts multiple buttons", () => {
    const src = `<button>Add</button><button>×</button><button>Done Today ✅</button>`;
    const r = extractButtonTexts(src);
    expect(r).toContain("Add");
    expect(r).toContain("×");
    expect(r).toContain("Done Today ✅");
  });

  it("skips purely dynamic button content", () => {
    const src = `<button onClick={fn}>{label}</button>`;
    expect(extractButtonTexts(src)).toEqual([]);
  });

  it("extracts both branches of a ternary string literal", () => {
    const src = `<button>{isDone ? "Done ✅" : "Mark as Done"}</button>`;
    const r = extractButtonTexts(src);
    expect(r).toContain("Done ✅");
    expect(r).toContain("Mark as Done");
  });

  it("skips buttons with mixed dynamic content", () => {
    const src = `<button>Delete {name}</button>`;
    expect(extractButtonTexts(src)).toEqual([]);
  });

  it("deduplicates identical button texts", () => {
    const src = `<button>Add</button><button>Add</button>`;
    expect(extractButtonTexts(src)).toEqual(["Add"]);
  });
});

// ─── extractRolesTree ─────────────────────────────────────────────────────────

describe("extractRolesTree", () => {
  it("extracts the accessible roles block from vitest error output", () => {
    const error = `
Unable to find an accessible element with the role "button" and name \`/foo/i\`

Here are the accessible roles:

  heading:
    Name "Habit Tracker":
      <h1 />

  button:
    Name "Add":
      <button />
    Name "×":
      <button />

Ignored nodes: comments, <script />, <style />
`.trim();
    const result = extractRolesTree(error);
    expect(result).not.toBeNull();
    expect(result).toContain('Name "Add"');
    expect(result).toContain('Name "×"');
    expect(result).toContain("Here are the accessible roles:");
  });

  it("returns null when error has no roles tree", () => {
    expect(
      extractRolesTree("TypeError: Cannot read properties of undefined"),
    ).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractRolesTree("")).toBeNull();
  });
});

// ─── formatAnalysisForPrompt ─────────────────────────────────────────────────

describe("formatAnalysisForPrompt", () => {
  it("produces container component guidance when no required props", () => {
    const analysis = analyzeComponent(
      `export default function App() { return <div><h1>Habit Tracker</h1><input placeholder="Add habit" /><button>Add</button></div>; }`,
    );
    const prompt = formatAnalysisForPrompt(analysis, "App");
    expect(prompt).toContain("No required props");
    expect(prompt).toContain("Habit Tracker");
    expect(prompt).toContain('"Add"');
    expect(prompt).toContain("INTERACTION TEST: text input exists");
  });

  it("lists required props when they exist", () => {
    const src = `
interface ItemProps { name: string; onDelete: () => void; }
export default function Item({ name, onDelete }: ItemProps) { return <div>{name}</div>; }`;
    const analysis = analyzeComponent(src);
    const prompt = formatAnalysisForPrompt(analysis, "Item");
    expect(prompt).toContain("Required props:");
    expect(prompt).toContain("name");
    expect(prompt).toContain("onDelete");
  });

  it("produces button-click guidance when no input", () => {
    const src = `<button>Mark as Done</button>`;
    const analysis = analyzeComponent(src);
    const prompt = formatAnalysisForPrompt(analysis, "HabitItem");
    expect(prompt).toContain("INTERACTION TEST: no text input");
    expect(prompt).toContain("Mark as Done");
  });
});
