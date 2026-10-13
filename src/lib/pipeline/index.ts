/**
 * Pipeline Orchestrator — Universal Task Execution
 *
 * Phases:
 *   1. DECOMPOSE — PM breaks idea into 3-5 epics
 *   1b. ARCHITECT — Determines output files and their types
 *   2. PLAN — Manager breaks each epic into 2-3 features
 *   3. MERGE — Programmatic: group features, deduplicate, cap at 8
 *   3b. TDD: GENERATE TESTS — Test-writer creates tests (code files only)
 *   4. EXECUTE — Sequential: one requirement at a time per file
 *   5. TDD: TEST QA — Run vitest, fix failing tests (code files only)
 *   6. REVIEW — Programmatic structural checks
 *   7. ITERATIVE QA — Find one bug → fix → repeat (ONLY if tests failed)
 *   8. IMPROVE — Improver reviews output (ONLY if tests failed)
 *   9. CONSISTENCY — Programmatic validation
 *
 * Output can be ANY file type: code (.tsx, .py, .html, .ts, .js),
 * documents (.md), config (.json, .yaml), or data files.
 * File manifest is determined by the Architect agent.
 *
 * Designed for small local LLMs — prompts are truncated, context is
 * minimized, and redundant LLM calls are skipped when tests pass.
 *
 * This file holds the Pipeline class: run state, stage sequencing
 * (_runInner) and small helpers (logging, events, task status, file IO).
 * Each phase is a module of functions taking the Pipeline as `p`, which is
 * why the class members are not `private`:
 *   planning.ts       architect, contract designer, decompose, breakdown
 *   execute.ts        feature specs → code, in dependency waves
 *   spec-qa.ts        per-spec QA and failure recovery tactics
 *   tdd.ts            test generation, test runs, test repair
 *   qa.ts             judge, full QA sequence, holistic/improve/integration
 *   review-passes.ts  iterative QA and progress review
 *   visual.ts         render-error gate and visual QA
 *   feedback.ts       applying a user's change request
 *   types.ts          shared limits and types
 */

import { db } from "@/db";
import {
  projects,
  tasks,
  references,
  logs,
  Task,
  ManifestFile,
} from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { assignFileForTask } from "@/lib/file-assignment";
import { extractReferences } from "@/lib/protocol";
import { streamingStorage, setStreamText, clearStreamText } from "@/lib/stream-state";
import fs from "fs";
import path from "path";
import { PipelineStage, EventCallback } from "./types";
import { estimateTokens } from "./text-utils";
import {
  createScaffold,
  decompose,
  loadOrCreateManifest,
  planAll,
  runArchitectPhase,
  runContractDesignerPhase,
} from "./planning";
import { prepareFileSpecs, runExecutePhase } from "./execute";
import { runTDDPhase } from "./tdd";
import { runFullQA, runJudgePhase } from "./qa";
import { runFeedbackPass } from "./feedback";

export type { PipelineStage, PipelineEvent } from "./types";

