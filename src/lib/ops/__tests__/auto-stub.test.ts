import { describe, it, expect } from "vitest";
import { autoStubUndefs } from "@/lib/ops/auto-stub";
import { findUndefinedIdentifiers } from "@/lib/ops/undef-check";

describe("autoStubUndefs", () => {
  it("stubs a handler used in JSX but never declared", () => {
    const code = `
import React, { useState } from "react";
export default function App() {
  const [n, setN] = useState(0);
  return <button onClick={handleClick}>{n}</button>;
}
`;
    const r = autoStubUndefs("App.tsx", code);
    expect(r.stubbedNames).toContain("handleClick");
    expect(r.content).toContain("const handleClick = () => {};");
    // After stubbing, undef check should be clean
    const remaining = findUndefinedIdentifiers("App.tsx", r.content);
    expect(remaining.map((i) => i.name)).not.toContain("handleClick");
  });

  it("stubs a useState pair when both halves are missing", () => {
    const code = `
import React from "react";
export default function App() {
  return <div>{generation}<button onClick={() => setGeneration(generation + 1)}>+</button></div>;
}
`;
    const r = autoStubUndefs("App.tsx", code);
    expect(r.stubbedNames).toContain("generation");
    expect(r.stubbedNames).toContain("setGeneration");
    expect(r.content).toContain("useState");
    expect(r.content).toContain("generation");
    const remaining = findUndefinedIdentifiers("App.tsx", r.content);
    expect(remaining.map((i) => i.name)).not.toContain("generation");
  });

  it("stubs a plain identifier as undefined any", () => {
    const code = `
import React from "react";
export default function App() {
  return <div>{theData.title}</div>;
}
`;
    const r = autoStubUndefs("App.tsx", code);
    expect(r.stubbedNames).toContain("theData");
    expect(r.content).toContain("const theData: any = undefined;");
  });

  it("returns unchanged content when there are no undefs", () => {
    const code = `
import React, { useState } from "react";
export default function App() {
  const [n, setN] = useState(0);
  const handleClick = () => setN(n + 1);
  return <button onClick={handleClick}>{n}</button>;
}
`;
    const r = autoStubUndefs("App.tsx", code);
    expect(r.stubbedNames).toEqual([]);
    expect(r.content).toBe(code);
  });

  it("returns unchanged for non-code files", () => {
    const r = autoStubUndefs("readme.md", "# hi");
    expect(r.stubbedNames).toEqual([]);
    expect(r.content).toBe("# hi");
  });

  it("inserts stubs inside the main component body", () => {
    const code = `
import React from "react";
export default function App() {
  return <button onClick={handleX}>x</button>;
}
`;
    const r = autoStubUndefs("App.tsx", code);
    const lines = r.content.split("\n");
    const fnIdx = lines.findIndex((l) => l.includes("function App()"));
    const stubIdx = lines.findIndex((l) => l.includes("auto-generated stubs"));
    // The stub block should be after the function opening
    expect(stubIdx).toBeGreaterThan(fnIdx);
  });
});
