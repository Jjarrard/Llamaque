/**
 * TypeScript syntax gate tests (Item 2).
 *
 * checkTypeScriptSyntax runs entirely in-memory using the TS compiler API.
 * No mocking needed — this is a pure synchronous function.
 */

import { describe, it, expect } from "vitest";
import {
  checkTypeScriptSyntax,
  extractExportSignatures,
  checkTypeScriptSemantics,
} from "@/lib/ops/compiler";

// ─── Non-TS files ─────────────────────────────────────────────────────────────

describe("checkTypeScriptSyntax — non-TS files", () => {
  it("returns [] for .css files", () => {
    expect(checkTypeScriptSyntax("styles.css", "body { color: red; }")).toEqual(
      [],
    );
  });

  it("returns [] for .json files", () => {
    expect(checkTypeScriptSyntax("data.json", '{ "key": "value" }')).toEqual(
      [],
    );
  });

  it("returns [] for .md files", () => {
    expect(checkTypeScriptSyntax("readme.md", "# Hello World")).toEqual([]);
  });

  it("returns [] for .py files", () => {
    expect(checkTypeScriptSyntax("script.py", "def foo(): pass")).toEqual([]);
  });
});

// ─── Valid TypeScript ──────────────────────────────────────────────────────────

describe("checkTypeScriptSyntax — valid TypeScript", () => {
  it("returns [] for a simple TS function", () => {
    const code = `export function add(a: number, b: number): number {
  return a + b;
}`;
    expect(checkTypeScriptSyntax("math.ts", code)).toEqual([]);
  });

  it("returns [] for a TypeScript interface", () => {
    const code = `export interface Todo {
  id: number;
  text: string;
  done: boolean;
}`;
    expect(checkTypeScriptSyntax("types.ts", code)).toEqual([]);
  });

  it("returns [] for valid TSX component (even with unresolvable import)", () => {
    const code = `import React from 'react';
import { Todo } from './types';

export default function TodoItem({ todo }: { todo: Todo }) {
  return <li>{todo.text}</li>;
}`;
    expect(checkTypeScriptSyntax("TodoItem.tsx", code)).toEqual([]);
  });

  it("returns [] for valid TSX with useState", () => {
    const code = `import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}`;
    expect(checkTypeScriptSyntax("App.tsx", code)).toEqual([]);
  });

  it("returns [] for empty file", () => {
    expect(checkTypeScriptSyntax("empty.ts", "")).toEqual([]);
  });
});

// ─── Invalid TypeScript (syntax errors) ──────────────────────────────────────

