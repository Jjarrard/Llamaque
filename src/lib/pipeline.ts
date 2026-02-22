/**
 * Pipeline Orchestrator — Spec-Based Execution
 *
 * Phases:
 *   1. DECOMPOSE — PM breaks idea into 3-5 epics
 *   2. PLAN — Manager breaks each epic into 2-3 file-targeted features
 *   3. MERGE — Programmatic: group features by file, deduplicate, cap at 8
 *   4. EXECUTE — Sequential: one requirement at a time per file (HTML → CSS → JS)
 *   5. REVIEW — Programmatic quality checks + LLM holistic review
 *   6. ITERATIVE QA — Find one bug → fix → repeat (up to 5 rounds)
 *   7. IMPROVE — Improver reviews all files for remaining bugs
 *   8. CONSISTENCY — Programmatic cross-file validation + auto-fix
 *
 * The HTML file IS the contract: CSS and JS get full HTML context.
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
import {
  validateOutput,
  autoRepairOutput,
  validateCrossFileConsistency,
} from "@/lib/validate";
import { isVagueOrCircular, extractReferences } from "@/lib/protocol";
import { applyOperations } from "@/lib/ops/executor";
import { compileRequirementsToOperations } from "@/lib/ops/compiler";
import { FileBundle } from "@/lib/ops/types";
import fs from "fs";
import path from "path";

/** Planning stops at depth 2 (Epic → Feature). Features ARE the execution leaves. */
const MAX_DEPTH = 2;
const MAX_TASKS = 200;
const MAX_RETRIES = 2;
const MAX_PARSE_RETRIES = 2;
/** Max bullet points per file spec — keeps Developer prompt short */
const MAX_REQUIREMENTS = 8;
/** Smaller caps per file to reduce overload on small models */
const FILE_REQUIREMENT_CAP: Record<string, number> = {
  "index.html": 5,
  "style.css": 4,
  "script.js": 3,
};
/** Max features the Manager can produce per epic */
const MAX_SUBTASKS = 3;
/** Max epics from PM */
const MAX_EPICS = 5;

/** The 3 fixed project files — no others are created */
const TEMPLATE_FILES = ["index.html", "style.css", "script.js"] as const;

/** File write order — HTML first so CSS/JS can reference its selectors */
const FILE_ORDER = ["index.html", "style.css", "script.js"] as const;

export type PipelineStage =
  | "all"
  | "decompose"
  | "breakdown"
  | "execute"
  | "qa";

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

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${this.projectName}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>

  <script src="script.js"></script>
