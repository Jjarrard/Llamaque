/**
 * Iterative QA and progress-review passes: find one problem, fix it, repeat.
 */
import { runDeveloper, runDeveloperPatch } from "@/lib/agents/developer";
import { parsePatch, applyPatch } from "@/lib/patch";
import { runIterativeQA } from "@/lib/agents/iterative-qa";
import { runProgressReviewer } from "@/lib/agents/progress-reviewer";
import { runEditor, applyEdit, extractFileWindow } from "@/lib/agents/editor";
import { checkTypeScriptSyntax } from "@/lib/ops/compiler";
import { validateOutput, autoRepairOutput } from "@/lib/validate";
import { runTests } from "@/lib/test-runner";
import fs from "fs";
import path from "path";
import type { Pipeline } from ".";
import { MAX_ITERATIVE_QA_ROUNDS, MAX_HONING_FIXES } from "./types";

export async function runIterativeQAPass(p: Pipeline) {
  const outDir = p.outputDir();
  if (!fs.existsSync(outDir)) return;

  const readFile = (name: string) => {
    const fullPath = path.join(outDir, name);
    if (!fs.existsSync(fullPath)) return "";
    return fs.readFileSync(fullPath, "utf-8");
  };

  // Check if any manifest files have content
  let hasContent = false;
  for (const file of p.manifest) {
    const content = readFile(file.path);
    if (content.trim().length > 20) {
      hasContent = true;
      break;
    }
  }
  if (!hasContent) return;

  await p.log(
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
  const qaOutDir = p.outputDir();

  /** Run tests for the given source file (if a test file exists).
   *  Returns true if tests pass (or no test file), false if they regress. */
  const qaRunTests = (srcFile: string, baselineFailures: number): boolean => {
    const ext = srcFile.split(".").pop()?.toLowerCase() || "";
    const testFile = srcFile.replace(
      /\.\w+$/,
      `.test.${ext === "tsx" || ext === "jsx" ? "tsx" : ext}`,
    );
    if (!fs.existsSync(path.join(qaOutDir, testFile))) return true;
    const result = runTests(p.projectId, testFile);
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
    const result = runTests(p.projectId, testFile);
    return result.crashed ? 0 : result.failed;
  };

  let round = 0;

  while (round < MAX_ITERATIVE_QA_ROUNDS && !p.aborted) {
    round++;

    // Read fresh file contents each round (they change after fixes)
    const currentFiles: { path: string; content: string }[] = [];
    for (const file of p.manifest) {
      const content = readFile(file.path);
      if (content.trim().length > 20) {
        currentFiles.push({ path: file.path, content });
      }
    }

    if (currentFiles.length === 0) break;

    await p.log(
      "QA",
      `Round ${round}/${MAX_ITERATIVE_QA_ROUNDS}: looking for issues...`,
    );

    const result = await runIterativeQA(
      p.model,
      p.projectName,
      p.projectDescription,
      currentFiles,
      previousFixes.length > 0 ? previousFixes : undefined,
      round === 1 ? p.lastTestFailure : undefined, // give first round the test failure context
      round - 1, // rotate through files each round
    );

    if (!result.issue) {
      await p.log(
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
      await p.log(
        "QA",
        `Round ${round}: Skipping repeated issue in ${targetFile} (already tried ${priorAttempts}x): ${problem.slice(0, 100)}`,
      );
      previousFixes.push(`${problem} (skipped — repeated)`);
      continue;
    }
    issueAttemptCount.set(issueKey, priorAttempts + 1);

    await p.log(
      "QA",
      `Round ${round} found: [${targetFile}] ${problem}`,
      undefined,
      result.prompt,
      result.raw,
    );
    await p.log("QA", `Fix: ${fix}`);

    // Resolve the file name to one of our template files
    const resolvedFile = p.resolveTargetFile(targetFile);
    if (!resolvedFile) {
      await p.log("QA", `Unknown file "${targetFile}" — skipping`);
      previousFixes.push(`${problem} (skipped — unknown file)`);
      continue;
    }

    // Skip if this file has already burned too many failed-validation attempts.
    const fileFails = fileFailCount.get(resolvedFile) ?? 0;
    if (fileFails >= MAX_FILE_VALIDATION_FAILS) {
      await p.log(
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
      await p.log(
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
      p.model,
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
          await p.log(
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
          await p.writeOutputFile(resolvedFile, editRepaired);
          // Regression guard: revert if the fix made tests crash or increased
          // the failure count relative to the pre-fix baseline.
          if (!qaRunTests(resolvedFile, baselineFailures)) {
            await p.writeOutputFile(resolvedFile, existingContent);
            await p.log(
              "QA",
              `Round ${round}: Surgical fix in ${resolvedFile} broke tests — reverting`,
            );
            fileFailCount.set(
              resolvedFile,
              (fileFailCount.get(resolvedFile) ?? 0) + 1,
            );
            previousFixes.push(`${problem} (fix reverted — broke tests)`);
          } else {
            await p.log(
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
        await p.log(
          "QA",
          `Round ${round}: Surgical edit validation failed (${reason}) — falling back to full rewrite`,
        );
      }
    }

    if (fixed) continue;

    // ── Attempt 2: SEARCH/REPLACE patch (non-destructive) ──
    // The prior full-rewrite fallback was destructive: it routinely
    // reintroduced cross-file duplicates and dropped working code while
    // "fixing" one issue. Patch path keeps the rest of the file intact.
    const numberedForPatch = existingContent
      .split("\n")
      .map((line, idx) => `${String(idx + 1).padStart(4, " ")} | ${line}`)
      .join("\n");
    const patchInstruction = `QA issue: ${problem}. Suggested fix: ${fix}. Apply ONLY the minimum diff to address this issue.`;

    const patchRes = await runDeveloperPatch(
      p.model,
      resolvedFile,
      numberedForPatch,
      patchInstruction,
      p.projectName,
      p.projectDescription,
    );

    const patchBlocks = parsePatch(patchRes.raw);
    if (patchBlocks.length === 0) {
      await p.log(
        "QA",
        `Round ${round}: No patch block produced for ${resolvedFile} — keeping original`,
        undefined,
        patchRes.prompt,
        patchRes.raw,
      );
      previousFixes.push(`${problem} (no patch produced)`);
      continue;
    }

    const applied = applyPatch(existingContent, [patchBlocks[0]]);
    if (!applied.ok) {
      fileFailCount.set(
        resolvedFile,
        (fileFailCount.get(resolvedFile) ?? 0) + 1,
      );
      await p.log(
        "QA",
        `Round ${round}: Patch SEARCH didn't match in ${resolvedFile} (${applied.reason}) — keeping original`,
        undefined,
        patchRes.prompt,
        patchRes.raw,
      );
      previousFixes.push(`${problem} (patch search miss)`);
      continue;
    }

    const { repaired } = autoRepairOutput(applied.content, resolvedFile);
    const candidate = repaired || applied.content;
    const validation = validateOutput(candidate, resolvedFile);
    const rewriteExt = (resolvedFile.split(".").pop() ?? "").toLowerCase();
    const rewriteSyntaxErrors =
      validation.valid && ["ts", "tsx", "js", "jsx"].includes(rewriteExt)
        ? checkTypeScriptSyntax(resolvedFile, candidate)
        : [];
    if (validation.valid && rewriteSyntaxErrors.length === 0) {
      // Oscillation guard: reject if this content was seen before
      const fp = (c: string) => `${c.length}:${c.slice(0, 200)}`;
      const seenHashesFull =
        fileContentHashes.get(resolvedFile) ?? new Set<string>();
      if (seenHashesFull.has(fp(candidate))) {
        await p.log(
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
        await p.writeOutputFile(resolvedFile, candidate);
        // Regression guard: revert if the fix made tests crash or increased
        // the failure count relative to the pre-fix baseline.
        if (!qaRunTests(resolvedFile, baselineFailures)) {
          await p.writeOutputFile(resolvedFile, existingContent);
          await p.log(
            "QA",
            `Round ${round}: Patch on ${resolvedFile} broke tests — reverting`,
          );
          fileFailCount.set(
            resolvedFile,
            (fileFailCount.get(resolvedFile) ?? 0) + 1,
          );
          previousFixes.push(`${problem} (fix reverted — broke tests)`);
        } else {
          await p.log(
            "QA",
            `Round ${round}: Patched ${resolvedFile} (${applied.blocksApplied} block, ${patchRes.tokens} tokens)`,
            undefined,
            patchRes.prompt,
            patchRes.raw,
          );
          previousFixes.push(
            `${problem} → APPLIED: ${fix} (patched in ${resolvedFile})`,
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
      await p.log(
        "QA",
        `Round ${round}: Patched ${resolvedFile} failed validation: ${reason} — keeping original`,
        undefined,
        patchRes.prompt,
        patchRes.raw,
      );
      previousFixes.push(`${problem} (patch failed validation)`);
    }
  }

  if (round >= MAX_ITERATIVE_QA_ROUNDS && !p.aborted) {
    await p.log(
      "QA",
      `Iterative QA hit max rounds (${MAX_ITERATIVE_QA_ROUNDS})`,
    );
  }

  await p.log(
    "QA",
    `Iterative QA complete: ${previousFixes.length} issue(s) addressed in ${round} round(s)`,
  );
}

/**
 * After QA finishes, ask the model "as PM" whether the built project
 * actually matches the spec. For each item flagged "missing", apply
 * a targeted patch on the indicated file.
 *
 * Capped at MAX_HONING_FIXES total feature applications to keep runtime
 * bounded — if more features are missing the user can run "feedback".
 */
export async function runProgressReviewPass(p: Pipeline) {
  if (p.aborted) return;
  const outDir = p.outputDir();
  if (!fs.existsSync(outDir)) return;

  // Snapshot files for the reviewer
  const snapshot: { path: string; content: string }[] = [];
  for (const file of p.manifest) {
    const full = path.join(outDir, file.path);
    if (!fs.existsSync(full)) continue;
    const content = fs.readFileSync(full, "utf-8");
    if (content.trim().length > 20)
      snapshot.push({ path: file.path, content });
  }
  if (snapshot.length === 0) return;

  await p.log(
    "REV",
    "Progress review: checking built files against spec...",
  );

  let review;
  try {
    review = await runProgressReviewer(
      p.model,
      p.projectName,
      p.projectDescription,
      snapshot,
    );
  } catch (err) {
    await p.log(
      "REV",
      `Progress review failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  await p.log(
    "REV",
    `Progress: ${review.done.length} done, ${review.missing.length} missing. Next: ${review.nextAction || "(none)"}`,
    undefined,
    review.prompt,
    review.raw,
  );

  if (review.missing.length === 0) return;

  const patchableExts = ["tsx", "jsx", "ts", "js"];
  const fixes = review.missing.slice(0, MAX_HONING_FIXES);

  for (const { feature, file } of fixes) {
    if (p.aborted) return;

    // Resolve the file to a real manifest file
    const resolved = p.resolveTargetFile(file);
    if (!resolved) {
      await p.log(
        "REV",
        `Honing: unknown file "${file}" — skipping "${feature}"`,
      );
      continue;
    }
    const ext = resolved.split(".").pop()?.toLowerCase() || "";
    if (!patchableExts.includes(ext)) {
      await p.log(
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
        p.model,
        resolved,
        numbered,
        featureInstruction,
        p.projectName,
        p.projectDescription,
        honingNote,
      );

      const blocks = parsePatch(patchRes.raw);
      if (blocks.length === 0) {
        await p.log(
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
        await p.log(
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
        await p.log(
          "REV",
          `Honing: patch for "${feature}" invalid (${reason}) — keeping original`,
        );
        break;
      }

      await p.writeOutputFile(resolved, candidate);
      await p.log(
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
      let rewriteMsg = `Project: ${p.projectName} — ${p.projectDescription}\n\n`;
      rewriteMsg += `Current ${resolved}:\n${currentContent}\n\n`;
      rewriteMsg += `MISSING SPEC FEATURE: ${feature}. Add the minimum code to satisfy this requirement. Wire it into the UI if applicable.\n\n`;
      rewriteMsg += `Apply ONLY this feature addition. Keep everything else exactly the same. Rewrite the COMPLETE ${resolved} file.`;

      rewriteMsg = p.withCustomInstructions(rewriteMsg);

      const rewriteResult = await runDeveloper(
        p.model,
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
          await p.writeOutputFile(resolved, repaired);
          await p.log(
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
          await p.log(
            "REV",
            `Honing: full-rewrite for "${feature}" invalid (${reason}) — keeping original`,
          );
        }
      } else {
        await p.log(
          "REV",
          `Honing: full-rewrite for "${feature}" failed (no output block)`,
        );
      }
    }
  }
}
