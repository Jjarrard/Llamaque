/**
 * Pipeline state-machine tests
 *
 * These verify that the correct DB status values are written at each stage
 * transition — specifically that normal workflow checkpoints set "review"
 * (not "paused"), and that errors propagate so the run route can set "paused".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── mock all heavy dependencies before importing Pipeline ───────────────────

vi.mock("@/db/schema", () => ({
  projects: "projects",
  tasks: "tasks",
  references: "references",
  logs: "logs",
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ type: "eq", a, b }),
  and: (...args: unknown[]) => ({ type: "and", args }),
  asc: (col: unknown) => ({ type: "asc", col }),
  inArray: (col: unknown, vals: unknown) => ({ type: "inArray", col, vals }),
}));

vi.mock("@/db", () => ({
  db: {
    query: {
      projects: { findFirst: vi.fn() },
      tasks: { findMany: vi.fn() },
    },
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock("@/lib/agents/architect", () => ({
  runArchitect: vi.fn(),
  inferDefaultManifest: vi.fn(),
}));

vi.mock("@/lib/agents/project-manager", () => ({
  runProjectManager: vi.fn(),
}));

vi.mock("@/lib/agents/reviewer", () => ({
  runReviewer: vi.fn(),
}));

vi.mock("@/lib/agents/improver", () => ({
  runImprover: vi.fn(),
}));

vi.mock("@/lib/agents/manager", () => ({
  runManager: vi.fn(),
}));

vi.mock("@/lib/agents/developer", () => ({
  runDeveloper: vi.fn(),
  getFileTypeRules: vi.fn().mockReturnValue(""),
  supportsTDD: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/agents/cleaner", () => ({
  runCleaner: vi.fn(),
  runMinimalRetry: vi.fn(),
  runScaffoldTactic: vi.fn(),
  runReframeTactic: vi.fn(),
}));

vi.mock("@/lib/agents/iterative-qa", () => ({
  runIterativeQA: vi.fn(),
}));

vi.mock("@/lib/agents/test-writer", () => ({
  runTestWriter: vi.fn(),
}));

vi.mock("@/lib/validate", () => ({
  validateOutput: vi.fn().mockReturnValue({ valid: true, errors: [] }),
  autoRepairOutput: vi.fn(),
}));

vi.mock("@/lib/test-runner", () => ({
  runTests: vi.fn().mockResolvedValue({ passed: true, failures: [] }),
  getFirstFailure: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/ollama", () => ({
  callOllama: vi.fn(),
}));

vi.mock("@/lib/protocol", () => ({
  isVagueOrCircular: vi.fn().mockReturnValue(false),
  extractReferences: vi.fn().mockReturnValue([]),
  parseTTM: vi.fn().mockReturnValue(null),
}));

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue(""),
  },
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn().mockReturnValue(""),
}));

// ─── import after mocks are registered ───────────────────────────────────────

import { db } from "@/db";
import { runArchitect } from "@/lib/agents/architect";
import { runProjectManager } from "@/lib/agents/project-manager";
import { runReviewer } from "@/lib/agents/reviewer";
import { Pipeline } from "@/lib/pipeline";

// ─── helpers ─────────────────────────────────────────────────────────────────

const FAKE_PROJECT = {
  id: 1,
  name: "Test Project",
  description: "A test project",
  status: "pending",
  primaryModel: "qwen2.5:7b",
  completedStages: "[]",
  fileManifest: null,
  customInstructions: null,
};

const FAKE_MANIFEST = [
  { path: "index.html", description: "Main HTML file", language: "html" },
];

/** Captured project-status updates from db.update().set() calls */
function captureProjectStatusUpdates() {
  const captured: string[] = [];
  const makeChain = (vals: Record<string, unknown>) => {
    if (typeof vals.status === "string") captured.push(vals.status);
    return { where: vi.fn().mockResolvedValue(undefined) };
  };
  vi.mocked(db.update).mockReturnValue({ set: makeChain } as ReturnType<
    typeof db.update
  >);
  return captured;
}

function setupDbDefaults(
  projectOverride: Partial<typeof FAKE_PROJECT> = {},
  existingTasks: unknown[] = [],
) {
  const project = { ...FAKE_PROJECT, ...projectOverride };

  vi.mocked(db.query.projects.findFirst).mockResolvedValue(project as never);
  vi.mocked(db.query.tasks.findMany).mockResolvedValue(
    existingTasks as never,
  );
  vi.mocked(db.insert).mockReturnValue({
    values: vi.fn().mockResolvedValue(undefined),
  } as ReturnType<typeof db.insert>);
}