export class Pipeline {
  projectId: number;
  model: string;
  onEvent: EventCallback;
  taskCount: number = 0;
  aborted: boolean = false;
  stage: PipelineStage = "all";
  breakdownDepth: number | null = null;
  projectName: string = "";
  projectDescription: string = "";
  customInstructions: string = "";
  threadProfile: "low" | "med" | "high" = "med";
  deterministicDraftByFile: Record<string, string> = {};
  /** Round-robin cursor for resolveFilePath ties — prevents all features
   * landing on manifest[0] when keyword overlap is ambiguous. */
  assignmentCursor: number = 0;
  /** Dynamic file manifest — set by Architect agent or inferred from description */
  manifest: ManifestFile[] = [];
  /** Shared TypeScript type definitions produced by ContractDesigner (may be empty) */
  contractSnippet: string = "";
  /** Last test failure message from runTestQA, passed to iterativeQA for focused fixing */
  lastTestFailure: string | undefined = undefined;
  /**
   * Track the last error seen per test name during repair.
   * If repairSingleTest is called with the same error twice in a row, the patch
   * approach is stuck — escalate to rewrite or regenerate mode.
   * Cleared at the start of each runTestQA call.
   */
  lastRepairError = new Map<string, string>();
  /**
   * Track how many times the regenerate (runTestWriter from scratch) path has
   * been attempted per test name. Cap at 1 to avoid infinite loops.
   */
  regenerateCount = new Map<string, number>();
  /**
   * Requirements and manifest description stored during generateTests() so
   * repairSingleTest() can regenerate a test file from scratch if stuck.
   */
  lastGenerateRequirements: string[] = [];
  lastGenerateManifestDescription: string | undefined = undefined;
  /** Per-file summaries produced after each file completes during Execute.
   * Injected into subsequent files' first Developer step as cross-file context. */
  fileContextSummaries: Record<string, string> = {};
  /**
   * Set by runJudgePhase() after Execute. Controls whether runFullQA skips
   * the expensive vitest pass (when output is clearly insufficient).
   * Defaults to "proceed" so feedback/qa-only runs always get full QA.
   */
  judgeVerdict: "proceed" | "warn" | "skip_vitest" = "proceed";
  /**
   * Set by post-build gates (render gate, undef check, judge SKIP_VITEST)
   * when the produced artifact is known-broken in a way that would ship a
   * non-functional preview to the user. When non-empty, the final project
   * status becomes "review" instead of "done" so the user is not silently
   * handed a broken build.
   */
  qaFatalIssues: string[] = [];

  constructor(
    projectId: number,
    model: string,
    onEvent: EventCallback,
    threadProfile: "low" | "med" | "high" = "med",
  ) {
    this.projectId = projectId;
    this.model = model;
    this.onEvent = onEvent;
    this.threadProfile = threadProfile;
  }

  abort() {
    this.aborted = true;
    clearStreamText(this.projectId);
  }

