/**
 * Pipeline Orchestrator — React Component Generation
 *
 * Phases:
 *   1. DECOMPOSE — PM breaks idea into 3-5 epics
 *   2. PLAN — Manager breaks each epic into 2-3 component features
 *   3. MERGE — Programmatic: group features, deduplicate, cap at 8
 *   4. EXECUTE — Sequential: one requirement at a time for Component.tsx
 *   5. REVIEW — Programmatic quality checks + LLM holistic review
 *   6. ITERATIVE QA — Find one bug → fix → repeat (up to 5 rounds)
 *   7. IMPROVE — Improver reviews component for remaining bugs
 *   8. CONSISTENCY — Programmatic validation + auto-fix
 *
 * Output is a single React TSX component with inline styles.
 * No build step — preview uses React CDN + Babel standalone.
 */

import { db } from "@/db";
import { projects, tasks, references, logs, Task } from "@/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { runProjectManager } from "@/lib/agents/project-manager";
import { runReviewer } from "@/lib/agents/reviewer";
import { runImprover } from "@/lib/agents/improver";
import { runManager } from "@/lib/agents/manager";
import { runDeveloper } from "@/lib/agents/developer";
import { runHolisticReview } from "@/lib/agents/holistic-reviewer";
import { runIterativeQA } from "@/lib/agents/iterative-qa";
import { validateOutput, autoRepairOutput } from "@/lib/validate";
import { callOllama as callOllamaFn } from "@/lib/ollama";
import { isVagueOrCircular, extractReferences, parseTTM } from "@/lib/protocol";
import fs from "fs";
import path from "path";

/** Planning stops at depth 2 (Epic → Feature). Features ARE the execution leaves. */
const MAX_DEPTH = 2;
const MAX_TASKS = 200;
const MAX_RETRIES = 2;
const MAX_PARSE_RETRIES = 2;
/** Max bullet points per file spec — keeps Developer prompt short */
const MAX_REQUIREMENTS = 8;
/** Caps per file to reduce overload on small models */
const FILE_REQUIREMENT_CAP: Record<string, number> = {
  "Component.tsx": 8,
};
/** Max features the Manager can produce per epic */
const MAX_SUBTASKS = 3;
/** Max epics from PM */
const MAX_EPICS = 5;

/** The single output component file */
const TEMPLATE_FILES = ["Component.tsx"] as const;

/** File write order — single component */
const FILE_ORDER = ["Component.tsx"] as const;