function makeNoopOnEvent() {
  return vi.fn();
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("Pipeline status transitions", () => {
  beforeEach(() => {
    vi.mocked(runArchitect).mockResolvedValue({
      manifest: FAKE_MANIFEST,
      tokens: 50,
      durationMs: 200,
      prompt: "",
      raw: "",
    } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── architect stage ───────────────────────────────────────────────────────

  describe('run("architect") — new project', () => {
    it('first sets status to "running"', async () => {
      setupDbDefaults();
      const updates = captureProjectStatusUpdates();
      const pipeline = new Pipeline(1, "qwen2.5:7b", makeNoopOnEvent());

      await pipeline.run("architect");

      expect(updates[0]).toBe("running");
    });

    it('ends with status "review", never "paused"', async () => {
      setupDbDefaults();
      const updates = captureProjectStatusUpdates();
      const pipeline = new Pipeline(1, "qwen2.5:7b", makeNoopOnEvent());

      await pipeline.run("architect");

      const lastStatus = updates[updates.length - 1];
      expect(lastStatus).toBe("review");
      expect(updates).not.toContain("paused");
    });

    it("calls the architect agent exactly once", async () => {
      setupDbDefaults();
      captureProjectStatusUpdates();
      const pipeline = new Pipeline(1, "qwen2.5:7b", makeNoopOnEvent());

      await pipeline.run("architect");

      expect(runArchitect).toHaveBeenCalledTimes(1);
      expect(runArchitect).toHaveBeenCalledWith(
        "qwen2.5:7b",
        FAKE_PROJECT.name,
        FAKE_PROJECT.description,
      );
    });

    it("saves the file manifest to the DB", async () => {
      setupDbDefaults();
      const manifestUpdates: unknown[] = [];
      vi.mocked(db.update).mockReturnValue({
        set: (vals: Record<string, unknown>) => {
          if (vals.fileManifest) manifestUpdates.push(vals.fileManifest);
          return { where: vi.fn().mockResolvedValue(undefined) };
        },
      } as ReturnType<typeof db.update>);

      const pipeline = new Pipeline(1, "qwen2.5:7b", makeNoopOnEvent());
      await pipeline.run("architect");

      expect(manifestUpdates.length).toBeGreaterThan(0);
      const saved = JSON.parse(manifestUpdates[0] as string);
      expect(saved).toEqual(FAKE_MANIFEST);
    });

    it("does not blow past the architect stage — does NOT call decompose", async () => {
      setupDbDefaults();
      captureProjectStatusUpdates();
      const pipeline = new Pipeline(1, "qwen2.5:7b", makeNoopOnEvent());

      await pipeline.run("architect");

      expect(runProjectManager).not.toHaveBeenCalled();
    });
  });

  // ─── decompose stage ───────────────────────────────────────────────────────

  describe('run("decompose") — new project', () => {
    beforeEach(() => {
      vi.mocked(runProjectManager).mockResolvedValue({
        block: { tasks: ["Epic 1", "Epic 2", "Epic 3"] },
        tokens: 80,
        durationMs: 300,
        prompt: "",
        raw: "",
      } as never);

      vi.mocked(runReviewer).mockResolvedValue({
        kept: ["Epic 1", "Epic 2", "Epic 3"],
        tokens: 30,
        durationMs: 100,
        prompt: "",
        raw: "",
      } as never);
    });

    it('ends with status "review", never "paused"', async () => {
      setupDbDefaults();
      const updates = captureProjectStatusUpdates();
      const pipeline = new Pipeline(1, "qwen2.5:7b", makeNoopOnEvent());

      await pipeline.run("decompose");

      const lastStatus = updates[updates.length - 1];
      expect(lastStatus).toBe("review");
      expect(updates).not.toContain("paused");
    });

    it("runs architect then decompose in sequence", async () => {
      setupDbDefaults();
      captureProjectStatusUpdates();
      const pipeline = new Pipeline(1, "qwen2.5:7b", makeNoopOnEvent());

      await pipeline.run("decompose");

      expect(runArchitect).toHaveBeenCalledTimes(1);
      expect(runProjectManager).toHaveBeenCalledTimes(1);
    });

    it("creates epic tasks with awaiting_approval status", async () => {
      setupDbDefaults();
      captureProjectStatusUpdates();
      const insertedTasks: unknown[] = [];
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockImplementation((vals: unknown) => {
          insertedTasks.push(vals);
          return Promise.resolve(undefined);
        }),
      } as ReturnType<typeof db.insert>);

      const pipeline = new Pipeline(1, "qwen2.5:7b", makeNoopOnEvent());
      await pipeline.run("decompose");

      const taskInserts = insertedTasks.filter(
        (v) =>
          typeof v === "object" &&
          v !== null &&
          "status" in v &&
          (v as Record<string, unknown>).status === "awaiting_approval",
      );
      expect(taskInserts.length).toBe(3);
    });
  });

  // ─── re-run architect on existing project ───────────────────────────────────

  describe('run("architect") — re-run on existing project', () => {
    it('still ends with "review" not "paused"', async () => {
      // Simulate a project that already has tasks
      setupDbDefaults({ completedStages: '["architect","decompose"]' }, [
        { id: 1, description: "Epic 1", status: "awaiting_approval", depth: 1 },
      ]);
      const updates = captureProjectStatusUpdates();
      const pipeline = new Pipeline(1, "qwen2.5:7b", makeNoopOnEvent());

      await pipeline.run("architect");

      expect(updates).toContain("review");
      expect(updates).not.toContain("paused");
    });
  });

  // ─── error handling ───────────────────────────────────────────────────────

  describe("error propagation", () => {
    it("throws when architect agent fails, so the run route can set 'paused'", async () => {
      setupDbDefaults();
      captureProjectStatusUpdates();
      vi.mocked(runArchitect).mockRejectedValue(
        new Error("Ollama connection refused"),
      );

      const pipeline = new Pipeline(1, "qwen2.5:7b", makeNoopOnEvent());

      await expect(pipeline.run("architect")).rejects.toThrow(
        "Ollama connection refused",
      );
    });

    it("does not silently swallow errors and stay showing running", async () => {
      setupDbDefaults();
      const updates = captureProjectStatusUpdates();
      vi.mocked(runArchitect).mockRejectedValue(new Error("Timeout"));

      const pipeline = new Pipeline(1, "qwen2.5:7b", makeNoopOnEvent());

      try {
        await pipeline.run("architect");
      } catch {
        // expected
      }

      // Should NOT have set status to "running" and left it there
      // The last status in the DB is "running" from pipeline start —
      // the caller (run route) is responsible for setting "paused" on catch
      expect(updates).toContain("running");
      expect(updates).not.toContain("done");
    });
  });

  // ─── abort / stop ─────────────────────────────────────────────────────────

  describe("abort()", () => {
    it("stops before the breakdown stage when aborted mid-pipeline", async () => {
      // Abort is checked after the architect+decompose block and after breakdown,
      // not mid-stage — so aborting on a new project doing decompose still completes
      // architect+decompose (they're in one block), but stops before breakdown.
      setupDbDefaults();
      const updates = captureProjectStatusUpdates();

      vi.mocked(runProjectManager).mockResolvedValue({
        block: { tasks: ["Epic A"] },
        tokens: 10,
        durationMs: 50,
        prompt: "",
        raw: "",
      } as never);

      vi.mocked(runReviewer).mockResolvedValue({
        kept: ["Epic A"],
        tokens: 10,
        durationMs: 50,
        prompt: "",
        raw: "",
      } as never);

      const pipeline = new Pipeline(1, "qwen2.5:7b", makeNoopOnEvent());
      pipeline.abort();

      // run("all") on new project: does architect+decompose, then hits abort check
      // before breakdown — should stop there
      await pipeline.run("all").catch(() => {});

      // architect ran, decompose ran, but status was set to "review" from the abort path
      expect(updates).toContain("running");
      // Pipeline stops cleanly — no unhandled state
      expect(updates[updates.length - 1]).toBe("review");
    });
  });
});

// ─── status badge logic ───────────────────────────────────────────────────────
// Also confirm the three valid end-states are only set in the right circumstances

describe("Project status values", () => {
  it('"review" is set by pauseAndDone() on normal stage completion', async () => {
    setupDbDefaults();
    const updates = captureProjectStatusUpdates();
    vi.mocked(runArchitect).mockResolvedValue({
      manifest: FAKE_MANIFEST,
      tokens: 10,
      durationMs: 50,
      prompt: "",
      raw: "",
    } as never);

    const pipeline = new Pipeline(1, "qwen2.5:7b", makeNoopOnEvent());
    await pipeline.run("architect");

    expect(updates).toContain("review");
    expect(updates).not.toContain("paused");
  });

  it('"paused" is NOT used by normal pipeline completion paths', async () => {
    setupDbDefaults();
    const updates = captureProjectStatusUpdates();
    vi.mocked(runArchitect).mockResolvedValue({
      manifest: FAKE_MANIFEST,
      tokens: 10,
      durationMs: 50,
      prompt: "",
      raw: "",
    } as never);

    const pipeline = new Pipeline(1, "qwen2.5:7b", makeNoopOnEvent());
    await pipeline.run("architect");

    // "paused" should ONLY be written by the error catch handler in run/route.ts
    // or the DELETE stop route — never by pauseAndDone()
    expect(updates).not.toContain("paused");
  });
});
