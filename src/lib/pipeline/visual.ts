/**
 * Browser-based gates: render-error gate and visual QA.
 */
import { runDeveloperPatch } from "@/lib/agents/developer";
import { parsePatch, applyPatch } from "@/lib/patch";
import { runVisualQA } from "@/lib/agents/visual-qa";
import { renderAndCollectErrors } from "@/lib/agents/visual-qa";
import { modelCapabilities } from "@/lib/model-capabilities";
import { checkTypeScriptSyntax } from "@/lib/ops/compiler";
import { autoStubUndefs } from "@/lib/ops/auto-stub";
import { validateOutput, autoRepairOutput } from "@/lib/validate";
import fs from "fs";
import path from "path";
import type { Pipeline } from ".";

// ─────────────────────────────────────────────
//  PHASE 8: VISUAL QA (vision-capable models only)
// ─────────────────────────────────────────────

/**
 * Mandatory render gate — load the built artifact in headless Chromium
 * and collect any runtime errors (page errors, console.error). Runs for
 * ALL models, not just vision-capable ones.
 *
 * This is the only check that catches cross-file bugs introduced when
 * the preview HTML inlines sibling imports: duplicate identifiers,
 * undefined references, throw-on-mount components. Per-file TypeScript
 * checks miss these because each file is valid in isolation.
 *
 * On errors, attempts a single SEARCH/REPLACE patch fix per file before
 * surfacing to the user.
 */