describe("checkTypeScriptSyntax — syntax errors", () => {
  it("detects unclosed brace", () => {
    const code = `export function broken() {
  const x = 1;
  // missing closing brace`;
    const errors = checkTypeScriptSyntax("broken.ts", code);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("detects missing closing parenthesis", () => {
    const code = `export function bad(x: number {
  return x;
}`;
    const errors = checkTypeScriptSyntax("bad.ts", code);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("detects unterminated string literal", () => {
    const code = `const msg = "hello world;
export default msg;`;
    const errors = checkTypeScriptSyntax("str.ts", code);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("caps errors at 3", () => {
    // Multiple mismatched brackets — intentionally many errors
    const code = `export function a( {
export function b( {
export function c( {
export function d( {
export function e( {`;
    const errors = checkTypeScriptSyntax("many.ts", code);
    expect(errors.length).toBeLessThanOrEqual(3);
  });

  it("returns strings (not objects)", () => {
    const code = `const x = {`;
    const errors = checkTypeScriptSyntax("x.ts", code);
    for (const e of errors) {
      expect(typeof e).toBe("string");
    }
  });
});

// ─── Semantic errors (safe subset) ───────────────────────────────────────────

describe("checkTypeScriptSyntax — semantic errors", () => {
  it("catches parameter shadow (let x = x) — TS2300 duplicate identifier", () => {
    // This is the QA-introduced bug pattern: LLM declares `let param = param`
    // inside a function, creating a temporal-dead-zone ReferenceError at runtime.
    const code = `
const handleToggle = (id: string, newIsCompleted: boolean) => {
  let newIsCompleted = newIsCompleted;
  return newIsCompleted;
};`;
    const errors = checkTypeScriptSyntax("App.tsx", code);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toMatch(/duplicate identifier/i);
  });

  it("catches duplicate function declaration — TS2300", () => {
    const code = `
function foo(x: number): number { return x; }
function foo(x: number): number { return x + 1; }`;
    const errors = checkTypeScriptSyntax("util.ts", code);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("does NOT flag missing imports (unresolved names are expected in isolation)", () => {
    // useState is not imported — but we should NOT flag TS2304 (cannot find name)
    // because on isolated files this is always a false positive.
    const code = `
export default function App() {
  const [count, setCount] = useState(0);
  return count;
}`;
    const errors = checkTypeScriptSyntax("App.tsx", code);
    expect(errors).toEqual([]);
  });
});

// ─── JSX files ────────────────────────────────────────────────────────────────

describe("checkTypeScriptSyntax — .jsx files", () => {
  it("returns [] for valid JSX", () => {
    const code = `export default function Hello({ name }) {
  return <h1>Hello {name}</h1>;
}`;
    expect(checkTypeScriptSyntax("Hello.jsx", code)).toEqual([]);
  });

  it("detects syntax error in JSX", () => {
    const code = `export default function Bad() {
  return <div
}`;
    const errors = checkTypeScriptSyntax("Bad.jsx", code);
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ─── Error safety ─────────────────────────────────────────────────────────────

describe("checkTypeScriptSyntax — does not throw", () => {
  it("returns [] for completely garbage input", () => {
    expect(() =>
      checkTypeScriptSyntax("x.ts", "🤖🤖🤖 @@@!!!! <<<>>>"),
    ).not.toThrow();
  });
});

// ─── extractExportSignatures ──────────────────────────────────────────────────

describe("extractExportSignatures", () => {
  it("returns [] for non-TS files", () => {
    expect(extractExportSignatures("styles.css", "body{}")).toEqual([]);
  });

  it("extracts exported function declarations", () => {
    const sigs = extractExportSignatures(
      "a.ts",
      `export function add(a: number, b: number): number { return a + b; }`,
    );
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toContain("export function add");
    expect(sigs[0]).toContain("a: number");
    expect(sigs[0]).toContain(": number");
  });

  it("extracts default exported function", () => {
    const sigs = extractExportSignatures(
      "App.tsx",
      `export default function App(): JSX.Element { return <div/>; }`,
    );
    expect(sigs[0]).toMatch(/export default function App/);
  });

  it("extracts exported const with type annotation", () => {
    const sigs = extractExportSignatures(
      "Card.tsx",
      `import React from 'react';
type Props = { title: string };
export const Card: React.FC<Props> = ({ title }) => <div>{title}</div>;`,
    );
    expect(sigs.some((s) => s.includes("export const Card"))).toBe(true);
    expect(sigs.some((s) => s.includes("React.FC<Props>"))).toBe(true);
  });

  it("extracts exported interface and type alias", () => {
    const sigs = extractExportSignatures(
      "types.ts",
      `export interface CardProps { title: string; onDelete: () => void; }
export type Id = string | number;`,
    );
    expect(sigs.some((s) => s.includes("CardProps"))).toBe(true);
    expect(sigs.some((s) => s.includes("type Id"))).toBe(true);
  });

  it("ignores non-exported declarations", () => {
    const sigs = extractExportSignatures(
      "a.ts",
      `const internal = 1;
function helper() {}
export const visible = 2;`,
    );
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toContain("visible");
  });

  it("returns [] for empty content", () => {
    expect(extractExportSignatures("a.ts", "")).toEqual([]);
  });

  it("extracts param shape from untyped arrow component", () => {
    const sigs = extractExportSignatures(
      "Card.tsx",
      `export const Card = ({ title, onDelete }) => <div onClick={onDelete}>{title}</div>;`,
    );
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toContain("export const Card");
    expect(sigs[0]).toContain("title");
    expect(sigs[0]).toContain("onDelete");
    expect(sigs[0]).toContain("=>");
  });

  it("does not throw on malformed source", () => {
    expect(() =>
      extractExportSignatures("a.ts", "export function $$$ ((("),
    ).not.toThrow();
  });
});

// ─── checkTypeScriptSemantics ─────────────────────────────────────────────────

describe("checkTypeScriptSemantics", () => {
  it("returns [] for non-TS files", () => {
    expect(checkTypeScriptSemantics("styles.css", "body{}")).toEqual([]);
  });

  it("ignores unresolved imports (cross-file noise)", () => {
    // React, useState etc. cannot resolve — should not yield errors.
    const errs = checkTypeScriptSemantics(
      "App.tsx",
      `import React, { useState } from 'react';
export default function App() {
  const [n, setN] = useState(0);
  return <div onClick={() => setN(n + 1)}>{n}</div>;
}`,
    );
    expect(errs).toEqual([]);
  });

  it("does not false-positive on standard string/array methods (DOM lib loaded)", () => {
    // Regression: without lib: ['dom'], .trim() / .map() trigger
    // "Property does not exist on type" false positives.
    const errs = checkTypeScriptSemantics(
      "App.tsx",
      `function clean(s: string): string[] {
  return s.trim().split(",").map((x) => x.trim());
}
const arr: number[] = [1, 2, 3].map((n) => n * 2);
const el = document.getElementById("x");`,
    );
    expect(errs).toEqual([]);
  });

  it("catches duplicate object literal keys (real bug class)", () => {
    const errs = checkTypeScriptSemantics(
      "a.ts",
      `const o = { foo: 1, foo: 2 };`,
    );
    expect(errs.length).toBeGreaterThan(0);
  });

  it("does not throw on garbage input", () => {
    expect(() =>
      checkTypeScriptSemantics("a.ts", "🤖 @@@ <<<>>>"),
    ).not.toThrow();
  });

  it("returns [] for clean code", () => {
    expect(
      checkTypeScriptSemantics(
        "a.ts",
        `function add(a: number, b: number): number { return a + b; }
const x = add(1, 2);`,
      ),
    ).toEqual([]);
  });
});
