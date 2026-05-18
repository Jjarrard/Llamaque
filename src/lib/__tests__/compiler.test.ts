/**
 * TypeScript syntax gate tests (Item 2).
 *
 * checkTypeScriptSyntax runs entirely in-memory using the TS compiler API.
 * No mocking needed — this is a pure synchronous function.
 */

import { describe, it, expect } from "vitest";
import { checkTypeScriptSyntax } from "@/lib/ops/compiler";

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
