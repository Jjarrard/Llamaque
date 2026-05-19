import { describe, it, expect } from "vitest";
import { assignFileForTask } from "../file-assignment";

describe("assignFileForTask", () => {
  const kanbanManifest = [
    {
      path: "Card.tsx",
      description: "Card component for an individual kanban card",
    },
    {
      path: "KanbanColumn.tsx",
      description: "A single column that holds cards and an input",
    },
    {
      path: "App.tsx",
      description: "Top-level app that renders three columns",
    },
  ];

  it("returns the only manifest file when there is one", () => {
    const { path } = assignFileForTask(
      [{ path: "Solo.tsx", description: "the only file" }],
      null,
      "anything",
      0,
    );
    expect(path).toBe("Solo.tsx");
  });

  it("honours an explicit filePath that matches the manifest", () => {
    const { path } = assignFileForTask(
      kanbanManifest,
      "App.tsx",
      "add a card",
      0,
    );
    expect(path).toBe("App.tsx");
  });

  it("routes column-specific tasks to KanbanColumn.tsx, not Card.tsx", () => {
    const { path } = assignFileForTask(
      kanbanManifest,
      null,
      "Build a single column that holds cards and a text input",
      0,
    );
    expect(path).toBe("KanbanColumn.tsx");
  });

  it("routes 'top-level app' tasks to App.tsx", () => {
    const { path } = assignFileForTask(
      kanbanManifest,
      null,
      "Render the top-level app shell",
      0,
    );
    expect(path).toBe("App.tsx");
  });

  it("does NOT pile every kanban feature onto Card.tsx (regression for project 43)", () => {
    // The original bug: first file with ≥2 keyword overlap won, so every
    // feature containing "card" landed on Card.tsx, leaving the other two
    // files empty.
    const features = [
      "Display Kanban board with three columns and card counts",
      "Implement card creation via input field and drag-and-drop",
      "Implement card addition via input field and Enter key",
      "Enable drag and drop functionality between all columns",
    ];
    let cursor = 0;
    const assigned: string[] = [];
    for (const f of features) {
      const r = assignFileForTask(kanbanManifest, null, f, cursor);
      assigned.push(r.path);
      cursor = r.cursor;
    }
    // At least 2 distinct manifest files must receive at least one feature
    const unique = new Set(assigned);
    expect(unique.size).toBeGreaterThanOrEqual(2);
    // And specifically, Card.tsx must not receive ALL of them
    const cardCount = assigned.filter((p) => p === "Card.tsx").length;
    expect(cardCount).toBeLessThan(features.length);
  });

  it("round-robins when nothing scores against any manifest file", () => {
    const manifest = [
      { path: "Alpha.tsx", description: "First widget thing" },
      { path: "Beta.tsx", description: "Second widget thing" },
      { path: "Gamma.tsx", description: "Third widget thing" },
    ];
    let cursor = 0;
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      // Description has no overlap with any file → pure round-robin
      const r = assignFileForTask(
        manifest,
        null,
        "xyzzy plover frobnitz",
        cursor,
      );
      seen.push(r.path);
      cursor = r.cursor;
    }
    expect(seen).toEqual([
      "Alpha.tsx",
      "Beta.tsx",
      "Gamma.tsx",
      "Alpha.tsx",
      "Beta.tsx",
      "Gamma.tsx",
    ]);
  });

  it("[Path.ext] prefix routes directly, ignoring keyword overlap", () => {
    // "card addition" naively matches Card.tsx, but [KanbanColumn.tsx] wins.
    const { path } = assignFileForTask(
      kanbanManifest,
      null,
      "[KanbanColumn.tsx] Implement card addition input",
      0,
    );
    expect(path).toBe("KanbanColumn.tsx");
  });

  it("[Path.ext] prefix is case-insensitive", () => {
    const { path } = assignFileForTask(
      kanbanManifest,
      null,
      "[app.tsx] Top-level layout wiring",
      0,
    );
    expect(path).toBe("App.tsx");
  });

  it("falls back to keyword scoring when [Path] does not match manifest", () => {
    const { path } = assignFileForTask(
      kanbanManifest,
      null,
      "[Missing.tsx] Render single card",
      0,
    );
    expect(path).toBe("Card.tsx"); // "card" / "individual" still scores Card.tsx
  });
});