</body>
</html>`;

    const css = `/* style.css */\n`;
    const js = `// script.js\n`;

    fs.writeFileSync(path.join(outDir, "index.html"), html, "utf-8");
    fs.writeFileSync(path.join(outDir, "style.css"), css, "utf-8");
    fs.writeFileSync(path.join(outDir, "script.js"), js, "utf-8");

    await this.log("SYS", "Created scaffold: index.html, style.css, script.js");
  }

  // ─────────────────────────────────────────────
  //  FILE PATH RESOLUTION
  // ─────────────────────────────────────────────

  private resolveFilePath(
    filePath: string | null,
    description: string,
  ): string {
    if (
      filePath &&
      TEMPLATE_FILES.includes(filePath as (typeof TEMPLATE_FILES)[number])
    ) {
      return filePath;
    }

    if (filePath) {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === ".html" || ext === ".htm") return "index.html";
      if (ext === ".css") return "style.css";
      if (ext === ".js") return "script.js";
    }

    const desc = description.toLowerCase();

    // CSS keywords
    if (
      desc.includes("style") ||
      desc.includes("css") ||
      desc.includes("color") ||
      desc.includes("font") ||
      desc.includes("grid") ||
      desc.includes("design") ||
      desc.includes("theme") ||
      desc.includes("responsive") ||
      desc.includes("animation") ||
      desc.includes("hover") ||
      desc.includes("transition") ||
      desc.includes("flexbox") ||
      desc.includes("margin") ||
      desc.includes("padding") ||
      desc.includes("background") ||
      desc.includes("border")
    ) {
      return "style.css";
    }

    // JS keywords
    if (
      desc.includes("script") ||
      desc.includes(".js") ||
      desc.includes("javascript") ||
      desc.includes("click") ||
      desc.includes("event") ||
      desc.includes("function") ||
      desc.includes("logic") ||
      desc.includes("handler") ||
      desc.includes("listener") ||
      desc.includes("calculate") ||
      desc.includes("button action") ||
      desc.includes("counter") ||
      desc.includes("score") ||
      desc.includes("timer") ||
      desc.includes("game mechanic") ||
      desc.includes("interact") ||
      desc.includes("toggle") ||
      desc.includes("validate") ||
      desc.includes("submit") ||
      desc.includes("fetch") ||
      desc.includes("api") ||
      desc.includes("localstorage") ||
      desc.includes("dynamic")
    ) {
      return "script.js";
    }

    return "index.html";
  }

  // ─────────────────────────────────────────────
  //  MAIN ENTRY POINT
  // ─────────────────────────────────────────────

  async run(stage: PipelineStage = "all", breakdownDepth?: number) {
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
    const STAGE_ORDER = ["decompose", "breakdown", "execute", "qa"];
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

    // QA-only pass: skip task processing, just run review + iterative QA + improve + consistency
    if (stage === "qa") {
      await this.log(
        "SYS",
        "Running QA pass (review + iterative QA + improve + consistency)...",
      );
      await this.runHolisticReviewPass();
      await this.runIterativeQAPass();
      await this.runImprovementPass();
      await this.runConsistencyCheck();
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
      await this.runHolisticReviewPass();
      await this.runIterativeQAPass();
      await this.runImprovementPass();
      await this.runConsistencyCheck();
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
        `${task.description}\nThis is a high-level epic. You MUST break it into 2-3 smaller features that target specific files (index.html, style.css, or script.js). Reply with >>BREAKDOWN only.`,
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
          `${task.description}\nIMPORTANT: Break into DIFFERENT, SPECIFIC steps. Each must target one file (index.html, style.css, or script.js). Each must be a concrete coding action.`,
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
   * If CSS or JS have no features, generate a default spec.
   * Prevents the common issue where LLMs forget to generate CSS features.
   */
  private ensureBasicSpecs(
    fileSpecs: Record<string, { requirements: string[]; tasks: Task[] }>,
    fileGroups: Record<string, Task[]>,
  ) {
    // Collect all tasks for fallback assignment
    const allTasks = Object.values(fileGroups).flat();
    const fallbackTasks = fileGroups["index.html"] || allTasks.slice(0, 1);

    // If no HTML spec, ALWAYS add one — HTML is the foundation
    if (
      !fileSpecs["index.html"] ||
      fileSpecs["index.html"].requirements.length === 0
    ) {
      // Build HTML requirements from ALL features across all files
      const allRequirements = Object.values(fileSpecs)
        .flatMap((s) => s.requirements)
        .slice(0, 5);
      const htmlReqs = [
        `Build the complete HTML structure for "${this.projectName}"`,
        "Give every interactive element (buttons, inputs, lists) a unique id attribute",
        "Include semantic HTML5 structure with proper headings and sections",
      ];
      // Add context from other specs so HTML knows what elements are needed
      if (allRequirements.length > 0) {
        htmlReqs.push(
          `The app needs these features (build HTML elements for them): ${allRequirements.join("; ")}`,
        );
      }
      fileSpecs["index.html"] = {
        requirements: htmlReqs,
        tasks: fallbackTasks,
      };
      this.log(
        "SYS",
        "Added default HTML spec (no HTML features were generated)",
      );
    }

    // If no CSS spec, add styling requirements that reference the project's features
    if (
      !fileSpecs["style.css"] ||
      fileSpecs["style.css"].requirements.length === 0
    ) {
      const allFeatures = Object.values(fileSpecs)
        .flatMap((s) => s.requirements)
        .join(" ")
        .toLowerCase();
      const cssReqs = [
        `Add clean, modern CSS styling appropriate for "${this.projectName}"`,
        "Style the body with a centered layout, readable font, and background color",
        "Style all buttons with padding, border-radius, hover effects, and cursor pointer",
      ];
      if (
        allFeatures.includes("list") ||
        allFeatures.includes("item") ||
        allFeatures.includes("task")
      ) {
        cssReqs.push(
          "Style list items with padding, borders, and hover effects",
        );
      }
      if (
        allFeatures.includes("complete") ||
        allFeatures.includes("done") ||
        allFeatures.includes("toggle")
      ) {
        cssReqs.push(
          "Style completed items with line-through text and reduced opacity",
        );
      }
      if (
        allFeatures.includes("form") ||
        allFeatures.includes("input") ||
        allFeatures.includes("add")
      ) {
        cssReqs.push(
          "Style the form with flexbox layout and input with focus state",
        );
      }
      fileSpecs["style.css"] = {
        requirements: cssReqs.slice(0, FILE_REQUIREMENT_CAP["style.css"] ?? 4),
        tasks: fallbackTasks,
      };
      this.log(
        "SYS",
        "Added default CSS spec (no CSS features were generated)",
      );
    }

    // If no JS spec but project needs interactivity, add basic requirement
    const descLower = this.projectDescription.toLowerCase();
    const needsJS =
      descLower.includes("click") ||
      descLower.includes("button") ||
      descLower.includes("counter") ||
      descLower.includes("game") ||
      descLower.includes("calculator") ||
      descLower.includes("todo") ||
      descLower.includes("interactive") ||
      descLower.includes("timer") ||
      descLower.includes("form") ||
      descLower.includes("score") ||
      descLower.includes("list") ||
      descLower.includes("app");

    if (
      needsJS &&
      (!fileSpecs["script.js"] ||
        fileSpecs["script.js"].requirements.length === 0)
    ) {
      // Build JS requirements from the project description
      const jsReqs: string[] = [
        `Implement the core JavaScript logic for "${this.projectName}: ${this.projectDescription}"`,
      ];

      if (
        descLower.includes("add") ||
        descLower.includes("create") ||
        descLower.includes("new")
      ) {
        jsReqs.push(
          "Handle form submission to add new items to the list and render them",
        );
      }
      if (
        descLower.includes("delete") ||
        descLower.includes("remove") ||
        descLower.includes("clear")
      ) {
        jsReqs.push("Allow users to remove items from the list");
      }
      if (
        descLower.includes("complete") ||
        descLower.includes("toggle") ||
        descLower.includes("done") ||
        descLower.includes("check")
      ) {
        jsReqs.push("Toggle items as completed/active with visual feedback");
      }

      if (jsReqs.length === 1) {
        jsReqs.push("Query interactive elements by ID and add event listeners");
        jsReqs.push("Update the DOM to reflect state changes");
      }

      fileSpecs["script.js"] = {
        requirements: jsReqs.slice(0, FILE_REQUIREMENT_CAP["script.js"] ?? 3),
        tasks: fallbackTasks,
      };
      this.log("SYS", "Added default JS spec (no JS features were generated)");
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
        // Strip trailing "in index.html" / "in style.css" / "in script.js"
        const cleaned = task.description
          .replace(/\s+in\s+(index\.html|style\.css|script\.js)\s*$/i, "")
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

      // Re-read HTML/CSS context each step (HTML may have been updated)
      const htmlContext = this.getHTMLContext(filePath);
      const cssContext = this.getCSSContext(filePath);

      let userMessage = `Project: ${this.projectName} — ${this.projectDescription}\n\n`;

      if (htmlContext) {
        userMessage += `The HTML file:\n${htmlContext}\n\n`;
      }
      if (cssContext) {
        userMessage += `The CSS file:\n${cssContext}\n\n`;
      }

      if (hasContent) {
        userMessage += `Current ${filePath}:\n\`\`\`\n${this.truncateForPrompt(currentContent, 160)}\n\`\`\`\n\n`;
        userMessage += `ENHANCE the file above. Keep ALL existing code intact. Add ONLY this feature:\n- ${req}\n\nWrite the COMPLETE updated file with the new feature added.`;
      } else {
        userMessage += `Write the complete ${filePath} file implementing this feature:\n- ${req}`;
      }

      // File-specific rules
      if (filePath === "script.js") {
        userMessage +=
          "\n\nDeclare each variable/function EXACTLY ONCE. No duplicates. Keep all existing functions.";
      }
      if (filePath === "style.css") {
        userMessage +=
          "\n\nKeep ALL existing CSS rules. Only add new rules for the requested feature.";
      }

      // Include QA feedback from previous retry — only on first step
      if (i === 0 && qaReason) {
        userMessage += `\n\nWARNING: Previous version failed QA: ${qaReason}. Avoid this issue.`;
      }

      userMessage = this.withCustomInstructions(userMessage);

      const result = await runDeveloper(this.model, userMessage, filePath);

      if (!result.block) {
        await this.log(
          "DEV",
          `Step ${i + 1} parse failure, skipping`,
          tasksForThisStep[0]?.id || taskGroup[0].id,
          result.prompt,
          result.raw,
        );
        // Mark these tasks done anyway (their requirement was attempted)
        for (const task of tasksForThisStep) {
          await db
            .update(tasks)
            .set({ output: "", filePath })
            .where(eq(tasks.id, task.id));
          await this.completeTask(task);
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
        await this.writeOutputFile(filePath, output);
        stepsCompleted++;
        await this.log(
          "DEV",
          `Step ${i + 1} PASS (${result.tokens} tokens, ${result.durationMs}ms)`,
          tasksForThisStep[0]?.id || taskGroup[0].id,
          result.prompt,
          result.raw,
        );
      } else {
        await this.log(
          "QA",
          `Step ${i + 1} FAIL: ${validation.reason} — keeping previous version`,
          tasksForThisStep[0]?.id || taskGroup[0].id,
          result.prompt,
          result.raw,
        );
        // Don't write — keep the previous good version and continue
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

  private getHTMLContext(targetFile: string): string | null {
    if (targetFile === "index.html") return null;

    const htmlPath = path.join(this.outputDir(), "index.html");
    if (!fs.existsSync(htmlPath)) return null;

    const html = fs.readFileSync(htmlPath, "utf-8");
    if (html.trim().length < 50) return null;

    return html;
  }

  private getCSSContext(targetFile: string): string | null {
    if (targetFile !== "script.js") return null;

    const cssPath = path.join(this.outputDir(), "style.css");
    if (!fs.existsSync(cssPath)) return null;

    const css = fs.readFileSync(cssPath, "utf-8");
    if (css.trim().length < 20) return null;

    const lines = css.split("\n");
    if (lines.length > 60) {
      return lines.slice(0, 60).join("\n") + "\n/* ... */";
    }
    return css;
  }

  private async applyDeterministicOpsPrepass(
    filePath: string,
    requirements: string[],
    taskId: number,
  ): Promise<string | null> {
    let bundle = this.readFileBundle();

    // Compile ALL requirements together so the compiler can detect the full
    // app pattern (e.g. isList + hasAdd + hasToggle → generate CRUD logic).
    // Individual per-requirement compilation loses cross-requirement context.
    const operations = compileRequirementsToOperations(
      filePath,
      requirements,
      this.projectName,
    );

    if (operations.length === 0) {
      const draft = this.getCurrentFileContent(filePath);
      if (!draft) return null;
      this.deterministicDraftByFile[filePath] = draft;
      return this.truncateForPrompt(draft, 160);
    }

    const result = applyOperations(bundle, operations);
    const totalApplied = result.executions.filter((e) => e.applied).length;
    bundle = result.files;

    if (totalApplied > 0) {
      this.writeFileBundle(bundle);
      await this.log(
        "SYS",
        `Applied ${totalApplied}/${operations.length} deterministic ops for ${filePath}`,
        taskId,
      );
    }

    const draft = this.getCurrentFileContent(filePath);
    if (!draft) return null;
    this.deterministicDraftByFile[filePath] = draft;
    return this.truncateForPrompt(draft, 160);
  }

  private readFileBundle(): FileBundle {
    const outDir = this.outputDir();
    const read = (name: string) => {
      const fullPath = path.join(outDir, name);
      if (!fs.existsSync(fullPath)) return "";
      return fs.readFileSync(fullPath, "utf-8");
    };
    return {
      html: read("index.html"),
      css: read("style.css"),
      js: read("script.js"),
    };
  }

  private writeFileBundle(bundle: FileBundle) {
    const outDir = this.outputDir();
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    fs.writeFileSync(path.join(outDir, "index.html"), bundle.html, "utf-8");
    fs.writeFileSync(path.join(outDir, "style.css"), bundle.css, "utf-8");
    fs.writeFileSync(path.join(outDir, "script.js"), bundle.js, "utf-8");
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

    // Targeted repair pass for common JS failure mode on small models
    if (
      filePath === "script.js" &&
      !result.valid &&
      (result.reason || "").toLowerCase().includes("duplicate declarations")
    ) {
      const deduped = this.removeDuplicateJsDeclarations(finalOutput);
      if (deduped !== finalOutput) {
        const dedupeValidation = validateOutput(deduped, filePath);
        if (dedupeValidation.valid) {
          finalOutput = deduped;
          result = dedupeValidation;
          await this.writeOutputFile(filePath, finalOutput);
          for (const task of taskGroup) {
            await db
              .update(tasks)
              .set({ output: finalOutput })
              .where(eq(tasks.id, task.id));
          }
          await this.log(
            "QA",
            "Auto-repaired duplicate JavaScript declarations",
            taskGroup[0].id,
          );
        }
      }
    }

    // Soft cross-file check (warning only)
    if (
      result.valid &&
      (filePath === "style.css" || filePath === "script.js")
    ) {
      const crossFileResult = this.validateCrossFileRefs(filePath, finalOutput);
      if (!crossFileResult.valid) {
        await this.log(
          "QA",
          `WARN: ${crossFileResult.reason}`,
          taskGroup[0].id,
        );
      }
    }

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

      const isCssBraceFailure =
        filePath === "style.css" &&
        (result.reason || "").toLowerCase().includes("braces");

      if (isCssBraceFailure) {
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
              "Using deterministic fallback for CSS brace failure",
              firstTask.id,
            );
            for (const task of taskGroup) {
              await this.completeTask(task);
            }
            return;
          }
        }
      }

      const isJsDuplicateFailure =
        filePath === "script.js" &&
        (result.reason || "").toLowerCase().includes("duplicate declarations");

      // Early fallback for weak-model JS duplicate loops: after first failed retry,
      // prefer deterministic draft if valid rather than burning more model attempts.
      if (isJsDuplicateFailure && firstTask.retryCount >= 1) {
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
              `Using deterministic fallback early for ${filePath} after duplicate-declaration retry failure`,
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

  private removeDuplicateJsDeclarations(source: string): string {
    const countChar = (value: string, char: string) =>
      value.split(char).length - 1;

    const lines = source.split("\n");
    const seenConsts = new Set<string>();
    const seenFunctions = new Set<string>();
    const output: string[] = [];

    let skipFunction = false;
    let functionBraceDepth = 0;

    for (const line of lines) {
      const constMatch = line.match(
        /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/,
      );
      if (constMatch && !skipFunction) {
        const name = constMatch[1];
        if (seenConsts.has(name)) {
          continue;
        }
        seenConsts.add(name);
      }

      const fnMatch = line.match(/^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/);
      if (fnMatch && !skipFunction) {
        const name = fnMatch[1];
        if (seenFunctions.has(name)) {
          skipFunction = true;
          functionBraceDepth = countChar(line, "{") - countChar(line, "}");
          if (functionBraceDepth <= 0) {
            skipFunction = false;
          }
          continue;
        }
        seenFunctions.add(name);
      }

      if (skipFunction) {
        functionBraceDepth += countChar(line, "{") - countChar(line, "}");
        if (functionBraceDepth <= 0) {
          skipFunction = false;
        }
        continue;
      }

      output.push(line);
    }

    return output.join("\n");
  }

  private validateCrossFileRefs(
    filePath: string,
    content: string,
  ): { valid: boolean; reason?: string } {
    const htmlPath = path.join(this.outputDir(), "index.html");
    if (!fs.existsSync(htmlPath)) return { valid: true };

    const html = fs.readFileSync(htmlPath, "utf-8");

    const htmlIds = new Set<string>();
    const htmlClasses = new Set<string>();
    for (const m of html.matchAll(/id=["']([^"']+)["']/g)) {
      htmlIds.add(m[1]);
    }
    for (const m of html.matchAll(/class=["']([^"']+)["']/g)) {
      for (const cls of m[1].split(/\s+/)) {
        if (cls) htmlClasses.add(cls);
      }
    }

    if (htmlIds.size === 0 && htmlClasses.size === 0) {
      return { valid: true };
    }

    if (filePath === "style.css") {
      const cssSelectors = content.match(/[.#][\w-]+/g) || [];
      const matchesAny = cssSelectors.some((sel) => {
        if (sel.startsWith("#")) return htmlIds.has(sel.slice(1));
        if (sel.startsWith(".")) return htmlClasses.has(sel.slice(1));
        return false;
      });
      if (cssSelectors.length > 0 && !matchesAny) {
        return {
          valid: false,
          reason: `CSS selectors don't match any HTML IDs/classes. HTML has: ${[
            ...htmlIds,
          ]
            .map((i) => "#" + i)
            .concat([...htmlClasses].map((c) => "." + c))
            .join(", ")}`,
        };
      }
    }

    if (filePath === "script.js") {
      const jsSelectors = [
        ...content.matchAll(/getElementById\s*\(\s*["']([^"']+)["']\s*\)/g),
        ...content.matchAll(
          /querySelector(?:All)?\s*\(\s*["']([^"']+)["']\s*\)/g,
        ),
        ...content.matchAll(
          /getElementsByClassName\s*\(\s*["']([^"']+)["']\s*\)/g,
        ),
      ];
      if (jsSelectors.length === 0 && htmlIds.size + htmlClasses.size > 2) {
        return {
          valid: false,
          reason: `JavaScript doesn't query any DOM elements, but HTML has ${htmlIds.size} IDs and ${htmlClasses.size} classes`,
        };
      }
    }

    return { valid: true };
  }

  // ─────────────────────────────────────────────
  //  PHASE 5: HOLISTIC REVIEW (Programmatic quality checks + LLM review)
  // ─────────────────────────────────────────────

  /**
   * Programmatic checks for common structural/quality problems that
   * small LLMs produce but can't reliably detect in their own output.
   */
  private checkOutputQuality(
    html: string,
    css: string,
    js: string,
  ): { file: string; issue: string }[] {
    const issues: { file: string; issue: string }[] = [];

    // ── HTML structural checks ──
    if (html) {
      // Elements outside the main container (body > direct children that aren't the container)
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      if (bodyMatch) {
        const bodyContent = bodyMatch[1];
        // Count direct child elements (rough heuristic)
        const topLevelTags = bodyContent.match(
          /^\s*<(?!script|link|!--)([\w-]+)/gim,
        );
        if (topLevelTags && topLevelTags.length > 3) {
          issues.push({
            file: "index.html",
            issue:
              "Too many top-level elements in <body> — wrap all content in a single container (e.g. <main> or <div id='app'>) so CSS can center and constrain the layout",
          });
        }
      }

      // Form wrapping non-form content
      const formBlocks = html.match(/<form[^>]*>[\s\S]*?<\/form>/gi) || [];
      for (const form of formBlocks) {
        if (form.includes("<ul") || form.includes("<ol")) {
          issues.push({
            file: "index.html",
            issue:
              "A <ul> or <ol> list is nested inside a <form> — move the list outside the form so it renders as a separate section",
          });
        }
      }

      // Buttons outside any container
      const mainOrDiv = /<main|<div\s+id=["']app/i.test(html);
      if (mainOrDiv) {
        const outsideButtons = html.match(
          /<\/main>[\s\S]*?<button|<\/div><!--\s*app\s*-->[\s\S]*?<button/i,
        );
        if (outsideButtons) {
          issues.push({
            file: "index.html",
            issue:
              "One or more <button> elements appear outside the main container — move them inside so they inherit container styling",
          });
        }
      }
    }

    // ── CSS quality checks ──
    if (css) {
      const cssLower = css.toLowerCase();
      const cssLines = css.split("\n").length;

      // Barely any CSS
      if (cssLines < 10 || css.trim().length < 150) {
        issues.push({
          file: "style.css",
          issue:
            "CSS file is nearly empty or minimal — add proper styling: body layout, font, colors, spacing for all elements, button hover states, and input focus states",
        });
      } else {
        // No body styling
        if (!cssLower.includes("body")) {
          issues.push({
            file: "style.css",
            issue:
              "No body CSS rule — add body styling with font-family, background-color, and centered layout",
          });
        }

        // No max-width / centering for main container
        if (
          !cssLower.includes("max-width") &&
          !cssLower.includes("margin: 0 auto") &&
          !cssLower.includes("margin:0 auto") &&
          !cssLower.includes("margin: auto")
        ) {
          issues.push({
            file: "style.css",
            issue:
              "No container centering (max-width + margin auto) — the content will stretch full-width on large screens. Add a centered container with max-width",
          });
        }

        // No button styling
        if (!cssLower.includes("button") && !cssLower.includes("btn")) {
          issues.push({
            file: "style.css",
            issue:
              "No button styling — add button rules with padding, border-radius, background-color, hover state, and cursor: pointer",
          });
        }

        // No hover/focus states at all
        if (!cssLower.includes(":hover") && !cssLower.includes(":focus")) {
          issues.push({
            file: "style.css",
            issue:
              "No :hover or :focus states — add hover effects on buttons and focus styles on inputs for better interactivity",
          });
        }

        // No input styling
        if (
          html &&
          (html.includes("<input") || html.includes("<textarea")) &&
          !cssLower.includes("input") &&
          !cssLower.includes("textarea")
        ) {
          issues.push({
            file: "style.css",
            issue:
              "HTML has input/textarea elements but CSS has no input styling — add padding, border, border-radius, and focus state for inputs",
          });
        }
      }
    } else if (html && html.length > 100) {
      issues.push({
        file: "style.css",
        issue:
          "CSS file is empty but HTML has content — write complete CSS with body layout, element styling, hover states, and responsive design",
      });
    }

    // ── JS checks ──
    if (js && html) {
      // Check if JS references IDs that don't exist in HTML
      const jsIds =
        js.match(/getElementById\(['"](\w+)['"]\)/g)?.map((m) => {
          const match = m.match(/['"](\w+)['"]/);
          return match ? match[1] : null;
        }) || [];

      for (const id of jsIds) {
        if (
          id &&
          !html.includes(`id="${id}"`) &&
          !html.includes(`id='${id}'`)
        ) {
          issues.push({
            file: "index.html",
            issue: `JavaScript references element id="${id}" but it doesn't exist in the HTML — add the missing element or fix the ID`,
          });
          break; // One warning is enough
        }
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

    const html = readFile("index.html");
    const css = readFile("style.css");
    const js = readFile("script.js");

    if (html.trim().length < 20) return;

    await this.log("QA", "Running quality review of full output...");

    // Phase A: Programmatic quality checks (reliable, catches what LLMs miss)
    const structuralIssues = this.checkOutputQuality(html, css, js);

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
            "index.html": [
              "html",
              "element",
              "form",
              "button",
              "structure",
              "heading",
              "container",
            ],
            "style.css": [
              "css",
              "style",
              "layout",
              "spacing",
              "font",
              "color",
              "visual",
              "margin",
              "padding",
            ],
            "script.js": [
              "js",
              "javascript",
              "function",
              "event",
              "click",
              "listener",
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

      const htmlContext = this.getHTMLContext(filePath);

      let userMessage = `Project: ${this.projectName} — ${this.projectDescription}\n\n`;
      if (htmlContext && filePath !== "index.html") {
        userMessage += `HTML file:\n${htmlContext}\n\n`;
      }
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

  private async runIterativeQAPass() {
    const outDir = this.outputDir();
    if (!fs.existsSync(outDir)) return;

    const readFile = (name: string) => {
      const fullPath = path.join(outDir, name);
      if (!fs.existsSync(fullPath)) return "";
      return fs.readFileSync(fullPath, "utf-8");
    };

    const html = readFile("index.html");
    if (html.trim().length < 20) return;

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

      const htmlContext = this.getHTMLContext(resolvedFile);

      let userMessage = `Project: ${this.projectName} — ${this.projectDescription}\n\n`;
      if (htmlContext && resolvedFile !== "index.html") {
        userMessage += `HTML file:\n${htmlContext}\n\n`;
      }
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

  /** Map an LLM-returned filename to one of the 3 template files */
  private resolveTargetFile(name: string): string | null {
    const n = name.toLowerCase().trim();
    if (n.includes("html") || n === "index.html") return "index.html";
    if (n.includes("css") || n === "style.css" || n === "styles.css")
      return "style.css";
    if (
      n.includes("js") ||
      n === "script.js" ||
      n === "main.js" ||
      n === "app.js"
    )
      return "script.js";
    // Check if it matches one of the template files directly
    for (const f of TEMPLATE_FILES) {
      if (n === f) return f;
    }
    return null;
  }

  // ─────────────────────────────────────────────
  //  PHASE 7: IMPROVE (Cross-file bug review)
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

    await this.log("IMP", "Reviewing all files for cross-file bugs...");

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

      const htmlContext = this.getHTMLContext(filePath);

      let userMessage = `Project: ${this.projectName}\n\n`;
      if (htmlContext && filePath !== "index.html") {
        userMessage += `HTML file:\n${htmlContext}\n\n`;
      }
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
  //  PHASE 6: CONSISTENCY CHECK (Programmatic cross-file validation + auto-fix)
  // ─────────────────────────────────────────────

  private async runConsistencyCheck() {
    const outDir = this.outputDir();
    if (!fs.existsSync(outDir)) return;

    const readFile = (name: string) => {
      const fullPath = path.join(outDir, name);
      if (!fs.existsSync(fullPath)) return "";
      return fs.readFileSync(fullPath, "utf-8");
    };

    const html = readFile("index.html");
    const css = readFile("style.css");
    const js = readFile("script.js");

    if (html.trim().length < 20) return;

    await this.log("CHK", "Running cross-file consistency check...");

    const issues = validateCrossFileConsistency(html, css, js);

    if (issues.length === 0) {
      await this.log("CHK", "All files are consistent — no cross-file issues");
      return;
    }

    const errors = issues.filter((i) => i.severity === "error");
    const warnings = issues.filter((i) => i.severity === "warning");

    for (const warn of warnings) {
      await this.log("CHK", `WARN: [${warn.file}] ${warn.message}`);
    }

    if (errors.length === 0) {
      await this.log(
        "CHK",
        `Consistency check done: ${warnings.length} warning(s), 0 errors`,
      );
      return;
    }

    await this.log(
      "CHK",
      `Found ${errors.length} error(s), ${warnings.length} warning(s) — attempting auto-fix`,
    );

    // Group errors by file
    const errorsByFile: Record<string, string[]> = {};
    for (const err of errors) {
      if (!errorsByFile[err.file]) errorsByFile[err.file] = [];
      errorsByFile[err.file].push(err.message);
    }

    // Fix each file that has errors
    for (const filePath of FILE_ORDER) {
      if (this.aborted) break;
      const fileErrors = errorsByFile[filePath];
      if (!fileErrors || fileErrors.length === 0) continue;

      const fixList = fileErrors.map((e, i) => `${i + 1}. ${e}`).join("\n");
      await this.log(
        "CHK",
        `Fixing ${filePath}: ${fileErrors.length} issue(s)`,
      );

      const existingContent = readFile(filePath);
      const htmlContext =
        filePath !== "index.html" ? readFile("index.html") : "";

      let userMessage = `Project: ${this.projectName}\n\n`;
      if (htmlContext) {
        userMessage += `HTML file:\n${htmlContext}\n\n`;
      }
      if (existingContent) {
        userMessage += `Current ${filePath}:\n${existingContent}\n\n`;
      }
      userMessage += `Fix these cross-file consistency issues and rewrite the COMPLETE ${filePath} file:\n${fixList}`;

      userMessage = this.withCustomInstructions(userMessage);

      const devResult = await runDeveloper(this.model, userMessage, filePath);

      if (devResult.block) {
        const output = devResult.block.output;
        const { repaired } = autoRepairOutput(output, filePath);
        const validation = validateOutput(repaired, filePath);
        if (validation.valid) {
          await this.writeOutputFile(filePath, repaired);
          await this.log(
            "CHK",
            `Fixed ${filePath} (${devResult.tokens} tokens)`,
            undefined,
            devResult.prompt,
            devResult.raw,
          );
        } else {
          await this.log(
            "CHK",
            `Fix for ${filePath} failed validation: ${validation.reason} — keeping original`,
            undefined,
            devResult.prompt,
            devResult.raw,
          );
        }
      } else {
        await this.log(
          "CHK",
          `Could not fix ${filePath} — Developer parse failure`,
          undefined,
          devResult.prompt,
          devResult.raw,
        );
      }
    }

    await this.log("CHK", "Consistency check complete");
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