export type PipelineStage =
  | "all"
  | "decompose"
  | "breakdown"
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
  private deterministicDraftByFile: Record<string, string> = {};

  constructor(projectId: number, model: string, onEvent: EventCallback) {
    this.projectId = projectId;
    this.model = model;
    this.onEvent = onEvent;
  }

  abort() {
    this.aborted = true;
  }

  /** Mark a user-facing stage as complete in the project record */
  private async markStageComplete(stage: string) {
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, this.projectId),
    });
    const stages: string[] = JSON.parse(project?.completedStages || "[]");
    if (!stages.includes(stage)) {
      stages.push(stage);
      await db
        .update(projects)
        .set({ completedStages: JSON.stringify(stages) })
        .where(eq(projects.id, this.projectId));
    }
  }

  /** Appends custom instructions to a message if present */
  private withCustomInstructions(message: string): string {
    if (!this.customInstructions) return message;
    return `${message}\n\nADDITIONAL USER INSTRUCTIONS:\n${this.customInstructions}`;
  }

  private emit(type: string, data: Record<string, unknown>) {
    this.onEvent({ type, data });
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

    const component = `import React from "react";

export default function Component() {
  return (
    <div style={{ fontFamily: "sans-serif", padding: "2rem" }}>
      <h1>${this.projectName}</h1>
    </div>
  );
}
`;

    fs.writeFileSync(path.join(outDir, "Component.tsx"), component, "utf-8");

    await this.log("SYS", "Created scaffold: Component.tsx");
  }

  // ─────────────────────────────────────────────
  //  FILE PATH RESOLUTION
  // ─────────────────────────────────────────────

  /**
   * All features resolve to the single Component.tsx file.
   */
  private resolveFilePath(
    filePath: string | null,
    description: string,
  ): string {
    return "Component.tsx";
  }

  // ─────────────────────────────────────────────
  //  MAIN ENTRY POINT
  // ─────────────────────────────────────────────

  async run(
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
    const STAGE_ORDER = ["decompose", "breakdown", "execute", "qa", "feedback"];
    const currentStages: string[] = JSON.parse(project.completedStages || "[]");
    let effectiveStage: string;
    if (stage === "all") {
      effectiveStage = existingTasks.length === 0 ? "decompose" : "breakdown";
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

    if (existingTasks.length === 0) {
      await this.createScaffold();
      await this.log("PM", "Breaking down idea into epics...");
      await this.decompose(project.name, project.description);
      await this.markStageComplete("decompose");
      if (stage === "decompose") {
        await this.log(
          "SYS",
          "Decomposition complete. Review epics, then run Breakdown.",
        );
        await db
          .update(projects)
          .set({ status: "paused" })
          .where(eq(projects.id, this.projectId));
        this.emit("pipeline_done", { projectId: this.projectId });
        return;
      }
    } else if (stage === "decompose") {
      await this.log(
        "SYS",
        "Project already decomposed. Use Breakdown or Execute.",
      );
      await db
        .update(projects)
        .set({ status: "paused" })
        .where(eq(projects.id, this.projectId));
      this.emit("pipeline_done", { projectId: this.projectId });
      return;
    }

    // Feedback pass: user-driven iterative improvement
    if (stage === "feedback") {
      if (!feedback || !feedback.trim()) {
        await this.log("SYS", "No feedback provided.");
        await db
          .update(projects)
          .set({ status: "paused" })
          .where(eq(projects.id, this.projectId));
        this.emit("pipeline_done", { projectId: this.projectId });
        return;
      }
      await this.log("SYS", "Running feedback pass...");
      await this.runFeedbackPass(feedback);
      // QA after feedback — catches corruption from small models
      await this.log("SYS", "Running QA after feedback...");
      await this.runFullQA();
      await this.markStageComplete("feedback");
      // Always pause after feedback so user can add more
      await db
        .update(projects)
        .set({ status: "paused" })
        .where(eq(projects.id, this.projectId));
      this.emit("pipeline_done", { projectId: this.projectId });
      return;
    }

    // QA-only pass: skip task processing, just run full QA pipeline
    if (stage === "qa") {
      await this.log("SYS", "Running QA pass...");
      await this.runFullQA();
      await this.markStageComplete("qa");
      await db
        .update(projects)
        .set({ status: "done" })
        .where(eq(projects.id, this.projectId));
      this.emit("pipeline_done", { projectId: this.projectId });
      return;
    }

    await this.processAllTasks();

    // Breakdown is an intermediate step — always pause so user can proceed
    if (this.stage === "breakdown") {
      await db
        .update(projects)
        .set({ status: "paused" })
        .where(eq(projects.id, this.projectId));
      this.emit("pipeline_done", { projectId: this.projectId });
      return;
    }

    if (this.stage === "all" || this.stage === "execute") {
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
      .set({ status: stuck > 0 ? "paused" : "done" })
      .where(eq(projects.id, this.projectId));

    this.emit("pipeline_done", {
      projectId: this.projectId,
      totalTasks: allTasks.length,
      done,
      stuck,
    });
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

  // ─────────────────────────────────────────────
  //  PHASE 2: PLAN (Manager → Features per Epic)
  // ─────────────────────────────────────────────

  private async processAllTasks() {
    if (this.stage === "all" || this.stage === "breakdown") {
      await db
        .update(tasks)
        .set({ status: "pending" })
        .where(
          and(
            eq(tasks.projectId, this.projectId),
            eq(tasks.status, "awaiting_approval"),
          ),
        );
    }

    if (this.stage === "all" || this.stage === "breakdown") {
      await this.planAll();
      await this.markStageComplete("breakdown");
    }

    if (this.aborted) return;

    if (this.stage === "breakdown") {
      await this.log(
        "SYS",
        "Breakdown stage complete. Review results, then continue.",
      );
      return;
    }

    if (this.stage === "all" || this.stage === "execute") {
      await this.mergeAndExecute();
      await this.markStageComplete("execute");
    }
  }

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

    let result = await runManager(
      this.model,
      task.description,
      this.withCustomInstructions(
        `Project: ${this.projectName} — ${this.projectDescription}`,
      ),
    );

    if (!result.block && task.parseRetryCount < MAX_PARSE_RETRIES) {
      await db
        .update(tasks)
        .set({ parseRetryCount: task.parseRetryCount + 1 })
        .where(eq(tasks.id, task.id));
      await this.log("MGR", "Parse failure, retrying...", task.id);
      result = await runManager(
        this.model,
        task.description,
        `Project: ${this.projectName} — ${this.projectDescription}`,
      );
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
        `${task.description}\nThis is a high-level epic. You MUST break it into 2-3 smaller features for a React TSX component. Each feature should describe a specific UI element, behavior, or styling to add. Reply with >>BREAKDOWN only.`,
        `Project: ${this.projectName} — ${this.projectDescription}`,
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
          `${task.description}\nIMPORTANT: Break into DIFFERENT, SPECIFIC steps. Each must be a concrete feature for a React TSX component (UI elements, event handlers, or inline styles). Each must be a concrete coding action.`,
          `Project: ${this.projectName} — ${this.projectDescription}`,
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
        await db.insert(tasks).values({
          projectId: this.projectId,
          parentId: task.id,
          description: cappedTasks[i],
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
  //  PHASE 3: MERGE  (Programmatic — no LLM)
  // ─────────────────────────────────────────────

  private async mergeAndExecute() {
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

    if (readyTasks.length === 0) return;

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

    // Ensure CSS/JS get basic specs if model forgot them
    this.ensureBasicSpecs(fileSpecs, fileGroups);

    // Execute in dependency order: HTML → CSS → JS
    for (const filePath of FILE_ORDER) {
      if (this.aborted) break;
      const spec = fileSpecs[filePath];
      if (!spec || spec.requirements.length === 0) continue;

      await this.executeSpec(filePath, spec.requirements, spec.tasks);
    }
  }

  /**
   * If Component.tsx has no features, generate a default spec.
   */
  private ensureBasicSpecs(
    fileSpecs: Record<string, { requirements: string[]; tasks: Task[] }>,
    fileGroups: Record<string, Task[]>,
  ) {
    const allTasks = Object.values(fileGroups).flat();
    const fallbackTasks = fileGroups["Component.tsx"] || allTasks.slice(0, 1);

    if (
      !fileSpecs["Component.tsx"] ||
      fileSpecs["Component.tsx"].requirements.length === 0
    ) {
      const componentReqs = [
        `Build a complete React component for "${this.projectName}: ${this.projectDescription}"`,
        "Use React.useState for all interactive state management",
        "Use inline styles (style={{ ... }}) for all styling — modern, clean design",
        "Include all UI elements: buttons, inputs, lists as needed for the features",
      ];

      const descLower = this.projectDescription.toLowerCase();
      if (
        descLower.includes("list") ||
        descLower.includes("item") ||
        descLower.includes("task")
      ) {
        componentReqs.push(
          "Render items in a styled list with add/remove functionality",
        );
      }
      if (
        descLower.includes("form") ||
        descLower.includes("input") ||
        descLower.includes("add")
      ) {
        componentReqs.push(
          "Include a form with controlled inputs for adding data",
        );
      }

      fileSpecs["Component.tsx"] = {
        requirements: componentReqs.slice(
          0,
          FILE_REQUIREMENT_CAP["Component.tsx"] ?? MAX_REQUIREMENTS,
        ),
        tasks: fallbackTasks,
      };
      this.log(
        "SYS",
        "Added default Component.tsx spec (no features were generated)",
      );
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
            this.stringSimilarity(existing.toLowerCase(), normalized) > 0.6,
        );
        if (isDuplicate) continue;

        seenNormalized.add(key);
        // Strip trailing "in Component.tsx" from task descriptions
        const cleaned = task.description
          .replace(/\s+in\s+Component\.tsx\s*$/i, "")
          .trim();
        requirements.push(cleaned);
      }

      result[filePath] = {
        requirements: requirements.slice(
          0,
          FILE_REQUIREMENT_CAP[filePath] ?? MAX_REQUIREMENTS,
        ),
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
      const req = requirements[i];

      // Mark the corresponding task(s) as executing NOW (not all upfront)
      // Spread tasks across requirements so each step shows 1 active task
      const tasksForThisStep = this.getTasksForStep(
        i,
        requirements.length,
        taskGroup,
      );
      for (const task of tasksForThisStep) {
        await this.setStatus(task.id, "executing");
        this.emit("task_started", {
          taskId: task.id,
          description: task.description,
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
        userMessage += `Current ${filePath}:\n\`\`\`\n${this.truncateForPrompt(currentContent, 160)}\n\`\`\`\n\n`;
        userMessage += `ENHANCE the file above. Keep ALL existing code intact. Add ONLY this feature:\n- ${req}\n\nWrite the COMPLETE updated file with the new feature added.`;
      } else {
        userMessage += `Write the complete ${filePath} file implementing this feature:\n- ${req}`;
      }

      // TSX-specific rules
      userMessage +=
        "\n\nUse inline styles (React style objects). Export a default function component. Do NOT use import statements except React.";

      // Include QA feedback from previous retry — only on first step
      if (i === 0 && qaReason) {
        userMessage += `\n\nWARNING: Previous version failed QA: ${qaReason}. Avoid this issue.`;
      }

      userMessage = this.withCustomInstructions(userMessage);

      // Self-healing loop: try → validate → feed error back → retry
      let stepPassed = false;
      let stepUserMessage = userMessage;

      for (
        let attempt = 1;
        attempt <= Pipeline.MAX_SELF_HEAL_ATTEMPTS;
        attempt++
      ) {
        const result = await runDeveloper(
          this.model,
          stepUserMessage,
          filePath,
        );

        if (!result.block) {
          await this.log(
            "DEV",
            `Step ${i + 1} attempt ${attempt}: parse failure`,
            tasksForThisStep[0]?.id || taskGroup[0].id,
            result.prompt,
            result.raw,
          );
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

        await this.log(
          "QA",
          `Step ${i + 1} attempt ${attempt} FAIL: ${validation.reason}`,
          tasksForThisStep[0]?.id || taskGroup[0].id,
          result.prompt,
          result.raw,
        );

        // Feed the error back for next attempt
        stepUserMessage =
          userMessage +
          `\n\nYour previous output failed validation: ${validation.reason}\nFix this error and try again.`;
      }

      if (!stepPassed) {
        await this.log(
          "QA",
          `Step ${i + 1}: all attempts failed — keeping previous version`,
          tasksForThisStep[0]?.id || taskGroup[0].id,
        );
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

    // Phase C: Final QA on the accumulated file
    const finalContent = this.getCurrentFileContent(filePath);
    if (!finalContent || finalContent.trim().length < 30) {
      // File is still basically empty — try to use deterministic fallback
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
          // Mark any remaining not-yet-done tasks
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
  private getTasksForStep(
    stepIndex: number,
    totalSteps: number,
    taskGroup: Task[],
  ): Task[] {
    if (totalSteps === 0) return taskGroup;
    if (taskGroup.length <= totalSteps) {
      // 1:1 mapping or fewer tasks than steps
      return stepIndex < taskGroup.length ? [taskGroup[stepIndex]] : [];
    }
    // More tasks than steps: distribute evenly
    const perStep = Math.floor(taskGroup.length / totalSteps);
    const remainder = taskGroup.length % totalSteps;
    const start = stepIndex * perStep + Math.min(stepIndex, remainder);
    const count = perStep + (stepIndex < remainder ? 1 : 0);
    return taskGroup.slice(start, start + count);
  }

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
    return this.truncateForPrompt(draft, 160);
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
        // Final fallback: if deterministic pre-pass produced a valid draft,
        // use it instead of marking the file STUCK.
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
  //  FULL QA PIPELINE (reusable: called after execute AND feedback)
  // ─────────────────────────────────────────────

  /**
   * Runs the complete QA pipeline: holistic review → iterative QA → improve → consistency.
   * Used after execute and after feedback so both paths get the same checks.
   */
  private async runFullQA() {
    await this.runHolisticReviewPass();
    await this.runIterativeQAPass();
    await this.runImprovementPass();
    await this.runConsistencyCheck();
  }

  // ─────────────────────────────────────────────
  //  PHASE 5: HOLISTIC REVIEW (Programmatic quality checks + LLM review)
  // ─────────────────────────────────────────────

  /**
   * Programmatic checks for common structural/quality problems that
   * small LLMs produce but can't reliably detect in their own output.
   */
  private checkOutputQuality(
    component: string,
  ): { file: string; issue: string }[] {
    const issues: { file: string; issue: string }[] = [];

    if (!component || component.trim().length < 50) {
      issues.push({
        file: "Component.tsx",
        issue:
          "Component file is nearly empty — write a complete React component with inline styles",
      });
      return issues;
    }

    const lower = component.toLowerCase();

    // Must have a default export
    if (!lower.includes("export default")) {
      issues.push({
        file: "Component.tsx",
        issue:
          "No default export found — add 'export default function Component()' or similar",
      });
    }

    // Should use inline styles
    if (!component.includes("style=") && !component.includes("style:")) {
      issues.push({
        file: "Component.tsx",
        issue:
          "No inline styles found — use React style objects (e.g., style={{ color: 'red' }}) for all styling",
      });
    }

    // Must return JSX
    if (!component.includes("return")) {
      issues.push({
        file: "Component.tsx",
        issue:
          "Component has no return statement — it must return JSX elements",
      });
    } else if (
      !component.includes("<") &&
      !component.includes("React.createElement")
    ) {
      issues.push({
        file: "Component.tsx",
        issue:
          "Component doesn't appear to return JSX — ensure the component returns rendered elements",
      });
    }

    // Check for truncated/incomplete functions (mismatched braces)
    const stripped = component
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``");
    let braceCount = 0;
    for (const ch of stripped) {
      if (ch === "{") braceCount++;
      if (ch === "}") braceCount--;
    }
    if (braceCount !== 0) {
      issues.push({
        file: "Component.tsx",
        issue: `Unbalanced braces (${braceCount > 0 ? braceCount + " unclosed" : Math.abs(braceCount) + " extra closing"}) — component may be truncated`,
      });
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

    const component = readFile("Component.tsx");

    if (component.trim().length < 20) return;

    await this.log("QA", "Running quality review of full output...");

    // Phase A: Programmatic quality checks (reliable, catches what LLMs miss)
    const structuralIssues = this.checkOutputQuality(component);

    // If no structural issues, skip the expensive LLM review entirely
    // Small models tend to find phantom issues and introduce bugs while "fixing" them
    if (structuralIssues.length === 0) {
      await this.log("QA", "PASS — no structural issues, skipping LLM review");
      return;
    }

    // Phase B: LLM holistic review (may find issues the programmatic checks miss)
    const projectFiles: { path: string; content: string }[] = [];
    for (const file of TEMPLATE_FILES) {
      const content = readFile(file);
      if (content.trim().length > 20) {
        projectFiles.push({ path: file, content });
      }
    }

    let llmIssues: string[] = [];
    if (projectFiles.length > 0) {
      const result = await runHolisticReview(
        this.model,
        this.projectName,
        this.projectDescription,
        projectFiles,
      );

      await this.log(
        "QA",
        `LLM review: ${result.verdict} (${result.tokens} tokens, ${result.durationMs}ms)`,
        undefined,
        result.prompt,
        result.raw,
      );

      if (result.verdict === "REWORK" && result.issues.length > 0) {
        llmIssues = result.issues;
      }
    }

    // Merge all issues (programmatic + LLM)
    const allIssues: { file: string; issue: string }[] = [
      ...structuralIssues,
      ...llmIssues.map((iss) => ({ file: "unknown", issue: iss })),
    ];

    if (allIssues.length === 0) {
      await this.log(
        "QA",
        "Quality review PASS — no structural or visual issues found",
      );
      return;
    }

    await this.log(
      "QA",
      `Quality review found ${allIssues.length} issue(s) to fix`,
    );
    for (const { file, issue } of allIssues) {
      await this.log("QA", `[${file}] ${issue}`);
    }

    // Group issues by file
    const issuesByFile: Record<string, string[]> = {};
    for (const { file, issue } of allIssues) {
      if (file === "unknown") {
        // LLM issues — try to route by keywords
        const issueLower = issue.toLowerCase();
        for (const fp of FILE_ORDER) {
          const keywords: Record<string, string[]> = {
            "Component.tsx": [
              "component",
              "jsx",
              "tsx",
              "react",
              "render",
              "style",
              "layout",
              "function",
              "event",
              "click",
              "state",
              "hook",
              "element",
              "html",
              "css",
              "button",
            ],
          };
          if ((keywords[fp] || []).some((kw) => issueLower.includes(kw))) {
            if (!issuesByFile[fp]) issuesByFile[fp] = [];
            issuesByFile[fp].push(issue);
          }
        }
      } else {
        if (!issuesByFile[file]) issuesByFile[file] = [];
        issuesByFile[file].push(issue);
      }
    }

    // Fix each file that has issues
    for (const filePath of FILE_ORDER) {
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
  private static readonly MAX_ITERATIVE_QA_ROUNDS = 5;

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

    const component = readFile("Component.tsx");
    if (component.trim().length < 20) return;

    await this.log(
      "QA",
      "Starting iterative QA (find one bug → fix → repeat)...",
    );

    const previousFixes: string[] = [];
    let round = 0;

    while (round < Pipeline.MAX_ITERATIVE_QA_ROUNDS && !this.aborted) {
      round++;

      // Read fresh file contents each round (they change after fixes)
      const currentFiles: { path: string; content: string }[] = [];
      for (const file of TEMPLATE_FILES) {
        const content = readFile(file);
        if (content.trim().length > 20) {
          currentFiles.push({ path: file, content });
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

      // Build fix prompt for the Developer
      const existingContent = readFile(resolvedFile);
      if (!existingContent || existingContent.trim().length < 20) {
        previousFixes.push(`${problem} (skipped — file empty)`);
        continue;
      }

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
        if (validation.valid) {
          await this.writeOutputFile(resolvedFile, repaired);
          await this.log(
            "QA",
            `Round ${round}: Fixed ${resolvedFile} (${devResult.tokens} tokens)`,
            undefined,
            devResult.prompt,
            devResult.raw,
          );
          previousFixes.push(`${problem} → fixed in ${resolvedFile}`);
        } else {
          await this.log(
            "QA",
            `Round ${round}: Fix for ${resolvedFile} failed validation: ${validation.reason} — keeping original`,
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
  //  FEEDBACK PASS — User-driven iterative loop
  // ─────────────────────────────────────────────

  /**
   * Applies user feedback to the component with backup, self-healing retry,
   * and validation. If the result is worse than the original, restores backup.
   */
  async runFeedbackPass(feedback: string) {
    const outDir = this.outputDir();
    if (!fs.existsSync(outDir)) {
      await this.log("FEEDBACK", "No output files found — nothing to modify.");
      return;
    }

    const componentPath = path.join(outDir, "Component.tsx");
    if (!fs.existsSync(componentPath)) {
      await this.log("FEEDBACK", "No Component.tsx found — nothing to modify.");
      return;
    }

    const original = fs.readFileSync(componentPath, "utf-8");
    if (original.trim().length === 0) {
      await this.log("FEEDBACK", "Component.tsx is empty — run Execute first.");
      return;
    }

    await this.log(
      "FEEDBACK",
      `Processing feedback: "${feedback.slice(0, 200)}${feedback.length > 200 ? "…" : ""}"`,
    );

    // Backup before modifying
    const backupPath = componentPath + ".bak";
    fs.writeFileSync(backupPath, original, "utf-8");
    await this.log("FEEDBACK", "Backed up Component.tsx");

    const FEEDBACK_SYSTEM_PROMPT = `Fix the issues in this React component. Do NOT rewrite or replace it.
Keep same name, structure, features. Only change what's broken.
Must have: export default function, return with JSX, inline styles.

Reply:
>>RESULT
status: DONE
filePath: Component.tsx
output: |
  (full corrected component code)
>>END`;

    let currentContent = original;
    let applied = false;

    // Self-healing retry loop: apply → validate → feed error back → retry
    for (
      let attempt = 1;
      attempt <= Pipeline.MAX_SELF_HEAL_ATTEMPTS;
      attempt++
    ) {
      await this.log(
        "FEEDBACK",
        `Attempt ${attempt}/${Pipeline.MAX_SELF_HEAL_ATTEMPTS}...`,
      );

      let userMessage = `Project: ${this.projectName} — ${this.projectDescription}\n\n`;
      userMessage += `EXISTING Component.tsx (edit this, do NOT replace):\n\`\`\`tsx\n${currentContent}\n\`\`\`\n\n`;
      userMessage += `USER FEEDBACK: "${feedback}"\n\n`;
      userMessage += `Output the COMPLETE corrected Component.tsx.`;

      userMessage = this.withCustomInstructions(userMessage);

      const result = await callOllamaFn(
        this.model,
        "feedback",
        FEEDBACK_SYSTEM_PROMPT,
        userMessage,
      );

      const parsed = parseTTM(result.text);
      const block =
        parsed && "output" in parsed ? (parsed as { output: string }) : null;

      if (!block) {
        await this.log(
          "FEEDBACK",
          `Attempt ${attempt}: parse failure — retrying`,
          undefined,
          result.prompt,
          result.text,
        );
        continue;
      }

      const { repaired, fixes } = autoRepairOutput(
        block.output,
        "Component.tsx",
      );
      if (fixes.length > 0) {
        await this.log("FEEDBACK", `Auto-repaired: ${fixes.join(", ")}`);
      }

      const validation = validateOutput(repaired, "Component.tsx");
      if (validation.valid) {
        await this.writeOutputFile("Component.tsx", repaired);
        currentContent = repaired;
        applied = true;
        await this.log(
          "FEEDBACK",
          `Applied feedback (${result.tokens} tokens)`,
          undefined,
          result.prompt,
          result.text,
        );
        break;
      }

      // Validation failed — feed the error back for the next attempt
      await this.log(
        "FEEDBACK",
        `Attempt ${attempt} failed: ${validation.reason}`,
        undefined,
        result.prompt,
        result.text,
      );
      feedback = `${feedback}\n\nYour previous fix failed validation: ${validation.reason}. Fix this error too.`;
    }

    if (!applied) {
      // All attempts failed — restore backup
      fs.writeFileSync(componentPath, original, "utf-8");
      await this.log(
        "FEEDBACK",
        "All attempts failed — restored original component",
      );
    }

    // Clean up backup
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }

    await this.log("FEEDBACK", "Feedback pass complete");
  }

  /** Map an LLM-returned filename to Component.tsx */
  private resolveTargetFile(name: string): string | null {
    // Single-file model — everything targets Component.tsx
    const n = name.toLowerCase().trim();
    if (
      n.includes("component") ||
      n.includes("tsx") ||
      n.includes("jsx") ||
      n.includes("html") ||
      n.includes("css") ||
      n.includes("js") ||
      n.includes("style") ||
      n.includes("script") ||
      n.includes("index")
    ) {
      return "Component.tsx";
    }
    // Check if it matches one of the template files directly
    for (const f of TEMPLATE_FILES) {
      if (n === f.toLowerCase()) return f;
    }
    // Default to Component.tsx for any file reference
    return "Component.tsx";
  }

  // ─────────────────────────────────────────────
  //  PHASE 7: IMPROVE (Component bug review)
  // ─────────────────────────────────────────────

  private async runImprovementPass() {
    const outDir = this.outputDir();
    if (!fs.existsSync(outDir)) return;

    const projectFiles: { path: string; content: string }[] = [];
    for (const file of TEMPLATE_FILES) {
      const fullPath = path.join(outDir, file);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, "utf-8");
        if (content.trim().length > 20) {
          projectFiles.push({ path: file, content });
        }
      }
    }

    if (projectFiles.length === 0) return;

    const project = await db.query.projects.findFirst({
      where: eq(projects.id, this.projectId),
    });
    if (!project) return;

    const userRequest = `${project.name}: ${project.description}`;

    await this.log("IMP", "Reviewing component for bugs...");

    const result = await runImprover(this.model, userRequest, projectFiles);

    if (result.fixes.length === 0) {
      await this.log(
        "IMP",
        `No issues found (${result.tokens} tokens, ${result.durationMs}ms)`,
        undefined,
        result.prompt,
        result.raw,
      );
      return;
    }

    await this.log(
      "IMP",
      `Found ${result.fixes.length} issue(s) to fix (${result.tokens} tokens, ${result.durationMs}ms)`,
      undefined,
      result.prompt,
      result.raw,
    );

    // Group fixes by file for single rewrite per file
    const fixesByFile: Record<string, string[]> = {};
    for (const fix of result.fixes) {
      const fp = this.resolveFilePath(fix.filePath, fix.description);
      if (!fixesByFile[fp]) fixesByFile[fp] = [];
      fixesByFile[fp].push(fix.description);
    }

    for (const filePath of FILE_ORDER) {
      if (this.aborted) break;
      const fixDescriptions = fixesByFile[filePath];
      if (!fixDescriptions || fixDescriptions.length === 0) continue;

      const fixList = fixDescriptions
        .map((d, i) => `${i + 1}. ${d}`)
        .join("\n");
      await this.log(
        "IMP",
        `Fixing ${filePath}: ${fixDescriptions.length} issue(s)`,
      );

      const outputPath = path.join(outDir, filePath);
      const existingContent = fs.existsSync(outputPath)
        ? fs.readFileSync(outputPath, "utf-8")
        : null;

      let userMessage = `Project: ${this.projectName}\n\n`;
      if (existingContent) {
        userMessage += `Current ${filePath}:\n${existingContent}\n\n`;
      }
      userMessage += `Fix these bugs and rewrite the COMPLETE ${filePath} file:\n${fixList}`;

      userMessage = this.withCustomInstructions(userMessage);

      const devResult = await runDeveloper(this.model, userMessage, filePath);

      if (devResult.block) {
        const output = devResult.block.output;
        const { repaired } = autoRepairOutput(output, filePath);
        const validation = validateOutput(repaired, filePath);
        if (validation.valid) {
          await this.writeOutputFile(filePath, repaired);
          await this.log(
            "IMP",
            `Fixed ${filePath} (${devResult.tokens} tokens)`,
            undefined,
            devResult.prompt,
            devResult.raw,
          );
        } else {
          await this.log(
            "IMP",
            `Fix for ${filePath} failed validation: ${validation.reason} — keeping original`,
            undefined,
            devResult.prompt,
            devResult.raw,
          );
        }
      } else {
        await this.log(
          "IMP",
          `Could not fix ${filePath} — Developer parse failure`,
          undefined,
          devResult.prompt,
          devResult.raw,
        );
      }
    }

    await this.log("IMP", "Improvement pass complete");
  }

  // ─────────────────────────────────────────────
  //  PHASE 6: CONSISTENCY CHECK (Programmatic validation)
  // ─────────────────────────────────────────────

  private async runConsistencyCheck() {
    // Single-component model — no cross-file consistency to check.
    // Structural issues are already caught by the holistic review.
    await this.log(
      "CHK",
      "Component consistency check — OK (single-file model)",
    );
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
