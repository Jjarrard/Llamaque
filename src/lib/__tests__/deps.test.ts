/**
 * Dependency wave builder tests (Item 8).
 *
 * buildWaves and parseImportDeps are pure functions — no mocking needed.
 */

import { describe, it, expect } from "vitest";
import { buildWaves, parseImportDeps } from "@/lib/deps";

// ─── buildWaves ───────────────────────────────────────────────────────────────

describe("buildWaves — basic cases", () => {
  it("returns [] for empty file list", () => {
    expect(buildWaves([], new Map())).toEqual([]);
  });

  it("returns single wave for single file", () => {
    const files = ["App.tsx"];
    const depMap = new Map([["App.tsx", new Set<string>()]]);
    expect(buildWaves(files, depMap)).toEqual([["App.tsx"]]);
  });

  it("returns single wave when no file depends on another", () => {
    const files = ["A.tsx", "B.tsx", "C.tsx"];
    const depMap = new Map(files.map((f) => [f, new Set<string>()]));
    const waves = buildWaves(files, depMap);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(3);
  });

  it("returns two waves when B imports A", () => {
    const files = ["A.tsx", "B.tsx"];
    const depMap = new Map([
      ["A.tsx", new Set<string>()],
      ["B.tsx", new Set(["A.tsx"])],
    ]);
    const waves = buildWaves(files, depMap);
    expect(waves).toHaveLength(2);
    expect(waves[0]).toContain("A.tsx");
    expect(waves[1]).toContain("B.tsx");
  });
});

describe("buildWaves — multi-level chains", () => {
  it("respects a 3-level chain: A → B → C (each file in its own wave)", () => {
    const files = ["C.tsx", "B.tsx", "A.tsx"];
    const depMap = new Map([
      ["A.tsx", new Set<string>()],
      ["B.tsx", new Set(["A.tsx"])],
      ["C.tsx", new Set(["B.tsx"])],
    ]);
    const waves = buildWaves(files, depMap);
    // A must come before B, B before C
    const flatOrder = waves.flat();
    expect(flatOrder.indexOf("A.tsx")).toBeLessThan(flatOrder.indexOf("B.tsx"));
    expect(flatOrder.indexOf("B.tsx")).toBeLessThan(flatOrder.indexOf("C.tsx"));
  });

  it("puts shared dependency (A) in wave 0, dependents (B, C) in wave 1", () => {
    // B and C both depend on A, but not on each other
    const files = ["A.tsx", "B.tsx", "C.tsx"];
    const depMap = new Map([
      ["A.tsx", new Set<string>()],
      ["B.tsx", new Set(["A.tsx"])],
      ["C.tsx", new Set(["A.tsx"])],
    ]);
    const waves = buildWaves(files, depMap);
    expect(waves[0]).toContain("A.tsx");
    expect(waves[1]).toContain("B.tsx");
    expect(waves[1]).toContain("C.tsx");
    expect(waves[1]).toHaveLength(2); // B and C in same wave
  });

  it("handles diamond dependency: A → B, A → C, B+C → D", () => {
    const files = ["A.tsx", "B.tsx", "C.tsx", "D.tsx"];
    const depMap = new Map([
      ["A.tsx", new Set<string>()],
      ["B.tsx", new Set(["A.tsx"])],
      ["C.tsx", new Set(["A.tsx"])],
      ["D.tsx", new Set(["B.tsx", "C.tsx"])],
    ]);
    const waves = buildWaves(files, depMap);
    const flat = waves.flat();
    expect(flat.indexOf("A.tsx")).toBeLessThan(flat.indexOf("B.tsx"));
    expect(flat.indexOf("A.tsx")).toBeLessThan(flat.indexOf("C.tsx"));
    expect(flat.indexOf("B.tsx")).toBeLessThan(flat.indexOf("D.tsx"));
    expect(flat.indexOf("C.tsx")).toBeLessThan(flat.indexOf("D.tsx"));
  });
});

describe("buildWaves — cycle handling", () => {
  it("does not throw or hang when there is a direct cycle (A ↔ B)", () => {
    const files = ["A.tsx", "B.tsx"];
    const depMap = new Map([
      ["A.tsx", new Set(["B.tsx"])],
      ["B.tsx", new Set(["A.tsx"])],
    ]);
    expect(() => buildWaves(files, depMap)).not.toThrow();
  });

  it("includes all files in output despite a cycle", () => {
    const files = ["A.tsx", "B.tsx", "C.tsx"];
    const depMap = new Map([
      ["A.tsx", new Set(["B.tsx"])],
      ["B.tsx", new Set(["A.tsx"])],
      ["C.tsx", new Set<string>()],
    ]);
    const waves = buildWaves(files, depMap);
    const flat = waves.flat();
    expect(flat).toHaveLength(3);
    expect(flat).toContain("A.tsx");
    expect(flat).toContain("B.tsx");
    expect(flat).toContain("C.tsx");
  });
});

describe("buildWaves — deps not in manifest are ignored", () => {
  it("ignores deps that aren't in the files list", () => {
    const files = ["A.tsx", "B.tsx"];
    const depMap = new Map([
      ["A.tsx", new Set(["external.tsx"])], // not in manifest
      ["B.tsx", new Set(["A.tsx"])],
    ]);
    const waves = buildWaves(files, depMap);
    expect(waves[0]).toContain("A.tsx"); // A has no manifest dep → wave 0
    expect(waves[1]).toContain("B.tsx");
  });
});

// ─── parseImportDeps ──────────────────────────────────────────────────────────

describe("parseImportDeps — basic", () => {
  it("extracts relative imports that match a manifest file", () => {
    const source = `import { TodoList } from './TodoList';`;
    const deps = parseImportDeps(source, "App.tsx", [
      "App.tsx",
      "TodoList.tsx",
    ]);
    expect(deps.has("TodoList.tsx")).toBe(true);
    expect(deps.size).toBe(1);
  });

  it("ignores non-relative (package) imports", () => {
    const source = `import React from 'react';
import { useState } from 'react';`;
    const deps = parseImportDeps(source, "App.tsx", ["App.tsx", "react.ts"]);
    expect(deps.size).toBe(0);
  });

  it("matches extension-less imports to manifest files", () => {
    const source = `import { add } from './utils';`;
    const deps = parseImportDeps(source, "App.tsx", ["App.tsx", "utils.ts"]);
    expect(deps.has("utils.ts")).toBe(true);
  });

  it("does not include the file's own path as a dep", () => {
    const source = `import { foo } from './App';`;
    const deps = parseImportDeps(source, "App.tsx", ["App.tsx"]);
    expect(deps.has("App.tsx")).toBe(false);
  });

  it("handles multiple imports", () => {
    const source = `import { A } from './ComponentA';
import { B } from './ComponentB';`;
    const deps = parseImportDeps(source, "App.tsx", [
      "App.tsx",
      "ComponentA.tsx",
      "ComponentB.tsx",
    ]);
    expect(deps.has("ComponentA.tsx")).toBe(true);
    expect(deps.has("ComponentB.tsx")).toBe(true);
    expect(deps.size).toBe(2);
  });

  it("returns empty Set for file with no imports", () => {
    const source = `export const x = 1;`;
    const deps = parseImportDeps(source, "utils.ts", ["utils.ts", "App.tsx"]);
    expect(deps.size).toBe(0);
  });

  it("returns empty Set for empty source", () => {
    const deps = parseImportDeps("", "App.tsx", ["App.tsx", "B.tsx"]);
    expect(deps.size).toBe(0);
  });
});
