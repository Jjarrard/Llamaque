/**
 * Planning phases: architect (file manifest + scaffold), contract designer,
 * decompose (epics) and breakdown (features).
 */
import { db } from "@/db";
import {
  projects,
  tasks,
  Task,
  ManifestFile,
} from "@/db/schema";
import { eq, asc } from "drizzle-orm";
import { runProjectManager } from "@/lib/agents/project-manager";
import { runReviewer } from "@/lib/agents/reviewer";
import { runManager } from "@/lib/agents/manager";
import { runArchitect, inferDefaultManifest } from "@/lib/agents/architect";
import { runContractDesigner } from "@/lib/agents/contract-designer";
import { isVagueOrCircular } from "@/lib/protocol";
import fs from "fs";
import path from "path";
import type { Pipeline } from ".";
import {
  MAX_DEPTH,
  MAX_TASKS,
  MAX_PARSE_RETRIES,
  MAX_SUBTASKS,
  MAX_EPICS,
} from "./types";

// ─────────────────────────────────────────────
//  SCAFFOLD
// ─────────────────────────────────────────────

export async function createScaffold(p: Pipeline) {
  const outDir = p.outputDir();
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  for (const file of p.manifest) {
    const fullPath = path.join(outDir, file.path);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const scaffold = generateScaffold(p, file);
    fs.writeFileSync(fullPath, scaffold, "utf-8");
  }

  const fileList = p.manifest.map((f) => f.path).join(", ");
  await p.log("SYS", `Created scaffold: ${fileList}`);
}