  /** Mark a user-facing stage as complete in the project record */
  async markStageComplete(stage: string) {
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, this.projectId),
    });
    const stages: string[] = JSON.parse(project?.completedStages || "[]");
    if (!stages.includes(stage)) {
      stages.push(stage);
    }
    // Always clear currentStage when a stage completes so the UI shows
    // the fallback (first non-done stage) between stage transitions.
    await db
      .update(projects)
      .set({
        completedStages: JSON.stringify(stages),
        currentStage: null,
        currentActivity: null,
      })
      .where(eq(projects.id, this.projectId));
  }

  /** Appends custom instructions to a message if present */
  withCustomInstructions(message: string): string {
    if (!this.customInstructions) return message;
    return `${message}\n\nADDITIONAL USER INSTRUCTIONS:\n${this.customInstructions}`;
  }

  emit(type: string, data: Record<string, unknown>) {
    this.onEvent({ type, data });
  }

  /** Write the active stage to the DB so the UI can highlight it immediately. */
  async emitStageStart(stage: string) {
    await db
      .update(projects)
      .set({
        currentStage: stage,
        stageStartedAt: Date.now(),
        currentActivity: `Starting ${stage}...`,
        activityCounter: 0,
      })
      .where(eq(projects.id, this.projectId));
    await this.log("STAGE", stage);
  }

  /**
   * Write a short freetext message describing what the pipeline is doing
   * RIGHT NOW. The UI polls this and displays it under the stage bar so the
   * user always knows what the model/system is up to.
   */
  async emitActivity(message: string) {
    // Truncate to keep UI tidy
    const msg = message.length > 200 ? message.slice(0, 197) + "..." : message;
    try {
      await db
        .update(projects)
        .set({
          currentActivity: msg,
          activityCounter: sql`${projects.activityCounter} + 1`,
        })
        .where(eq(projects.id, this.projectId));
    } catch {
      // Activity tracking is best-effort — never block the pipeline
    }
  }

  async log(
    agent: string,
    message: string,
    taskId?: number,
    rawPrompt?: string,
    rawResponse?: string,
  ) {
    this.emit("log", {
      agent,
      message,
      taskId,
      hasRaw: !!(rawPrompt || rawResponse),
    });
    await db.insert(logs).values({
      projectId: this.projectId,
      taskId: taskId || null,
      agent,
      message,
      rawPrompt: rawPrompt || null,
      rawResponse: rawResponse || null,
    });
    // Every log line is a real event — mirror it into the activity bar so the
    // user always sees what's happening. Skip pure STAGE markers (emitStageStart
    // already wrote a "Starting X..." activity).
    if (agent !== "STAGE") {
      await this.emitActivity(`[${agent}] ${message}`);
    }
  }

  outputDir(): string {
    return path.join(process.cwd(), "output", String(this.projectId));
  }

  // ─────────────────────────────────────────────
  //  FILE PATH RESOLUTION
  // ─────────────────────────────────────────────

  /** Helper: get manifest file paths in build order */
  getFileOrder(): string[] {
    return this.manifest.map((f) => f.path);
  }

  /**
   * Map a task's filePath/description to one of the manifest files.
   * Delegates to the pure {@link assignFileForTask} helper and threads the
   * round-robin cursor through Pipeline state. See file-assignment.ts.
   */
  resolveFilePath(
    filePath: string | null,
    description: string,
  ): string {
    const { path, cursor } = assignFileForTask(
      this.manifest,
      filePath,
      description,
      this.assignmentCursor,
    );
    this.assignmentCursor = cursor;
    return path;
  }

  // ─────────────────────────────────────────────
  //  MAIN ENTRY POINT
  // ─────────────────────────────────────────────

  async run(
    stage: PipelineStage = "all",
    breakdownDepth?: number,
    feedback?: string,
  ) {
    const projectId = this.projectId;
    // Wrap the entire pipeline in an AsyncLocalStorage context so callOllama
    // can stream tokens back to the UI without any changes to agent call sites.
    return streamingStorage.run(
      {
        onChunk: (token: string) => {
          setStreamText(projectId, token, "LLM");
        },
        onActivity: (message: string) => {
          // Fire-and-forget — don't await in the hot path
          void this.emitActivity(message);
        },
        threadProfile: this.threadProfile,
      },
      () => this._runInner(stage, breakdownDepth, feedback),
    );
  }

  async _runInner(
    stage: PipelineStage = "all",
    breakdownDepth?: number,
    feedback?: string,
  ) {
    this.stage = stage;
    this.breakdownDepth = breakdownDepth ?? null;
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, this.projectId),
    });

    if (!project) throw new Error(`Project ${this.projectId} not found`);

    this.projectName = project.name;
    this.projectDescription = project.description;
    this.customInstructions = project.customInstructions || "";

    // Load or create the file manifest
    await loadOrCreateManifest(this, project);

    await db
      .update(projects)
      .set({ status: "running" })
      .where(eq(projects.id, this.projectId));

    const existingTasks = await db.query.tasks.findMany({
      where: eq(tasks.projectId, this.projectId),
    });

    // Clear the current stage and all downstream stages from completedStages
    // so the tracker shows them as pending/active again.
    // For "all" with existing tasks, decompose is already done — start from breakdown.
    const STAGE_ORDER = [
      "architect",
      "decompose",
      "breakdown",
      "tdd",
      "execute",
      "qa",
      "feedback",
    ];
    const currentStages: string[] = JSON.parse(project.completedStages || "[]");
    let effectiveStage: string;
    if (stage === "all") {
      effectiveStage = existingTasks.length === 0 ? "architect" : "breakdown";
    } else {
      effectiveStage = stage;
    }
    const idx = STAGE_ORDER.indexOf(effectiveStage);
    if (idx >= 0) {
      const toRemove = new Set(STAGE_ORDER.slice(idx));
      const kept = currentStages.filter((s) => !toRemove.has(s));
      await db
        .update(projects)
        .set({ completedStages: JSON.stringify(kept) })
        .where(eq(projects.id, this.projectId));
    }

    if (
      existingTasks.length === 0 &&
      (stage === "all" || stage === "architect" || stage === "decompose")
    ) {
      // Run Architect to determine file manifest (if not already set)
      await this.emitStageStart("architect");
      if (this.manifest.length === 0) {
        await runArchitectPhase(this);
      }
      await createScaffold(this);
      await runContractDesignerPhase(this);
      await this.markStageComplete("architect");

      if (stage === "architect") {
        await this.log(
          "SYS",
          "Architect complete. Review file structure, then run Decompose.",
        );
        await this.pauseAndDone();
        return;
      }

      // Continue to decompose
      await this.emitStageStart("decompose");
      await this.log("PM", "Breaking down idea into epics...");
      await decompose(this, project.name, project.description);
      await this.markStageComplete("decompose");

      if (stage === "decompose") {
        await this.log(
          "SYS",
          "Decomposition complete. Review epics, then run Breakdown.",
        );
        await this.pauseAndDone();
        return;
      }
    } else if (stage === "architect") {
      // Re-run architect on existing project
      await this.emitStageStart("architect");
      await runArchitectPhase(this);
      await createScaffold(this);
      await runContractDesignerPhase(this);
      await this.markStageComplete("architect");
      await this.log("SYS", "Architect complete. File structure updated.");
      await this.pauseAndDone();
      return;
    } else if (stage === "decompose") {
      if (existingTasks.length > 0) {
        await this.log(
          "SYS",
          "Project already decomposed. Use Breakdown or Execute.",
        );
        await this.pauseAndDone();
        return;
      }
    }

    if (this.aborted) {
      await this.pauseAndDone();
      return;
    }

    // Feedback pass: user-driven iterative improvement
    if (stage === "feedback") {
      if (!feedback || !feedback.trim()) {
        await this.log("SYS", "No feedback provided.");
        await this.pauseAndDone();
        return;
      }
      await this.emitStageStart("feedback");
      await this.log("SYS", "Running feedback pass...");
      await runFeedbackPass(this, feedback);
      try {
        await this.emitStageStart("qa");
        await this.log("SYS", "Running QA after feedback...");
        await runFullQA(this);
        await this.markStageComplete("qa");
      } catch {
        await this.log("SYS", "QA check after feedback failed — continuing");
      }
      await this.markStageComplete("feedback");
      const fatalCount = this.qaFatalIssues.length;
      const finalStatus: "done" | "review" = fatalCount > 0 ? "review" : "done";
      const fatalActivity =
        fatalCount > 0
          ? `Pipeline finished with ${fatalCount} unresolved issue${
              fatalCount === 1 ? "" : "s"
            }: ${this.qaFatalIssues[0].slice(0, 160)}`
          : null;
      if (fatalCount > 0) {
        await this.log(
          "SYS",
          `Feedback pipeline finished with ${fatalCount} fatal issue(s) — marking project for review`,
        );
      }
      await db
        .update(projects)
        .set({
          status: finalStatus,
          currentStage: null,
          currentActivity: fatalActivity,
        })
        .where(eq(projects.id, this.projectId));
      this.emit("pipeline_done", {
        projectId: this.projectId,
        fatalIssues: this.qaFatalIssues.slice(0, 10),
      });
      return;
    }

    // QA-only pass
    if (stage === "qa") {
      await this.emitStageStart("qa");
      await this.log("SYS", "Running QA pass...");
      await runFullQA(this);
      await this.markStageComplete("qa");
      const fatalCount = this.qaFatalIssues.length;
      const finalStatus: "done" | "review" = fatalCount > 0 ? "review" : "done";
      const fatalActivity =
        fatalCount > 0
          ? `Pipeline finished with ${fatalCount} unresolved issue${
              fatalCount === 1 ? "" : "s"
            }: ${this.qaFatalIssues[0].slice(0, 160)}`
          : null;
      if (fatalCount > 0) {
        await this.log(
          "SYS",
          `QA-only pipeline finished with ${fatalCount} fatal issue(s) — marking project for review`,
        );
      }
      await db
        .update(projects)
        .set({
          status: finalStatus,
          currentStage: null,
          currentActivity: fatalActivity,
        })
        .where(eq(projects.id, this.projectId));
      this.emit("pipeline_done", {
        projectId: this.projectId,
        fatalIssues: this.qaFatalIssues.slice(0, 10),
      });
      return;
    }

    // ── Breakdown ──
    if (
      stage === "all" ||
      stage === "breakdown" ||
      stage === "tdd" ||
      stage === "execute"
    ) {
      // Only run breakdown if not already done
      const alreadyBroken = JSON.parse(
        (
          await db.query.projects.findFirst({
            where: eq(projects.id, this.projectId),
          })
        )?.completedStages || "[]",
      ).includes("breakdown");

      if (!alreadyBroken && (stage === "all" || stage === "breakdown")) {
        await this.emitStageStart("breakdown");
        await db
          .update(tasks)
          .set({ status: "pending" })
          .where(
            and(
              eq(tasks.projectId, this.projectId),
              eq(tasks.status, "awaiting_approval"),
            ),
          );
        await planAll(this);
        await this.markStageComplete("breakdown");

        if (stage === "breakdown") {
          await this.log(
            "SYS",
            "Breakdown complete. Review features, then run TDD or Execute.",
          );
          await this.pauseAndDone();
          return;
        }
      } else if (stage === "breakdown") {
        // Explicit breakdown request on already-broken project: re-run
        await this.emitStageStart("breakdown");
        await db
          .update(tasks)
          .set({ status: "pending" })
          .where(
            and(
              eq(tasks.projectId, this.projectId),
              eq(tasks.status, "awaiting_approval"),
            ),
          );
        await planAll(this);
        await this.markStageComplete("breakdown");
        await this.log(
          "SYS",
          "Breakdown complete. Review features, then run TDD or Execute.",
        );
        await this.pauseAndDone();
        return;
      }
    }

    if (this.aborted) {
      await this.pauseAndDone();
      return;
    }

    // ── TDD + Execute ──
    // TDD runs first: tests are written from the requirements and the shared
    // contract types, and fail against the scaffold. Execute then writes code
    // to make them pass; the Developer is shown the tests so it uses the same
    // prop names.
    if (stage === "all" || stage === "tdd" || stage === "execute") {
      const fileSpecs = await prepareFileSpecs(this);

      // ── TDD: generate test files ──
      if (stage === "all" || stage === "tdd") {
        await this.emitStageStart("tdd");
        await this.log("TDD", "Generating test files...");
        try {
          await runTDDPhase(this, fileSpecs);
        } catch (err) {
          await this.log(
            "TDD",
            `Test generation phase failed: ${
              err instanceof Error ? err.message : String(err)
            } — continuing`,
          );
        }
        await this.markStageComplete("tdd");

        if (stage === "tdd") {
          await this.log(
            "SYS",
            "TDD complete. Tests generated. Run Execute to write the implementation.",
          );
          await this.pauseAndDone();
          return;
        }
      }

      if (this.aborted) {
        await this.pauseAndDone();
        return;
      }

      // ── Execute: write code to pass the tests ──
      if (stage === "all" || stage === "execute") {
        await this.emitStageStart("execute");
        await this.log("SYS", "Executing — writing code for each file...");
        await runExecutePhase(this, fileSpecs);
        await this.markStageComplete("execute");
        await runJudgePhase(this);

        if (stage === "execute") {
          await this.log("SYS", "Execute complete. Review code, then run QA.");
          await this.pauseAndDone();
          return;
        }
      }
    }

    if (this.aborted) {
      await this.pauseAndDone();
      return;
    }

    // ── QA (after "all" flow) ──
    if (stage === "all") {
      await this.emitStageStart("qa");
      await runFullQA(this);
      await this.markStageComplete("qa");
    }

    const allTasks = await db.query.tasks.findMany({
      where: eq(tasks.projectId, this.projectId),
    });
    const done = allTasks.filter((t) => t.status === "done").length;
    const stuck = allTasks.filter((t) => t.status === "stuck").length;

    const fatalCount = this.qaFatalIssues.length;
    const finalStatus: "done" | "paused" | "review" =
      fatalCount > 0 ? "review" : stuck > 0 ? "paused" : "done";
    const fatalActivity =
      fatalCount > 0
        ? `Pipeline finished with ${fatalCount} unresolved issue${
            fatalCount === 1 ? "" : "s"
          }: ${this.qaFatalIssues[0].slice(0, 160)}`
        : null;

    if (fatalCount > 0) {
      await this.log(
        "SYS",
        `Pipeline finished but ${fatalCount} fatal issue(s) remain — marking project for review:`,
      );
      for (const reason of this.qaFatalIssues.slice(0, 5)) {
        await this.log("SYS", `  • ${reason}`);
      }
    }

    await db
      .update(projects)
      .set({
        status: finalStatus,
        currentStage: null,
        currentActivity: fatalActivity,
      })
      .where(eq(projects.id, this.projectId));

    clearStreamText(this.projectId);
    this.emit("pipeline_done", {
      projectId: this.projectId,
      totalTasks: allTasks.length,
      done,
      stuck,
      fatalIssues: this.qaFatalIssues.slice(0, 10),
    });
  }

  /** Helper: pause the project and emit done */
  async pauseAndDone() {
    await db
      .update(projects)
      .set({ status: "review", currentStage: null, currentActivity: null })
      .where(eq(projects.id, this.projectId));
    clearStreamText(this.projectId);
    this.emit("pipeline_done", { projectId: this.projectId });
  }

  getCurrentFileContent(filePath: string): string | null {
    const fullPath = path.join(this.outputDir(), filePath);
    if (!fs.existsSync(fullPath)) return null;
    return fs.readFileSync(fullPath, "utf-8");
  }

  warnIfPromptTooLarge(label: string, prompt: string) {
    const est = estimateTokens(prompt);
    // Warn if prompt alone eats >60% of our 32K context window
    // leaving little room for the model's output
    if (est > 19000) {
      // Log synchronously (fire and forget)
      this.log(
        "WARN",
        `${label} prompt is ~${est} tokens (${prompt.length} chars) — may exceed context window. Consider reducing input.`,
      ).catch(() => {});
    }
  }

  /** Map an LLM-returned filename to the closest manifest file */
  resolveTargetFile(name: string): string | null {
    const n = name.toLowerCase().trim();

    // Exact match against manifest
    for (const f of this.manifest) {
      if (n === f.path.toLowerCase()) return f.path;
    }

    // Partial match (LLM might say "component" or "main" instead of full path)
    for (const f of this.manifest) {
      const fp = f.path.toLowerCase();
      if (fp.includes(n) || n.includes(fp.replace(/\.\w+$/, ""))) return f.path;
    }

    // Keyword matching fallback
    for (const f of this.manifest) {
      const fp = f.path.toLowerCase();
      if (
        (n.includes("component") && fp.includes("component")) ||
        (n.includes("main") && fp.includes("main")) ||
        (n.includes("index") && fp.includes("index")) ||
        (n.includes("style") &&
          (fp.endsWith(".css") || fp.includes("style"))) ||
        (n.includes("test") && fp.includes("test"))
      ) {
        return f.path;
      }
    }

    // Default to primary manifest file
    return this.manifest[0]?.path || null;
  }

  // ─────────────────────────────────────────────
  //  HELPERS
  // ─────────────────────────────────────────────

  async completeTask(task: Task) {
    // Skip if already done (tasks are completed per-step in sequential execution)
    const current = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });
    if (current && current.status === "done") return;

    await this.setStatus(task.id, "done");
    this.emit("task_completed", {
      taskId: task.id,
      status: "DONE",
      duration: 0,
    });

    if (task.output && task.filePath) {
      const refs = extractReferences(task.output, task.filePath);
      for (const ref of refs) {
        await db.insert(references).values({
          projectId: this.projectId,
          filePath: ref.filePath,
          refType: ref.refType as
            | "id"
            | "class"
            | "function"
            | "variable"
            | "endpoint",
          refName: ref.refName,
        });
      }
    }
  }

  async markStuck(taskId: number, reason: string) {
    await db
      .update(tasks)
      .set({ status: "stuck", stuckReason: reason })
      .where(eq(tasks.id, taskId));
    this.emit("task_stuck", { taskId, reason });
    await this.log("SYS", `STUCK: ${reason}`, taskId);
  }

  async setStatus(taskId: number, status: Task["status"]) {
    await db.update(tasks).set({ status }).where(eq(tasks.id, taskId));
  }

  async getTotalTaskCount(): Promise<number> {
    const allTasks = await db.query.tasks.findMany({
      where: eq(tasks.projectId, this.projectId),
    });
    return allTasks.length;
  }

  async writeOutputFile(filePath: string, content: string) {
    const fullPath = path.join(this.outputDir(), filePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content, "utf-8");
  }
}
