/**
 * Execute phase: turn feature specs into code, file by file, in dependency waves.
 */
import { db } from "@/db";
import { tasks, Task } from "@/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { runDeveloper, runDeveloperPatch, getFileTypeRules } from "@/lib/agents/developer";
import { parsePatch, applyPatch } from "@/lib/patch";
import { runSummariser } from "@/lib/agents/summariser";
import { runPlanner } from "@/lib/agents/planner";
import { checkTypeScriptSyntax, checkTypeScriptSemantics } from "@/lib/ops/compiler";
import {
  findDuplicateSymbols,
  formatDuplicateIssue,
  listTopLevelSymbols,
} from "@/lib/ops/duplicate-check";
import { detectTruncation } from "@/lib/ops/truncation-check";
import { findUndefinedIdentifiers, formatUndefIssue } from "@/lib/ops/undef-check";
import { validateOutput, autoRepairOutput } from "@/lib/validate";
import { buildWaves, parseImportDeps } from "@/lib/deps";
import { getTasksForStep, getUncoveredTasks } from "@/lib/execute-utils";
import fs from "fs";
import path from "path";
import type { Pipeline } from ".";
import {
  MAX_DEPTH,
  MAX_REQUIREMENTS,
  DEFAULT_SPEC_TAG,
  MAX_SELF_HEAL_ATTEMPTS,
} from "./types";
import { truncateForPrompt } from "./text-utils";
import { qaSpec, recoverFromFailure } from "./spec-qa";

// ─────────────────────────────────────────────
//  PHASE 3: MERGE + TDD + EXECUTE (split into separate runnable phases)
// ─────────────────────────────────────────────

/**
 * Prepare file specs from ready tasks — shared by TDD and Execute phases.
 * Returns the fileSpecs map (requirements + tasks per file).
 */
export async function prepareFileSpecs(p: Pipeline): Promise<
  Record<string, { requirements: string[]; tasks: Task[] }>