/** Generate a minimal scaffold for a file based on its type/language */
export function generateScaffold(p: Pipeline, file: ManifestFile): string {
  const ext = file.path.split(".").pop()?.toLowerCase() || "";

  switch (ext) {
    case "tsx":
    case "jsx": {
      const compName = file.path.replace(/\.\w+$/, "") || "Component";
      return `import React from "react";

export default function ${compName}() {
  return (
    <div style={{ fontFamily: "sans-serif", padding: "2rem" }}>
      <h1>${p.projectName}</h1>
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
  <title>${p.projectName}</title>
</head>
<body>
  <h1>${p.projectName}</h1>
</body>
</html>
`;
    case "css":
      return `/* ${file.description} */\n`;
    case "md":
    case "markdown":
      return `# ${p.projectName}\n\n${file.description}\n`;
    case "json":
      return `{}\n`;
    case "yaml":
    case "yml":
      return `# ${file.description}\n`;
    default:
      return ``;
  }
}

/** Load manifest from project record or infer a default */
export async function loadOrCreateManifest(p: Pipeline, project: {
  fileManifest: string | null;
  description: string;
}) {
  if (project.fileManifest) {
    try {
      p.manifest = JSON.parse(project.fileManifest) as ManifestFile[];
      if (p.manifest.length > 0) return;
    } catch {
      // Invalid JSON — fall through to inference
    }
  }
  // No manifest yet — will be set by runArchitectPhase or inferred
  p.manifest = [];
}

/** Run the Architect agent to determine the output file manifest */
export async function runArchitectPhase(p: Pipeline) {
  await p.log("ARCH", "Determining output file structure...");

  const result = await runArchitect(
    p.model,
    p.projectName,
    p.projectDescription,
  );

  if (result.manifest.length > 0) {
    p.manifest = result.manifest;
    await p.log(
      "ARCH",
      `Determined ${result.manifest.length} output file(s): ${result.manifest.map((f) => f.path).join(", ")} (${result.tokens} tokens, ${result.durationMs}ms)`,
      undefined,
      result.prompt,
      result.raw,
    );
  } else {
    // Architect failed — use heuristic fallback
    p.manifest = inferDefaultManifest(p.projectDescription);
    await p.log(
      "ARCH",
      `Architect parse failed — inferred: ${p.manifest.map((f) => f.path).join(", ")}`,
      undefined,
      result.prompt,
      result.raw,
    );
  }

  // Persist to DB
  await db
    .update(projects)
    .set({ fileManifest: JSON.stringify(p.manifest) })
    .where(eq(projects.id, p.projectId));
}

/**
 * ContractDesigner phase — runs once after Architect.
 * For multi-file TS projects, produces a compact shared-types snippet
 * that gets injected into every subsequent Developer prompt.
 * Silent no-op on failure or single-file/non-TS projects.
 */
export async function runContractDesignerPhase(p: Pipeline) {
  const snippet = await runContractDesigner(
    p.model,
    p.projectName,
    p.projectDescription,
    p.manifest,
  );
  if (snippet) {
    p.contractSnippet = snippet;
    await p.log("ARCH", `Shared types defined:\n${snippet}`);
  }
}

// ─────────────────────────────────────────────
//  PHASE 1: DECOMPOSE (PM + Reviewer → Epics)
// ─────────────────────────────────────────────

export async function decompose(p: Pipeline, name: string, description: string) {
  const desc = p.withCustomInstructions(description);
  let result = await runProjectManager(p.model, name, desc);

  if (!result.block) {
    await p.log("PM", "Failed to parse response, retrying...");
    result = await runProjectManager(p.model, name, desc);
  }

  if (!result.block) {
    await p.log("PM", "STUCK: Could not decompose project idea");
    return;
  }

  const userRequest = `${name}: ${description}`;
  const reviewResult = await runReviewer(
    p.model,
    userRequest,
    result.block.tasks,
  );

  const filteredTasks = reviewResult.kept.slice(0, MAX_EPICS);
  const removed = result.block.tasks.length - filteredTasks.length;
  if (removed > 0) {
    await p.log(
      "REV",
      `Removed ${removed} unnecessary feature(s) (${reviewResult.tokens} tokens, ${reviewResult.durationMs}ms)`,
      undefined,
      reviewResult.prompt,
      reviewResult.raw,
    );
  } else {
    await p.log(
      "REV",
      `All ${filteredTasks.length} features approved (${reviewResult.tokens} tokens, ${reviewResult.durationMs}ms)`,
      undefined,
      reviewResult.prompt,
      reviewResult.raw,
    );
  }

  for (let i = 0; i < filteredTasks.length; i++) {
    await db.insert(tasks).values({
      projectId: p.projectId,
      parentId: null,
      description: filteredTasks[i],
      status: "awaiting_approval",
      depth: 1,
      sortOrder: i,
    });
    p.taskCount++;
  }

  await p.log(
    "PM",
    `Created ${filteredTasks.length} epics (${result.tokens} tokens, ${result.durationMs}ms)`,
    undefined,
    result.prompt,
    result.raw,
  );
}

// ─────────────────────────────────────────────\n  //  PHASE 2: PLAN (Manager → Features per Epic)\n  // ─────────────────────────────────────────────

export async function planAll(p: Pipeline) {
  while (!p.aborted) {
    const allTasks = await db.query.tasks.findMany({
      where: eq(tasks.projectId, p.projectId),
      orderBy: [asc(tasks.depth), asc(tasks.id)],
    });

    const next = allTasks.find((t) => {
      if (t.status !== "pending" && t.status !== "decomposing") return false;
      if (p.stage === "breakdown" && p.breakdownDepth !== null) {
        if (t.depth !== p.breakdownDepth) return false;
      }
      return true;
    });

    if (!next) break;

    // At MAX_DEPTH (2), features are leaves — mark READY
    if (next.depth >= MAX_DEPTH) {
      const effectiveFilePath = p.resolveFilePath(
        next.filePath,
        next.description,
      );
      await db
        .update(tasks)
        .set({ status: "ready", filePath: effectiveFilePath })
        .where(eq(tasks.id, next.id));
      await p.log(
        "SYS",
        `Feature → READY (${effectiveFilePath}): ${next.description}`,
        next.id,
      );
      continue;
    }

    const totalTasks = await p.getTotalTaskCount();
    if (totalTasks >= MAX_TASKS) {
      await p.markStuck(next.id, "Global task limit reached");
      continue;
    }

    await breakdownEpic(p, next);
  }
}

export async function breakdownEpic(p: Pipeline, task: Task) {
  await p.setStatus(task.id, "decomposing");
  p.emit("task_started", {
    taskId: task.id,
    description: task.description,
    agent: "manager",
  });

  await p.log("MGR", `Breaking down epic: ${task.description}`, task.id);

  // Build the file-manifest context so Manager scopes each task title to
  // a specific file via [FileName.ext] prefix. Without this the manager
  // generates list-level features (e.g. "implement card addition") that
  // the keyword router mis-targets at single-item files (e.g. Card.tsx).
  const manifestBlock =
    p.manifest.length > 0
      ? "\nFILES (each task MUST start with [FileName.ext] choosing the best fit):\n" +
        p.manifest.map((f) => `- [${f.path}] ${f.description}`).join("\n")
      : "";
  const baseContext = p.withCustomInstructions(
    `Project: ${p.projectName} — ${p.projectDescription}${manifestBlock}`,
  );

  let result = await runManager(p.model, task.description, baseContext);

  if (!result.block && task.parseRetryCount < MAX_PARSE_RETRIES) {
    await db
      .update(tasks)
      .set({ parseRetryCount: task.parseRetryCount + 1 })
      .where(eq(tasks.id, task.id));
    await p.log("MGR", "Parse failure, retrying...", task.id);
    result = await runManager(p.model, task.description, baseContext);
  }

  if (!result.block) {
    await p.markStuck(task.id, "Manager could not parse response");
    return;
  }

  // Manager must BREAKDOWN at depth 1 — never READY
  if (result.block.command === "READY") {
    await p.log(
      "MGR",
      `Overriding READY at depth 1 — forcing breakdown`,
      task.id,
      result.prompt,
      result.raw,
    );
    result = await runManager(
      p.model,
      `${task.description}\nThis is a high-level epic. You MUST break it into 2-3 smaller, specific tasks. Each task should describe a concrete piece of work to produce or implement. Reply with >>BREAKDOWN only.`,
      baseContext,
    );
    if (!result.block || result.block.command !== "BREAKDOWN") {
      await p.markStuck(task.id, "Manager refused to break down epic");
      return;
    }
  }

  if (result.block.command === "BREAKDOWN") {
    const validTasks: string[] = [];

    for (const subtask of result.block.tasks) {
      const check = isVagueOrCircular(task.description, subtask);
      if (check.isVague) {
        await p.log(
          "MGR",
          `Rejected subtask "${subtask}": ${check.reason}`,
          task.id,
        );
      } else {
        validTasks.push(subtask);
      }
    }

    if (validTasks.length === 0) {
      await p.log("MGR", "All subtasks rejected, retrying...", task.id);
      const retryResult = await runManager(
        p.model,
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
        await p.markStuck(
          task.id,
          "All subtasks were too vague or circular",
        );
        return;
      }
    }

    const cappedTasks = validTasks.slice(0, MAX_SUBTASKS);
    for (let i = 0; i < cappedTasks.length; i++) {
      const featureFilePath = p.resolveFilePath(null, cappedTasks[i]);
      // Strip the [File.ext] prefix from the stored description — it's
      // already captured in filePath, and leaking it into developer prompts
      // is noisy.
      const cleanedDesc = cappedTasks[i]
        .replace(/^\s*\[[^\]]+\]\s*/, "")
        .trim();
      await db.insert(tasks).values({
        projectId: p.projectId,
        parentId: task.id,
        description: cleanedDesc || cappedTasks[i],
        status: "pending",
        depth: task.depth + 1,
        sortOrder: i,
        filePath: featureFilePath,
      });
      p.taskCount++;
    }

    await p.setStatus(task.id, "done");
    await p.log(
      "MGR",
      `Broke down into ${cappedTasks.length} features`,
      task.id,
      result.prompt,
      result.raw,
    );
    p.emit("task_completed", {
      taskId: task.id,
      status: "DONE",
      duration: 0,
    });
  }
}