export async function runRenderErrorGate(p: Pipeline) {
  if (p.aborted) return;
  const outDir = p.outputDir();
  if (!fs.existsSync(outDir)) return;

  const tsxFiles = p.manifest.filter((f) => /\.(tsx|jsx)$/i.test(f.path));
  if (tsxFiles.length === 0) return;
  const mainFile =
    tsxFiles.find((f) => /^app\.(tsx|jsx)$/i.test(f.path))?.path ??
    tsxFiles[tsxFiles.length - 1].path;

  // ── Pre-flight: auto-stub undefined identifiers across all TSX files ──
  // If the recovery path shipped a file with `<button onClick={handleX}>`
  // but no `handleX` declaration, we'd rather render an inert UI than a
  // ReferenceError page. Stubs preserve UI shape; the user can iterate
  // via the feedback pass.
  for (const f of tsxFiles) {
    const fp = path.join(outDir, f.path);
    if (!fs.existsSync(fp)) continue;
    const src = fs.readFileSync(fp, "utf-8");
    const { content: stubbed, stubbedNames } = autoStubUndefs(f.path, src);
    if (stubbedNames.length > 0) {
      await p.writeOutputFile(f.path, stubbed);
      await p.log(
        "QA",
        `Auto-stubbed ${stubbedNames.length} undefined identifier(s) in ${f.path}: ${stubbedNames.slice(0, 6).join(", ")}${stubbedNames.length > 6 ? "..." : ""} — UI will render but these handlers are no-ops`,
      );
      p.qaFatalIssues.push(
        `${f.path}: ${stubbedNames.length} handler(s) stubbed (no-op) — model did not declare: ${stubbedNames.slice(0, 4).join(", ")}`,
      );
    }
  }

  await p.log(
    "QA",
    `Render gate: loading ${mainFile} in headless Chromium...`,
  );

  let report;
  try {
    report = await renderAndCollectErrors(mainFile, outDir);
  } catch (err) {
    await p.log(
      "QA",
      `Render gate crashed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (report.skippedReason) {
    await p.log("QA", `Render gate skipped: ${report.skippedReason}`);
    return;
  }

  if (report.errors.length === 0) {
    await p.log("QA", `Render gate: ${mainFile} mounts cleanly`);
    return;
  }

  await p.log(
    "QA",
    `Render gate found ${report.errors.length} runtime error(s) in ${mainFile}:`,
  );
  for (const e of report.errors) {
    await p.log("QA", `  • ${e.slice(0, 200)}`);
  }

  // Attempt one fix round: feed the first error as a patch instruction
  // against the main file. If the model can't fix it in one shot, leave
  // the errors logged — surfacing failure honestly is better than
  // claiming false success.
  const primaryError = report.errors[0];
  const fullPath = path.join(outDir, mainFile);
  if (!fs.existsSync(fullPath)) return;

  const current = fs.readFileSync(fullPath, "utf-8");
  const numbered = current
    .split("\n")
    .map((line, idx) => `${String(idx + 1).padStart(4, " ")} | ${line}`)
    .join("\n");
  const featureInstruction = `RUNTIME ERROR when rendering ${mainFile}: ${primaryError}. Fix the root cause in this file. If the error is a duplicate-identifier across files, REMOVE the duplicate from this file and import from the file that defines it.`;

  try {
    const patchRes = await runDeveloperPatch(
      p.model,
      mainFile,
      numbered,
      featureInstruction,
      p.projectName,
      p.projectDescription,
    );
    const blocks = parsePatch(patchRes.raw);
    if (blocks.length === 0) {
      await p.log(
        "QA",
        `Render gate: no patch produced — leaving errors for user`,
      );
      p.qaFatalIssues.push(
        `Render gate (${mainFile}): ${primaryError.slice(0, 200)} (model produced no patch)`,
      );
      return;
    }
    const applied = applyPatch(current, [blocks[0]]);
    if (!applied.ok) {
      await p.log(
        "QA",
        `Render gate: patch failed (${applied.reason}) — leaving errors for user`,
      );
      p.qaFatalIssues.push(
        `Render gate (${mainFile}): ${primaryError.slice(0, 200)} (patch failed: ${applied.reason})`,
      );
      return;
    }

    const { repaired } = autoRepairOutput(applied.content, mainFile);
    const candidate = repaired || applied.content;
    const validation = validateOutput(candidate, mainFile, {
      allowScaffold: true,
    });
    const syntax = validation.valid
      ? checkTypeScriptSyntax(mainFile, candidate)
      : [];
    if (!validation.valid || syntax.length > 0) {
      await p.log(
        "QA",
        `Render gate: patch invalid (${!validation.valid ? validation.reason : syntax.join("; ")}) — leaving errors for user`,
      );
      p.qaFatalIssues.push(
        `Render gate (${mainFile}): ${primaryError.slice(0, 200)} (patch produced invalid output)`,
      );
      return;
    }

    await p.writeOutputFile(mainFile, candidate);
    await p.log(
      "QA",
      `Render gate: patched ${mainFile} — re-rendering to verify`,
    );

    // Re-render once to verify
    const verify = await renderAndCollectErrors(mainFile, outDir);
    if (verify.errors.length === 0) {
      await p.log("QA", `Render gate: errors resolved`);
    } else {
      await p.log(
        "QA",
        `Render gate: ${verify.errors.length} error(s) remain after patch — surfacing to user`,
      );
      for (const e of verify.errors) {
        await p.log("QA", `  • ${e.slice(0, 200)}`);
      }
      p.qaFatalIssues.push(
        `Render gate (${mainFile}): ${verify.errors[0].slice(0, 200)}`,
      );
    }
  } catch (err) {
    await p.log(
      "QA",
      `Render gate: patch attempt crashed: ${err instanceof Error ? err.message : String(err)}`,
    );
    p.qaFatalIssues.push(
      `Render gate (${mainFile}): unresolved runtime error after patch attempt`,
    );
  }
}

/**
 * Render the main TSX file in headless Chromium, screenshot it, and ask a
 * vision-capable LLM (gemma3+, llava, etc) whether the UI matches the spec.
 *
 * Visual issues are logged as REV entries — they are NOT auto-fixed because
 * vision models still hallucinate UI elements they expect to see. The user
 * can apply visual feedback via the feedback pass.
 */
export async function runVisualQAPass(p: Pipeline) {
  if (p.aborted) return;

  const caps = modelCapabilities(p.model);
  if (!caps.vision) return; // Silent skip for text-only models

  const outDir = p.outputDir();
  if (!fs.existsSync(outDir)) return;

  // Pick the main TSX/JSX file — typically the manifest entry whose
  // basename is App.tsx, or otherwise the last manifest file (root).
  const tsxFiles = p.manifest.filter((f) => /\.(tsx|jsx)$/i.test(f.path));
  if (tsxFiles.length === 0) return;
  const mainFile =
    tsxFiles.find((f) => /^app\.(tsx|jsx)$/i.test(f.path))?.path ??
    tsxFiles[tsxFiles.length - 1].path;

  await p.log(
    "REV",
    `Visual QA: rendering ${mainFile} in headless Chromium...`,
  );

  let result;
  try {
    result = await runVisualQA(
      p.model,
      p.projectName,
      p.projectDescription,
      mainFile,
      outDir,
    );
  } catch (err) {
    await p.log(
      "REV",
      `Visual QA crashed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (result.skippedReason) {
    await p.log("REV", `Visual QA skipped: ${result.skippedReason}`);
    return;
  }

  const shotKb = result.screenshotBytes
    ? Math.round(result.screenshotBytes / 1024)
    : 0;
  if (result.issues.length === 0) {
    await p.log(
      "REV",
      `Visual QA: UI matches spec (${shotKb}KB screenshot, ${result.tokens ?? 0} tokens)`,
      undefined,
      result.prompt,
      result.raw,
    );
    return;
  }

  await p.log(
    "REV",
    `Visual QA found ${result.issues.length} issue(s) in ${mainFile}:`,
    undefined,
    result.prompt,
    result.raw,
  );
  for (const { problem } of result.issues) {
    await p.log("REV", `  • ${problem}`);
  }
}