> {
  // Ensure all depth-2 tasks are READY
  const pendingD2 = await db.query.tasks.findMany({
    where: and(
      eq(tasks.projectId, p.projectId),
      eq(tasks.status, "pending"),
    ),
  });
  for (const t of pendingD2) {
    if (t.depth >= MAX_DEPTH) {
      const fp = p.resolveFilePath(t.filePath, t.description);
      await db
        .update(tasks)
        .set({ status: "ready", filePath: fp })
        .where(eq(tasks.id, t.id));
    }
  }

  const readyTasks = await db.query.tasks.findMany({
    where: and(
      eq(tasks.projectId, p.projectId),
      eq(tasks.status, "ready"),
    ),
    orderBy: [asc(tasks.id)],
  });

  if (readyTasks.length === 0) return {};

  // Group by file
  const fileGroups: Record<string, Task[]> = {};
  for (const task of readyTasks) {
    const fp = task.filePath || p.resolveFilePath(null, task.description);
    if (!fileGroups[fp]) fileGroups[fp] = [];
    fileGroups[fp].push(task);
  }

  // MERGE: deduplicate and build per-file specs
  const fileSpecs = mergeFeatureSpecs(fileGroups);

  const specCount = Object.values(fileSpecs).filter(
    (s) => s.requirements.length > 0,
  ).length;
  await p.log(
    "SYS",
    `Merged ${readyTasks.length} features into ${specCount} file specs`,
  );

  // Ensure each manifest file has specs if model forgot them
  ensureBasicSpecs(p, fileSpecs, fileGroups);

  return fileSpecs;
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
export function buildDependencyWaves(p: Pipeline): string[][] {
  const files = p.getFileOrder();
  if (files.length <= 1) return [files];

  const outDir = p.outputDir();
  const depMap = new Map<string, Set<string>>();

  for (const fp of files) {
    const manifestEntry = p.manifest.find((m) => m.path === fp);

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
export async function summariseFile(p: Pipeline, filePath: string): Promise<void> {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (!["ts", "tsx", "jsx"].includes(ext)) return;
  const content = p.getCurrentFileContent(filePath);
  if (!content || content.replace(/\s/g, "").length <= 150) return;
  try {
    const result = await runSummariser(
      p.model,
      filePath,
      truncateForPrompt(content, 80),
    );
    if (result.block?.context) {
      p.fileContextSummaries[filePath] = result.block.context;
      await p.log("SUM", `${filePath}: ${result.block.context}`);
    }
  } catch {
    // Silent — never block the pipeline on a summary failure
  }
}

/**
 * Execute phase: write code for each file, parallelising files that have
 * no dependency on each other within the same wave.
 */
export async function runExecutePhase(
  p: Pipeline,
  fileSpecs: Record<string, { requirements: string[]; tasks: Task[] }>,
) {
  const waves = buildDependencyWaves(p);

  for (const wave of waves) {
    if (p.aborted) break;
    // Sort: feature files (utils.js etc.) before default-spec files (Counter.tsx etc.)
    // so that when a default-spec file runs, sibling injection has real code to inject.
    const sortedWave = [...wave].sort((a, b) => {
      const aDefault = fileSpecs[a]?.requirements[0]?.startsWith(
        DEFAULT_SPEC_TAG,
      )
        ? 1
        : 0;
      const bDefault = fileSpecs[b]?.requirements[0]?.startsWith(
        DEFAULT_SPEC_TAG,
      )
        ? 1
        : 0;
      return aDefault - bDefault;
    });
    for (const filePath of sortedWave) {
      if (p.aborted) break;
      const spec = fileSpecs[filePath];
      if (spec && spec.requirements.length > 0) {
        await executeSpec(p, filePath, spec.requirements, spec.tasks);
        await summariseFile(p, filePath);
      }
    }
  }
}

export function ensureBasicSpecs(
  p: Pipeline,
  fileSpecs: Record<string, { requirements: string[]; tasks: Task[] }>,
  fileGroups: Record<string, Task[]>,
) {
  const allTasks = Object.values(fileGroups).flat();

  // For each manifest file that has no specs, generate a default
  for (const file of p.manifest) {
    if (
      !fileSpecs[file.path] ||
      fileSpecs[file.path].requirements.length === 0
    ) {
      const fallbackTasks = fileGroups[file.path] || allTasks.slice(0, 1);
      const defaultReqs = [
        // TAG: execute loop detects this to inject sibling code context
        `${DEFAULT_SPEC_TAG}Write ${file.path} (${file.description}) for "${p.projectName}: ${p.projectDescription}"`,
        file.description,
      ];

      fileSpecs[file.path] = {
        requirements: defaultReqs.slice(0, MAX_REQUIREMENTS),
        tasks: fallbackTasks,
      };
      p.log(
        "SYS",
        `Added default ${file.path} spec (no features were generated)`,
      );
    }
  }
}

export function mergeFeatureSpecs(
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
          stringSimilarity(existing.toLowerCase(), normalized) > 0.45,
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

export function stringSimilarity(a: string, b: string): number {
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

export async function executeSpec(
  p: Pipeline,
  filePath: string,
  requirements: string[],
  taskGroup: Task[],
) {
  // DON'T mark all tasks executing upfront — mark them one at a time
  // so the UI shows sequential progress instead of a batch.

  await p.log(
    "DEV",
    `Writing ${filePath} (${requirements.length} requirements, sequential)`,
    taskGroup[0].id,
  );

  // Chain-of-thought planning pass — one call, no retry, silent fallback.
  // Only runs for multi-requirement files where an outline is actually useful.
  let planOutline: string | null = null;
  if (requirements.length >= 2) {
    const manifestDesc = p.manifest.find(
      (m) => m.path === filePath,
    )?.description;
    planOutline = await runPlanner(
      p.model,
      filePath,
      requirements,
      manifestDesc,
      p.contractSnippet || undefined,
    );
    if (planOutline) {
      await p.log(
        "PLAN",
        `Implementation plan for ${filePath}:\n${planOutline}`,
        taskGroup[0].id,
      );
    }
  }

  // Phase A: Deterministic pre-pass (builds base draft)
  await applyDeterministicOpsPrepass(p, 
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
    if (p.aborted) break;
    // Strip the default-spec tag before the requirement reaches any prompt.
    const req = requirements[i].startsWith(DEFAULT_SPEC_TAG)
      ? requirements[i].slice(DEFAULT_SPEC_TAG.length)
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
      await p.setStatus(displayTask.id, "executing");
      p.emit("task_started", {
        taskId: displayTask.id,
        description: displayTask.description,
        agent: "developer",
      });
    }

    await p.log(
      "DEV",
      `[${i + 1}/${requirements.length}] ${req}`,
      tasksForThisStep[0]?.id || taskGroup[0].id,
    );

    // Read current file (accumulates previous changes)
    const currentContent = p.getCurrentFileContent(filePath) || "";
    const hasContent = currentContent.trim().length > 50;

    let userMessage = `Project: ${p.projectName} — ${p.projectDescription}\n\n`;

    if (hasContent) {
      userMessage += `Current ${filePath}:\n${currentContent}\n\n`;
      userMessage += `ENHANCE the file above. Keep ALL existing code intact. Add ONLY this feature:\n- ${req}\n\nWrite the COMPLETE updated file with the new feature added.`;
    } else {
      userMessage += `Write the complete ${filePath} file implementing this feature:\n- ${req}`;
    }

    // File-type-specific rules + UX quality reminders
    userMessage += `\n\n${getFileTypeRules(filePath)}`;

    // Critical anti-pattern guard for small models: they often write JSX
    // that references handlers/state they never declared. Hammer this
    // home explicitly — empirically the single most common failure
    // mode for gemma4:e4b and similar.
    if (/\.(tsx|jsx)$/i.test(filePath)) {
      userMessage += `\n\nMANDATORY DECLARATION RULE: Before writing JSX, list in your head every name you will reference (handlers like onClick={X}, state values like {count}, computed vars). EVERY such name MUST be declared above the return statement as either:\n  • const NAME = () => { ... };\n  • const [NAME, setNAME] = useState(...);\n  • function NAME() { ... }\n  • imported at the top of the file\nIf you reference handleStartPause in JSX, you MUST have const handleStartPause = ... somewhere above. NO EXCEPTIONS.`;
    }

    // Inject the file manifest so the developer knows the role of every file
    // in the project. This prevents leaf components from being written as
    // standalone apps and tells container files which siblings to import.
    if (p.manifest.length > 1) {
      const manifestLines = p.manifest
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
    if (p.contractSnippet) {
      userMessage += `\n\nSHARED TYPES (use these exact definitions):\n${p.contractSnippet}`;
    }

    // Cross-file symbol lock: collect every top-level symbol already
    // declared in sibling files on disk and tell the model NOT to
    // redeclare them. Catches the cross-file duplicate-identifier
    // failure mode (e.g. Game of Life declaring `countNeighbors` in
    // both GameLogic.ts and GameOfLifeSimulator.tsx) that per-file TS
    // checks cannot see — the preview HTML inlines siblings and the
    // duplicate then throws at mount.
    {
      const outDir = p.outputDir();
      const lockedSymbols = new Map<string, string>(); // name → owning file
      for (const m of p.manifest) {
        if (m.path === filePath) continue;
        const sibPath = path.join(outDir, m.path);
        if (!fs.existsSync(sibPath)) continue;
        const sibContent = fs.readFileSync(sibPath, "utf-8");
        if (sibContent.trim().length < 50) continue;
        for (const sym of listTopLevelSymbols(m.path, sibContent)) {
          // Skip ultra-common single-letter / framework names that
          // would generate noise: React, useState, useEffect, etc.
          if (/^(React|use[A-Z]\w*)$/.test(sym)) continue;
          if (!lockedSymbols.has(sym)) lockedSymbols.set(sym, m.path);
        }
      }
      if (lockedSymbols.size > 0) {
        const lines = Array.from(lockedSymbols.entries())
          .slice(0, 40)
          .map(([name, owner]) => `  - ${name} (defined in ${owner})`)
          .join("\n");
        userMessage += `\n\nEXISTING SYMBOLS — DO NOT REDECLARE these names anywhere in your file. If you need them, import from the listed file:\n${lines}`;
      }
    }

    // On the first step only, inject context from already-completed files.
    // Priority order:
    //   1. Actual code of files this file directly imports (planned dep graph)
    //      — model sees exact export names, prop signatures, type shapes
    //   2. LLM summaries of other completed files (broader awareness)
    // Capped to keep prompts manageable on small models.
    if (i === 0) {
      const outDir = p.outputDir();
      const manifestEntry = p.manifest.find((m) => m.path === filePath);
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
        DEFAULT_SPEC_TAG,
      );

      // Inject actual first-35-lines of completed sibling files.
      // Small models pattern-match concrete code far better than abstract
      // type signatures — seeing the real props interface and import line
      // tells the model exactly how to use the sibling.
      // Cap at 2 siblings × 35 lines ≈ ~3000 chars to avoid context bloat.
      const completedSiblings: string[] = [];
      const siblingPaths = new Set<string>([
        ...p.manifest.map((m) => m.path),
        ...Object.keys(p.fileContextSummaries),
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
          p.fileContextSummaries,
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
        const priorSummaries = Object.entries(p.fileContextSummaries)
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

    userMessage = p.withCustomInstructions(userMessage);
    p.warnIfPromptTooLarge(`Execute step ${i + 1}`, userMessage);

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

    if (canPatch && !p.aborted) {
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
        if (p.aborted) break;

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
          p.model,
          filePath,
          numbered,
          turnInstruction,
          p.projectName,
          p.projectDescription,
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
            await p.log(
              "QA",
              `Step ${i + 1} patch turn ${turn}: no block — treating as DONE (${totalBlocks} block(s) already applied)`,
              tasksForThisStep[0]?.id || taskGroup[0].id,
            );
            modelSaidDone = true;
            break;
          }
          // No block AND no prior progress: model gave up — fall back
          await p.log(
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
          await p.log(
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
        const patchSemantic =
          patchValidation.valid &&
          patchSyntax.length === 0 &&
          patchableExts.includes(fileExt)
            ? checkTypeScriptSemantics(filePath, candidate)
            : [];
        const patchDupes =
          patchValidation.valid &&
          patchSyntax.length === 0 &&
          patchSemantic.length === 0 &&
          patchableExts.includes(fileExt)
            ? findDuplicateSymbols(filePath, candidate)
            : [];
        const patchTruncation =
          patchValidation.valid &&
          patchSyntax.length === 0 &&
          patchSemantic.length === 0 &&
          patchDupes.length === 0
            ? detectTruncation(filePath, candidate)
            : [];
        const patchUndefs =
          patchValidation.valid &&
          patchSyntax.length === 0 &&
          patchSemantic.length === 0 &&
          patchDupes.length === 0 &&
          patchTruncation.length === 0 &&
          patchableExts.includes(fileExt)
            ? findUndefinedIdentifiers(filePath, candidate)
            : [];

        if (
          patchValidation.valid &&
          patchSyntax.length === 0 &&
          patchSemantic.length === 0 &&
          patchDupes.length === 0 &&
          patchTruncation.length === 0 &&
          patchUndefs.length === 0
        ) {
          await p.writeOutputFile(filePath, candidate);
          stepsCompleted++;
          const turnNote = modelSaidDone ? " (DONE)" : "";
          await p.log(
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
            : patchSyntax.length > 0
              ? `TS syntax: ${patchSyntax.join("; ")}`
              : patchSemantic.length > 0
                ? `TS semantic: ${patchSemantic.join("; ")}`
                : patchDupes.length > 0
                  ? `duplicate symbols: ${patchDupes.map(formatDuplicateIssue).join("; ")}`
                  : patchTruncation.length > 0
                    ? `truncation: ${patchTruncation.join("; ")}`
                    : `undefined identifiers: ${patchUndefs.map((u) => u.name).join(", ")}`;
          await p.log(
            "QA",
            `Step ${i + 1} patch invalid after ${totalBlocks} block(s) (${reason}) — falling back to full rewrite`,
            tasksForThisStep[0]?.id || taskGroup[0].id,
          );
        }
      } else if (!patchAborted && modelSaidDone && totalBlocks === 0) {
        // Model said DONE on turn 1 — feature already implemented.
        // Skip this step entirely; the file is fine as-is.
        stepsCompleted++;
        await p.log(
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
        await p.setStatus(displayTask.id, "done");
        p.emit("task_completed", {
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
      attempt <= MAX_SELF_HEAL_ATTEMPTS;
      attempt++
    ) {
      if (stepPassed) break;
      const result = await runDeveloper(
        p.model,
        stepUserMessage,
        filePath,
        p.manifest.find((m) => m.path === filePath)?.description,
      );

      if (!result.block) {
        lastGarbageOutput = result.raw;
        await p.log(
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
          await p.log(
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
        await p.log(
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
          await p.log(
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
            await p.log(
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
          await p.log(
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
            await p.log(
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

        // AST duplicate-symbol check — catches the in-file redeclaration
        // pattern that the small model sometimes emits (e.g. declaring
        // the same `const seconds` twice in one component scope).
        const dupes = findDuplicateSymbols(filePath, output);
        if (dupes.length > 0) {
          const errorSummary = dupes.map(formatDuplicateIssue).join("; ");
          await p.log(
            "QA",
            `Step ${i + 1} attempt ${attempt} duplicate symbols: ${errorSummary}`,
            tasksForThisStep[0]?.id || taskGroup[0].id,
          );
          lastGarbageOutput = output;
          const sig = `DUP:${errorSummary.slice(0, 80)}`;
          if (lastErrorSignature === sig) {
            repeatedErrorCount++;
          } else {
            lastErrorSignature = sig;
            repeatedErrorCount = 1;
          }
          if (repeatedErrorCount >= 2) {
            await p.log(
              "QA",
              `Step ${i + 1}: identical duplicate-symbol error twice — short-circuiting to recovery`,
              tasksForThisStep[0]?.id || taskGroup[0].id,
            );
            break;
          }
          stepUserMessage =
            userMessage +
            `\n\nYour previous output declared the same symbol(s) twice in the same scope:\n${errorSummary}\nRewrite the complete file with each symbol declared EXACTLY ONCE.`;
          continue;
        }

        // Truncation check — catches mid-statement cutoffs (unbalanced
        // braces, trailing operators, bare-identifier last line).
        const truncReasons = detectTruncation(filePath, output);
        if (truncReasons.length > 0) {
          const errorSummary = truncReasons.join("; ");
          await p.log(
            "QA",
            `Step ${i + 1} attempt ${attempt} truncation: ${errorSummary}`,
            tasksForThisStep[0]?.id || taskGroup[0].id,
          );
          lastGarbageOutput = output;
          const sig = `TRUNC:${errorSummary.slice(0, 80)}`;
          if (lastErrorSignature === sig) {
            repeatedErrorCount++;
          } else {
            lastErrorSignature = sig;
            repeatedErrorCount = 1;
          }
          if (repeatedErrorCount >= 2) {
            await p.log(
              "QA",
              `Step ${i + 1}: identical truncation twice — short-circuiting to recovery`,
              tasksForThisStep[0]?.id || taskGroup[0].id,
            );
            break;
          }
          stepUserMessage =
            userMessage +
            `\n\nYour previous output appears truncated: ${errorSummary}. Rewrite the COMPLETE file — make sure every block, function, and statement is properly closed.`;
          continue;
        }

        // Undefined-identifier check — catches the most common runtime
        // bug that slips past TS (we exclude code 2304 due to JSX/React
        // false positives). E.g. `<button onClick={handleStartPause}>`
        // when handleStartPause was never declared.
        const undefs = findUndefinedIdentifiers(filePath, output);
        if (undefs.length > 0) {
          const errorSummary = undefs.map(formatUndefIssue).join("\n");
          await p.log(
            "QA",
            `Step ${i + 1} attempt ${attempt} undefined identifiers: ${undefs.map((u) => u.name).join(", ")}`,
            tasksForThisStep[0]?.id || taskGroup[0].id,
          );
          lastGarbageOutput = output;
          const sig = `UNDEF:${undefs
            .map((u) => u.name)
            .sort()
            .join(",")
            .slice(0, 80)}`;
          if (lastErrorSignature === sig) {
            repeatedErrorCount++;
          } else {
            lastErrorSignature = sig;
            repeatedErrorCount = 1;
          }
          if (repeatedErrorCount >= 2) {
            await p.log(
              "QA",
              `Step ${i + 1}: identical undefined-identifier set twice — short-circuiting to recovery`,
              tasksForThisStep[0]?.id || taskGroup[0].id,
            );
            break;
          }
          stepUserMessage =
            userMessage +
            `\n\nYour previous output references identifiers that are never declared anywhere in the file:\n${errorSummary}\n\nRewrite the COMPLETE file. For EVERY name you reference in JSX or expressions, make sure it is either: (a) declared with const/let/function/useState, (b) imported at the top, or (c) a function parameter in scope. Do not output JSX that calls a handler you forgot to define.`;
          continue;
        }

        await p.writeOutputFile(filePath, output);
        stepsCompleted++;
        await p.log(
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

      await p.log(
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
        await p.log(
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
    if (!stepPassed && !p.aborted) {
      const recovered = await recoverFromFailure(p, 
        filePath,
        req,
        lastGarbageOutput,
        tasksForThisStep[0]?.id || taskGroup[0].id,
      );

      if (recovered) {
        await p.writeOutputFile(filePath, recovered);
        stepsCompleted++;
        stepPassed = true;
      } else {
        await p.log(
          "QA",
          `Step ${i + 1}: all recovery failed — keeping previous version`,
          tasksForThisStep[0]?.id || taskGroup[0].id,
        );
      }
    }

    // Mark this step's tasks as done immediately
    const stepOutput = p.getCurrentFileContent(filePath) || "";
    for (const task of tasksForThisStep) {
      await db
        .update(tasks)
        .set({ output: stepOutput, filePath })
        .where(eq(tasks.id, task.id));
      await p.completeTask(task);
    }
  }

  // Mark any tasks that were never individually stepped through as done.
  // This happens when taskGroup.length > requirements.length.
  const finalOutput = p.getCurrentFileContent(filePath) || "";
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
      await p.completeTask(current);
    }
  }

  // Phase C: Final QA on the accumulated file
  const finalContent = p.getCurrentFileContent(filePath);
  if (!finalContent || finalContent.trim().length < 30) {
    // File is still basically empty — try LLM recovery first
    const recovered = await recoverFromFailure(p, 
      filePath,
      requirements.join("; "),
      null,
      taskGroup[0].id,
    );
    if (recovered) {
      await p.writeOutputFile(filePath, recovered);
      await p.log(
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
          await p.completeTask(task);
        }
      }
    } else {
      // Recovery failed — try deterministic fallback
      const deterministicFallback = p.deterministicDraftByFile[filePath];
      if (deterministicFallback) {
        const fbResult = validateOutput(deterministicFallback, filePath, {
          allowScaffold: true,
        });
        if (fbResult.valid) {
          await p.writeOutputFile(filePath, deterministicFallback);
          await p.log(
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
              await p.completeTask(task);
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
          await p.markStuck(
            task.id,
            `${filePath} has no meaningful content after ${requirements.length} attempts`,
          );
        }
      }
    }
    return;
  }

  await p.log(
    "DEV",
    `${filePath} complete: ${stepsCompleted}/${requirements.length} steps succeeded`,
    taskGroup[0].id,
  );

  // Run full-file QA (handles retries, auto-repair, cross-file checks)
  // Tasks are already marked done per-step; qaSpec will only validate/repair the file
  await qaSpec(p, filePath, requirements, taskGroup, finalContent);
}

/**
 * Distribute tasks across requirement steps for sequential UI updates.
 * Each step gets at least 1 task; extra tasks go to earlier steps.
 */
export async function applyDeterministicOpsPrepass(
  p: Pipeline,
  filePath: string,
  _requirements: string[],
  _taskId: number,
): Promise<string | null> {
  // Single-component model — deterministic ops are not used for TSX.
  // Just return the current file content as the draft for the LLM prompt.
  const draft = p.getCurrentFileContent(filePath);
  if (!draft) return null;
  p.deterministicDraftByFile[filePath] = draft;
  return truncateForPrompt(draft, 100);
}
