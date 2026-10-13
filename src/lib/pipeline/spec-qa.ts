/**
 * Per-spec QA after Execute writes a file, and the recovery tactics used when a spec fails.
 */
import { db } from "@/db";
import { tasks, Task } from "@/db/schema";
import { eq, and, asc } from "drizzle-orm";
import {
  runCleaner,
  runMinimalRetry,
  runScaffoldTactic,
  runReframeTactic,
} from "@/lib/agents/cleaner";
import { validateOutput, autoRepairOutput } from "@/lib/validate";
import type { Pipeline } from ".";
import { MAX_RETRIES } from "./types";
import { executeSpec } from "./execute";

// ─────────────────────────────────────────────
//  QA (Programmatic validation + retry)
// ─────────────────────────────────────────────

export async function qaSpec(
  p: Pipeline,
  filePath: string,
  requirements: string[],
  taskGroup: Task[],
  output: string,
) {
  await p.log("QA", `Validating: ${filePath}`, taskGroup[0].id);

  const { repaired, fixes } = autoRepairOutput(output, filePath);
  if (fixes.length > 0) {
    await p.writeOutputFile(filePath, repaired);
    for (const task of taskGroup) {
      await db
        .update(tasks)
        .set({ output: repaired })
        .where(eq(tasks.id, task.id));
    }
    await p.log(
      "QA",
      `Auto-repaired: ${fixes.join(", ")}`,
      taskGroup[0].id,
    );
  }

  const finalOutput = repaired;
  const result = validateOutput(finalOutput, filePath);

  if (result.valid) {
    await p.log("QA", `PASS: ${filePath}`, taskGroup[0].id);
    for (const task of taskGroup) {
      await p.completeTask(task);
    }
  } else {
    await p.log("QA", `FAIL: ${result.reason}`, taskGroup[0].id);
    const firstTask = taskGroup[0];

    const isInstructionDumpFailure = (result.reason || "")
      .toLowerCase()
      .includes("prompt/instruction text");

    if (isInstructionDumpFailure) {
      // Try LLM-based recovery (cleaner → minimal retry → alt model)
      const recovered = await recoverFromFailure(p, 
        filePath,
        requirements.join("; "),
        finalOutput,
        firstTask.id,
      );
      if (recovered) {
        await p.writeOutputFile(filePath, recovered);
        for (const task of taskGroup) {
          await db
            .update(tasks)
            .set({ output: recovered })
            .where(eq(tasks.id, task.id));
        }
        await p.log(
          "QA",
          `Recovery succeeded for instruction-dump failure in ${filePath}`,
          firstTask.id,
        );
        for (const task of taskGroup) {
          await p.completeTask(task);
        }
        return;
      }

      // Recovery failed — try deterministic fallback
      const deterministicFallback = p.deterministicDraftByFile[filePath];
      if (deterministicFallback) {
        const fallbackResult = validateOutput(
          deterministicFallback,
          filePath,
          { allowScaffold: true },
        );
        if (fallbackResult.valid) {
          await p.writeOutputFile(filePath, deterministicFallback);
          for (const task of taskGroup) {
            await db
              .update(tasks)
              .set({ output: deterministicFallback })
              .where(eq(tasks.id, task.id));
          }
          await p.log(
            "QA",
            `Using deterministic fallback for instruction-dump failure in ${filePath}`,
            firstTask.id,
          );
          for (const task of taskGroup) {
            await p.completeTask(task);
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
        await p.setStatus(task.id, "ready");
      }
      await p.log(
        "QA",
        `Retrying ${filePath} (${firstTask.retryCount + 1}/${MAX_RETRIES})`,
        firstTask.id,
      );
      const updatedGroup = await db.query.tasks.findMany({
        where: and(
          eq(tasks.projectId, p.projectId),
          eq(tasks.status, "ready"),
          eq(tasks.filePath, filePath),
        ),
        orderBy: [asc(tasks.id)],
      });
      if (updatedGroup.length > 0) {
        await executeSpec(p, filePath, requirements, updatedGroup);
      }
    } else {
      // Final fallback chain: recovery → deterministic → stuck
      // Try LLM recovery first
      const recovered = await recoverFromFailure(p, 
        filePath,
        requirements.join("; "),
        finalOutput,
        firstTask.id,
      );
      if (recovered) {
        await p.writeOutputFile(filePath, recovered);
        for (const task of taskGroup) {
          await db
            .update(tasks)
            .set({ output: recovered })
            .where(eq(tasks.id, task.id));
        }
        await p.log(
          "QA",
          `Recovery succeeded for ${filePath} after retries exhausted`,
          firstTask.id,
        );
        for (const task of taskGroup) {
          await p.completeTask(task);
        }
        return;
      }

      // Recovery failed — try deterministic fallback
      const deterministicFallback = p.deterministicDraftByFile[filePath];
      if (deterministicFallback) {
        const fallbackResult = validateOutput(
          deterministicFallback,
          filePath,
          { allowScaffold: true },
        );
        if (fallbackResult.valid) {
          await p.writeOutputFile(filePath, deterministicFallback);
          for (const task of taskGroup) {
            await db
              .update(tasks)
              .set({ output: deterministicFallback })
              .where(eq(tasks.id, task.id));
          }
          await p.log(
            "QA",
            `Using deterministic fallback for ${filePath} after retries exhausted`,
            firstTask.id,
          );
          for (const task of taskGroup) {
            await p.completeTask(task);
          }
          return;
        }
      }

      for (const task of taskGroup) {
        await p.markStuck(
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
export async function recoverFromFailure(
  p: Pipeline,
  filePath: string,
  requirement: string,
  garbageOutput: string | null,
  taskId: number,
): Promise<string | null> {
  const context = `${p.projectName} — ${p.projectDescription}`;

  // ── Layer 1: Cleaner Agent ──
  if (garbageOutput && garbageOutput.trim().length > 30) {
    await p.log(
      "RECOVER",
      `Layer 1: Attempting to clean garbled output for ${filePath}`,
      taskId,
    );

    const cleanResult = await runCleaner(
      p.model,
      garbageOutput,
      filePath,
      context,
    );

    if (cleanResult.cleaned) {
      const validation = validateOutput(cleanResult.cleaned, filePath, {
        allowScaffold: true,
      });
      if (validation.valid) {
        await p.log(
          "RECOVER",
          `Layer 1 SUCCESS: Cleaner extracted valid code (${cleanResult.tokens} tokens)`,
          taskId,
          cleanResult.prompt,
          cleanResult.raw,
        );
        return cleanResult.cleaned;
      }
      await p.log(
        "RECOVER",
        `Layer 1 FAIL: Cleaned output still invalid: ${validation.reason}`,
        taskId,
        cleanResult.prompt,
        cleanResult.raw,
      );
    } else {
      await p.log(
        "RECOVER",
        "Layer 1 FAIL: Cleaner could not extract any code",
        taskId,
      );
    }
  }

  // ── Layer 2: Minimal Retry ──
  await p.log(
    "RECOVER",
    `Layer 2: Minimal prompt retry for ${filePath}`,
    taskId,
  );

  const minimalResult = await runMinimalRetry(
    p.model,
    filePath,
    requirement,
    p.projectName,
  );

  if (minimalResult.cleaned) {
    const validation = validateOutput(minimalResult.cleaned, filePath, {
      allowScaffold: true,
    });
    if (validation.valid) {
      await p.log(
        "RECOVER",
        `Layer 2 SUCCESS: Minimal prompt produced valid code (${minimalResult.tokens} tokens)`,
        taskId,
        minimalResult.prompt,
        minimalResult.raw,
      );
      return minimalResult.cleaned;
    }
    await p.log(
      "RECOVER",
      `Layer 2 FAIL: Minimal retry still invalid: ${validation.reason}`,
      taskId,
      minimalResult.prompt,
      minimalResult.raw,
    );
  } else {
    await p.log(
      "RECOVER",
      "Layer 2 FAIL: Minimal retry produced no parseable output",
      taskId,
    );
  }

  // ── Layer 3: Scaffold Tactic ──
  // Break the task into skeleton + fill-in — two simpler calls instead of one complex one
  await p.log(
    "RECOVER",
    `Layer 3: Scaffold tactic (skeleton → fill) for ${filePath}`,
    taskId,
  );

  const scaffoldResult = await runScaffoldTactic(
    p.model,
    filePath,
    requirement,
    p.projectName,
  );

  if (scaffoldResult.cleaned) {
    const validation = validateOutput(scaffoldResult.cleaned, filePath, {
      allowScaffold: true,
    });
    if (validation.valid) {
      await p.log(
        "RECOVER",
        `Layer 3 SUCCESS: Scaffold tactic produced valid code (${scaffoldResult.tokens} tokens)`,
        taskId,
        scaffoldResult.prompt,
        scaffoldResult.raw,
      );
      return scaffoldResult.cleaned;
    }
    await p.log(
      "RECOVER",
      `Layer 3 FAIL: Scaffold output invalid: ${validation.reason}`,
      taskId,
      scaffoldResult.prompt,
      scaffoldResult.raw,
    );
  } else {
    await p.log(
      "RECOVER",
      "Layer 3 FAIL: Scaffold tactic produced no parseable output",
      taskId,
    );
  }

  // ── Layer 4: Reframe Tactic ──
  // Completely different prompt style — "file generator" persona, no TTM format
  await p.log(
    "RECOVER",
    `Layer 4: Reframe tactic (file-generator persona) for ${filePath}`,
    taskId,
  );

  const reframeResult = await runReframeTactic(
    p.model,
    filePath,
    requirement,
    p.projectName,
  );

  if (reframeResult.cleaned) {
    const validation = validateOutput(reframeResult.cleaned, filePath, {
      allowScaffold: true,
    });
    if (validation.valid) {
      await p.log(
        "RECOVER",
        `Layer 4 SUCCESS: Reframe tactic produced valid code (${reframeResult.tokens} tokens)`,
        taskId,
        reframeResult.prompt,
        reframeResult.raw,
      );
      return reframeResult.cleaned;
    }
    await p.log(
      "RECOVER",
      `Layer 4 FAIL: Reframe output invalid: ${validation.reason}`,
      taskId,
      reframeResult.prompt,
      reframeResult.raw,
    );
  } else {
    await p.log(
      "RECOVER",
      "Layer 4 FAIL: Reframe tactic produced no parseable output",
      taskId,
    );
  }

  // ── Layer 5: Model Escalation ──
  // Last-resort: if LLAMAQUE_FALLBACK_MODEL env var is set to a bigger
  // model name (e.g. "qwen2.5-coder:32b"), retry the reframe tactic on
  // that model. Skipped silently when the env var is missing.
  const fallbackModel = process.env.LLAMAQUE_FALLBACK_MODEL?.trim();
  if (fallbackModel && fallbackModel !== p.model) {
    await p.log(
      "RECOVER",
      `Layer 5: Escalating ${filePath} to fallback model "${fallbackModel}"`,
      taskId,
    );
    try {
      const escResult = await runReframeTactic(
        fallbackModel,
        filePath,
        requirement,
        p.projectName,
      );
      if (escResult.cleaned) {
        const validation = validateOutput(escResult.cleaned, filePath, {
          allowScaffold: true,
        });
        if (validation.valid) {
          await p.log(
            "RECOVER",
            `Layer 5 SUCCESS: ${fallbackModel} produced valid code (${escResult.tokens} tokens)`,
            taskId,
            escResult.prompt,
            escResult.raw,
          );
          return escResult.cleaned;
        }
        await p.log(
          "RECOVER",
          `Layer 5 FAIL: ${fallbackModel} output invalid: ${validation.reason}`,
          taskId,
          escResult.prompt,
          escResult.raw,
        );
      } else {
        await p.log(
          "RECOVER",
          `Layer 5 FAIL: ${fallbackModel} produced no parseable output`,
          taskId,
        );
      }
    } catch (err) {
      await p.log(
        "RECOVER",
        `Layer 5 CRASH: ${err instanceof Error ? err.message : String(err)}`,
        taskId,
      );
    }
  }

  await p.log(
    "RECOVER",
    "All recovery layers exhausted — no valid output produced",
    taskId,
  );
  return null;
}
