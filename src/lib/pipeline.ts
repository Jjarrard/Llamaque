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
import { eq, and, asc, sql } from "drizzle-orm";
import { runProjectManager } from "@/lib/agents/project-manager";
import { runReviewer } from "@/lib/agents/reviewer";
import { runManager } from "@/lib/agents/manager";
import {
  runDeveloper,
  runDeveloperPatch,
  getFileTypeRules,
  supportsTDD,
} from "@/lib/agents/developer";
import { parsePatch, applyPatch } from "@/lib/patch";
import { runArchitect, inferDefaultManifest } from "@/lib/agents/architect";
import { assignFileForTask } from "@/lib/file-assignment";
import {
  runCleaner,
  runMinimalRetry,
  runScaffoldTactic,
  runReframeTactic,
} from "@/lib/agents/cleaner";
import { runIterativeQA } from "@/lib/agents/iterative-qa";
import { runProgressReviewer } from "@/lib/agents/progress-reviewer";
import { runVisualQA } from "@/lib/agents/visual-qa";
import { modelCapabilities } from "@/lib/model-capabilities";
import {
  runEditor,
  runFeedbackEditor,
  applyEdit,
  extractFileWindow,
  numberLines,
  stripLineNumberPrefixes,
} from "@/lib/agents/editor";
import { runTestWriter } from "@/lib/agents/test-writer";
import {
  analyzeComponent,
  extractRolesTree,
} from "@/lib/ops/component-analyzer";
import { runSummariser } from "@/lib/agents/summariser";
import { runPlanner } from "@/lib/agents/planner";
import { runFeedbackPlanner } from "@/lib/agents/feedback-planner";
import { runContractDesigner } from "@/lib/agents/contract-designer";
import {
  checkTypeScriptSyntax,
  checkTypeScriptSemantics,
} from "@/lib/ops/compiler";
import { validateOutput, autoRepairOutput } from "@/lib/validate";
import { locateWindows, hashString, LocateCandidate } from "@/lib/locator";
import {
  derivePostconditions,
  checkPostconditions,
  formatFailureMessage,
} from "@/lib/postconditions";
import {
  appendLedgerItem,
  updateLedgerItem,
  initLedger,
  finalizeLedger,
} from "@/lib/ledger";
import { runTests, getFirstFailure, TestRunResult } from "@/lib/test-runner";
import { callOllama as callOllamaFn } from "@/lib/ollama";
import { isVagueOrCircular, extractReferences, parseTTM } from "@/lib/protocol";
import { buildWaves, parseImportDeps } from "@/lib/deps";
import { getTasksForStep, getUncoveredTasks } from "@/lib/execute-utils";
import {
  streamingStorage,
  setStreamText,
  clearStreamText,
} from "@/lib/stream-state";
import fs from "fs";
import path from "path";

/** Planning stops at depth 2 (Epic → Feature). Features ARE the execution leaves. */
const MAX_DEPTH = 2;
const MAX_TASKS = 200;
const MAX_RETRIES = 2;
const MAX_PARSE_RETRIES = 2;
/** Max bullet points per file spec — keeps Developer prompt short */
const MAX_REQUIREMENTS = 4;
/** Max features the Manager can produce per epic */
const MAX_SUBTASKS = 2;
/** Max epics from PM */
const MAX_EPICS = 4;

export type PipelineStage =
  | "all"
  | "architect"
  | "decompose"
  | "breakdown"
  | "tdd"
  | "execute"
  | "qa"
  | "feedback";

export type PipelineEvent = {
  type: string;
  data: Record<string, unknown>;
};

type EventCallback = (event: PipelineEvent) => void;

