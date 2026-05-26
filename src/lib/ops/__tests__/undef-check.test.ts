import { describe, it, expect } from "vitest";
import {
  findUndefinedIdentifiers,
  formatUndefIssue,
} from "@/lib/ops/undef-check";

describe("findUndefinedIdentifiers", () => {
  it("catches undefined handler referenced in JSX onClick", () => {
    const code = `
import React, { useState } from "react";
export default function App() {
  const [n, setN] = useState(0);
  return <button onClick={handleStartPause}>Start</button>;
}
`;
    const issues = findUndefinedIdentifiers("App.tsx", code);
    expect(issues.map((i) => i.name)).toContain("handleStartPause");
  });

  it("catches undefined variable referenced in JSX expression", () => {
    const code = `
import React from "react";
export default function App() {
  return <div>{generation}</div>;
}
`;
    const issues = findUndefinedIdentifiers("App.tsx", code);
    expect(issues.map((i) => i.name)).toContain("generation");
  });

  it("does not flag declared state and handlers", () => {
    const code = `
import React, { useState } from "react";
export default function App() {
  const [count, setCount] = useState(0);
  const handleClick = () => setCount(count + 1);
  return <button onClick={handleClick}>{count}</button>;
}
`;
    const issues = findUndefinedIdentifiers("App.tsx", code);
    expect(issues).toEqual([]);
  });

  it("does not flag JSX intrinsic lowercase tags", () => {
    const code = `
import React from "react";
export default function App() {
  return <div><span><button>x</button></span></div>;
}
`;
    const issues = findUndefinedIdentifiers("App.tsx", code);
    expect(issues).toEqual([]);
  });

  it("does not flag React hooks like useEffect or useState", () => {
    const code = `
import React, { useState, useEffect } from "react";
export default function App() {
  const [v, setV] = useState(0);
  const cb = useCallback(() => setV(v + 1), [v]);
  useEffect(() => {}, []);
  return <button onClick={cb}>{v}</button>;
}
`;
    const issues = findUndefinedIdentifiers("App.tsx", code);
    // useCallback was not imported — but our rule allows any use* hook.
    expect(issues).toEqual([]);
  });

  it("does not flag imported names", () => {
    const code = `
import React from "react";
import GameLogic from "./GameLogic";
import { computeNext } from "./helpers";
export default function App() {
  const next = computeNext(GameLogic.init());
  return <div>{String(next)}</div>;
}
`;
    const issues = findUndefinedIdentifiers("App.tsx", code);
    expect(issues).toEqual([]);
  });

  it("does not flag function parameters or destructured params", () => {
    const code = `
import React from "react";
function Greet({ name, age }: { name: string; age: number }) {
  return <div>{name} {age}</div>;
}
export default function App() {
  return <Greet name="x" age={1} />;
}
`;
    const issues = findUndefinedIdentifiers("App.tsx", code);
    expect(issues).toEqual([]);
  });

  it("does not flag object property keys", () => {
    const code = `
import React from "react";
export default function App() {
  const x = { foo: 1, bar: 2 };
  return <div>{x.foo + x.bar}</div>;
}
`;
    const issues = findUndefinedIdentifiers("App.tsx", code);
    expect(issues).toEqual([]);
  });

  it("catches usage inside event handler body", () => {
    const code = `
import React, { useState } from "react";
export default function App() {
  const [count, setCount] = useState(0);
  const handler = () => {
    setCount(missingThing + 1);
  };
  return <button onClick={handler}>x</button>;
}
`;
    const issues = findUndefinedIdentifiers("App.tsx", code);
    expect(issues.map((i) => i.name)).toContain("missingThing");
  });

  it("ignores common globals", () => {
    const code = `
import React, { useEffect } from "react";
export default function App() {
  useEffect(() => {
    const id = setTimeout(() => console.log(Date.now()), 100);
    return () => clearTimeout(id);
  }, []);
  return <div />;
}
`;
    const issues = findUndefinedIdentifiers("App.tsx", code);
    expect(issues).toEqual([]);
  });

  it("returns [] for non-code files", () => {
    expect(findUndefinedIdentifiers("readme.md", "anything")).toEqual([]);
    expect(findUndefinedIdentifiers("data.json", "{}")).toEqual([]);
  });

  it("returns [] on parse failure (never throws)", () => {
    const code = "function broken( {{{ ";
    expect(() => findUndefinedIdentifiers("bad.ts", code)).not.toThrow();
  });

  it("formats issue prompt-friendly", () => {
    const issue = {
      name: "handleStartPause",
      line: 23,
      kind: "expression" as const,
    };
    const text = formatUndefIssue(issue);
    expect(text).toContain("handleStartPause");
    expect(text).toContain("23");
    expect(text).toMatch(/declar|import|parameter/i);
  });

  it("does not flag for-of loop variables", () => {
    const code = `
export function sum(nums: number[]) {
  let total = 0;
  for (const n of nums) total += n;
  return total;
}
`;
    const issues = findUndefinedIdentifiers("util.ts", code);
    expect(issues).toEqual([]);
  });

  it("does not flag catch clause variable", () => {
    const code = `
export function safe() {
  try { JSON.parse("x"); } catch (e) { return String(e); }
  return "ok";
}
`;
    const issues = findUndefinedIdentifiers("util.ts", code);
    expect(issues).toEqual([]);
  });

  it("flags multiple undefined identifiers", () => {
    const code = `
import React from "react";
export default function App() {
  return (
    <div>
      <button onClick={onStart}>Start</button>
      <button onClick={onStop}>Stop</button>
      <span>{counter}</span>
    </div>
  );
}
`;
    const issues = findUndefinedIdentifiers("App.tsx", code);
    const names = issues.map((i) => i.name);
    expect(names).toContain("onStart");
    expect(names).toContain("onStop");
    expect(names).toContain("counter");
  });

  it("accepts extraDeclared globals", () => {
    const code = `
export function f() {
  return MY_INJECTED_GLOBAL.value;
}
`;
    const issues = findUndefinedIdentifiers("f.ts", code, {
      extraDeclared: ["MY_INJECTED_GLOBAL"],
    });
    expect(issues).toEqual([]);
  });
});