export class Pipeline {
  private projectId: number;
  private model: string;
  private onEvent: EventCallback;
  private taskCount: number = 0;
  private aborted: boolean = false;
  private stage: PipelineStage = "all";
  private breakdownDepth: number | null = null;
  private projectName: string = "";
  private projectDescription: string = "";
  private customInstructions: string = "";
  private threadProfile: "low" | "med" | "high" = "med";
  private deterministicDraftByFile: Record<string, string> = {};
  /** Round-robin cursor for resolveFilePath ties — prevents all features
   * landing on manifest[0] when keyword overlap is ambiguous. */
  private assignmentCursor: number = 0;
  /** Dynamic file manifest — set by Architect agent or inferred from description */
  private manifest: ManifestFile[] = [];
  /** Shared TypeScript type definitions produced by ContractDesigner (may be empty) */
  private contractSnippet: string = "";
  /** Last test failure message from runTestQA, passed to iterativeQA for focused fixing */
  private lastTestFailure: string | undefined = undefined;
  /**
   * Track the last error seen per test name during repair.
   * If repairSingleTest is called with the same error twice in a row, the patch
   * approach is stuck — escalate to rewrite or regenerate mode.
   * Cleared at the start of each runTestQA call.
   */
  private lastRepairError = new Map<string, string>();
  /**
   * Track how many times the regenerate (runTestWriter from scratch) path has
   * been attempted per test name. Cap at 1 to avoid infinite loops.
   */
  private regenerateCount = new Map<string, number>();
  /**
   * Requirements and manifest description stored during generateTests() so
   * repairSingleTest() can regenerate a test file from scratch if stuck.
   */
  private lastGenerateRequirements: string[] = [];
  private lastGenerateManifestDescription: string | undefined = undefined;
  /** Per-file summaries produced after each file completes during Execute.
   * Injected into subsequent files' first Developer step as cross-file context. */
  private fileContextSummaries: Record<string, string> = {};
  /**
   * Set by runJudgePhase() after Execute. Controls whether runFullQA skips
   * the expensive vitest pass (when output is clearly insufficient).
   * Defaults to "proceed" so feedback/qa-only runs always get full QA.
   */
  private judgeVerdict: "proceed" | "warn" | "skip_vitest" = "proceed";

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
  private async markStageComplete(stage: string) {
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
  private withCustomInstructions(message: string): string {
    if (!this.customInstructions) return message;
    return `${message}\n\nADDITIONAL USER INSTRUCTIONS:\n${this.customInstructions}`;
  }

  private emit(type: string, data: Record<string, unknown>) {
    this.onEvent({ type, data });
  }

  /** Write the active stage to the DB so the UI can highlight it immediately. */
  private async emitStageStart(stage: string) {
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
  private async emitActivity(message: string) {
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

  private async log(
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

  private outputDir(): string {
    return path.join(process.cwd(), "output", String(this.projectId));
  }

  // ─────────────────────────────────────────────
  //  SCAFFOLD
  // ─────────────────────────────────────────────

  private async createScaffold() {
    const outDir = this.outputDir();
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    for (const file of this.manifest) {
      const fullPath = path.join(outDir, file.path);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const scaffold = this.generateScaffold(file);
      fs.writeFileSync(fullPath, scaffold, "utf-8");
    }

    const fileList = this.manifest.map((f) => f.path).join(", ");
    await this.log("SYS", `Created scaffold: ${fileList}`);
  }

  /** Generate a minimal scaffold for a file based on its type/language */
  private generateScaffold(file: ManifestFile): string {
    const ext = file.path.split(".").pop()?.toLowerCase() || "";

    switch (ext) {
      case "tsx":
      case "jsx": {
        const compName = file.path.replace(/\.\w+$/, "") || "Component";
        return `import React from "react";

export default function ${compName}() {
  return (
    <div style={{ fontFamily: "sans-serif", padding: "2rem" }}>
      <h1>${this.projectName}</h1>
    </div>
  );
}
`;
      }
      case "ts":
        return `// ${file.description}\n`;
      case "js":
        return `// ${file.description}\n`;
      case "py":
        return `# ${file.description}\n`;
      case "html":
      case "htm":
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${this.projectName}</title>
</head>
<body>
  <h1>${this.projectName}</h1>
</body>
</html>
`;
      case "css":
        return `/* ${file.description} */\n`;
      case "md":
      case "markdown":
        return `# ${this.projectName}\n\n${file.description}\n`;
      case "json":
        return `{}\n`;
      case "yaml":
      case "yml":
        return `# ${file.description}\n`;
      default:
        return ``;
    }
  }

  // ─────────────────────────────────────────────
  //  FILE PATH RESOLUTION
  // ─────────────────────────────────────────────

  /** Helper: get manifest file paths in build order */
  private getFileOrder(): string[] {
    return this.manifest.map((f) => f.path);
  }

  /** Load manifest from project record or infer a default */
  private async loadOrCreateManifest(project: {
    fileManifest: string | null;
    description: string;
  }) {
    if (project.fileManifest) {
      try {
        this.manifest = JSON.parse(project.fileManifest) as ManifestFile[];
        if (this.manifest.length > 0) return;
      } catch {
        // Invalid JSON — fall through to inference
      }
    }
    // No manifest yet — will be set by runArchitectPhase or inferred
    this.manifest = [];
  }

  /** Run the Architect agent to determine the output file manifest */
  private async runArchitectPhase() {
    await this.log("ARCH", "Determining output file structure...");

    const result = await runArchitect(
      this.model,
      this.projectName,
      this.projectDescription,
    );

    if (result.manifest.length > 0) {
      this.manifest = result.manifest;
      await this.log(
        "ARCH",
        `Determined ${result.manifest.length} output file(s): ${result.manifest.map((f) => f.path).join(", ")} (${result.tokens} tokens, ${result.durationMs}ms)`,
        undefined,
        result.prompt,
        result.raw,
      );
    } else {
      // Architect failed — use heuristic fallback
      this.manifest = inferDefaultManifest(this.projectDescription);
      await this.log(
        "ARCH",
        `Architect parse failed — inferred: ${this.manifest.map((f) => f.path).join(", ")}`,
        undefined,
        result.prompt,
        result.raw,
      );
    }

    // Persist to DB
    await db
      .update(projects)
      .set({ fileManifest: JSON.stringify(this.manifest) })
      .where(eq(projects.id, this.projectId));
  }

  /**
   * ContractDesigner phase — runs once after Architect.
   * For multi-file TS projects, produces a compact shared-types snippet
   * that gets injected into every subsequent Developer prompt.
   * Silent no-op on failure or single-file/non-TS projects.
   */
  private async runContractDesignerPhase() {
    const snippet = await runContractDesigner(
      this.model,
      this.projectName,
      this.projectDescription,
      this.manifest,
    );
    if (snippet) {
      this.contractSnippet = snippet;
      await this.log("ARCH", `Shared types defined:\n${snippet}`);
    }
  }

  /**
   * Map a task's filePath/description to one of the manifest files.
   * Delegates to the pure {@link assignFileForTask} helper and threads the
   * round-robin cursor through Pipeline state. See file-assignment.ts.
   */
  private resolveFilePath(
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

  private async _runInner(
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
    await this.loadOrCreateManifest(project);

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
      "execute",
      "tdd",
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
        await this.runArchitectPhase();
      }
      await this.createScaffold();
      await this.runContractDesignerPhase();
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
      await this.decompose(project.name, project.description);
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
      await this.runArchitectPhase();
      await this.createScaffold();
      await this.runContractDesignerPhase();
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
      await this.runFeedbackPass(feedback);
      try {
        await this.emitStageStart("qa");
        await this.log("SYS", "Running QA after feedback...");
        await this.runFullQA();
        await this.markStageComplete("qa");
      } catch {
        await this.log("SYS", "QA check after feedback failed — continuing");
      }
      await this.markStageComplete("feedback");
      await db
        .update(projects)
        .set({ status: "done", currentStage: null, currentActivity: null })
        .where(eq(projects.id, this.projectId));
      this.emit("pipeline_done", { projectId: this.projectId });
      return;
    }

    // QA-only pass
    if (stage === "qa") {
      await this.emitStageStart("qa");
      await this.log("SYS", "Running QA pass...");
      await this.runFullQA();
      await this.markStageComplete("qa");
      await db
        .update(projects)
        .set({ status: "done", currentStage: null, currentActivity: null })
        .where(eq(projects.id, this.projectId));
      this.emit("pipeline_done", { projectId: this.projectId });
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
        await this.planAll();
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
        await this.planAll();
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

    // ── Execute + TDD ──
    // Execute runs first (write code from requirements), then TDD generates tests
    // that use the real prop shapes from the written code. This eliminates prop-name
    // mismatches that require costly test-repair rounds in QA.
    if (stage === "all" || stage === "tdd" || stage === "execute") {
      const fileSpecs = await this.prepareFileSpecs();

      // ── Execute: write code ──
      if (stage === "all" || stage === "execute") {
        await this.emitStageStart("execute");
        await this.log("SYS", "Executing — writing code for each file...");
        await this.runExecutePhase(fileSpecs);
        await this.markStageComplete("execute");
        await this.runJudgePhase();

        if (stage === "execute") {
          await this.log(
            "SYS",
            "Execute complete. Review code, then run TDD/QA.",
          );
          await this.pauseAndDone();
          return;
        }
      }

      if (this.aborted) {
        await this.pauseAndDone();
        return;
      }

      // ── TDD: generate test files (after code exists so test writer sees real props) ──
      if (stage === "all" || stage === "tdd") {
        await this.emitStageStart("tdd");
        await this.log("TDD", "Generating test files...");
        try {
          await this.runTDDPhase(fileSpecs);
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
            "TDD complete. Tests generated. Run QA to validate.",
          );
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
      await this.runFullQA();
      await this.markStageComplete("qa");
    }

    const allTasks = await db.query.tasks.findMany({
      where: eq(tasks.projectId, this.projectId),
    });
    const done = allTasks.filter((t) => t.status === "done").length;
    const stuck = allTasks.filter((t) => t.status === "stuck").length;

    await db
      .update(projects)
      .set({
        status: stuck > 0 ? "paused" : "done",
        currentStage: null,
        currentActivity: null,
      })
      .where(eq(projects.id, this.projectId));

    clearStreamText(this.projectId);
    this.emit("pipeline_done", {
      projectId: this.projectId,
      totalTasks: allTasks.length,
      done,
      stuck,
    });
  }

  /** Helper: pause the project and emit done */
  private async pauseAndDone() {
    await db
      .update(projects)
      .set({ status: "review", currentStage: null, currentActivity: null })
      .where(eq(projects.id, this.projectId));
    clearStreamText(this.projectId);
    this.emit("pipeline_done", { projectId: this.projectId });
  }

  // ─────────────────────────────────────────────
  //  PHASE 1: DECOMPOSE (PM + Reviewer → Epics)
  // ─────────────────────────────────────────────

  private async decompose(name: string, description: string) {
    const desc = this.withCustomInstructions(description);
    let result = await runProjectManager(this.model, name, desc);

    if (!result.block) {
      await this.log("PM", "Failed to parse response, retrying...");
      result = await runProjectManager(this.model, name, desc);
    }

    if (!result.block) {
      await this.log("PM", "STUCK: Could not decompose project idea");
      return;
    }

    const userRequest = `${name}: ${description}`;
    const reviewResult = await runReviewer(
      this.model,
      userRequest,
      result.block.tasks,
    );

    const filteredTasks = reviewResult.kept.slice(0, MAX_EPICS);
    const removed = result.block.tasks.length - filteredTasks.length;
    if (removed > 0) {
      await this.log(
        "REV",
        `Removed ${removed} unnecessary feature(s) (${reviewResult.tokens} tokens, ${reviewResult.durationMs}ms)`,
        undefined,
        reviewResult.prompt,
        reviewResult.raw,
      );
    } else {
      await this.log(
        "REV",
        `All ${filteredTasks.length} features approved (${reviewResult.tokens} tokens, ${reviewResult.durationMs}ms)`,
        undefined,
        reviewResult.prompt,
        reviewResult.raw,
      );
    }

    for (let i = 0; i < filteredTasks.length; i++) {
      await db.insert(tasks).values({
        projectId: this.projectId,
        parentId: null,
        description: filteredTasks[i],
        status: "awaiting_approval",
        depth: 1,
        sortOrder: i,
      });
      this.taskCount++;
    }

    await this.log(
      "PM",
      `Created ${filteredTasks.length} epics (${result.tokens} tokens, ${result.durationMs}ms)`,
      undefined,
      result.prompt,
      result.raw,
    );
  }

  // ─────────────────────────────────────────────\n  //  PHASE 2: PLAN (Manager → Features per Epic)\n  // ─────────────────────────────────────────────

  private async planAll() {
    while (!this.aborted) {
      const allTasks = await db.query.tasks.findMany({
        where: eq(tasks.projectId, this.projectId),
        orderBy: [asc(tasks.depth), asc(tasks.id)],
      });

      const next = allTasks.find((t) => {
        if (t.status !== "pending" && t.status !== "decomposing") return false;
        if (this.stage === "breakdown" && this.breakdownDepth !== null) {
          if (t.depth !== this.breakdownDepth) return false;
        }
        return true;
      });

      if (!next) break;

      // At MAX_DEPTH (2), features are leaves — mark READY
      if (next.depth >= MAX_DEPTH) {
        const effectiveFilePath = this.resolveFilePath(
          next.filePath,
          next.description,
        );
        await db
          .update(tasks)
          .set({ status: "ready", filePath: effectiveFilePath })
          .where(eq(tasks.id, next.id));
        await this.log(
          "SYS",
          `Feature → READY (${effectiveFilePath}): ${next.description}`,
          next.id,
        );
        continue;
      }

      const totalTasks = await this.getTotalTaskCount();
      if (totalTasks >= MAX_TASKS) {
        await this.markStuck(next.id, "Global task limit reached");
        continue;
      }

      await this.breakdownEpic(next);
    }
  }

  private async breakdownEpic(task: Task) {
    await this.setStatus(task.id, "decomposing");
    this.emit("task_started", {
      taskId: task.id,
      description: task.description,
      agent: "manager",
    });

    await this.log("MGR", `Breaking down epic: ${task.description}`, task.id);

    // Build the file-manifest context so Manager scopes each task title to
    // a specific file via [FileName.ext] prefix. Without this the manager
    // generates list-level features (e.g. "implement card addition") that
    // the keyword router mis-targets at single-item files (e.g. Card.tsx).
    const manifestBlock =
      this.manifest.length > 0
        ? "\nFILES (each task MUST start with [FileName.ext] choosing the best fit):\n" +
          this.manifest.map((f) => `- [${f.path}] ${f.description}`).join("\n")
        : "";
    const baseContext = this.withCustomInstructions(
      `Project: ${this.projectName} — ${this.projectDescription}${manifestBlock}`,
    );

    let result = await runManager(this.model, task.description, baseContext);

    if (!result.block && task.parseRetryCount < MAX_PARSE_RETRIES) {
      await db
        .update(tasks)
        .set({ parseRetryCount: task.parseRetryCount + 1 })
        .where(eq(tasks.id, task.id));
      await this.log("MGR", "Parse failure, retrying...", task.id);
      result = await runManager(this.model, task.description, baseContext);
    }

    if (!result.block) {
      await this.markStuck(task.id, "Manager could not parse response");
      return;
    }

    // Manager must BREAKDOWN at depth 1 — never READY
    if (result.block.command === "READY") {
      await this.log(
        "MGR",
        `Overriding READY at depth 1 — forcing breakdown`,
        task.id,
        result.prompt,
        result.raw,
      );
      result = await runManager(
        this.model,
        `${task.description}\nThis is a high-level epic. You MUST break it into 2-3 smaller, specific tasks. Each task should describe a concrete piece of work to produce or implement. Reply with >>BREAKDOWN only.`,
        baseContext,
      );
      if (!result.block || result.block.command !== "BREAKDOWN") {
        await this.markStuck(task.id, "Manager refused to break down epic");
        return;
      }
    }

    if (result.block.command === "BREAKDOWN") {
      const validTasks: string[] = [];

      for (const subtask of result.block.tasks) {
        const check = isVagueOrCircular(task.description, subtask);
        if (check.isVague) {
          await this.log(
            "MGR",
            `Rejected subtask "${subtask}": ${check.reason}`,
            task.id,
          );
        } else {
          validTasks.push(subtask);
        }
      }

      if (validTasks.length === 0) {
        await this.log("MGR", "All subtasks rejected, retrying...", task.id);
        const retryResult = await runManager(
          this.model,
          `${task.description}\nIMPORTANT: Break into DIFFERENT, SPECIFIC steps. Each must be a concrete piece of work with a clear deliverable. Each must be a specific, actionable task.`,
          baseContext,
        );
        if (retryResult.block && retryResult.block.command === "BREAKDOWN") {
          for (const subtask of retryResult.block.tasks) {
            const recheck = isVagueOrCircular(task.description, subtask);
            if (!recheck.isVague) validTasks.push(subtask);
          }
        }
        if (validTasks.length === 0) {
          await this.markStuck(
            task.id,
            "All subtasks were too vague or circular",
          );
          return;
        }
      }

      const cappedTasks = validTasks.slice(0, MAX_SUBTASKS);
      for (let i = 0; i < cappedTasks.length; i++) {
        const featureFilePath = this.resolveFilePath(null, cappedTasks[i]);
        // Strip the [File.ext] prefix from the stored description — it's
        // already captured in filePath, and leaking it into developer prompts
        // is noisy.
        const cleanedDesc = cappedTasks[i]
          .replace(/^\s*\[[^\]]+\]\s*/, "")
          .trim();
        await db.insert(tasks).values({
          projectId: this.projectId,
          parentId: task.id,
          description: cleanedDesc || cappedTasks[i],
          status: "pending",
          depth: task.depth + 1,
          sortOrder: i,
          filePath: featureFilePath,
        });
        this.taskCount++;
      }

      await this.setStatus(task.id, "done");
      await this.log(
        "MGR",
        `Broke down into ${cappedTasks.length} features`,
        task.id,
        result.prompt,
        result.raw,
      );
      this.emit("task_completed", {
        taskId: task.id,
        status: "DONE",
        duration: 0,
      });
    }
  }

  // ─────────────────────────────────────────────
  //  PHASE 3: MERGE + TDD + EXECUTE (split into separate runnable phases)
  // ─────────────────────────────────────────────

  /**
   * Prepare file specs from ready tasks — shared by TDD and Execute phases.
   * Returns the fileSpecs map (requirements + tasks per file).
   */
  private async prepareFileSpecs(): Promise<
    Record<string, { requirements: string[]; tasks: Task[] }>
  > {
    // Ensure all depth-2 tasks are READY
    const pendingD2 = await db.query.tasks.findMany({
      where: and(
        eq(tasks.projectId, this.projectId),
        eq(tasks.status, "pending"),
      ),
    });
    for (const t of pendingD2) {
      if (t.depth >= MAX_DEPTH) {
        const fp = this.resolveFilePath(t.filePath, t.description);
        await db
          .update(tasks)
          .set({ status: "ready", filePath: fp })
          .where(eq(tasks.id, t.id));
      }
    }

    const readyTasks = await db.query.tasks.findMany({
      where: and(
        eq(tasks.projectId, this.projectId),
        eq(tasks.status, "ready"),
      ),
      orderBy: [asc(tasks.id)],
    });

    if (readyTasks.length === 0) return {};

    // Group by file
    const fileGroups: Record<string, Task[]> = {};
    for (const task of readyTasks) {
      const fp = task.filePath || this.resolveFilePath(null, task.description);
      if (!fileGroups[fp]) fileGroups[fp] = [];
      fileGroups[fp].push(task);
    }

    // MERGE: deduplicate and build per-file specs
    const fileSpecs = this.mergeFeatureSpecs(fileGroups);

    const specCount = Object.values(fileSpecs).filter(
      (s) => s.requirements.length > 0,
    ).length;
    await this.log(
      "SYS",
      `Merged ${readyTasks.length} features into ${specCount} file specs`,
    );

    // Ensure each manifest file has specs if model forgot them
    this.ensureBasicSpecs(fileSpecs, fileGroups);

    return fileSpecs;
  }

  /**
   * TDD phase: generate test files BEFORE writing code.
   * Only for file types that support TDD.
   */
  private async runTDDPhase(
    fileSpecs: Record<string, { requirements: string[]; tasks: Task[] }>,
  ) {
    let testsGenerated = 0;
    for (const filePath of this.getFileOrder()) {
      if (this.aborted) break;
      const spec = fileSpecs[filePath];
      if (!spec || spec.requirements.length === 0) continue;
      if (supportsTDD(filePath)) {
        try {
          const manifestDesc = this.manifest.find(
            (m) => m.path === filePath,
          )?.description;
          await this.generateTests(spec.requirements, filePath, manifestDesc);
          testsGenerated++;
        } catch (err) {
          // A single file failing to generate tests must not crash the pipeline.
          // Log it and move on — the Execute phase will still write code.
          await this.log(
            "TDD",
            `Test generation failed for ${filePath}: ${
              err instanceof Error ? err.message : String(err)
            } — skipping`,
          );
        }
      }
    }
    if (testsGenerated === 0) {
      await this.log("TDD", "No testable files — skipping test generation");
    }
  }

  /**
   * Build ordered execution waves from the manifest's import graph.
   * Files with no cross-manifest dependencies go in wave 0; files that
   * import from wave-0 files go in wave 1; and so on.
   *
   * Uses Kahn's topological sort. If a cycle is detected the remaining
   * files are appended as a final sequential wave so execution always
   * completes.
   */
  private buildDependencyWaves(): string[][] {
    const files = this.getFileOrder();
    if (files.length <= 1) return [files];

    const outDir = this.outputDir();
    const depMap = new Map<string, Set<string>>();

    for (const fp of files) {
      const manifestEntry = this.manifest.find((m) => m.path === fp);

      // ── Primary: use architect-planned import graph ──
      // The architect explicitly listed which files each file imports from.
      // This is available before any code is written, so wave 0 correctly
      // contains leaf files (no deps) and later waves contain dependents.
      if (manifestEntry?.imports && manifestEntry.imports.length > 0) {
        const planned = new Set<string>();
        for (const imp of manifestEntry.imports) {
          // Match by exact path or by basename (handles extension-less refs)
          const exact = files.find((f) => f === imp);
          if (exact) {
            planned.add(exact);
            continue;
          }
          const baseName = imp.replace(/\.\w+$/, "").toLowerCase();
          const byBase = files.find(
            (f) => f.replace(/\.\w+$/, "").toLowerCase() === baseName,
          );
          if (byBase) planned.add(byBase);
        }
        depMap.set(fp, planned);
        continue;
      }

      // ── Fallback: scan already-written file content or description ──
      let content = "";
      try {
        const fullPath = path.join(outDir, fp);
        if (fs.existsSync(fullPath))
          content = fs.readFileSync(fullPath, "utf-8");
      } catch {
        /* ignore */
      }
      const description = manifestEntry?.description ?? "";
      const source = content || description;
      depMap.set(fp, parseImportDeps(source, fp, files));
    }

    return buildWaves(files, depMap);
  }

  /** Summarise a completed file and store in fileContextSummaries (silent). */
  private async summariseFile(filePath: string): Promise<void> {
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    if (!["ts", "tsx", "jsx"].includes(ext)) return;
    const content = this.getCurrentFileContent(filePath);
    if (!content || content.replace(/\s/g, "").length <= 150) return;
    try {
      const result = await runSummariser(
        this.model,
        filePath,
        this.truncateForPrompt(content, 80),
      );
      if (result.block?.context) {
        this.fileContextSummaries[filePath] = result.block.context;
        await this.log("SUM", `${filePath}: ${result.block.context}`);
      }
    } catch {
      // Silent — never block the pipeline on a summary failure
    }
  }

  /**
   * Execute phase: write code for each file, parallelising files that have
   * no dependency on each other within the same wave.
   */
  private async runExecutePhase(
    fileSpecs: Record<string, { requirements: string[]; tasks: Task[] }>,
  ) {
    const waves = this.buildDependencyWaves();

    for (const wave of waves) {
      if (this.aborted) break;
      // Sort: feature files (utils.js etc.) before default-spec files (Counter.tsx etc.)
      // so that when a default-spec file runs, sibling injection has real code to inject.
      const sortedWave = [...wave].sort((a, b) => {
        const aDefault = fileSpecs[a]?.requirements[0]?.startsWith(
          Pipeline.DEFAULT_SPEC_TAG,
        )
          ? 1
          : 0;
        const bDefault = fileSpecs[b]?.requirements[0]?.startsWith(
          Pipeline.DEFAULT_SPEC_TAG,
        )
          ? 1
          : 0;
        return aDefault - bDefault;
      });
      for (const filePath of sortedWave) {
        if (this.aborted) break;
        const spec = fileSpecs[filePath];
        if (spec && spec.requirements.length > 0) {
          await this.executeSpec(filePath, spec.requirements, spec.tasks);
          await this.summariseFile(filePath);
        }
      }
    }
  }

  /**
   * If manifest files have no features, generate a default spec.
   * Default-spec files are tagged with a recognisable prefix so the execute
   * loop can inject richer sibling-file context and avoid duplicates.
   */
  static readonly DEFAULT_SPEC_TAG = "__DEFAULT_SPEC__";

  private ensureBasicSpecs(
    fileSpecs: Record<string, { requirements: string[]; tasks: Task[] }>,
    fileGroups: Record<string, Task[]>,
  ) {
    const allTasks = Object.values(fileGroups).flat();

    // For each manifest file that has no specs, generate a default
    for (const file of this.manifest) {
      if (
        !fileSpecs[file.path] ||
        fileSpecs[file.path].requirements.length === 0
      ) {
        const fallbackTasks = fileGroups[file.path] || allTasks.slice(0, 1);
        const defaultReqs = [
          // TAG: execute loop detects this to inject sibling code context
          `${Pipeline.DEFAULT_SPEC_TAG}Write ${file.path} (${file.description}) for "${this.projectName}: ${this.projectDescription}"`,
          file.description,
        ];

        fileSpecs[file.path] = {
          requirements: defaultReqs.slice(0, MAX_REQUIREMENTS),
          tasks: fallbackTasks,
        };
        this.log(
          "SYS",
          `Added default ${file.path} spec (no features were generated)`,
        );
      }
    }
  }

  private mergeFeatureSpecs(
    fileGroups: Record<string, Task[]>,
  ): Record<string, { requirements: string[]; tasks: Task[] }> {
    const result: Record<string, { requirements: string[]; tasks: Task[] }> =
      {};

    for (const [filePath, taskList] of Object.entries(fileGroups)) {
      const seenNormalized = new Set<string>();
      const requirements: string[] = [];

      for (const task of taskList) {
        const normalized = task.description
          .toLowerCase()
          .replace(/["']/g, "")
          .replace(/\s+/g, " ")
          .trim();

        const key = normalized.slice(0, 40);
        if (seenNormalized.has(key)) continue;

        const isDuplicate = requirements.some(
          (existing) =>
            this.stringSimilarity(existing.toLowerCase(), normalized) > 0.45,
        );
        if (isDuplicate) continue;

        seenNormalized.add(key);
        // Strip trailing file path references from task descriptions
        const cleaned = task.description
          .replace(/\s+in\s+[\w.-]+\s*$/i, "")
          .trim();
        requirements.push(cleaned);
      }

      result[filePath] = {
        requirements: requirements.slice(0, MAX_REQUIREMENTS),
        tasks: taskList,
      };
    }

    return result;
  }

  private stringSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.split(/\s+/).filter((w) => w.length > 2));
    const wordsB = new Set(b.split(/\s+/).filter((w) => w.length > 2));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++;
    }
    return intersection / Math.max(wordsA.size, wordsB.size);
  }

  // ─────────────────────────────────────────────
  //  PHASE 4: EXECUTE (Sequential — one requirement at a time)
  // ─────────────────────────────────────────────

  private async executeSpec(
    filePath: string,
    requirements: string[],
    taskGroup: Task[],
  ) {
    // DON'T mark all tasks executing upfront — mark them one at a time
    // so the UI shows sequential progress instead of a batch.

    await this.log(
      "DEV",
      `Writing ${filePath} (${requirements.length} requirements, sequential)`,
      taskGroup[0].id,
    );

    // Chain-of-thought planning pass — one call, no retry, silent fallback.
    // Only runs for multi-requirement files where an outline is actually useful.
    let planOutline: string | null = null;
    if (requirements.length >= 2) {
      const manifestDesc = this.manifest.find(
        (m) => m.path === filePath,
      )?.description;
      planOutline = await runPlanner(
        this.model,
        filePath,
        requirements,
        manifestDesc,
        this.contractSnippet || undefined,
      );
      if (planOutline) {
        await this.log(
          "PLAN",
          `Implementation plan for ${filePath}:\n${planOutline}`,
          taskGroup[0].id,
        );
      }
    }

    // Phase A: Deterministic pre-pass (builds base draft)
    await this.applyDeterministicOpsPrepass(
      filePath,
      requirements,
      taskGroup[0].id,
    );

    // Phase B: Sequential LLM enhancement — one requirement at a time
    // Each step reads the current file, adds ONE feature, validates, writes.
    // This prevents model confusion from trying to do everything at once.
    const qaReason = taskGroup[0].qAReason;
    let stepsCompleted = 0;

    for (let i = 0; i < requirements.length; i++) {
      if (this.aborted) break;
      // Strip the default-spec tag before the requirement reaches any prompt.
      const req = requirements[i].startsWith(Pipeline.DEFAULT_SPEC_TAG)
        ? requirements[i].slice(Pipeline.DEFAULT_SPEC_TAG.length)
        : requirements[i];

      // Mark EXACTLY ONE task as executing for this step so the UI
      // never shows concurrent executing tasks. The display task is always
      // the first in the step's task group (or the last available task).
      const tasksForThisStep = getTasksForStep(
        i,
        requirements.length,
        taskGroup,
      );
      const displayTask = tasksForThisStep[0];
      if (displayTask) {
        await this.setStatus(displayTask.id, "executing");
        this.emit("task_started", {
          taskId: displayTask.id,
          description: displayTask.description,
          agent: "developer",
        });
      }

      await this.log(
        "DEV",
        `[${i + 1}/${requirements.length}] ${req}`,
        tasksForThisStep[0]?.id || taskGroup[0].id,
      );

      // Read current file (accumulates previous changes)
      const currentContent = this.getCurrentFileContent(filePath) || "";
      const hasContent = currentContent.trim().length > 50;

      let userMessage = `Project: ${this.projectName} — ${this.projectDescription}\n\n`;

      if (hasContent) {
        userMessage += `Current ${filePath}:\n${currentContent}\n\n`;
        userMessage += `ENHANCE the file above. Keep ALL existing code intact. Add ONLY this feature:\n- ${req}\n\nWrite the COMPLETE updated file with the new feature added.`;
      } else {
        userMessage += `Write the complete ${filePath} file implementing this feature:\n- ${req}`;
      }

      // File-type-specific rules + UX quality reminders
      userMessage += `\n\n${getFileTypeRules(filePath)}`;

      // Inject the file manifest so the developer knows the role of every file
      // in the project. This prevents leaf components from being written as
      // standalone apps and tells container files which siblings to import.
      if (this.manifest.length > 1) {
        const manifestLines = this.manifest
          .map((m) => `  - ${m.path}: ${m.description}`)
          .join("\n");
        userMessage += `\n\nFILE ARCHITECTURE (all files in this project):\n${manifestLines}\n\nYou are writing: ${filePath}\nWrite it for its role above — NOT as a standalone app. Use props/callbacks for data that comes from a parent. Import from sibling files when they are listed in SIBLING FILES.`;
      }

      // Inject the skeleton on every step — not just step 0.
      // Later steps see the current file in context, but for code files
      // the skeleton anchors state variable names and handler names that
      // the model might otherwise reinvent inconsistently on step 3+.
      if (planOutline) {
        userMessage += `\n\nFILE SKELETON (use these exact names):\n${planOutline}`;
      }

      // Inject shared type contracts on every step so cross-file types
      // stay consistent. The snippet is tiny (3-6 lines) so prompt cost
      // is negligible.
      if (this.contractSnippet) {
        userMessage += `\n\nSHARED TYPES (use these exact definitions):\n${this.contractSnippet}`;
      }

      // On the first step only, inject context from already-completed files.
      // Priority order:
      //   1. Actual code of files this file directly imports (planned dep graph)
      //      — model sees exact export names, prop signatures, type shapes
      //   2. LLM summaries of other completed files (broader awareness)
      // Capped to keep prompts manageable on small models.
      if (i === 0) {
        const outDir = this.outputDir();
        const manifestEntry = this.manifest.find((m) => m.path === filePath);
        const plannedImports = manifestEntry?.imports ?? [];

        // Inject existing test file so the developer uses the exact prop names
        // the tests expect. Tests are generated before code (TDD), so they define
        // the component's public interface — the implementation must match.
        {
          const fExt = filePath.split(".").pop()?.toLowerCase() || "";
          const testExt = fExt === "tsx" || fExt === "jsx" ? "tsx" : fExt;
          const testFileName = filePath.replace(/\.\w+$/, `.test.${testExt}`);
          const testDiskPath = path.join(outDir, testFileName);
          if (fs.existsSync(testDiskPath)) {
            const testSrc = fs.readFileSync(testDiskPath, "utf-8").trim();
            if (testSrc.length > 20) {
              userMessage += `\n\nEXISTING TESTS — your component MUST use the EXACT prop names shown in the render() calls below (e.g. if the test writes onDelete={...}, your Props interface must have onDelete, not onDeleteHabit or deleteHabit):\n${testSrc.split("\n").slice(0, 35).join("\n")}`;
            }
          }
        }

        // Inject actual code for direct dependencies (limit 3 files, 60 lines each)
        const depSnippets: string[] = [];
        for (const dep of plannedImports.slice(0, 3)) {
          const depPath = path.join(outDir, dep);
          if (fs.existsSync(depPath)) {
            const depContent = fs.readFileSync(depPath, "utf-8").trim();
            if (depContent.length > 50) {
              const lines = depContent.split("\n").slice(0, 60).join("\n");
              depSnippets.push(`--- ${dep} ---\n${lines}`);
            }
          }
        }
        if (depSnippets.length > 0) {
          userMessage += `\n\nFILES YOU MUST IMPORT FROM (use these exact export names and prop types):\n${depSnippets.join("\n\n")}`;
        }

        // Default-spec files: inject actual code of ALL already-written siblings
        // so the model doesn't re-implement components that already exist.
        const isDefaultSpec = requirements[0]?.startsWith(
          Pipeline.DEFAULT_SPEC_TAG,
        );

        // Inject actual first-35-lines of completed sibling files.
        // Small models pattern-match concrete code far better than abstract
        // type signatures — seeing the real props interface and import line
        // tells the model exactly how to use the sibling.
        // Cap at 2 siblings × 35 lines ≈ ~3000 chars to avoid context bloat.
        const completedSiblings: string[] = [];
        const siblingPaths = new Set<string>([
          ...this.manifest.map((m) => m.path),
          ...Object.keys(this.fileContextSummaries),
        ]);
        for (const siblingPath of siblingPaths) {
          if (siblingPath === filePath) continue;
          // Skip files already shown in the "FILES YOU MUST IMPORT FROM" block
          // to avoid injecting the same content twice.
          if (plannedImports.includes(siblingPath)) continue;
          const siblingDiskPath = path.join(outDir, siblingPath);
          if (!fs.existsSync(siblingDiskPath)) continue;
          const code = fs.readFileSync(siblingDiskPath, "utf-8").trim();
          // Skip empty scaffolds (< 100 chars means not yet written)
          if (code.length < 100) continue;
          const importSpec = "./" + siblingPath.replace(/\.(tsx?|jsx?)$/, "");
          // Extract the real exported name so the model gets a correct import
          // hint rather than the "ComponentName" placeholder that small models
          // copy literally: e.g. "import ComponentName from './KanbanColumn'"
          const exportMatch = code.match(
            /export\s+default\s+(?:function|class)\s+(\w+)/,
          );
          const exportedName = exportMatch
            ? exportMatch[1]
            : siblingPath.replace(/\.\w+$/, "").replace(/[^a-zA-Z0-9]/g, "");
          const preview = code.split("\n").slice(0, 35).join("\n");
          completedSiblings.push(
            `// ${siblingPath} — import with: import ${exportedName} from "${importSpec}"\n${preview}`,
          );
        }
        if (completedSiblings.length > 0) {
          const toShow = completedSiblings.slice(0, 3);
          userMessage += `\n\nSIBLING FILES ALREADY WRITTEN — import and use these instead of re-implementing their logic:\n${toShow.join("\n\n")}`;
        }

        if (isDefaultSpec) {
          const siblingSnippets: string[] = [];
          for (const [siblingPath] of Object.entries(
            this.fileContextSummaries,
          )) {
            if (siblingPath === filePath) continue;
            const siblingDiskPath = path.join(outDir, siblingPath);
            if (fs.existsSync(siblingDiskPath)) {
              const sibCode = fs.readFileSync(siblingDiskPath, "utf-8").trim();
              if (sibCode.length > 50) {
                const lines = sibCode.split("\n").slice(0, 60).join("\n");
                siblingSnippets.push(`--- ${siblingPath} ---\n${lines}`);
              }
            }
          }
          if (siblingSnippets.length > 0) {
            userMessage += `\n\nALREADY WRITTEN FILES — do NOT re-implement any component, hook, or state logic already present in these files. Import from them if needed:\n${siblingSnippets.join("\n\n")}`;
          }
        } else {
          // Also inject LLM summaries for non-dep completed files (awareness, not imports)
          const priorSummaries = Object.entries(this.fileContextSummaries)
            .filter(([fp]) => fp !== filePath && !plannedImports.includes(fp))
            .slice(-2);
          if (priorSummaries.length > 0) {
            userMessage += `\n\nOTHER COMPLETED FILES (for context):\n${priorSummaries.map(([, s]) => s).join("\n")}`;
          }
        }
      }

      // Include QA feedback from previous retry — only on first step
      if (i === 0 && qaReason) {
        userMessage += `\n\nWARNING: Previous version failed QA: ${qaReason}. Avoid this issue.`;
      }

      userMessage = this.withCustomInstructions(userMessage);
      this.warnIfPromptTooLarge(`Execute step ${i + 1}`, userMessage);

      // ── PATCH MODE (steps 2..N for code files) ──
      // Capable models like Gemma 4 will helpfully restructure the whole
      // file each step if asked for a full rewrite. To prevent drift, try a
      // surgical SEARCH/REPLACE patch first — emit only the diff.
      // The model emits ONE block per turn; we loop up to MAX_PATCH_TURNS
      // turns, asking "anything else?" between applications. Each turn may
      // retry once if the SEARCH text isn't found in the (possibly updated)
      // file. Falls through to the full-rewrite self-healing loop on any
      // unrecoverable failure.
      const patchableExts = ["tsx", "jsx", "ts", "js"];
      const fileExt = filePath.split(".").pop()?.toLowerCase() || "";
      const canPatch = hasContent && i > 0 && patchableExts.includes(fileExt);
      const MAX_PATCH_TURNS = 4;

      let stepPassed = false;

      if (canPatch && !this.aborted) {
        let workingContent = currentContent;
        let totalBlocks = 0;
        let totalTokens = 0;
        let totalMs = 0;
        let combinedRaw = "";
        let combinedPrompt = "";
        let lastPatchError: string | null = null;
        let modelSaidDone = false;
        let patchAborted = false;

        for (let turn = 1; turn <= MAX_PATCH_TURNS; turn++) {
          if (this.aborted) break;

          const numbered = workingContent
            .split("\n")
            .map((line, idx) => `${String(idx + 1).padStart(4, " ")} | ${line}`)
            .join("\n");

          // Build the per-turn instruction. After the first turn, ask the
          // model whether anything else is still needed for the feature.
          // Turn 1 asks the model to *think* about atomic edits before
          // emitting the first — biases toward small focused diffs and
          // avoids feature drift. (Improvement 1.)
          const turnInstruction =
            turn === 1
              ? `${req}\n\nThink (silently — do NOT write it out) of this feature as 3-5 atomic edits (e.g. "add state hook", "add handler", "wire JSX onClick", "render new element"). Output ONLY the FIRST atomic edit as a single SEARCH/REPLACE block — nothing else, no list, no prose. You will be re-prompted for each subsequent edit.`
              : `${req}\n\n(Continuing the same feature — turn ${turn}. Output ONLY the NEXT atomic edit as a single SEARCH/REPLACE block, nothing else. If every atomic edit is now in the file, reply with the single word DONE.)`;

          const note = lastPatchError ?? undefined;
          const patchRes = await runDeveloperPatch(
            this.model,
            filePath,
            numbered,
            turnInstruction,
            this.projectName,
            this.projectDescription,
            note,
          );
          lastPatchError = null;
          totalTokens += patchRes.tokens;
          totalMs += patchRes.durationMs;
          combinedRaw += (combinedRaw ? "\n\n---\n\n" : "") + patchRes.raw;
          combinedPrompt = combinedPrompt || patchRes.prompt;

          // DONE sentinel — model says nothing more is needed
          if (/^\s*DONE\s*$/m.test(patchRes.raw.trim().split("\n")[0] || "")) {
            modelSaidDone = true;
            break;
          }

          const blocks = parsePatch(patchRes.raw);
          if (blocks.length === 0) {
            if (totalBlocks > 0) {
              // Model produced prose after successfully applying N blocks —
              // treat as implicit DONE rather than triggering a full rewrite.
              await this.log(
                "QA",
                `Step ${i + 1} patch turn ${turn}: no block — treating as DONE (${totalBlocks} block(s) already applied)`,
                tasksForThisStep[0]?.id || taskGroup[0].id,
              );
              modelSaidDone = true;
              break;
            }
            // No block AND no prior progress: model gave up — fall back
            await this.log(
              "QA",
              `Step ${i + 1} patch turn ${turn}: no SEARCH/REPLACE block parsed — falling back to full rewrite`,
              tasksForThisStep[0]?.id || taskGroup[0].id,
            );
            patchAborted = true;
            break;
          }

          // Apply only the first block — we asked for one per turn
          const applied = applyPatch(workingContent, [blocks[0]]);
          if (!applied.ok) {
            // SEARCH didn't match. Give the model one retry with the same
            // (unchanged) file content and an explicit error note. If it
            // fails again next turn we'll fall back.
            if (!lastPatchError) {
              lastPatchError = `Your previous SEARCH did not match the file (${applied.reason}). The file is unchanged. Re-read the CURRENT file shown below and emit a corrected SEARCH/REPLACE block with the exact existing text.`;
              continue;
            }
            await this.log(
              "QA",
              `Step ${i + 1} patch turn ${turn} failed twice: ${applied.reason} — falling back to full rewrite`,
              tasksForThisStep[0]?.id || taskGroup[0].id,
            );
            patchAborted = true;
            break;
          }

          workingContent = applied.content;
          totalBlocks += applied.blocksApplied;
        }

        if (!patchAborted && totalBlocks > 0) {
          // Validate accumulated patched content
          const { repaired: patchRepaired, fixes: patchFixes } =
            autoRepairOutput(workingContent, filePath);
          const candidate =
            patchFixes.length > 0 ? patchRepaired : workingContent;
          const patchValidation = validateOutput(candidate, filePath, {
            allowScaffold: true,
          });
          const patchSyntax =
            patchValidation.valid && patchableExts.includes(fileExt)
              ? checkTypeScriptSyntax(filePath, candidate)
              : [];

          if (patchValidation.valid && patchSyntax.length === 0) {
            await this.writeOutputFile(filePath, candidate);
            stepsCompleted++;
            const turnNote = modelSaidDone ? " (DONE)" : "";
            await this.log(
              "DEV",
              `Step ${i + 1} PATCH (${totalBlocks} block${totalBlocks === 1 ? "" : "s"}${turnNote}, ${totalTokens} tokens, ${totalMs}ms)`,
              tasksForThisStep[0]?.id || taskGroup[0].id,
              combinedPrompt,
              combinedRaw,
            );
            stepPassed = true;
          } else {
            const reason = !patchValidation.valid
              ? patchValidation.reason
              : `TS syntax: ${patchSyntax.join("; ")}`;
            await this.log(
              "QA",
              `Step ${i + 1} patch invalid after ${totalBlocks} block(s) (${reason}) — falling back to full rewrite`,
              tasksForThisStep[0]?.id || taskGroup[0].id,
            );
          }
        } else if (!patchAborted && modelSaidDone && totalBlocks === 0) {
          // Model said DONE on turn 1 — feature already implemented.
          // Skip this step entirely; the file is fine as-is.
          stepsCompleted++;
          await this.log(
            "DEV",
            `Step ${i + 1} PATCH skipped (model reports feature already present, ${totalTokens} tokens, ${totalMs}ms)`,
            tasksForThisStep[0]?.id || taskGroup[0].id,
            combinedPrompt,
            combinedRaw,
          );
          stepPassed = true;
        }
      }

      if (stepPassed) {
        // Patch path succeeded — mark the display task done early so the
        // UI advances. We still fall through to the per-step task-marking
        // block below (which sets DB output / completeTask for every task).
        if (displayTask) {
          await this.setStatus(displayTask.id, "done");
          this.emit("task_completed", {
            taskId: displayTask.id,
            agent: "developer",
          });
        }
      }

      // Self-healing loop: try → validate → feed error back → retry.
      // Short-circuits to recovery if the model repeats the same error,
      // since retries with identical prompts produce identical garbage and
      // each one costs ~30-60s of model time.
      let stepUserMessage = userMessage;
      let lastGarbageOutput: string | null = null;
      let lastErrorSignature: string | null = null;
      let repeatedErrorCount = 0;

      for (
        let attempt = 1;
        attempt <= Pipeline.MAX_SELF_HEAL_ATTEMPTS;
        attempt++
      ) {
        if (stepPassed) break;
        const result = await runDeveloper(
          this.model,
          stepUserMessage,
          filePath,
          this.manifest.find((m) => m.path === filePath)?.description,
        );

        if (!result.block) {
          lastGarbageOutput = result.raw;
          await this.log(
            "DEV",
            `Step ${i + 1} attempt ${attempt}: parse failure`,
            tasksForThisStep[0]?.id || taskGroup[0].id,
            result.prompt,
            result.raw,
          );
          // Parse failure is a stable error — count it the same way
          if (lastErrorSignature === "PARSE_FAIL") {
            repeatedErrorCount++;
          } else {
            lastErrorSignature = "PARSE_FAIL";
            repeatedErrorCount = 1;
          }
          if (repeatedErrorCount >= 2) {
            await this.log(
              "QA",
              `Step ${i + 1}: same failure twice — short-circuiting to recovery`,
              tasksForThisStep[0]?.id || taskGroup[0].id,
            );
            break;
          }
          continue;
        }

        let output = result.block.output;
        const { repaired, fixes } = autoRepairOutput(output, filePath);
        if (fixes.length > 0) {
          output = repaired;
          await this.log(
            "QA",
            `Step ${i + 1} auto-repaired: ${fixes.join(", ")}`,
            tasksForThisStep[0]?.id || taskGroup[0].id,
          );
        }

        // Per-step validation (lenient — allowScaffold since we're building incrementally)
        const validation = validateOutput(output, filePath, {
          allowScaffold: true,
        });
        if (validation.valid) {
          // TypeScript syntax check — only for .ts/.tsx/.jsx/.js files.
          // Uses getSyntacticDiagnostics() so it only catches parse/syntax
          // errors (TS1xxx), never type errors. noResolve means imports are
          // not followed, keeping this fast and isolated.
          const syntaxErrors = checkTypeScriptSyntax(filePath, output);
          if (syntaxErrors.length > 0) {
            const errorSummary = syntaxErrors.join("; ");
            await this.log(
              "QA",
              `Step ${i + 1} attempt ${attempt} TS syntax: ${errorSummary}`,
              tasksForThisStep[0]?.id || taskGroup[0].id,
            );
            lastGarbageOutput = output;
            // Build a stable signature from the first ~80 chars of the
            // error summary; trailing offsets / positions vary slightly
            // but the underlying error class is what matters.
            const sig = `TS:${errorSummary.slice(0, 80)}`;
            if (lastErrorSignature === sig) {
              repeatedErrorCount++;
            } else {
              lastErrorSignature = sig;
              repeatedErrorCount = 1;
            }
            if (repeatedErrorCount >= 2) {
              await this.log(
                "QA",
                `Step ${i + 1}: identical TS error twice — short-circuiting to recovery`,
                tasksForThisStep[0]?.id || taskGroup[0].id,
              );
              break;
            }
            stepUserMessage =
              userMessage +
              `\n\nYour previous output has TypeScript syntax errors:\n${errorSummary}\nFix these errors and rewrite the complete file.`;
            continue;
          }

          // Semantic check — catches type errors and undefined identifiers
          // that syntax check misses. Codes related to unresolved imports
          // are filtered out (see checkTypeScriptSemantics). Improvement 3.
          const semanticErrors = checkTypeScriptSemantics(filePath, output);
          if (semanticErrors.length > 0) {
            const errorSummary = semanticErrors.join("; ");
            await this.log(
              "QA",
              `Step ${i + 1} attempt ${attempt} TS semantic: ${errorSummary}`,
              tasksForThisStep[0]?.id || taskGroup[0].id,
            );
            lastGarbageOutput = output;
            const sig = `SEM:${errorSummary.slice(0, 80)}`;
            if (lastErrorSignature === sig) {
              repeatedErrorCount++;
            } else {
              lastErrorSignature = sig;
              repeatedErrorCount = 1;
            }
            if (repeatedErrorCount >= 2) {
              await this.log(
                "QA",
                `Step ${i + 1}: identical semantic error twice — short-circuiting to recovery`,
                tasksForThisStep[0]?.id || taskGroup[0].id,
              );
              break;
            }
            stepUserMessage =
              userMessage +
              `\n\nYour previous output has TypeScript type errors:\n${errorSummary}\nFix these errors and rewrite the complete file.`;
            continue;
          }

          await this.writeOutputFile(filePath, output);
          stepsCompleted++;
          await this.log(
            "DEV",
            `Step ${i + 1} PASS (${result.tokens} tokens, ${result.durationMs}ms)`,
            tasksForThisStep[0]?.id || taskGroup[0].id,
            result.prompt,
            result.raw,
          );
          stepPassed = true;
          break;
        }

        lastGarbageOutput = result.block.output;

        await this.log(
          "QA",
          `Step ${i + 1} attempt ${attempt} FAIL: ${validation.reason}`,
          tasksForThisStep[0]?.id || taskGroup[0].id,
          result.prompt,
          result.raw,
        );

        // Same-error short-circuit for validation failures too
        const valSig = `VAL:${(validation.reason || "").slice(0, 80)}`;
        if (lastErrorSignature === valSig) {
          repeatedErrorCount++;
        } else {
          lastErrorSignature = valSig;
          repeatedErrorCount = 1;
        }
        if (repeatedErrorCount >= 2) {
          await this.log(
            "QA",
            `Step ${i + 1}: identical validation error twice — short-circuiting to recovery`,
            tasksForThisStep[0]?.id || taskGroup[0].id,
          );
          break;
        }

        // Feed the error back for next attempt
        stepUserMessage =
          userMessage +
          `\n\nYour previous output failed validation: ${validation.reason}\nFix this error and try again.`;
      }

      // If self-heal failed, try the 3-layer LLM recovery system
      if (!stepPassed && !this.aborted) {
        const recovered = await this.recoverFromFailure(
          filePath,
          req,
          lastGarbageOutput,
          tasksForThisStep[0]?.id || taskGroup[0].id,
        );

        if (recovered) {
          await this.writeOutputFile(filePath, recovered);
          stepsCompleted++;
          stepPassed = true;
        } else {
          await this.log(
            "QA",
            `Step ${i + 1}: all recovery failed — keeping previous version`,
            tasksForThisStep[0]?.id || taskGroup[0].id,
          );
        }
      }

      // Mark this step's tasks as done immediately
      const stepOutput = this.getCurrentFileContent(filePath) || "";
      for (const task of tasksForThisStep) {
        await db
          .update(tasks)
          .set({ output: stepOutput, filePath })
          .where(eq(tasks.id, task.id));
        await this.completeTask(task);
      }
    }

    // Mark any tasks that were never individually stepped through as done.
    // This happens when taskGroup.length > requirements.length.
    const finalOutput = this.getCurrentFileContent(filePath) || "";
    const uncovered = getUncoveredTasks(requirements.length, taskGroup);
    for (const task of uncovered) {
      const current = await db.query.tasks.findFirst({
        where: eq(tasks.id, task.id),
      });
      if (current && current.status !== "done") {
        await db
          .update(tasks)
          .set({ output: finalOutput, filePath })
          .where(eq(tasks.id, task.id));
        await this.completeTask(current);
      }
    }

    // Phase C: Final QA on the accumulated file
    const finalContent = this.getCurrentFileContent(filePath);
    if (!finalContent || finalContent.trim().length < 30) {
      // File is still basically empty — try LLM recovery first
      const recovered = await this.recoverFromFailure(
        filePath,
        requirements.join("; "),
        null,
        taskGroup[0].id,
      );
      if (recovered) {
        await this.writeOutputFile(filePath, recovered);
        await this.log(
          "QA",
          `Recovery produced valid code for empty ${filePath}`,
          taskGroup[0].id,
        );
        for (const task of taskGroup) {
          const current = await db.query.tasks.findFirst({
            where: eq(tasks.id, task.id),
          });
          if (current && current.status !== "done") {
            await db
              .update(tasks)
              .set({ output: recovered, filePath })
              .where(eq(tasks.id, task.id));
            await this.completeTask(task);
          }
        }
      } else {
        // Recovery failed — try deterministic fallback
        const deterministicFallback = this.deterministicDraftByFile[filePath];
        if (deterministicFallback) {
          const fbResult = validateOutput(deterministicFallback, filePath, {
            allowScaffold: true,
          });
          if (fbResult.valid) {
            await this.writeOutputFile(filePath, deterministicFallback);
            await this.log(
              "QA",
              `Using deterministic fallback for ${filePath} (all LLM steps failed)`,
              taskGroup[0].id,
            );
            for (const task of taskGroup) {
              const current = await db.query.tasks.findFirst({
                where: eq(tasks.id, task.id),
              });
              if (current && current.status !== "done") {
                await db
                  .update(tasks)
                  .set({ output: deterministicFallback, filePath })
                  .where(eq(tasks.id, task.id));
                await this.completeTask(task);
              }
            }
            return;
          }
        }
        // Mark any remaining tasks as stuck
        for (const task of taskGroup) {
          const current = await db.query.tasks.findFirst({
            where: eq(tasks.id, task.id),
          });
          if (current && current.status !== "done") {
            await this.markStuck(
              task.id,
              `${filePath} has no meaningful content after ${requirements.length} attempts`,
            );
          }
        }
      }
      return;
    }

    await this.log(
      "DEV",
      `${filePath} complete: ${stepsCompleted}/${requirements.length} steps succeeded`,
      taskGroup[0].id,
    );

    // Run full-file QA (handles retries, auto-repair, cross-file checks)
    // Tasks are already marked done per-step; qaSpec will only validate/repair the file
    await this.qaSpec(filePath, requirements, taskGroup, finalContent);
  }

  /**
   * Distribute tasks across requirement steps for sequential UI updates.
   * Each step gets at least 1 task; extra tasks go to earlier steps.
   */
  private async applyDeterministicOpsPrepass(
    filePath: string,
    _requirements: string[],
    _taskId: number,
  ): Promise<string | null> {
    // Single-component model — deterministic ops are not used for TSX.
    // Just return the current file content as the draft for the LLM prompt.
    const draft = this.getCurrentFileContent(filePath);
    if (!draft) return null;
    this.deterministicDraftByFile[filePath] = draft;
    return this.truncateForPrompt(draft, 100);
  }

  private getCurrentFileContent(filePath: string): string | null {
    const fullPath = path.join(this.outputDir(), filePath);
    if (!fs.existsSync(fullPath)) return null;
    return fs.readFileSync(fullPath, "utf-8");
  }

  private truncateForPrompt(content: string, maxLines: number): string {
    const lines = content.split("\n");
    if (lines.length <= maxLines) return content;
    return lines.slice(0, maxLines).join("\n") + "\n/* ... */";
  }

  /**
   * Extract only the failing test's code block from the full test file.
   * Returns the imports + the specific it() block (or the full file if
   * the test can't be located, truncated to 60 lines).
   */
  private extractRelevantTest(testCode: string, testName: string): string {
    const lines = testCode.split("\n");

    // Always include import lines (first ~10 lines)
    const importLines: string[] = [];
    let importEnd = 0;
    for (let i = 0; i < Math.min(lines.length, 15); i++) {
      if (
        lines[i].trim().startsWith("import") ||
        lines[i].trim() === "" ||
        lines[i].trim().startsWith("//")
      ) {
        importLines.push(lines[i]);
        importEnd = i + 1;
      } else {
        break;
      }
    }

    // Try to find the specific it() block by test name
    const escapedName = testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const itPattern = new RegExp(`it\\s*\\(\\s*["'\`]${escapedName}`, "i");

    for (let i = importEnd; i < lines.length; i++) {
      if (itPattern.test(lines[i])) {
        // Found the test — extract from here to its closing brace
        let depth = 0;
        let end = i;
        for (let j = i; j < lines.length; j++) {
          for (const ch of lines[j]) {
            if (ch === "{" || ch === "(") depth++;
            if (ch === "}" || ch === ")") depth--;
          }
          end = j;
          if (depth <= 0) break;
        }
        // Include the describe wrapper line if nearby
        const describeLines: string[] = [];
        for (let k = Math.max(importEnd, i - 3); k < i; k++) {
          if (lines[k].includes("describe")) {
            describeLines.push(lines[k]);
          }
        }
        return [
          ...importLines,
          "",
          ...describeLines,
          ...lines.slice(i, end + 1),
          "});", // close describe
        ].join("\n");
      }
    }

    // Couldn't find it — return truncated full file
    return this.truncateForPrompt(testCode, 60);
  }

  /**
   * Rough token estimate (~4 chars per token for English/code).
   * Logs a warning if the prompt exceeds a safety threshold.
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private warnIfPromptTooLarge(label: string, prompt: string) {
    const est = this.estimateTokens(prompt);
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

  // ─────────────────────────────────────────────
  //  QA (Programmatic validation + retry)
  // ─────────────────────────────────────────────

  private async qaSpec(
    filePath: string,
    requirements: string[],
    taskGroup: Task[],
    output: string,
  ) {
    await this.log("QA", `Validating: ${filePath}`, taskGroup[0].id);

    const { repaired, fixes } = autoRepairOutput(output, filePath);
    if (fixes.length > 0) {
      await this.writeOutputFile(filePath, repaired);
      for (const task of taskGroup) {
        await db
          .update(tasks)
          .set({ output: repaired })
          .where(eq(tasks.id, task.id));
      }
      await this.log(
        "QA",
        `Auto-repaired: ${fixes.join(", ")}`,
        taskGroup[0].id,
      );
    }

    let finalOutput = repaired;
    let result = validateOutput(finalOutput, filePath);

    if (result.valid) {
      await this.log("QA", `PASS: ${filePath}`, taskGroup[0].id);
      for (const task of taskGroup) {
        await this.completeTask(task);
      }
    } else {
      await this.log("QA", `FAIL: ${result.reason}`, taskGroup[0].id);
      const firstTask = taskGroup[0];

      const isInstructionDumpFailure = (result.reason || "")
        .toLowerCase()
        .includes("prompt/instruction text");

      if (isInstructionDumpFailure) {
        // Try LLM-based recovery (cleaner → minimal retry → alt model)
        const recovered = await this.recoverFromFailure(
          filePath,
          requirements.join("; "),
          finalOutput,
          firstTask.id,
        );
        if (recovered) {
          await this.writeOutputFile(filePath, recovered);
          for (const task of taskGroup) {
            await db
              .update(tasks)
              .set({ output: recovered })
              .where(eq(tasks.id, task.id));
          }
          await this.log(
            "QA",
            `Recovery succeeded for instruction-dump failure in ${filePath}`,
            firstTask.id,
          );
          for (const task of taskGroup) {
            await this.completeTask(task);
          }
          return;
        }

        // Recovery failed — try deterministic fallback
        const deterministicFallback = this.deterministicDraftByFile[filePath];
        if (deterministicFallback) {
          const fallbackResult = validateOutput(
            deterministicFallback,
            filePath,
            { allowScaffold: true },
          );
          if (fallbackResult.valid) {
            await this.writeOutputFile(filePath, deterministicFallback);
            for (const task of taskGroup) {
              await db
                .update(tasks)
                .set({ output: deterministicFallback })
                .where(eq(tasks.id, task.id));
            }
            await this.log(
              "QA",
              `Using deterministic fallback for instruction-dump failure in ${filePath}`,
              firstTask.id,
            );
            for (const task of taskGroup) {
              await this.completeTask(task);
            }
            return;
          }
        }
      }

      if (firstTask.retryCount < MAX_RETRIES) {
        for (const task of taskGroup) {
          await db
            .update(tasks)
            .set({
              retryCount: task.retryCount + 1,
              qAReason: result.reason || "Validation failed",
            })
            .where(eq(tasks.id, task.id));
          await this.setStatus(task.id, "ready");
        }
        await this.log(
          "QA",
          `Retrying ${filePath} (${firstTask.retryCount + 1}/${MAX_RETRIES})`,
          firstTask.id,
        );
        const updatedGroup = await db.query.tasks.findMany({
          where: and(
            eq(tasks.projectId, this.projectId),
            eq(tasks.status, "ready"),
            eq(tasks.filePath, filePath),
          ),
          orderBy: [asc(tasks.id)],
        });
        if (updatedGroup.length > 0) {
          await this.executeSpec(filePath, requirements, updatedGroup);
        }
      } else {
        // Final fallback chain: recovery → deterministic → stuck
        // Try LLM recovery first
        const recovered = await this.recoverFromFailure(
          filePath,
          requirements.join("; "),
          finalOutput,
          firstTask.id,
        );
        if (recovered) {
          await this.writeOutputFile(filePath, recovered);
          for (const task of taskGroup) {
            await db
              .update(tasks)
              .set({ output: recovered })
              .where(eq(tasks.id, task.id));
          }
          await this.log(
            "QA",
            `Recovery succeeded for ${filePath} after retries exhausted`,
            firstTask.id,
          );
          for (const task of taskGroup) {
            await this.completeTask(task);
          }
          return;
        }

        // Recovery failed — try deterministic fallback
        const deterministicFallback = this.deterministicDraftByFile[filePath];
        if (deterministicFallback) {
          const fallbackResult = validateOutput(
            deterministicFallback,
            filePath,
            { allowScaffold: true },
          );
          if (fallbackResult.valid) {
            await this.writeOutputFile(filePath, deterministicFallback);
            for (const task of taskGroup) {
              await db
                .update(tasks)
                .set({ output: deterministicFallback })
                .where(eq(tasks.id, task.id));
            }
            await this.log(
              "QA",
              `Using deterministic fallback for ${filePath} after retries exhausted`,
              firstTask.id,
            );
            for (const task of taskGroup) {
              await this.completeTask(task);
            }
            return;
          }
        }

        for (const task of taskGroup) {
          await this.markStuck(
            task.id,
            `Validation failed ${MAX_RETRIES} times: ${result.reason}`,
          );
        }
      }
    }
  }

  // ─────────────────────────────────────────────
  //  LLM-BASED RECOVERY (3-layer fallback system)
  // ─────────────────────────────────────────────

  /**
   * Three-layer recovery when a step produces invalid output:
   *
   * Layer 1: CLEANER — Ask an LLM to extract code from the garbled output.
   *          Works when the model mixed valid code with echoed instructions.
   *
   * Layer 2: MINIMAL RETRY — Use a radically shortened prompt to avoid
   *          overwhelming the model. Long/complex prompts cause echoing.
   *
   * Layer 3: ALT-MODEL FALLBACK — Try the same request on a different
   *          locally-available model. Different models fail differently.
   *
   * @returns The recovered code string if any layer succeeds, or null.
   */
  private async recoverFromFailure(
    filePath: string,
    requirement: string,
    garbageOutput: string | null,
    taskId: number,
  ): Promise<string | null> {
    const context = `${this.projectName} — ${this.projectDescription}`;

    // ── Layer 1: Cleaner Agent ──
    if (garbageOutput && garbageOutput.trim().length > 30) {
      await this.log(
        "RECOVER",
        `Layer 1: Attempting to clean garbled output for ${filePath}`,
        taskId,
      );

      const cleanResult = await runCleaner(
        this.model,
        garbageOutput,
        filePath,
        context,
      );

      if (cleanResult.cleaned) {
        const validation = validateOutput(cleanResult.cleaned, filePath, {
          allowScaffold: true,
        });
        if (validation.valid) {
          await this.log(
            "RECOVER",
            `Layer 1 SUCCESS: Cleaner extracted valid code (${cleanResult.tokens} tokens)`,
            taskId,
            cleanResult.prompt,
            cleanResult.raw,
          );
          return cleanResult.cleaned;
        }
        await this.log(
          "RECOVER",
          `Layer 1 FAIL: Cleaned output still invalid: ${validation.reason}`,
          taskId,
          cleanResult.prompt,
          cleanResult.raw,
        );
      } else {
        await this.log(
          "RECOVER",
          "Layer 1 FAIL: Cleaner could not extract any code",
          taskId,
        );
      }
    }

    // ── Layer 2: Minimal Retry ──
    await this.log(
      "RECOVER",
      `Layer 2: Minimal prompt retry for ${filePath}`,
      taskId,
    );

    const minimalResult = await runMinimalRetry(
      this.model,
      filePath,
      requirement,
      this.projectName,
    );

    if (minimalResult.cleaned) {
      const validation = validateOutput(minimalResult.cleaned, filePath, {
        allowScaffold: true,
      });
      if (validation.valid) {
        await this.log(
          "RECOVER",
          `Layer 2 SUCCESS: Minimal prompt produced valid code (${minimalResult.tokens} tokens)`,
          taskId,
          minimalResult.prompt,
          minimalResult.raw,
        );
        return minimalResult.cleaned;
      }
      await this.log(
        "RECOVER",
        `Layer 2 FAIL: Minimal retry still invalid: ${validation.reason}`,
        taskId,
        minimalResult.prompt,
        minimalResult.raw,
      );
    } else {
      await this.log(
        "RECOVER",
        "Layer 2 FAIL: Minimal retry produced no parseable output",
        taskId,
      );
    }

    // ── Layer 3: Scaffold Tactic ──
    // Break the task into skeleton + fill-in — two simpler calls instead of one complex one
    await this.log(
      "RECOVER",
      `Layer 3: Scaffold tactic (skeleton → fill) for ${filePath}`,
      taskId,
    );

    const scaffoldResult = await runScaffoldTactic(
      this.model,
      filePath,
      requirement,
      this.projectName,
    );

    if (scaffoldResult.cleaned) {
      const validation = validateOutput(scaffoldResult.cleaned, filePath, {
        allowScaffold: true,
      });
      if (validation.valid) {
        await this.log(
          "RECOVER",
          `Layer 3 SUCCESS: Scaffold tactic produced valid code (${scaffoldResult.tokens} tokens)`,
          taskId,
          scaffoldResult.prompt,
          scaffoldResult.raw,
        );
        return scaffoldResult.cleaned;
      }
      await this.log(
        "RECOVER",
        `Layer 3 FAIL: Scaffold output invalid: ${validation.reason}`,
        taskId,
        scaffoldResult.prompt,
        scaffoldResult.raw,
      );
    } else {
      await this.log(
        "RECOVER",
        "Layer 3 FAIL: Scaffold tactic produced no parseable output",
        taskId,
      );
    }

    // ── Layer 4: Reframe Tactic ──
    // Completely different prompt style — "file generator" persona, no TTM format
    await this.log(
      "RECOVER",
      `Layer 4: Reframe tactic (file-generator persona) for ${filePath}`,
      taskId,
    );

    const reframeResult = await runReframeTactic(
      this.model,
      filePath,
      requirement,
      this.projectName,
    );

    if (reframeResult.cleaned) {
      const validation = validateOutput(reframeResult.cleaned, filePath, {
        allowScaffold: true,
      });
      if (validation.valid) {
        await this.log(
          "RECOVER",
          `Layer 4 SUCCESS: Reframe tactic produced valid code (${reframeResult.tokens} tokens)`,
          taskId,
          reframeResult.prompt,
          reframeResult.raw,
        );
        return reframeResult.cleaned;
      }
      await this.log(
        "RECOVER",
        `Layer 4 FAIL: Reframe output invalid: ${validation.reason}`,
        taskId,
        reframeResult.prompt,
        reframeResult.raw,
      );
    } else {
      await this.log(
        "RECOVER",
        "Layer 4 FAIL: Reframe tactic produced no parseable output",
        taskId,
      );
    }

    await this.log(
      "RECOVER",
      "All 4 recovery layers exhausted — no valid output produced",
      taskId,
    );
    return null;
  }

  // ─────────────────────────────────────────────
  //  JUDGE PHASE (post-Execute gate)
  // ─────────────────────────────────────────────

  /**
   * Inspect what Execute actually produced and set this.judgeVerdict.
   *
   * Checks every TypeScript/TSX/JSX file in the manifest:
   *   - "substantial": > 150 non-whitespace chars (has real content)
   *   - "thin": <= 150 (scaffold-only or essentially empty)
   *   - "missing": not on disk at all
   *
   * Verdicts:
   *   proceed     — majority of files are substantial → normal QA
   *   warn        — some files are thin but majority OK → normal QA, log warning
   *   skip_vitest — majority are thin/missing → skip vitest (would crash-loop
   *                 against symptoms instead of the actual problem)
   *
   * Non-TS projects (markdown, JSON, Python) always get "proceed" since
   * vitest doesn't apply to them anyway.
   */
  private async runJudgePhase() {
    const SUBSTANTIAL = 150; // non-whitespace chars

    const tsFiles = this.manifest.filter((f) =>
      ["ts", "tsx", "jsx"].includes(
        f.path.split(".").pop()?.toLowerCase() ?? "",
      ),
    );

    if (tsFiles.length === 0) {
      this.judgeVerdict = "proceed";
      return;
    }

    let substantial = 0;
    let thin = 0;
    let missing = 0;

    for (const file of tsFiles) {
      const content = this.getCurrentFileContent(file.path);
      if (!content) {
        missing++;
        continue;
      }
      const nonWs = content.replace(/\s/g, "").length;
      if (nonWs >= SUBSTANTIAL) substantial++;
      else thin++;
    }

    const total = tsFiles.length;
    const summary = `${substantial}/${total} files substantial, ${thin} thin, ${missing} missing`;

    if (missing + thin > substantial) {
      await this.log(
        "JUDGE",
        `${summary} → SKIP_VITEST: most output is insufficient; skipping test runner to avoid crash-loop`,
      );
      this.judgeVerdict = "skip_vitest";
    } else if (thin > 0 || missing > 0) {
      await this.log(
        "JUDGE",
        `${summary} → WARN: some files are thin; QA may partially fail`,
      );
      this.judgeVerdict = "warn";
    } else {
      await this.log("JUDGE", `${summary} → PROCEED`);
      this.judgeVerdict = "proceed";
    }
  }

  // ─────────────────────────────────────────────
  //  FULL QA PIPELINE (reusable: called after execute AND feedback)
  // ─────────────────────────────────────────────

  /**
   * Runs the complete QA pipeline:
   *   1. Test-based QA (run vitest, fix failures one at a time) — PRIMARY
   *   2. Holistic review (structural checks — programmatic only)
   *   3. Iterative QA (LLM find-one-fix-one) — ONLY if tests failed
   *   4. Improve pass — ONLY if tests failed
   *   5. Consistency check
   *
   * When TDD tests all pass, skip the expensive LLM-based QA passes.
   * Small models hallucinate phantom issues and introduce bugs while "fixing" them.
   */
  private async runFullQA() {
    if (this.judgeVerdict === "skip_vitest") {
      await this.log(
        "QA",
        "Judge: skipping vitest (insufficient output) — running holistic + consistency only",
      );
      await this.runHolisticReviewPass();
      await this.runConsistencyCheck();
      return;
    }

    const tddFiles = this.manifest.filter((f) => supportsTDD(f.path));
    let testsAllPassed = tddFiles.length > 0;
    for (const tddFile of tddFiles) {
      const passed = await this.runTestQA(tddFile.path);
      if (!passed) testsAllPassed = false;
    }
    await this.runHolisticReviewPass();

    if (testsAllPassed) {
      await this.log(
        "QA",
        "Tests all pass — skipping iterative QA and improvement (would risk introducing bugs)",
      );
    } else {
      // Tests failed or don't exist: fall back to LLM-based QA as secondary safety net
      await this.runIterativeQAPass();
      await this.runImprovementPass();
    }

    // Progress review (PM honing): cheap final pass that compares the spec
    // to the built files and patches in genuinely missing spec features.
    // Runs whether or not tests passed — spec drift is orthogonal to bug
    // count, e.g. a project may build cleanly but be missing the "delete"
    // button the spec asked for.
    await this.runProgressReviewPass();

    // Visual QA — render the UI in headless Chromium and ask a vision
    // model whether it matches the spec. Only runs for vision-capable
    // models (gemma3+, llava, etc). Reports issues via REV log entries;
    // does NOT auto-fix (vision verdicts are noisy — surface to user).
    await this.runVisualQAPass();

    await this.runConsistencyCheck();
  }

  // ─────────────────────────────────────────────
  //  TDD: TEST GENERATION
  // ─────────────────────────────────────────────

  /** Max attempts to fix the test file itself when vitest crashes */
  private static readonly MAX_TEST_REPAIR_ATTEMPTS = 2; // repairs per individual test name

  /** Max test-fix rounds (run tests → fix first failure → repeat) */
  private static readonly MAX_TEST_FIX_ROUNDS = 5;

  /**
   * Generate tests from project requirements using the test-writer agent.
   * Called before code generation (TDD: tests first).
   * Only for file types that support TDD.
   */
  private async generateTests(
    requirements: string[],
    targetFile?: string,
    manifestDescription?: string,
  ) {
    // Store so repairSingleTest can regenerate from scratch if stuck
    this.lastGenerateRequirements = requirements;
    this.lastGenerateManifestDescription = manifestDescription;

    const file = targetFile || this.manifest[0]?.path || "output.txt";
    const ext = file.split(".").pop()?.toLowerCase() || "";
    const testFile = file.replace(
      /\.\w+$/,
      `.test.${ext === "tsx" || ext === "jsx" ? "tsx" : ext}`,
    );

    await this.log("TDD", `Generating tests for ${file}...`);

    // Read the already-written code file to extract the real export name.
    // Tests are now generated after Execute, so the file exists.
    const outDir = this.outputDir();
    let exportName: string | undefined;
    const codePath = path.join(outDir, file);
    let fileContent: string | undefined;
    if (fs.existsSync(codePath)) {
      fileContent = fs.readFileSync(codePath, "utf-8");
      // Match: export default function FooBar or export default class FooBar
      const match = fileContent.match(
        /export\s+default\s+(?:function|class)\s+(\w+)/,
      );
      if (match) exportName = match[1];
    }

    // Deterministically extract component structure from source before asking the LLM.
    // This gives the test writer exact prop shapes, button labels, and input presence
    // without requiring it to read or understand the source code itself.
    const componentAnalysis =
      fileContent && fileContent.trim().length > 50
        ? analyzeComponent(fileContent)
        : undefined;

    // For container components (e.g. App.tsx) that import leaf components, the
    // interactive elements (buttons, inputs) live in the children, not in the
    // container source. Scan local imports and merge child analyses so the test
    // writer knows what accessible names will actually appear in the DOM.
    if (componentAnalysis && fileContent) {
      const localImportRe =
        /import\s+\w+\s+from\s+["']\.\/([^"'./][^"']*?)["']/g;
      let importMatch;
      while ((importMatch = localImportRe.exec(fileContent)) !== null) {
        const importedName = importMatch[1];
        for (const ext of [".tsx", ".jsx", ".ts", ".js"]) {
          const childPath = path.join(outDir, importedName + ext);
          if (fs.existsSync(childPath)) {
            const childContent = fs.readFileSync(childPath, "utf-8");
            const childAnalysis = analyzeComponent(childContent);
            for (const btn of childAnalysis.buttonTexts) {
              if (!componentAnalysis.buttonTexts.includes(btn)) {
                componentAnalysis.buttonTexts.push(btn);
              }
            }
            for (const ph of childAnalysis.inputPlaceholders) {
              if (!componentAnalysis.inputPlaceholders.includes(ph)) {
                componentAnalysis.inputPlaceholders.push(ph);
              }
            }
            for (const al of childAnalysis.ariaLabels) {
              if (!componentAnalysis.ariaLabels.includes(al)) {
                componentAnalysis.ariaLabels.push(al);
              }
            }
            if (childAnalysis.hasInput) {
              componentAnalysis.hasInput = true;
            }
            break;
          }
        }
      }
    }

    if (componentAnalysis) {
      await this.log(
        "TDD",
        `Component analysis: ${componentAnalysis.requiredProps.length} required props, ` +
          `${componentAnalysis.buttonTexts.length} buttons (${componentAnalysis.buttonTexts
            .slice(0, 3)
            .map((b) => `"${b}"`)
            .join(", ")}), ` +
          `hasInput=${componentAnalysis.hasInput}`,
      );
    }

    let result = await runTestWriter(
      this.model,
      this.projectName,
      this.projectDescription,
      requirements,
      file,
      exportName,
      fileContent && fileContent.trim().length > 100 ? fileContent : undefined,
      manifestDescription,
      componentAnalysis,
    );

    if (!result.tests) {
      // Retry once with a slightly different prompt framing before giving up.
      await this.log(
        "TDD",
        "Test writer produced no tests on first attempt — retrying...",
        undefined,
        result.prompt,
        result.raw,
      );
      result = await runTestWriter(
        this.model,
        this.projectName,
        this.projectDescription,
        requirements,
        file,
        exportName,
        fileContent && fileContent.trim().length > 100
          ? fileContent
          : undefined,
        manifestDescription,
        componentAnalysis,
      );
    }

    if (!result.tests) {
      await this.log(
        "TDD",
        "Test writer failed to produce tests after retry — skipping TDD",
        undefined,
        result.prompt,
        result.raw,
      );
      return;
    }

    // Auto-repair the test output (strip fences, trailing text, fix braces)
    const { repaired, fixes } = autoRepairOutput(result.tests, testFile);
    if (fixes.length > 0) {
      await this.log("TDD", `Auto-repaired test file: ${fixes.join(", ")}`);
    }

    // Reject test files that contain no actual tests.
    // The model sometimes generates a full component implementation instead of tests.
    // If there's no describe() or it() call, the file is useless as a test file.
    const hasTests = /\bit\s*\(|\bdescribe\s*\(|\btest\s*\(/.test(repaired);
    if (!hasTests) {
      await this.log(
        "TDD",
        `Generated ${testFile} contains no tests (model wrote implementation code) — discarding`,
        undefined,
        result.prompt,
        result.raw,
      );
      return;
    }

    const testPath = path.join(outDir, testFile);
    // Ensure the target directory exists (handles nested manifest paths)
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, repaired, "utf-8");

    await this.log(
      "TDD",
      `Generated ${testFile} (${result.tokens} tokens, ${result.durationMs}ms)`,
      undefined,
      result.prompt,
      result.raw,
    );
  }

  // ─────────────────────────────────────────────
  //  TDD: TEST-BASED QA (run tests → fix failures one at a time)
  // ─────────────────────────────────────────────

  /**
   * Run vitest against the test file for the primary code file.
   * For each failing test: feed the error to the Developer agent → fix → re-run.
   * If vitest itself crashes (bad test syntax), repair the test file first.
   * @returns true if all tests pass (or no test file exists), false if failures remain
   */
  private async runTestQA(targetFile?: string): Promise<boolean> {
    // Clear per-run repair state so stuck detection doesn't bleed across TDD calls
    this.lastRepairError.clear();
    this.regenerateCount.clear();

    // Determine the primary code file and its test file
    const primaryFile =
      targetFile || this.manifest.find((f) => supportsTDD(f.path))?.path;
    if (!primaryFile) {
      await this.log(
        "TDD",
        "No testable file in manifest — skipping test-based QA",
      );
      return false;
    }

    const ext = primaryFile.split(".").pop()?.toLowerCase() || "";
    const testFileName = primaryFile.replace(
      /\.\w+$/,
      `.test.${ext === "tsx" || ext === "jsx" ? "tsx" : ext}`,
    );

    const outDir = this.outputDir();
    const testPath = path.join(outDir, testFileName);

    if (!fs.existsSync(testPath)) {
      await this.log(
        "TDD",
        `No test file (${testFileName}) found — skipping test-based QA`,
      );
      return false;
    }

    const codePath = path.join(outDir, primaryFile);
    if (!fs.existsSync(codePath)) {
      await this.log(
        "TDD",
        `No code file (${primaryFile}) — skipping test-based QA`,
      );
      return false;
    }

    await this.log("TDD", "Running tests...");

    // Fix import in test file to match the component's actual export name
    await this.fixTestImport(primaryFile);

    // Reconcile placeholder/button text in test to match what the component actually renders
    this.reconcileTestPlaceholders(primaryFile);

    let testResult = runTests(this.projectId, testFileName);

    // If vitest crashed (bad test syntax, missing import), try to repair the test file
    if (testResult.crashed) {
      await this.log(
        "TDD",
        `Tests crashed: ${testResult.crashError || "unknown error"}`,
      );

      const repaired = await this.repairTestFile(testResult, primaryFile);
      if (repaired) {
        testResult = runTests(this.projectId, testFileName);
      }

      if (testResult.crashed) {
        await this.log(
          "TDD",
          "Tests still crashing after repair — removing bad test file",
        );
        // Remove the bad test file so it doesn't interfere
        if (fs.existsSync(testPath)) fs.unlinkSync(testPath);
        return false;
      }
    }

    await this.log(
      "TDD",
      `Initial results: ${testResult.passed} passed, ${testResult.failed} failed, ${testResult.total} total`,
    );

    if (testResult.total === 0 && !testResult.crashed) {
      await this.log(
        "TDD",
        "0 tests ran — test file has import/parse errors. Falling back to LLM QA.",
      );
      return false;
    }

    if (testResult.failed === 0) {
      await this.log("TDD", "All tests passing!");
      return true;
    }

    // Fix failures one at a time
    let round = 0;
    // Track how many times repairSingleTest has been called for each test name.
    // Once a test has been through MAX_TEST_REPAIR_ATTEMPTS repairs without
    // resolving, drop it rather than looping indefinitely.
    const testRepairCount = new Map<string, number>();
    // Track consecutive validation failures per test: if the developer keeps
    // producing syntactically-broken code for the same test, the test itself
    // might be impossible — trigger repairSingleTest instead of spinning.
    const validationFailStreak = new Map<string, number>();
    while (round < Pipeline.MAX_TEST_FIX_ROUNDS && !this.aborted) {
      round++;

      const failure = getFirstFailure(testResult);
      if (!failure) {
        await this.log("TDD", "All tests passing!");
        break;
      }

      await this.log(
        "TDD",
        `Round ${round}/${Pipeline.MAX_TEST_FIX_ROUNDS}: fixing "${failure.name}"`,
      );
      await this.log(
        "TDD",
        `Error: ${failure.error?.slice(0, 300) || "unknown"}`,
      );

      // Read current code file
      const currentComponent = fs.readFileSync(
        path.join(outDir, primaryFile),
        "utf-8",
      );
      const currentTest = fs.readFileSync(testPath, "utf-8");

      // Build fix prompt — truncated code + only the failing test + error
      // Small models struggle with huge prompts; keep it focused.
      const truncatedComponent = this.truncateForPrompt(currentComponent, 100);
      const relevantTest = this.extractRelevantTest(currentTest, failure.name);

      let userMessage = `Project: ${this.projectName} — ${this.projectDescription}\n\n`;
      userMessage += `Current ${primaryFile}:\n${truncatedComponent}\n\n`;
      userMessage += `Failing test (DO NOT MODIFY TESTS — fix the code):\n${relevantTest}\n\n`;
      userMessage += `FAILING TEST: "${failure.name}"\n`;
      userMessage += `ERROR:\n${(failure.error || "Test failed").slice(0, 500)}\n\n`;
      userMessage += `Fix the ${primaryFile} so this test passes. Output the COMPLETE ${primaryFile}.`;

      userMessage = this.withCustomInstructions(userMessage);
      this.warnIfPromptTooLarge(`TDD fix round ${round}`, userMessage);

      const devResult = await runDeveloper(
        this.model,
        userMessage,
        primaryFile,
      );

      if (!devResult.block) {
        await this.log(
          "TDD",
          `Round ${round}: Developer parse failure — skipping`,
          undefined,
          devResult.prompt,
          devResult.raw,
        );
        // If the component can't be fixed, maybe the test is bad — try fixing the test
        const testFixed = await this.repairSingleTest(
          failure,
          currentComponent,
          currentTest,
          primaryFile,
        );
        if (testFixed) {
          testResult = runTests(this.projectId, testFileName);
          continue;
        }
        break;
      }

      const { repaired, fixes } = autoRepairOutput(
        devResult.block.output,
        primaryFile,
      );
      if (fixes.length > 0) {
        await this.log("TDD", `Auto-repaired: ${fixes.join(", ")}`);
      }

      const validation = validateOutput(repaired, primaryFile);
      if (!validation.valid) {
        await this.log(
          "TDD",
          `Round ${round}: Fix failed validation: ${validation.reason}`,
          undefined,
          devResult.prompt,
          devResult.raw,
        );
        // Track consecutive validation failures for this test. After 2 failures
        // the developer is stuck — the test might be impossible. Try repairing
        // the test instead of continuing to generate broken component code.
        const streak = (validationFailStreak.get(failure.name) ?? 0) + 1;
        validationFailStreak.set(failure.name, streak);
        if (streak >= 2) {
          const repairs = testRepairCount.get(failure.name) ?? 0;
          if (repairs < Pipeline.MAX_TEST_REPAIR_ATTEMPTS) {
            testRepairCount.set(failure.name, repairs + 1);
            validationFailStreak.set(failure.name, 0); // reset streak after repair
            const testFixed = await this.repairSingleTest(
              failure,
              currentComponent,
              fs.readFileSync(testPath, "utf-8"),
              primaryFile,
            );
            if (testFixed) {
              testResult = runTests(this.projectId, testFileName);
              if (testResult.failed === 0) break;
            }
          }
        }
        continue;
      }
      // Reset streak on a valid fix attempt
      validationFailStreak.set(failure.name, 0);

      // Write the fixed code and re-run tests
      await this.writeOutputFile(primaryFile, repaired);
      const newResult = runTests(this.projectId, testFileName);

      if (newResult.crashed) {
        await this.log(
          "TDD",
          `Round ${round}: Tests crashed after fix — reverting`,
        );
        await this.writeOutputFile(primaryFile, currentComponent);
        // The test might have wrong expectations. Try repairing it, but only
        // up to MAX_TEST_REPAIR_ATTEMPTS times per test name to avoid spinning.
        const repairs = testRepairCount.get(failure.name) ?? 0;
        if (repairs < Pipeline.MAX_TEST_REPAIR_ATTEMPTS) {
          testRepairCount.set(failure.name, repairs + 1);
          // Re-read the test after the crash (it may have been modified by the failed fix)
          const freshTestCode = fs.readFileSync(testPath, "utf-8");
          const testFixed = await this.repairSingleTest(
            failure,
            currentComponent,
            freshTestCode,
            primaryFile,
          );
          if (testFixed) {
            testResult = runTests(this.projectId, testFileName);
            continue;
          }
        } else {
          await this.log(
            "TDD",
            `Test "${failure.name}" repair limit reached — dropping`,
          );
        }
        testResult.tests = testResult.tests.filter(
          (t) => t.name !== failure.name,
        );
        continue;
      }

      if (newResult.failed < testResult.failed) {
        await this.log(
          "TDD",
          `Round ${round}: Fixed! ${newResult.passed} passed, ${newResult.failed} failed`,
          undefined,
          devResult.prompt,
          devResult.raw,
        );
        testResult = newResult;
      } else if (newResult.failed >= testResult.failed) {
        // Fix didn't help or made things worse
        await this.log(
          "TDD",
          `Round ${round}: Fix didn't reduce failures (was ${testResult.failed}, now ${newResult.failed})`,
          undefined,
          devResult.prompt,
          devResult.raw,
        );
        // If the same test is still failing after component fix attempts,
        // the test itself might be wrong — repair it (capped per test name)
        const sameTestStillFailing = newResult.tests.find(
          (t) => t.name === failure.name && t.status === "fail",
        );
        if (round >= 2 && sameTestStillFailing) {
          const repairs = testRepairCount.get(failure.name) ?? 0;
          if (repairs < Pipeline.MAX_TEST_REPAIR_ATTEMPTS) {
            testRepairCount.set(failure.name, repairs + 1);
            // Use fresh error from the latest run and fresh test content
            const latestFailure = sameTestStillFailing as {
              name: string;
              error?: string;
            };
            const testFixed = await this.repairSingleTest(
              latestFailure,
              repaired,
              fs.readFileSync(testPath, "utf-8"),
              primaryFile,
            );
            if (testFixed) {
              testResult = runTests(this.projectId, testFileName);
              continue;
            }
          } else {
            await this.log(
              "TDD",
              `Test "${failure.name}" repair limit reached — dropping`,
            );
            newResult.tests = newResult.tests.filter(
              (t) => t.name !== failure.name,
            );
          }
        }
        testResult = newResult;
      }

      if (testResult.failed === 0) break;
    }

    if (round >= Pipeline.MAX_TEST_FIX_ROUNDS && testResult.failed > 0) {
      await this.log(
        "TDD",
        `Hit max fix rounds (${Pipeline.MAX_TEST_FIX_ROUNDS}) with ${testResult.failed} still failing`,
      );
      // Store failure for iterativeQA so it can focus on the same root cause
      const firstFail = getFirstFailure(testResult);
      if (firstFail) {
        this.lastTestFailure = `Test: "${firstFail.name}"\nError: ${(firstFail.error || "").slice(0, 300)}`;
      }
    }

    await this.log(
      "TDD",
      `Test QA complete: ${testResult.passed}/${testResult.total} passing after ${round} rounds`,
    );

    return testResult.failed === 0;
  }

  /**
   * Reconcile getByPlaceholderText() and getByRole('button', {name:...}) calls in the test
   * with what the component actually renders. Replaces guessed values with actual ones.
   */
  private reconcileTestPlaceholders(targetFile: string): void {
    const ext = targetFile.split(".").pop()?.toLowerCase() || "";
    const testFileName = targetFile.replace(
      /\.\w+$/,
      `.test.${ext === "tsx" || ext === "jsx" ? "tsx" : ext}`,
    );

    const outDir = this.outputDir();
    const testPath = path.join(outDir, testFileName);
    const codePath = path.join(outDir, targetFile);

    if (!fs.existsSync(testPath) || !fs.existsSync(codePath)) return;

    const codeContent = fs.readFileSync(codePath, "utf-8");
    let testContent = fs.readFileSync(testPath, "utf-8");

    let changed = false;

    // 1. Extract actual placeholder values from the component
    const placeholderMatches = [
      ...codeContent.matchAll(/placeholder=["']([^"']{3,})["']/g),
    ];
    const actualPlaceholders = placeholderMatches.map((m) => m[1]);

    if (actualPlaceholders.length > 0) {
      // Replace any getByPlaceholderText(/regex/i) or getByPlaceholderText("string") with
      // the actual first placeholder from the component
      const actual = actualPlaceholders[0];
      const patched = testContent.replace(
        /getByPlaceholderText\(\s*(?:\/[^/]+\/[ig]*|["'][^"']*["'])\s*\)/g,
        () => `getByPlaceholderText("${actual}")`,
      );
      if (patched !== testContent) {
        testContent = patched;
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(testPath, testContent, "utf-8");
    }
  }

  /**
   * Fix the test file import to match the code's actual exported function name.
   * The test-writer might import "Component" but the actual export could be different.
   */
  private async fixTestImport(targetFile?: string) {
    const primaryFile =
      targetFile || this.manifest.find((f) => supportsTDD(f.path))?.path;
    if (!primaryFile) return;

    const ext = primaryFile.split(".").pop()?.toLowerCase() || "";
    const testFileName = primaryFile.replace(
      /\.\w+$/,
      `.test.${ext === "tsx" || ext === "jsx" ? "tsx" : ext}`,
    );
    const baseName = primaryFile.replace(/\.\w+$/, "");

    const outDir = this.outputDir();
    const testPath = path.join(outDir, testFileName);
    const codePath = path.join(outDir, primaryFile);

    if (!fs.existsSync(testPath) || !fs.existsSync(codePath)) return;

    const codeContent = fs.readFileSync(codePath, "utf-8");
    const testCode = fs.readFileSync(testPath, "utf-8");

    // Detect the actual export name from the code
    const exportMatch = codeContent.match(
      /export\s+default\s+function\s+(\w+)/,
    );
    if (!exportMatch) return; // Can't determine — leave as is

    const actualName = exportMatch[1];

    // Fix the import in the test file
    // Replace: import X from "./BaseName" → import ActualName from "./BaseName"
    let fixed = testCode
      .replace(
        new RegExp(
          `import\\s+(\\w+)\\s+from\\s+["']\\.\/${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
          "g",
        ),
        `import ${actualName} from "./${baseName}"`,
      )
      .replace(
        new RegExp(
          `import\\s+\\{\\s*(\\w+)\\s*\\}\\s+from\\s+["']\\.\/${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
          "g",
        ),
        `import ${actualName} from "./${baseName}"`,
      );

    // Replace usage of the old name with the new one
    const importMatch = testCode.match(
      new RegExp(
        `import\\s+(\\w+)\\s+from\\s+["']\\.\/${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
      ),
    );
    if (importMatch && importMatch[1] !== actualName) {
      const oldName = importMatch[1];
      const lines = fixed.split("\n");
      fixed = lines
        .map((line) => {
          if (line.match(/^\s*import\s/)) return line;
          return line.replace(new RegExp(`\\b${oldName}\\b`, "g"), actualName);
        })
        .join("\n");
    }

    if (fixed !== testCode) {
      fs.writeFileSync(testPath, fixed, "utf-8");
      await this.log("TDD", `Fixed test import: using ${actualName}`);
    }
  }

  /**
   * Repair the test file when vitest crashes (syntax error, bad import, etc.).
   * Sends the crash error + test file to the LLM to fix.
   */
  private async repairTestFile(
    crashResult: TestRunResult,
    targetFile?: string,
  ): Promise<boolean> {
    const primaryFile =
      targetFile || this.manifest.find((f) => supportsTDD(f.path))?.path;
    if (!primaryFile) return false;

    const ext = primaryFile.split(".").pop()?.toLowerCase() || "";
    const testFileName = primaryFile.replace(
      /\.\w+$/,
      `.test.${ext === "tsx" || ext === "jsx" ? "tsx" : ext}`,
    );
    const baseName = primaryFile.replace(/\.\w+$/, "");
    const isTSX = ext === "tsx" || ext === "jsx";

    const outDir = this.outputDir();
    const testPath = path.join(outDir, testFileName);

    if (!fs.existsSync(testPath)) return false;

    const testCode = fs.readFileSync(testPath, "utf-8");
    const codeContent = fs.existsSync(path.join(outDir, primaryFile))
      ? fs.readFileSync(path.join(outDir, primaryFile), "utf-8")
      : "";

    for (
      let attempt = 1;
      attempt <= Pipeline.MAX_TEST_REPAIR_ATTEMPTS;
      attempt++
    ) {
      await this.log("TDD", `Repairing test file (attempt ${attempt})...`);

      const REPAIR_PROMPT = `Fix this broken test file. It crashes when run with vitest.
Rules:
- Use vitest imports: import { describe, it, expect } from "vitest"
${
  isTSX
    ? `- Use @testing-library/react: import { render, screen, fireEvent } from "@testing-library/react"
- Import the component with default import from "./${baseName}"`
    : `- Import the module from "./${baseName}"`
}
- Keep tests simple. No mocking.
- Output ONLY code. No explanations.

Reply:
>>RESULT
status: DONE
filePath: ${testFileName}
output: |
  (fixed test code)
>>END`;

      let userMessage = `The test file crashes with this error:\n${(crashResult.crashError || crashResult.rawOutput.slice(0, 500)).slice(0, 500)}\n\n`;
      userMessage += `Current test file:\n${this.truncateForPrompt(testCode, 60)}\n\n`;
      if (codeContent) {
        const exportLine =
          codeContent.match(/export\s+default\s+function\s+\w+[^{]*/)?.[0] ||
          "";
        userMessage += `Code export: ${exportLine}\n\n`;
      }
      userMessage += `Fix the test file so it runs without crashing.`;

      const result = await callOllamaFn(
        this.model,
        "qa",
        REPAIR_PROMPT,
        userMessage,
      );

      const parsed = parseTTM(result.text);
      const block =
        parsed && "output" in parsed ? (parsed as { output: string }) : null;

      if (!block) {
        await this.log(
          "TDD",
          `Repair attempt ${attempt}: parse failure`,
          undefined,
          result.prompt,
          result.text,
        );
        continue;
      }

      const { repaired } = autoRepairOutput(block.output, testFileName);
      fs.writeFileSync(testPath, repaired, "utf-8");

      // Try running tests again
      const retryResult = runTests(this.projectId, testFileName);
      if (!retryResult.crashed) {
        await this.log("TDD", "Test file repaired successfully");
        return true;
      }

      await this.log(
        "TDD",
        `Repair attempt ${attempt}: still crashing — ${retryResult.crashError}`,
      );
    }

    return false;
  }

  /**
   * When a single test keeps failing after component fixes,
   * the test itself might be wrong. Remove or fix it.
   *
   * Escalation strategy (inspired by stuck-detection in autonomous loops):
   *   1st call  → patch mode: fix the specific assertion, keep other tests
   *   2nd call with same error → rewrite mode: rewrite the whole failing test
   *                              block with roles tree prominently featured
   *   3rd call (still stuck)  → regenerate: discard test file, call
   *                              generateTests() from scratch (capped at 1)
   *
   * "If the same evidence appears twice in a row, you have nothing new to act
   *  on — escalate, don't repeat." (autonomous loop check pattern)
   */
  private async repairSingleTest(
    failure: { name: string; error?: string },
    componentCode: string,
    testCode: string,
    targetFile?: string,
  ): Promise<boolean> {
    const primaryFile =
      targetFile || this.manifest.find((f) => supportsTDD(f.path))?.path;
    if (!primaryFile) return false;

    const ext = primaryFile.split(".").pop()?.toLowerCase() || "";
    const testFileName = primaryFile.replace(
      /\.\w+$/,
      `.test.${ext === "tsx" || ext === "jsx" ? "tsx" : ext}`,
    );

    const outDir = this.outputDir();
    const testPath = path.join(outDir, testFileName);

    // ── Stuck detection ──────────────────────────────────────────────────────
    // Hash the first 300 chars of the error (enough to distinguish different
    // failures, short enough to avoid false mismatches from pointer addresses).
    const errorFingerprint = (failure.error || "").slice(0, 300);
    const lastError = this.lastRepairError.get(failure.name);
    const isStuck = lastError !== undefined && lastError === errorFingerprint;
    this.lastRepairError.set(failure.name, errorFingerprint);

    // ── Regenerate path (3rd attempt, same error) ────────────────────────────
    if (isStuck) {
      const regenCount = this.regenerateCount.get(failure.name) ?? 0;
      if (regenCount >= 1) {
        await this.log(
          "TDD",
          `Test "${failure.name}" stuck after rewrite — dropping test`,
        );
        return false;
      }
      this.regenerateCount.set(failure.name, regenCount + 1);
      await this.log(
        "TDD",
        `Test "${failure.name}" still failing with same error — regenerating test file from scratch`,
      );
      await this.generateTests(
        this.lastGenerateRequirements,
        primaryFile,
        this.lastGenerateManifestDescription,
      );
      const regenResult = runTests(this.projectId, testFileName);
      if (!regenResult.crashed && regenResult.failed === 0) {
        await this.log("TDD", "Regenerated test file passes");
        // Update repair tracking so the next call doesn't think we're still stuck
        this.lastRepairError.delete(failure.name);
        return true;
      }
      await this.log(
        "TDD",
        `Regenerated tests: ${regenResult.passed} passed, ${regenResult.failed} failed`,
      );
      return regenResult.failed === 0;
    }

    // ── Mode selection ───────────────────────────────────────────────────────
    // rewriteMode = we've been here before (lastError was set but different, or
    // this is a second repair attempt). Determined by whether lastError existed.
    const rewriteMode = lastError !== undefined;
    await this.log(
      "TDD",
      `Test "${failure.name}" may be wrong — attempting ${rewriteMode ? "full rewrite" : "patch"} repair`,
    );

    // Extract UI hints from the component so the model can fix wrong queries
    // (e.g. getByRole("button", {name: /delete/i}) when the button says "×").
    const componentHints: string[] = [];
    const btnMatches =
      componentCode.match(/<button[^>]*>([^<]*)<\/button>/g) ?? [];
    btnMatches.forEach((m) => {
      const text = m.replace(/<[^>]+>/g, "").trim();
      if (text) componentHints.push(`button text: "${text}"`);
    });
    const ariaLabels =
      componentCode.match(/aria-label=["']([^"']+)["']/g) ?? [];
    ariaLabels.forEach((m) => componentHints.push(m));
    const placeholders =
      componentCode.match(/placeholder=["']([^"']+)["']/g) ?? [];
    placeholders.forEach((m) => componentHints.push(m));
    // Extract text+element patterns (e.g. <p>Label: <strong>{val}</strong></p>)
    // so the repair model knows text is split and cannot be matched by getByText.
    const splitTextPatterns =
      componentCode.match(
        /<(?:p|span|div|h[1-6])[^>]*>[^<]+<(?:strong|span|em|b)[^>]*>/g,
      ) ?? [];
    splitTextPatterns.forEach((m) => {
      const label = m.replace(/<[^>]+>/g, "").trim();
      if (label)
        componentHints.push(
          `split text (label + child element): "${label}..."`,
        );
    });

    // Detect the specific split-text error to give a targeted hint
    const isSplitTextError = (failure.error || "").includes(
      "broken up by multiple elements",
    );

    // Extract what text the test was searching for and find actual text patterns in the component
    let textMismatchHint = "";
    if (isSplitTextError) {
      const searchedMatch =
        /Unable to find an element with the text:\s*([^\n.]+)/i.exec(
          failure.error || "",
        );
      const searchedText = searchedMatch?.[1]?.trim();
      if (searchedText) {
        // Look for the searched label in JSX text patterns like {label} {value} {suffix}
        // e.g. searched "Streak: 12" → component has "Streak: {localStreak} days" → hint: "Streak: X days"
        const labelPrefix = searchedText.replace(/[:]\s*\S+.*$/, "").trim();
        if (labelPrefix) {
          // Find JSX that starts with this label prefix
          const jsxPattern = new RegExp(
            `(${labelPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^<"'\`\n]{1,40})`,
            "i",
          );
          const jsxMatch = jsxPattern.exec(componentCode);
          if (jsxMatch) {
            // Replace template literal expressions like {foo} with "X"
            const exampleText = jsxMatch[1]
              .replace(/\{[^}]+\}/g, "X")
              .replace(/\s+/g, " ")
              .trim();
            textMismatchHint = `\n- The test searched for "${searchedText}" but the component likely renders "${exampleText}". Use the correct text format.`;
          }
        }
      }
    }

    // ── Prompt assembly ──────────────────────────────────────────────────────
    // Extract roles tree first so we know prompt weight before choosing limits.
    const rolesTree = extractRolesTree(failure.error || "");

    // Prompt size guard: small models (~4k context) degrade when the prompt is
    // bloated. Estimate token count as chars/4. If the combined context would
    // exceed ~2000 tokens (8000 chars) for component + test alone, tighten
    // the truncation limits so the actual failure gets more of the budget.
    // Roles tree + error slice always included at full size.
    const rolesTreeLen = rolesTree ? rolesTree.length : 0;
    const errorLen = Math.min((failure.error || "").length, 2000);
    const contextBudgetChars = 8000 - rolesTreeLen - errorLen;
    const componentMaxLines = contextBudgetChars > 4000 ? 40 : 20;
    const testMaxLines = contextBudgetChars > 4000 ? 60 : 20;
    if (componentMaxLines < 40 || testMaxLines < 60) {
      await this.log(
        "TDD",
        `Prompt size guard active — trimming component to ${componentMaxLines} lines, test to ${testMaxLines} lines`,
      );
    }

    const REPAIR_PROMPT = rewriteMode
      ? `A test in this file has failed multiple times and could not be fixed by changing the component code.
Rewrite the ENTIRE failing test block so it tests the actual rendered output.
- Use only accessible roles and names you can see in the "Actual accessible roles" section.
- If there is no accessible name for a button, use getByRole('button') without a name option.
- Do NOT use getByText() for text that mixes static labels with dynamic values — use regex or getByRole.
- If the test is impossible to write correctly, remove it entirely.
- Keep all other passing tests unchanged.
- Output ONLY code. No explanations.

Reply:
>>RESULT
status: DONE
filePath: ${testFileName}
output: |
  (rewritten test file)
>>END`
      : `One test in this file always fails, even after multiple attempts to fix the code.
The test assertions are probably wrong — they reference UI elements that don't exist as written.
Fix the test so it correctly tests the actual behavior of the component.
If the test is testing something impossible, remove it.
- Output ONLY code. No explanations.
- Keep all other tests unchanged.${
          isSplitTextError
            ? `
- CRITICAL: The error says text is "broken up by multiple elements" — but this message appears for ANY text-not-found error. The real issue is that the searched text does not exactly match what the component renders. Check the component code for the actual rendered text.${textMismatchHint}
- If text like "Streak: X days" is spread across child elements, use a regex: getByText(/Streak: \\d+ days/i) or check by role instead.
- Do NOT use getByText() for any text that mixes a static label with a dynamic value unless you use a flexible regex.`
            : ""
        }

Reply:
>>RESULT
status: DONE
filePath: ${testFileName}
output: |
  (fixed test code)
>>END`;

    let userMessage = `Failing test: "${failure.name}"\n`;
    userMessage += `Error: ${(failure.error || "unknown").slice(0, 2000)}\n\n`;

    // Extract the vitest accessible-roles tree if present — this is the actual DOM
    // structure that testing-library sees, produced automatically when getByRole/
    // getByText/etc. fails. It tells the model exactly what roles and names exist.
    if (rolesTree) {
      userMessage += `Actual accessible roles when component renders:\n${rolesTree}\n\n`;
      userMessage += `Use only roles and names that appear in the tree above. Do NOT query for names that are not listed.\n\n`;
    }

    if (componentHints.length > 0) {
      userMessage += `Additional UI hints extracted from component source:\n${componentHints.map((h) => `  - ${h}`).join("\n")}\n\n`;
    }
    userMessage += `Component code (key exports):\n${this.truncateForPrompt(componentCode, componentMaxLines)}\n\n`;
    userMessage += `Current test file:\n${this.truncateForPrompt(testCode, testMaxLines)}\n\n`;
    userMessage += `Fix or remove the failing test. Keep all passing tests.`;

    const result = await callOllamaFn(
      this.model,
      "qa",
      REPAIR_PROMPT,
      userMessage,
    );

    const parsed = parseTTM(result.text);
    const block =
      parsed && "output" in parsed ? (parsed as { output: string }) : null;

    if (!block) {
      await this.log(
        "TDD",
        "Test repair: parse failure",
        undefined,
        result.prompt,
        result.text,
      );
      return false;
    }

    const { repaired } = autoRepairOutput(block.output, testFileName);
    fs.writeFileSync(testPath, repaired, "utf-8");

    const retryResult = runTests(this.projectId, testFileName);
    if (retryResult.crashed) {
      // Repair made things worse — restore original
      fs.writeFileSync(testPath, testCode, "utf-8");
      await this.log("TDD", "Test repair made things worse — reverted");
      return false;
    }

    // Only claim success if the specific failing test is now passing.
    // A non-crashing but still-failing test is not a successful repair.
    const stillFailing = retryResult.tests.find(
      (t) => t.name === failure.name && t.status === "fail",
    );
    if (stillFailing) {
      await this.log(
        "TDD",
        `Test repair ${rewriteMode ? "(rewrite)" : "(patch)"} ran but test still fails`,
      );
      // Update the error fingerprint so the next call sees new evidence
      // (the repaired output may produce a different error)
      const newFingerprint = (stillFailing.error || "").slice(0, 300);
      this.lastRepairError.set(failure.name, newFingerprint);
      return false;
    }

    await this.log(
      "TDD",
      `Test repair ${rewriteMode ? "(rewrite)" : "(patch)"} succeeded`,
    );
    return true;
  }

  // ─────────────────────────────────────────────
  //  PHASE 5: HOLISTIC REVIEW (Programmatic quality checks + LLM review)
  // ─────────────────────────────────────────────

  /**
   * Programmatic checks for common structural/quality problems.
   * Adapts checks based on file type.
   */
  private checkOutputQualityForFile(
    content: string,
    filePath: string,
  ): { file: string; issue: string }[] {
    const issues: { file: string; issue: string }[] = [];
    const ext = filePath.split(".").pop()?.toLowerCase() || "";

    if (!content || content.trim().length < 30) {
      issues.push({
        file: filePath,
        issue: `File is nearly empty — write complete content`,
      });
      return issues;
    }

    // Code-specific checks
    if (["tsx", "jsx", "ts", "js", "py", "css"].includes(ext)) {
      // Brace balance / truncation indicator.
      // For JS/TS/JSX/TSX, defer to the TypeScript parser — counting `{`/`}`
      // by hand produces false positives for regex literals (`/\}/`) and
      // JSX expressions. The parser already reports unterminated blocks.
      // For CSS we still use a naive counter (no parser available).
      if (["tsx", "jsx", "ts", "js"].includes(ext)) {
        const errs = checkTypeScriptSyntax(filePath, content);
        const trunc = errs.find(
          (msg) =>
            /\}.*expected|expected.*\}|Unexpected end of/i.test(msg) ||
            /unterminated|unexpected token/i.test(msg),
        );
        if (trunc) {
          issues.push({
            file: filePath,
            issue: `Syntax error suggests truncation: ${trunc}`,
          });
        }
      } else if (ext === "css") {
        let braceCount = 0;
        const stripped = content
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/"(?:[^"\\]|\\.)*"/g, '""')
          .replace(/'(?:[^'\\]|\\.)*'/g, "''");
        for (const ch of stripped) {
          if (ch === "{") braceCount++;
          if (ch === "}") braceCount--;
        }
        if (braceCount !== 0) {
          issues.push({
            file: filePath,
            issue: `Unbalanced braces (${braceCount > 0 ? braceCount + " unclosed" : Math.abs(braceCount) + " extra closing"}) — file may be truncated`,
          });
        }
      }

      // Detect placeholder handlers: alert() or console.log() as main action.
      // BUT: skip this check if the project description literally asks for an
      // alert/alarm/notification — for things like timers, alert("Done!") is
      // a legitimate implementation, not a placeholder.
      const descLower = (this.projectDescription || "").toLowerCase();
      const alertIsRequested =
        /\b(alert|alarm|notify|notification|beep|chime|sound)\b/.test(
          descLower,
        );
      const alertPlaceholders =
        content.match(/alert\s*\(\s*["'`][^"'`]*["'`]\s*\)/g) || [];
      if (alertPlaceholders.length > 0 && !alertIsRequested) {
        issues.push({
          file: filePath,
          issue: `Found ${alertPlaceholders.length} alert() placeholder(s) — replace with real logic`,
        });
      }

      // Detect empty/stub handlers
      const stubHandlers = content.match(/=>\s*\{\s*\/\/.*\n\s*\}/g) || [];
      if (stubHandlers.length > 0) {
        issues.push({
          file: filePath,
          issue: `${stubHandlers.length} empty/stub handler(s) with only comments — implement real logic`,
        });
      }
    }

    // React-specific checks
    if (ext === "tsx" || ext === "jsx") {
      const lower = content.toLowerCase();

      if (!lower.includes("export default")) {
        issues.push({
          file: filePath,
          issue:
            "No default export found — add 'export default function Component()'",
        });
      }

      if (!content.includes("return")) {
        issues.push({
          file: filePath,
          issue:
            "Component has no return statement — it must return JSX elements",
        });
      }

      // Detect uncontrolled inputs
      const inputTags = content.match(/<input\b[^>]*>/g) || [];
      let uncontrolledCount = 0;
      for (const tag of inputTags) {
        if (
          !tag.includes("value=") &&
          !tag.includes("defaultValue=") &&
          !tag.includes("checked=") &&
          !tag.includes("defaultChecked=") &&
          !tag.includes('type="submit"') &&
          !tag.includes('type="button"')
        ) {
          uncontrolledCount++;
        }
      }
      if (uncontrolledCount > 0) {
        issues.push({
          file: filePath,
          issue: `${uncontrolledCount} uncontrolled input(s) found — add value={state} and onChange={handler}`,
        });
      }
    }

    // HTML-specific checks
    if (ext === "html" || ext === "htm") {
      if (!content.includes("<!DOCTYPE") && !content.includes("<!doctype")) {
        issues.push({
          file: filePath,
          issue: "Missing DOCTYPE declaration",
        });
      }
      if (!content.includes("<html")) {
        issues.push({
          file: filePath,
          issue: "Missing <html> tag — write a complete HTML page",
        });
      }
    }

    // Markdown checks
    if (ext === "md" || ext === "markdown") {
      if (!content.includes("#")) {
        issues.push({
          file: filePath,
          issue: "No headings found — use # for structure",
        });
      }
      if (content.trim().split("\n").length < 5) {
        issues.push({
          file: filePath,
          issue: "Document is very short — add more detail and content",
        });
      }
    }

    // JSON check
    if (ext === "json") {
      try {
        JSON.parse(content);
      } catch {
        issues.push({
          file: filePath,
          issue: "Invalid JSON — file cannot be parsed",
        });
      }
    }

    return issues;
  }

  private async runHolisticReviewPass() {
    const outDir = this.outputDir();
    if (!fs.existsSync(outDir)) return;

    const readFile = (name: string) => {
      const fullPath = path.join(outDir, name);
      if (!fs.existsSync(fullPath)) return "";
      return fs.readFileSync(fullPath, "utf-8");
    };

    // Check all manifest files
    let hasContent = false;
    for (const file of this.manifest) {
      const content = readFile(file.path);
      if (content.trim().length > 20) {
        hasContent = true;
        break;
      }
    }
    if (!hasContent) return;

    await this.log("QA", "Running structural quality checks...");

    // Programmatic-only quality checks per file
    const allIssues: { file: string; issue: string }[] = [];
    for (const file of this.manifest) {
      const content = readFile(file.path);
      if (content.trim().length < 20) continue;
      const fileIssues = this.checkOutputQualityForFile(content, file.path);
      allIssues.push(...fileIssues);
    }

    if (allIssues.length === 0) {
      await this.log("QA", "PASS — no structural issues found");
      return;
    }

    await this.log(
      "QA",
      `Quality review found ${allIssues.length} issue(s) to fix`,
    );
    for (const { file, issue } of allIssues) {
      await this.log("QA", `[${file}] ${issue}`);
    }

    // Group issues by file (all are programmatic with known files)
    const issuesByFile: Record<string, string[]> = {};
    for (const { file, issue } of allIssues) {
      if (!issuesByFile[file]) issuesByFile[file] = [];
      issuesByFile[file].push(issue);
    }

    // Fix each file that has issues
    for (const filePath of this.getFileOrder()) {
      if (this.aborted) break;
      const fileIssues = issuesByFile[filePath];
      if (!fileIssues || fileIssues.length === 0) continue;

      const existingContent = readFile(filePath);
      if (!existingContent || existingContent.trim().length < 20) continue;

      let userMessage = `Project: ${this.projectName} — ${this.projectDescription}\n\n`;
      userMessage += `Current ${filePath}:\n${existingContent}\n\n`;
      userMessage += `A quality review found these issues:\n`;
      userMessage += fileIssues.map((iss, i) => `${i + 1}. ${iss}`).join("\n");
      userMessage += `\n\nFix ALL of these issues and rewrite the COMPLETE ${filePath} file. Keep all working functionality intact.`;

      userMessage = this.withCustomInstructions(userMessage);

      await this.log(
        "QA",
        `Reworking ${filePath}: ${fileIssues.length} issue(s)`,
      );

      const devResult = await runDeveloper(this.model, userMessage, filePath);

      if (devResult.block) {
        const output = devResult.block.output;
        const { repaired } = autoRepairOutput(output, filePath);
        const validation = validateOutput(repaired, filePath);
        if (validation.valid) {
          await this.writeOutputFile(filePath, repaired);
          await this.log(
            "QA",
            `Fixed ${filePath} (${devResult.tokens} tokens)`,
            undefined,
            devResult.prompt,
            devResult.raw,
          );
        } else {
          await this.log(
            "QA",
            `Fix for ${filePath} failed validation: ${validation.reason} — keeping original`,
            undefined,
            devResult.prompt,
            devResult.raw,
          );
        }
      } else {
        await this.log(
          "QA",
          `Could not fix ${filePath} — Developer parse failure`,
          undefined,
          devResult.prompt,
          devResult.raw,
        );
      }
    }

    await this.log("QA", "Quality review rework complete");
  }

  // ─────────────────────────────────────────────
  //  PHASE 6: ITERATIVE QA (find one bug → fix → repeat)
  // ─────────────────────────────────────────────

  /** Max iterations for the find-one-fix-one QA loop */
  private static readonly MAX_ITERATIVE_QA_ROUNDS = 3;

  /** Max attempts to self-heal a broken component before giving up */
  private static readonly MAX_SELF_HEAL_ATTEMPTS = 3;

  private async runIterativeQAPass() {
    const outDir = this.outputDir();
    if (!fs.existsSync(outDir)) return;

    const readFile = (name: string) => {
      const fullPath = path.join(outDir, name);
      if (!fs.existsSync(fullPath)) return "";
      return fs.readFileSync(fullPath, "utf-8");
    };

    // Check if any manifest files have content
    let hasContent = false;
    for (const file of this.manifest) {
      const content = readFile(file.path);
      if (content.trim().length > 20) {
        hasContent = true;
        break;
      }
    }
    if (!hasContent) return;

    await this.log(
      "QA",
      "Starting iterative QA (find one bug → fix → repeat)...",
    );

    const previousFixes: string[] = [];
    // Track (file+problem_prefix) to detect repeated identical issues.
    // If the same issue recurs in the same file after a fix attempt, skip it
    // rather than looping forever on the same broken code.
    const issueAttemptCount = new Map<string, number>();
    // Track validation failures per file. The model frequently RE-PHRASES
    // the same underlying issue, which defeats the problem-prefix dedup
    // above. After 2 validation failures on the same file we skip any
    // further attempts on that file in this pass — the model clearly
    // can't make progress and further rewrites risk breaking working code.
    const fileFailCount = new Map<string, number>();
    const MAX_FILE_VALIDATION_FAILS = 2;
    // Track TOTAL fix attempts per file (successful or not). If the model
    // keeps returning to the same file (rephrasing the same issue each round)
    // we cap at 3 attempts total — any deeper looping means we can't solve it.
    const fileTotalAttempts = new Map<string, number>();
    const MAX_FILE_TOTAL_ATTEMPTS = 3;
    // Content-hash history per file. If applying a fix would restore the file
    // to a previously-seen state (oscillation), the fix is rejected.
    const fileContentHashes = new Map<string, Set<string>>();
    const qaOutDir = this.outputDir();

    /** Run tests for the given source file (if a test file exists).
     *  Returns true if tests pass (or no test file), false if they regress. */
    const qaRunTests = (srcFile: string, baselineFailures: number): boolean => {
      const ext = srcFile.split(".").pop()?.toLowerCase() || "";
      const testFile = srcFile.replace(
        /\.\w+$/,
        `.test.${ext === "tsx" || ext === "jsx" ? "tsx" : ext}`,
      );
      if (!fs.existsSync(path.join(qaOutDir, testFile))) return true;
      const result = runTests(this.projectId, testFile);
      // Revert only if the fix caused a crash or made more tests fail.
      // Tests that were already failing before QA are expected and must not
      // cause every fix to be rejected.
      if (result.crashed) return false;
      if (result.failed > baselineFailures) return false;
      return true;
    };

    /** Snapshot test failures for a file before applying a QA fix. */
    const qaTestBaseline = (srcFile: string): number => {
      const ext = srcFile.split(".").pop()?.toLowerCase() || "";
      const testFile = srcFile.replace(
        /\.\w+$/,
        `.test.${ext === "tsx" || ext === "jsx" ? "tsx" : ext}`,
      );
      if (!fs.existsSync(path.join(qaOutDir, testFile))) return 0;
      const result = runTests(this.projectId, testFile);
      return result.crashed ? 0 : result.failed;
    };

    let round = 0;

    while (round < Pipeline.MAX_ITERATIVE_QA_ROUNDS && !this.aborted) {
      round++;

      // Read fresh file contents each round (they change after fixes)
      const currentFiles: { path: string; content: string }[] = [];
      for (const file of this.manifest) {
        const content = readFile(file.path);
        if (content.trim().length > 20) {
          currentFiles.push({ path: file.path, content });
        }
      }

      if (currentFiles.length === 0) break;

      await this.log(
        "QA",
        `Round ${round}/${Pipeline.MAX_ITERATIVE_QA_ROUNDS}: looking for issues...`,
      );

      const result = await runIterativeQA(
        this.model,
        this.projectName,
        this.projectDescription,
        currentFiles,
        previousFixes.length > 0 ? previousFixes : undefined,
        round === 1 ? this.lastTestFailure : undefined, // give first round the test failure context
        round - 1, // rotate through files each round
      );

      if (!result.issue) {
        await this.log(
          "QA",
          `Round ${round}: No more issues found (${result.tokens} tokens, ${result.durationMs}ms)`,
          undefined,
          result.prompt,
          result.raw,
        );
        break;
      }

      const { file: targetFile, problem, fix } = result.issue;
      // Deduplication: if the same file+problem has already been attempted twice
      // this session, the model is stuck in a loop — skip it.
      const issueKey = `${targetFile}::${problem.slice(0, 80)}`;
      const priorAttempts = issueAttemptCount.get(issueKey) ?? 0;
      if (priorAttempts >= 2) {
        await this.log(
          "QA",
          `Round ${round}: Skipping repeated issue in ${targetFile} (already tried ${priorAttempts}x): ${problem.slice(0, 100)}`,
        );
        previousFixes.push(`${problem} (skipped — repeated)`);
        continue;
      }
      issueAttemptCount.set(issueKey, priorAttempts + 1);

      await this.log(
        "QA",
        `Round ${round} found: [${targetFile}] ${problem}`,
        undefined,
        result.prompt,
        result.raw,
      );
      await this.log("QA", `Fix: ${fix}`);

      // Resolve the file name to one of our template files
      const resolvedFile = this.resolveTargetFile(targetFile);
      if (!resolvedFile) {
        await this.log("QA", `Unknown file "${targetFile}" — skipping`);
        previousFixes.push(`${problem} (skipped — unknown file)`);
        continue;
      }

      // Skip if this file has already burned too many failed-validation attempts.
      const fileFails = fileFailCount.get(resolvedFile) ?? 0;
      if (fileFails >= MAX_FILE_VALIDATION_FAILS) {
        await this.log(
          "QA",
          `Round ${round}: ${resolvedFile} has ${fileFails} prior validation failures — abandoning further fixes on this file`,
        );
        previousFixes.push(
          `${problem} (skipped — file abandoned after ${fileFails} failed fixes)`,
        );
        continue;
      }

      // Skip if this file has already been attempted too many times in total.
      const fileTotAttempts = fileTotalAttempts.get(resolvedFile) ?? 0;
      if (fileTotAttempts >= MAX_FILE_TOTAL_ATTEMPTS) {
        await this.log(
          "QA",
          `Round ${round}: ${resolvedFile} has been attempted ${fileTotAttempts} times — skipping to avoid loop`,
        );
        previousFixes.push(`${problem} (skipped — file attempt cap reached)`);
        continue;
      }
      fileTotalAttempts.set(resolvedFile, fileTotAttempts + 1);

      // Build fix prompt for the Developer
      const existingContent = readFile(resolvedFile);
      if (!existingContent || existingContent.trim().length < 20) {
        previousFixes.push(`${problem} (skipped — file empty)`);
        continue;
      }

      // Snapshot test failures before touching the file so the regression guard
      // can compare "before vs. after" instead of "0 vs. failures".
      const baselineFailures = qaTestBaseline(resolvedFile);

      // ── Attempt 1: Surgical edit (touch only the affected lines) ──
      let fixed = false;
      const lineHint = result.issue.line;
      const lineCount = existingContent.split("\n").length;
      const targetLine = lineHint ?? Math.ceil(lineCount / 2);
      const windowSize = Math.min(35, Math.ceil(lineCount / 2));
      const { section } = extractFileWindow(
        existingContent,
        targetLine,
        windowSize,
      );

      const editResult = await runEditor(
        this.model,
        resolvedFile,
        `Problem: ${problem}\nFix: ${fix}`,
        section,
      );

      if (editResult.block) {
        const edited = applyEdit(
          existingContent,
          editResult.block.startLine,
          editResult.block.endLine,
          editResult.block.replace,
        );
        const { repaired: editRepaired } = autoRepairOutput(
          edited,
          resolvedFile,
        );
        const editValidation = validateOutput(editRepaired, resolvedFile);
        const editExt = (resolvedFile.split(".").pop() ?? "").toLowerCase();
        const editSyntaxErrors =
          editValidation.valid && ["ts", "tsx", "js", "jsx"].includes(editExt)
            ? checkTypeScriptSyntax(resolvedFile, editRepaired)
            : [];
        if (editValidation.valid && editSyntaxErrors.length === 0) {
          // Oscillation guard: reject if this content was seen before
          const fp = (c: string) => `${c.length}:${c.slice(0, 200)}`;
          const seenHashes =
            fileContentHashes.get(resolvedFile) ?? new Set<string>();
          if (seenHashes.has(fp(editRepaired))) {
            await this.log(
              "QA",
              `Round ${round}: Oscillation detected — ${resolvedFile} would revert to a previous state, skipping`,
            );
            previousFixes.push(`${problem} (skipped — oscillation detected)`);
            fileFailCount.set(
              resolvedFile,
              (fileFailCount.get(resolvedFile) ?? 0) + 1,
            );
          } else {
            seenHashes.add(fp(existingContent));
            fileContentHashes.set(resolvedFile, seenHashes);
            await this.writeOutputFile(resolvedFile, editRepaired);
            // Regression guard: revert if the fix made tests crash or increased
            // the failure count relative to the pre-fix baseline.
            if (!qaRunTests(resolvedFile, baselineFailures)) {
              await this.writeOutputFile(resolvedFile, existingContent);
              await this.log(
                "QA",
                `Round ${round}: Surgical fix in ${resolvedFile} broke tests — reverting`,
              );
              fileFailCount.set(
                resolvedFile,
                (fileFailCount.get(resolvedFile) ?? 0) + 1,
              );
              previousFixes.push(`${problem} (fix reverted — broke tests)`);
            } else {
              await this.log(
                "QA",
                `Round ${round}: Surgical fix in ${resolvedFile} lines ${editResult.block.startLine}–${editResult.block.endLine} (${editResult.tokens} tokens)`,
                undefined,
                editResult.prompt,
                editResult.raw,
              );
              previousFixes.push(
                `${problem} → APPLIED: ${fix} (surgically in ${resolvedFile})`,
              );
              fixed = true;
            }
          }
        } else {
          const reason = !editValidation.valid
            ? editValidation.reason!
            : `${editSyntaxErrors[0]}`;
          fileFailCount.set(
            resolvedFile,
            (fileFailCount.get(resolvedFile) ?? 0) + 1,
          );
          await this.log(
            "QA",
            `Round ${round}: Surgical edit validation failed (${reason}) — falling back to full rewrite`,
          );
        }
      }

      if (fixed) continue;

      // ── Attempt 2: Full-file rewrite fallback ──
      let userMessage = `Project: ${this.projectName} — ${this.projectDescription}\n\n`;
      userMessage += `Current ${resolvedFile}:\n${existingContent}\n\n`;
      userMessage += `QA found this issue:\nProblem: ${problem}\nFix: ${fix}\n\n`;
      userMessage += `Apply ONLY this fix. Keep everything else exactly the same. Rewrite the COMPLETE ${resolvedFile} file.`;

      userMessage = this.withCustomInstructions(userMessage);

      const devResult = await runDeveloper(
        this.model,
        userMessage,
        resolvedFile,
      );

      if (devResult.block) {
        const output = devResult.block.output;
        const { repaired } = autoRepairOutput(output, resolvedFile);
        const validation = validateOutput(repaired, resolvedFile);
        const rewriteExt = (resolvedFile.split(".").pop() ?? "").toLowerCase();
        const rewriteSyntaxErrors =
          validation.valid && ["ts", "tsx", "js", "jsx"].includes(rewriteExt)
            ? checkTypeScriptSyntax(resolvedFile, repaired)
            : [];
        if (validation.valid && rewriteSyntaxErrors.length === 0) {
          // Oscillation guard: reject if this content was seen before
          const fp = (c: string) => `${c.length}:${c.slice(0, 200)}`;
          const seenHashesFull =
            fileContentHashes.get(resolvedFile) ?? new Set<string>();
          if (seenHashesFull.has(fp(repaired))) {
            await this.log(
              "QA",
              `Round ${round}: Oscillation detected — ${resolvedFile} would revert to a previous state, skipping`,
            );
            previousFixes.push(`${problem} (skipped — oscillation detected)`);
            fileFailCount.set(
              resolvedFile,
              (fileFailCount.get(resolvedFile) ?? 0) + 1,
            );
          } else {
            seenHashesFull.add(fp(existingContent));
            fileContentHashes.set(resolvedFile, seenHashesFull);
            await this.writeOutputFile(resolvedFile, repaired);
            // Regression guard: revert if the fix made tests crash or increased
            // the failure count relative to the pre-fix baseline.
            if (!qaRunTests(resolvedFile, baselineFailures)) {
              await this.writeOutputFile(resolvedFile, existingContent);
              await this.log(
                "QA",
                `Round ${round}: Full rewrite of ${resolvedFile} broke tests — reverting`,
              );
              fileFailCount.set(
                resolvedFile,
                (fileFailCount.get(resolvedFile) ?? 0) + 1,
              );
              previousFixes.push(`${problem} (fix reverted — broke tests)`);
            } else {
              await this.log(
                "QA",
                `Round ${round}: Fixed ${resolvedFile} (${devResult.tokens} tokens)`,
                undefined,
                devResult.prompt,
                devResult.raw,
              );
              previousFixes.push(
                `${problem} → APPLIED: ${fix} (full rewrite in ${resolvedFile})`,
              );
            }
          }
        } else {
          const reason = !validation.valid
            ? validation.reason!
            : `TS syntax: ${rewriteSyntaxErrors[0]}`;
          fileFailCount.set(
            resolvedFile,
            (fileFailCount.get(resolvedFile) ?? 0) + 1,
          );
          await this.log(
            "QA",
            `Round ${round}: Fix for ${resolvedFile} failed validation: ${reason} — keeping original`,
            undefined,
            devResult.prompt,
            devResult.raw,
          );
          previousFixes.push(`${problem} (fix failed validation)`);
        }
      } else {
        await this.log(
          "QA",
          `Round ${round}: Could not fix ${resolvedFile} — Developer parse failure`,
          undefined,
          devResult.prompt,
          devResult.raw,
        );
        previousFixes.push(`${problem} (Developer parse failure)`);
      }
    }

    if (round >= Pipeline.MAX_ITERATIVE_QA_ROUNDS && !this.aborted) {
      await this.log(
        "QA",
        `Iterative QA hit max rounds (${Pipeline.MAX_ITERATIVE_QA_ROUNDS})`,
      );
    }

    await this.log(
      "QA",
      `Iterative QA complete: ${previousFixes.length} issue(s) addressed in ${round} round(s)`,
    );
  }

  // ─────────────────────────────────────────────
  //  PHASE 7: PROGRESS REVIEW (PM "honing")
  // ─────────────────────────────────────────────

  /** Max distinct missing-feature patches applied per honing pass */
  private static readonly MAX_HONING_FIXES = 3;

  /**
   * After QA finishes, ask the model "as PM" whether the built project
   * actually matches the spec. For each item flagged "missing", apply
   * a targeted patch on the indicated file.
   *
   * Capped at MAX_HONING_FIXES total feature applications to keep runtime
   * bounded — if more features are missing the user can run "feedback".
   */
  private async runProgressReviewPass() {
    if (this.aborted) return;
    const outDir = this.outputDir();
    if (!fs.existsSync(outDir)) return;

    // Snapshot files for the reviewer
    const snapshot: { path: string; content: string }[] = [];
    for (const file of this.manifest) {
      const full = path.join(outDir, file.path);
      if (!fs.existsSync(full)) continue;
      const content = fs.readFileSync(full, "utf-8");
      if (content.trim().length > 20)
        snapshot.push({ path: file.path, content });
    }
    if (snapshot.length === 0) return;

    await this.log(
      "REV",
      "Progress review: checking built files against spec...",
    );

    let review;
    try {
      review = await runProgressReviewer(
        this.model,
        this.projectName,
        this.projectDescription,
        snapshot,
      );
    } catch (err) {
      await this.log(
        "REV",
        `Progress review failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    await this.log(
      "REV",
      `Progress: ${review.done.length} done, ${review.missing.length} missing. Next: ${review.nextAction || "(none)"}`,
      undefined,
      review.prompt,
      review.raw,
    );

    if (review.missing.length === 0) return;

    const patchableExts = ["tsx", "jsx", "ts", "js"];
    const fixes = review.missing.slice(0, Pipeline.MAX_HONING_FIXES);

    for (const { feature, file } of fixes) {
      if (this.aborted) return;

      // Resolve the file to a real manifest file
      const resolved = this.resolveTargetFile(file);
      if (!resolved) {
        await this.log(
          "REV",
          `Honing: unknown file "${file}" — skipping "${feature}"`,
        );
        continue;
      }
      const ext = resolved.split(".").pop()?.toLowerCase() || "";
      if (!patchableExts.includes(ext)) {
        await this.log(
          "REV",
          `Honing: ${resolved} is not patchable (${ext}) — skipping`,
        );
        continue;
      }

      const fullPath = path.join(outDir, resolved);
      if (!fs.existsSync(fullPath)) continue;

      // Retry loop: try the patch; on failure give the model one retry with
      // an explicit error note (same pattern used in the execute loop).
      let honingApplied = false;
      let honingNote: string | undefined;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const current = fs.readFileSync(fullPath, "utf-8");

        const numbered = current
          .split("\n")
          .map((line, idx) => `${String(idx + 1).padStart(4, " ")} | ${line}`)
          .join("\n");

        const featureInstruction = `MISSING SPEC FEATURE: ${feature}. Add the minimum code to satisfy this requirement. Wire it into the UI if applicable.`;

        const patchRes = await runDeveloperPatch(
          this.model,
          resolved,
          numbered,
          featureInstruction,
          this.projectName,
          this.projectDescription,
          honingNote,
        );

        const blocks = parsePatch(patchRes.raw);
        if (blocks.length === 0) {
          await this.log(
            "REV",
            `Honing: no patch block produced for "${feature}"`,
          );
          break;
        }

        // Apply only the first block (single-block-per-turn convention)
        const applied = applyPatch(current, [blocks[0]]);
        if (!applied.ok) {
          if (attempt === 1) {
            // First failure: retry with error note
            honingNote = `Your previous SEARCH did not match the file (${applied.reason}). The file is unchanged. Re-read the CURRENT file shown below and emit a corrected SEARCH/REPLACE block with the exact existing text.`;
            continue;
          }
          await this.log(
            "REV",
            `Honing: patch failed for "${feature}" after retry: ${applied.reason}`,
          );
          break;
        }

        const { repaired } = autoRepairOutput(applied.content, resolved);
        const candidate = repaired || applied.content;
        const validation = validateOutput(candidate, resolved, {
          allowScaffold: true,
        });
        const syntax = validation.valid
          ? checkTypeScriptSyntax(resolved, candidate)
          : [];

        if (!validation.valid || syntax.length > 0) {
          const reason = !validation.valid
            ? validation.reason
            : `TS syntax: ${syntax.join("; ")}`;
          await this.log(
            "REV",
            `Honing: patch for "${feature}" invalid (${reason}) — keeping original`,
          );
          break;
        }

        await this.writeOutputFile(resolved, candidate);
        await this.log(
          "REV",
          `Honing: applied "${feature}" to ${resolved} (${applied.blocksApplied} block, ${patchRes.tokens} tokens)`,
          undefined,
          patchRes.prompt,
          patchRes.raw,
        );
        honingApplied = true;
        break;
      }

      // ── Patch failed both attempts: fall back to full-file rewrite ──
      if (!honingApplied) {
        const currentContent = fs.readFileSync(fullPath, "utf-8");
        let rewriteMsg = `Project: ${this.projectName} — ${this.projectDescription}\n\n`;
        rewriteMsg += `Current ${resolved}:\n${currentContent}\n\n`;
        rewriteMsg += `MISSING SPEC FEATURE: ${feature}. Add the minimum code to satisfy this requirement. Wire it into the UI if applicable.\n\n`;
        rewriteMsg += `Apply ONLY this feature addition. Keep everything else exactly the same. Rewrite the COMPLETE ${resolved} file.`;

        rewriteMsg = this.withCustomInstructions(rewriteMsg);

        const rewriteResult = await runDeveloper(
          this.model,
          rewriteMsg,
          resolved,
        );
        if (rewriteResult.block) {
          const output = rewriteResult.block.output;
          const { repaired } = autoRepairOutput(output, resolved);
          const rValidation = validateOutput(repaired, resolved, {
            allowScaffold: true,
          });
          const rExt = (resolved.split(".").pop() ?? "").toLowerCase();
          const rSyntax =
            rValidation.valid && ["ts", "tsx", "js", "jsx"].includes(rExt)
              ? checkTypeScriptSyntax(resolved, repaired)
              : [];
          if (rValidation.valid && rSyntax.length === 0) {
            await this.writeOutputFile(resolved, repaired);
            await this.log(
              "REV",
              `Honing: applied "${feature}" to ${resolved} via full rewrite (${rewriteResult.tokens} tokens)`,
              undefined,
              rewriteResult.prompt,
              rewriteResult.raw,
            );
          } else {
            const reason = !rValidation.valid
              ? rValidation.reason
              : `TS syntax: ${rSyntax[0]}`;
            await this.log(
              "REV",
              `Honing: full-rewrite for "${feature}" invalid (${reason}) — keeping original`,
            );
          }
        } else {
          await this.log(
            "REV",
            `Honing: full-rewrite for "${feature}" failed (no output block)`,
          );
        }
      }
    }
  }

  // ─────────────────────────────────────────────
  //  PHASE 8: VISUAL QA (vision-capable models only)
  // ─────────────────────────────────────────────

  /**
   * Render the main TSX file in headless Chromium, screenshot it, and ask a
   * vision-capable LLM (gemma3+, llava, etc) whether the UI matches the spec.
   *
   * Visual issues are logged as REV entries — they are NOT auto-fixed because
   * vision models still hallucinate UI elements they expect to see. The user
   * can apply visual feedback via the feedback pass.
   */
  private async runVisualQAPass() {
    if (this.aborted) return;

    const caps = modelCapabilities(this.model);
    if (!caps.vision) return; // Silent skip for text-only models

    const outDir = this.outputDir();
    if (!fs.existsSync(outDir)) return;

    // Pick the main TSX/JSX file — typically the manifest entry whose
    // basename is App.tsx, or otherwise the last manifest file (root).
    const tsxFiles = this.manifest.filter((f) => /\.(tsx|jsx)$/i.test(f.path));
    if (tsxFiles.length === 0) return;
    const mainFile =
      tsxFiles.find((f) => /^app\.(tsx|jsx)$/i.test(f.path))?.path ??
      tsxFiles[tsxFiles.length - 1].path;

    await this.log(
      "REV",
      `Visual QA: rendering ${mainFile} in headless Chromium...`,
    );

    let result;
    try {
      result = await runVisualQA(
        this.model,
        this.projectName,
        this.projectDescription,
        mainFile,
        outDir,
      );
    } catch (err) {
      await this.log(
        "REV",
        `Visual QA crashed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (result.skippedReason) {
      await this.log("REV", `Visual QA skipped: ${result.skippedReason}`);
      return;
    }

    const shotKb = result.screenshotBytes
      ? Math.round(result.screenshotBytes / 1024)
      : 0;
    if (result.issues.length === 0) {
      await this.log(
        "REV",
        `Visual QA: UI matches spec (${shotKb}KB screenshot, ${result.tokens ?? 0} tokens)`,
        undefined,
        result.prompt,
        result.raw,
      );
      return;
    }

    await this.log(
      "REV",
      `Visual QA found ${result.issues.length} issue(s) in ${mainFile}:`,
      undefined,
      result.prompt,
      result.raw,
    );
    for (const { problem } of result.issues) {
      await this.log("REV", `  • ${problem}`);
    }
  }

  // ─────────────────────────────────────────────
  //  FBK PASS — User-driven iterative loop
  // ─────────────────────────────────────────────

  /**
   * Applies user feedback to project files with backup, self-healing retry,
   * and validation. If the result is worse than the original, restores backup.
   */
  async runFeedbackPass(feedback: string) {
    const outDir = this.outputDir();
    if (!fs.existsSync(outDir)) {
      await this.log("FBK", "No output files found — nothing to modify.");
      return;
    }

    if (this.manifest.length === 0) {
      await this.log("FBK", "No file manifest — nothing to modify.");
      return;
    }

    await this.log(
      "FBK",
      `Feedback: "${feedback.slice(0, 200)}${feedback.length > 200 ? "…" : ""}"`,
    );

    // ── Step 1: PLAN — decide which files need changing and what to change ──
    await this.log("FBK", "Planning changes...");

    // Give the planner a brief preview of each file so it can locate features
    // like "signup screen" by content, not just description.
    const PREVIEW_LINES = 25;
    const plannerFiles = this.manifest.map((f) => {
      const full = path.join(outDir, f.path);
      let preview: string | undefined;
      if (fs.existsSync(full)) {
        const content = fs.readFileSync(full, "utf-8");
        const lines = content.split("\n").slice(0, PREVIEW_LINES);
        preview = lines.map((l) => `    ${l}`).join("\n");
      }
      return { path: f.path, description: f.description, preview };
    });

    const plan = await runFeedbackPlanner(
      this.model,
      `${this.projectName}: ${this.projectDescription}`,
      feedback,
      plannerFiles,
    );

    if (plan.edits.length === 0) {
      await this.log(
        "FBK",
        "Planner found no files to change",
        undefined,
        plan.prompt,
        plan.raw,
      );
      return;
    }

    // Resolve each planned file path against the manifest (handles partial names)
    const resolvedEdits: { filePath: string; instruction: string }[] = [];
    for (const edit of plan.edits) {
      const resolved =
        this.resolveTargetFile(edit.filePath) ||
        this.resolveFilePath(edit.filePath, edit.instruction);
      if (!resolved) {
        await this.log("FBK", `Skipping unknown file: ${edit.filePath}`);
        continue;
      }
      resolvedEdits.push({ filePath: resolved, instruction: edit.instruction });
    }

    if (resolvedEdits.length === 0) {
      await this.log("FBK", "No valid files to edit after resolution");
      return;
    }

    await this.log(
      "FBK",
      `Plan: ${resolvedEdits.length} file(s) to edit (${plan.tokens} tokens)`,
      undefined,
      plan.prompt,
      plan.raw,
    );
    for (const e of resolvedEdits) {
      await this.log("FBK", `  • ${e.filePath}: ${e.instruction}`);
    }

    // Start a fresh ledger for this feedback pass.
    await initLedger(this.projectId, feedback);

    // ── Step 2: APPLY — surgical edit first, whole-file rewrite as fallback ──
    let appliedCount = 0;
    for (const edit of resolvedEdits) {
      if (this.aborted) break;

      const fullPath = path.join(outDir, edit.filePath);
      if (!fs.existsSync(fullPath)) {
        await this.log("FBK", `Missing file: ${edit.filePath} — skipping`);
        continue;
      }

      const original = fs.readFileSync(fullPath, "utf-8");
      if (original.trim().length === 0) {
        await this.log("FBK", `${edit.filePath} is empty — skipping`);
        continue;
      }

      // Backup before modifying
      const backupPath = fullPath + ".bak";
      fs.writeFileSync(backupPath, original, "utf-8");

      await this.log("FBK", `Editing ${edit.filePath}: ${edit.instruction}`);

      const surgicalOk = await this.trySurgicalFeedbackEdit(
        edit.filePath,
        edit.instruction,
        original,
        fullPath,
      );

      if (surgicalOk) {
        appliedCount++;
      } else {
        // Fall back to whole-file rewrite via the developer agent.
        const wholeFileOk = await this.tryWholeFileFeedbackEdit(
          edit.filePath,
          edit.instruction,
          feedback,
          fullPath,
          original,
        );
        if (wholeFileOk) {
          appliedCount++;
        } else {
          fs.writeFileSync(fullPath, original, "utf-8");
          await this.log(
            "FBK",
            `${edit.filePath}: all attempts failed — restored original`,
          );
        }
      }

      if (fs.existsSync(backupPath)) {
        fs.unlinkSync(backupPath);
      }
    }

    // ── Step 3: PROPAGATE — cross-file rename consistency ──
    // If the instructions implied a rename (absent old + present new),
    // scan every manifest file for residual occurrences of the old name and
    // run a follow-up surgical edit.
    const editedPaths = new Set(resolvedEdits.map((e) => e.filePath));
    const renamePairs: { from: string; to: string }[] = [];
    for (const edit of resolvedEdits) {
      const conds = derivePostconditions(edit.instruction);
      const absent = conds.find((c) => c.kind === "absent");
      const present = conds.find((c) => c.kind === "present");
      if (absent && present) {
        renamePairs.push({ from: absent.needle, to: present.needle });
      }
    }

    if (renamePairs.length > 0) {
      for (const file of this.manifest) {
        if (this.aborted) break;
        const fullPath = path.join(outDir, file.path);
        if (!fs.existsSync(fullPath)) continue;
        const content = fs.readFileSync(fullPath, "utf-8");
        const masked = content.toLowerCase();
        for (const pair of renamePairs) {
          if (
            masked.includes(pair.from.toLowerCase()) &&
            !masked.includes(pair.to.toLowerCase()) &&
            !editedPaths.has(file.path)
          ) {
            await this.log(
              "FBK",
              `Propagating rename "${pair.from}"→"${pair.to}" into ${file.path}`,
            );
            const propInstruction = `Rename ${pair.from} to ${pair.to}`;
            const backupPath = fullPath + ".bak";
            fs.writeFileSync(backupPath, content, "utf-8");
            const ok = await this.trySurgicalFeedbackEdit(
              file.path,
              propInstruction,
              content,
              fullPath,
            );
            if (ok) {
              appliedCount++;
              editedPaths.add(file.path);
            } else {
              fs.writeFileSync(fullPath, content, "utf-8");
            }
            if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
            break; // one pair per file is enough
          }
        }
      }
    }

    await finalizeLedger(this.projectId);

    await this.log(
      "FBK",
      `Feedback pass complete — ${appliedCount}/${resolvedEdits.length} file(s) updated`,
    );
  }

  /**
   * Surgical feedback edit: locate a window, ask the editor for a small replace,
   * verify postconditions, and apply. Returns true if applied.
   */
  private async trySurgicalFeedbackEdit(
    filePath: string,
    instruction: string,
    original: string,
    fullPath: string,
  ): Promise<boolean> {
    const candidates: LocateCandidate[] = locateWindows(original, instruction);
    if (candidates.length === 0) {
      await this.log(
        "FBK",
        `${filePath}: locator found no window — falling back to whole-file rewrite`,
      );
      return false;
    }

    const postconds = derivePostconditions(instruction);
    let currentContent = original;
    let lastEvidence: string | undefined;
    let candidateIdx = 0;
    let candidate = candidates[candidateIdx];

    const ledgerId = await appendLedgerItem(this.projectId, {
      kind: "edit",
      status: "active",
      file: filePath,
      instruction,
      window: { startLine: candidate.startLine, endLine: candidate.endLine },
    });

    await this.log(
      "FBK",
      `${filePath}: locator chose lines ${candidate.startLine}-${candidate.endLine} (${candidate.why})`,
    );

    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (this.aborted) {
        await updateLedgerItem(this.projectId, ledgerId, {
          status: "failed",
          evidence: "aborted",
        });
        return false;
      }

      // Drift check: window content must still hash to what the locator saw.
      const liveSnippet = this.sliceLines(
        currentContent,
        candidate.startLine,
        candidate.endLine,
      );
      const liveHash = hashString(liveSnippet);
      if (liveHash !== candidate.hash && attempt === 1) {
        // First attempt only — re-locate from current content.
        const refreshed = locateWindows(currentContent, instruction);
        if (refreshed.length === 0) {
          await this.log(
            "FBK",
            `${filePath}: window drifted, re-locate failed`,
          );
          await updateLedgerItem(this.projectId, ledgerId, {
            status: "failed",
            evidence: "snippet hash drift, re-locate empty",
          });
          return false;
        }
        candidate = refreshed[0];
        await this.log(
          "FBK",
          `${filePath}: re-located to ${candidate.startLine}-${candidate.endLine}`,
        );
      }

      const windowSnippet = numberLines(
        currentContent,
        candidate.startLine,
        candidate.endLine,
      );

      const result = await runFeedbackEditor(
        this.model,
        filePath,
        instruction,
        windowSnippet,
        candidate.startLine,
        candidate.endLine,
        lastEvidence,
      );

      await updateLedgerItem(this.projectId, ledgerId, { attempts: attempt });

      if (result.needsWiderWindow) {
        const start = result.needsWiderWindow.suggestedStartLine ?? 1;
        const totalLines = currentContent.split("\n").length;
        const end = Math.min(
          totalLines,
          result.needsWiderWindow.suggestedEndLine ?? candidate.endLine + 40,
        );
        candidate = {
          ...candidate,
          startLine: Math.max(1, start),
          endLine: end,
          hash: hashString(this.sliceLines(currentContent, start, end)),
          why: `widened: ${result.needsWiderWindow.reason}`,
        };
        await this.log(
          "FBK",
          `${filePath}: editor requested wider window ${candidate.startLine}-${candidate.endLine} (${result.needsWiderWindow.reason})`,
          undefined,
          result.prompt,
          result.raw,
        );
        continue;
      }

      if (!result.edit) {
        lastEvidence = `Editor produced no parseable EDIT block. Reply with the exact >>EDIT...>>END schema.`;
        await this.log(
          "FBK",
          `${filePath} attempt ${attempt}: parse failure`,
          undefined,
          result.prompt,
          result.raw,
        );
        continue;
      }

      const edit = result.edit;
      // Reject edits outside the allowed window.
      if (
        edit.startLine < candidate.startLine ||
        edit.endLine > candidate.endLine ||
        edit.startLine > edit.endLine
      ) {
        lastEvidence = `Your edit range ${edit.startLine}-${edit.endLine} is outside the allowed window ${candidate.startLine}-${candidate.endLine}. Stay inside it.`;
        await this.log(
          "FBK",
          `${filePath} attempt ${attempt}: out-of-window edit ${edit.startLine}-${edit.endLine}`,
          undefined,
          result.prompt,
          result.raw,
        );
        continue;
      }

      const cleanedReplace = stripLineNumberPrefixes(edit.replace);
      const proposed = applyEdit(
        currentContent,
        edit.startLine,
        edit.endLine,
        cleanedReplace,
      );

      if (proposed === currentContent) {
        lastEvidence = `Your edit did not change the file. Actually modify lines ${edit.startLine}-${edit.endLine}.`;
        continue;
      }

      const validation = validateOutput(proposed, filePath);
      if (!validation.valid) {
        lastEvidence = `Validation failed: ${validation.reason}`;
        await this.log(
          "FBK",
          `${filePath} attempt ${attempt}: validation failed — ${validation.reason}`,
          undefined,
          result.prompt,
          result.raw,
        );
        continue;
      }

      const failures = checkPostconditions(proposed, postconds, filePath);
      if (failures.length > 0) {
        lastEvidence = formatFailureMessage(failures);
        await this.log(
          "FBK",
          `${filePath} attempt ${attempt}: postconditions failed (${failures.length})`,
          undefined,
          result.prompt,
          result.raw,
        );
        // Try a different candidate window next time.
        if (candidateIdx + 1 < candidates.length) {
          candidateIdx++;
          candidate = candidates[candidateIdx];
          await this.log(
            "FBK",
            `${filePath}: trying next candidate ${candidate.startLine}-${candidate.endLine} (${candidate.why})`,
          );
        }
        continue;
      }

      // Post-edit syntax check (TS/TSX/JS/JSX only). Treat errors as evidence
      // and retry; never write a syntactically broken file.
      const ext = (filePath.split(".").pop() ?? "").toLowerCase();
      if (["ts", "tsx", "js", "jsx"].includes(ext)) {
        const syntaxErrors = checkTypeScriptSyntax(filePath, proposed);
        if (syntaxErrors.length > 0) {
          lastEvidence = `Your edit introduced syntax errors:\n${syntaxErrors.slice(0, 5).join("\n")}\nFix them while keeping the instruction intact.`;
          await this.log(
            "FBK",
            `${filePath} attempt ${attempt}: ${syntaxErrors.length} syntax error(s) — retrying`,
            undefined,
            result.prompt,
            result.raw,
          );
          continue;
        }
      }

      // Capture before/after snippet for the ledger so the UI can show
      // a tiny diff of what changed.
      const before = this.sliceLines(
        currentContent,
        edit.startLine,
        edit.endLine,
      );
      const after = cleanedReplace;

      await this.writeOutputFile(filePath, proposed);
      currentContent = proposed;
      await this.log(
        "FBK",
        `${filePath}: surgical edit applied (lines ${edit.startLine}-${edit.endLine}, ${result.tokens} tokens)`,
        undefined,
        result.prompt,
        result.raw,
      );
      await updateLedgerItem(this.projectId, ledgerId, {
        status: "done",
        window: { startLine: edit.startLine, endLine: edit.endLine },
        before,
        after,
      });
      return true;
    }

    await updateLedgerItem(this.projectId, ledgerId, {
      status: "failed",
      evidence: lastEvidence ?? "max attempts reached",
    });
    return false;
  }

  /** Extract a 1-indexed inclusive line range from content. */
  private sliceLines(
    content: string,
    startLine: number,
    endLine: number,
  ): string {
    const lines = content.split("\n");
    const s = Math.max(1, startLine);
    const e = Math.min(lines.length, endLine);
    return lines.slice(s - 1, e).join("\n");
  }

  /**
   * Fallback: whole-file rewrite via the developer agent. Used when surgical
   * editing fails. Preserves the original truncation-marker and identical-output
   * guards from the prior implementation.
   */
  private async tryWholeFileFeedbackEdit(
    filePathRel: string,
    instructionIn: string,
    feedback: string,
    fullPath: string,
    original: string,
  ): Promise<boolean> {
    const ledgerId = await appendLedgerItem(this.projectId, {
      kind: "rewrite",
      status: "active",
      file: filePathRel,
      instruction: instructionIn,
    });

    let currentContent = original;
    let instruction = instructionIn;

    for (
      let attempt = 1;
      attempt <= Pipeline.MAX_SELF_HEAL_ATTEMPTS;
      attempt++
    ) {
      await updateLedgerItem(this.projectId, ledgerId, { attempts: attempt });
      await this.log(
        "FBK",
        `${filePathRel} whole-file attempt ${attempt}/${Pipeline.MAX_SELF_HEAL_ATTEMPTS}`,
      );

      let userMessage = `Project: ${this.projectName} — ${this.projectDescription}\n\n`;
      userMessage += `User feedback: "${feedback}"\n\n`;
      userMessage += `Specifically in ${filePathRel}: ${instruction}\n\n`;
      userMessage += `Current ${filePathRel} (FULL FILE — do not truncate, output every line back):\n${currentContent}\n\n`;
      userMessage += `Apply the change above. Output the COMPLETE updated ${filePathRel} verbatim — every line that should remain, plus your changes. Do not abbreviate. Do not use "/* ... */" or "// rest unchanged". Do not change anything outside the requested edit.`;
      userMessage = this.withCustomInstructions(userMessage);

      const devResult = await runDeveloper(
        this.model,
        userMessage,
        filePathRel,
      );

      if (!devResult.block) {
        await this.log(
          "FBK",
          `${filePathRel}: parse failure — retrying`,
          undefined,
          devResult.prompt,
          devResult.raw,
        );
        continue;
      }

      const { repaired, fixes } = autoRepairOutput(
        devResult.block.output,
        filePathRel,
      );
      if (fixes.length > 0) {
        await this.log("FBK", `Auto-repaired: ${fixes.join(", ")}`);
      }

      const validation = validateOutput(repaired, filePathRel);
      if (!validation.valid) {
        await this.log(
          "FBK",
          `${filePathRel} attempt ${attempt} failed: ${validation.reason}`,
          undefined,
          devResult.prompt,
          devResult.raw,
        );
        instruction = `${instructionIn}\n\nYour previous fix failed validation: ${validation.reason}. Fix this too.`;
        continue;
      }

      if (repaired === original) {
        await this.log(
          "FBK",
          `${filePathRel}: output identical to original — retrying with stronger instruction`,
          undefined,
          devResult.prompt,
          devResult.raw,
        );
        instruction = `${instructionIn}\n\nIMPORTANT: Your previous output was IDENTICAL to the input. You MUST actually change the file.`;
        continue;
      }

      const truncationMarkers = [
        /\/\*\s*\.\.\.\s*\*\//,
        /\/\/\s*\.\.\.\s*(rest|remaining|unchanged|same|other)/i,
        /\/\/\s*\(unchanged\)/i,
        /#\s*\.\.\.\s*(rest|remaining|unchanged)/i,
        /\{\/\*\s*\.\.\.\s*\*\/\}/,
      ];
      const hasTruncation = truncationMarkers.some((re) => re.test(repaired));
      const origLines = original.split("\n").length;
      const newLines = repaired.split("\n").length;
      const shrunkenTooMuch = origLines >= 20 && newLines < origLines * 0.6;

      if (hasTruncation || shrunkenTooMuch) {
        await this.log(
          "FBK",
          `${filePathRel}: output appears truncated (${newLines}/${origLines} lines${hasTruncation ? ", abbreviation marker" : ""}) — retrying`,
          undefined,
          devResult.prompt,
          devResult.raw,
        );
        instruction = `${instructionIn}\n\nIMPORTANT: Your previous output was TRUNCATED (you used "..." or omitted code). You MUST output every single line of the file, verbatim, including all imports, all functions, all JSX. Do not use abbreviation markers.`;
        continue;
      }

      // Verify postconditions on the full rewrite too.
      const postconds = derivePostconditions(instructionIn);
      const failures = checkPostconditions(repaired, postconds, filePathRel);
      if (failures.length > 0) {
        await this.log(
          "FBK",
          `${filePathRel}: postconditions failed (${failures.length}) — retrying`,
          undefined,
          devResult.prompt,
          devResult.raw,
        );
        instruction = `${instructionIn}\n\n${formatFailureMessage(failures)}`;
        continue;
      }

      // Post-edit syntax check (TS/TSX/JS/JSX only).
      const ext = (filePathRel.split(".").pop() ?? "").toLowerCase();
      if (["ts", "tsx", "js", "jsx"].includes(ext)) {
        const syntaxErrors = checkTypeScriptSyntax(filePathRel, repaired);
        if (syntaxErrors.length > 0) {
          await this.log(
            "FBK",
            `${filePathRel}: ${syntaxErrors.length} syntax error(s) — retrying`,
            undefined,
            devResult.prompt,
            devResult.raw,
          );
          instruction = `${instructionIn}\n\nYour previous output had syntax errors:\n${syntaxErrors.slice(0, 5).join("\n")}\nFix them.`;
          continue;
        }
      }

      await this.writeOutputFile(filePathRel, repaired);
      currentContent = repaired;
      await this.log(
        "FBK",
        `${filePathRel}: whole-file rewrite applied (${devResult.tokens} tokens)`,
        undefined,
        devResult.prompt,
        devResult.raw,
      );
      await updateLedgerItem(this.projectId, ledgerId, {
        status: "done",
        before: original.slice(0, 1200),
        after: repaired.slice(0, 1200),
      });
      return true;
    }

    await updateLedgerItem(this.projectId, ledgerId, { status: "failed" });
    return false;
  }

  /** Map an LLM-returned filename to the closest manifest file */
  private resolveTargetFile(name: string): string | null {
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
  //  PHASE 7: IMPROVE (file bug review)
  // ─────────────────────────────────────────────

  private async runImprovementPass() {
    // Check each code file for real syntax/rendering errors using the TS
    // compiler — no LLM guessing. Only call the developer when there are
    // actual errors to fix.
    const CODE_EXTS = new Set(["tsx", "jsx", "ts", "js"]);
    const outDir = this.outputDir();
    if (!fs.existsSync(outDir)) return;

    for (const file of this.manifest) {
      if (this.aborted) break;
      const ext = file.path.split(".").pop()?.toLowerCase() || "";
      if (!CODE_EXTS.has(ext)) continue;

      const fullPath = path.join(outDir, file.path);
      if (!fs.existsSync(fullPath)) continue;

      const content = fs.readFileSync(fullPath, "utf-8");
      if (content.trim().length < 20) continue;

      const errors = checkTypeScriptSyntax(file.path, content);
      if (errors.length === 0) continue;

      const errorList = errors.join("\n");
      await this.log(
        "IMP",
        `${file.path}: ${errors.length} syntax error(s) — fixing`,
      );
      await this.log("IMP", errorList);

      let userMessage = `Project: ${this.projectName} — ${this.projectDescription}\n\n`;
      userMessage += `Current ${file.path}:\n${content}\n\n`;
      userMessage += `Fix these syntax errors and output the COMPLETE ${file.path}:\n${errorList}`;
      userMessage = this.withCustomInstructions(userMessage);

      const devResult = await runDeveloper(this.model, userMessage, file.path);
      if (!devResult.block) {
        await this.log(
          "IMP",
          `${file.path}: parse failure — skipping`,
          undefined,
          devResult.prompt,
          devResult.raw,
        );
        continue;
      }

      const { repaired } = autoRepairOutput(devResult.block.output, file.path);
      const validation = validateOutput(repaired, file.path);
      if (!validation.valid) {
        await this.log(
          "IMP",
          `${file.path}: fix failed validation (${validation.reason}) — keeping original`,
          undefined,
          devResult.prompt,
          devResult.raw,
        );
        continue;
      }

      // Only write if the errors are actually gone
      const remaining = checkTypeScriptSyntax(file.path, repaired);
      if (remaining.length < errors.length) {
        await this.writeOutputFile(file.path, repaired);
        await this.log(
          "IMP",
          `${file.path}: fixed (${errors.length - remaining.length} error(s) resolved)`,
          undefined,
          devResult.prompt,
          devResult.raw,
        );
      } else {
        await this.log(
          "IMP",
          `${file.path}: fix didn't reduce errors — keeping original`,
          undefined,
          devResult.prompt,
          devResult.raw,
        );
      }
    }
  }

  // ─────────────────────────────────────────────
  //  PHASE 6: CONSISTENCY CHECK (Programmatic validation)
  // ─────────────────────────────────────────────

  private async runConsistencyCheck() {
    await this.runIntegrationPass();
  }

  /**
   * Integration Pass — checks that named imports between manifest files
   * actually exist as exports in the target file.
   *
   * Pattern detected:
   *   import { Foo, Bar } from './SomeFile'
   *
   * For each such import we check whether the target file (SomeFile.tsx etc.)
   * contains a matching export. If not, we call the Developer to fix the
   * importing file with the specific missing-export error.
   *
   * Caps at 3 fix calls — beyond that the output is too broken for targeted
   * repair and the holistic pass will have already flagged the issues.
   */
  private async runIntegrationPass() {
    if (this.manifest.length < 2) {
      await this.log("CHK", "Integration check skipped (single-file project)");
      return;
    }

    const outDir = this.outputDir();
    if (!fs.existsSync(outDir)) return;

    const readFile = (name: string): string => {
      const fullPath = path.join(outDir, name);
      if (!fs.existsSync(fullPath)) return "";
      return fs.readFileSync(fullPath, "utf-8");
    };

    /**
     * Extract all named exports from a file's content.
     * Matches:
     *   export function Foo
     *   export const Foo
     *   export class Foo
     *   export type Foo
     *   export interface Foo
     *   export { Foo, Bar }
     *   export default function Foo  (adds "default" + "Foo")
     */
    const getExports = (content: string): Set<string> => {
      const names = new Set<string>();
      // export default (any form)
      if (/export\s+default\b/.test(content)) names.add("default");
      // export default function/class Name
      for (const m of content.matchAll(
        /export\s+default\s+(?:function|class)\s+(\w+)/g,
      )) {
        names.add(m[1]);
      }
      // export function/const/class/type/interface Name
      for (const m of content.matchAll(
        /export\s+(?:async\s+)?(?:function|const|let|var|class|type|interface)\s+(\w+)/g,
      )) {
        names.add(m[1]);
      }
      // export { Foo, Bar as Baz }
      for (const m of content.matchAll(/export\s*\{([^}]+)\}/g)) {
        for (const part of m[1].split(",")) {
          const name = part
            .trim()
            .split(/\s+as\s+/)
            .pop()
            ?.trim();
          if (name) names.add(name);
        }
      }
      return names;
    };

    /**
     * Resolve a relative import path from an importing file to a manifest
     * file path. Returns the manifest file path if found, null otherwise.
     * e.g. import from './TodoList' → 'TodoList.tsx'
     */
    const resolveToManifest = (
      importFrom: string,
      _importingFile: string,
    ): string | null => {
      // Strip leading ./ or ../
      const base = importFrom.replace(/^\.\.?\//, "").replace(/\\/g, "/");
      // Try exact match first
      const exact = this.manifest.find((f) => f.path === base);
      if (exact) return exact.path;
      // Try matching basename without extension
      const baseName = base.replace(/\.\w+$/, "").toLowerCase();
      const byBaseName = this.manifest.find(
        (f) => f.path.replace(/\.\w+$/, "").toLowerCase() === baseName,
      );
      if (byBaseName) return byBaseName.path;
      return null;
    };

    interface ImportIssue {
      importingFile: string;
      targetFile: string;
      missingNames: string[];
    }

    const issues: ImportIssue[] = [];

    for (const file of this.manifest) {
      const content = readFile(file.path);
      if (!content || content.trim().length < 30) continue;

      // Find all named import statements: import { A, B } from './X'
      const importRegex = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
      for (const m of content.matchAll(importRegex)) {
        const importedNames = m[1]
          .split(",")
          .map((s) =>
            s
              .trim()
              .split(/\s+as\s+/)[0]
              .trim(),
          )
          .filter(Boolean);
        const importPath = m[2];

        // Only check relative imports to other manifest files
        if (!importPath.startsWith(".")) continue;
        const targetPath = resolveToManifest(importPath, file.path);
        if (!targetPath) continue;

        const targetContent = readFile(targetPath);
        if (!targetContent || targetContent.trim().length < 30) continue;

        const exported = getExports(targetContent);
        const missing = importedNames.filter((n) => !exported.has(n));
        if (missing.length > 0) {
          issues.push({
            importingFile: file.path,
            targetFile: targetPath,
            missingNames: missing,
          });
        }
      }
    }

    if (issues.length === 0) {
      await this.log(
        "CHK",
        `Integration check PASS — all cross-file imports resolved`,
      );
      return;
    }

    await this.log(
      "CHK",
      `Integration check found ${issues.length} unresolved import(s)`,
    );

    // Cap at 3 fix calls — beyond that the output is too broken for targeted repair
    const MAX_INTEGRATION_FIXES = 3;
    let fixCount = 0;

    for (const issue of issues) {
      if (this.aborted || fixCount >= MAX_INTEGRATION_FIXES) break;

      const { importingFile, targetFile, missingNames } = issue;
      await this.log(
        "CHK",
        `[${importingFile}] imports { ${missingNames.join(", ")} } from '${targetFile}' but those are not exported`,
      );

      const importingContent = readFile(importingFile);
      const targetContent = readFile(targetFile);
      const targetExports = [...getExports(targetContent)].join(", ");

      let userMessage = `Project: ${this.projectName} — ${this.projectDescription}\n\n`;
      userMessage += `Current ${importingFile}:\n${importingContent}\n\n`;
      userMessage += `INTEGRATION ERROR: this file imports { ${missingNames.join(", ")} } from '${targetFile}', but ${targetFile} only exports: ${targetExports || "(nothing)"}\n\n`;
      userMessage += `Fix the import in ${importingFile} to only use what ${targetFile} actually exports. Rewrite the COMPLETE ${importingFile} file.`;
      userMessage = this.withCustomInstructions(userMessage);

      const devResult = await runDeveloper(
        this.model,
        userMessage,
        importingFile,
      );

      if (devResult.block) {
        const { repaired } = autoRepairOutput(
          devResult.block.output,
          importingFile,
        );
        const validation = validateOutput(repaired, importingFile);
        if (validation.valid) {
          await this.writeOutputFile(importingFile, repaired);
          await this.log(
            "CHK",
            `Fixed import in ${importingFile}`,
            undefined,
            devResult.prompt,
            devResult.raw,
          );
          fixCount++;
        } else {
          await this.log(
            "CHK",
            `Integration fix for ${importingFile} failed validation — keeping original`,
          );
        }
      } else {
        await this.log(
          "CHK",
          `Integration fix for ${importingFile} — Developer parse failure`,
        );
      }
    }

    await this.log("CHK", "Integration pass complete");
  }

  // ─────────────────────────────────────────────
  //  HELPERS
  // ─────────────────────────────────────────────

  private async completeTask(task: Task) {
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

  private async markStuck(taskId: number, reason: string) {
    await db
      .update(tasks)
      .set({ status: "stuck", stuckReason: reason })
      .where(eq(tasks.id, taskId));
    this.emit("task_stuck", { taskId, reason });
    await this.log("SYS", `STUCK: ${reason}`, taskId);
  }

  private async setStatus(taskId: number, status: Task["status"]) {
    await db.update(tasks).set({ status }).where(eq(tasks.id, taskId));
  }

  private async getTotalTaskCount(): Promise<number> {
    const allTasks = await db.query.tasks.findMany({
      where: eq(tasks.projectId, this.projectId),
    });
    return allTasks.length;
  }

  private async writeOutputFile(filePath: string, content: string) {
    const fullPath = path.join(this.outputDir(), filePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content, "utf-8");
  }
}
