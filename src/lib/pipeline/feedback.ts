/**
 * Feedback pass: apply a user's change request to the generated project.
 */
import { runDeveloper } from "@/lib/agents/developer";
import {
  runFeedbackEditor,
  applyEdit,
  numberLines,
  stripLineNumberPrefixes,
} from "@/lib/agents/editor";
import { runFeedbackPlanner } from "@/lib/agents/feedback-planner";
import { checkTypeScriptSyntax } from "@/lib/ops/compiler";
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
import fs from "fs";
import path from "path";
import type { Pipeline } from ".";
import { MAX_SELF_HEAL_ATTEMPTS } from "./types";

// ─────────────────────────────────────────────
//  FBK PASS — User-driven iterative loop
// ─────────────────────────────────────────────

/**
 * Applies user feedback to project files with backup, self-healing retry,
 * and validation. If the result is worse than the original, restores backup.
 */
export async function runFeedbackPass(p: Pipeline, feedback: string) {
  const outDir = p.outputDir();
  if (!fs.existsSync(outDir)) {
    await p.log("FBK", "No output files found — nothing to modify.");
    return;
  }

  if (p.manifest.length === 0) {
    await p.log("FBK", "No file manifest — nothing to modify.");
    return;
  }

  await p.log(
    "FBK",
    `Feedback: "${feedback.slice(0, 200)}${feedback.length > 200 ? "…" : ""}"`,
  );

  // ── Step 1: PLAN — decide which files need changing and what to change ──
  await p.log("FBK", "Planning changes...");

  // Give the planner a brief preview of each file so it can locate features
  // like "signup screen" by content, not just description.
  const PREVIEW_LINES = 25;
  const plannerFiles = p.manifest.map((f) => {
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
    p.model,
    `${p.projectName}: ${p.projectDescription}`,
    feedback,
    plannerFiles,
  );

  if (plan.edits.length === 0) {
    await p.log(
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
      p.resolveTargetFile(edit.filePath) ||
      p.resolveFilePath(edit.filePath, edit.instruction);
    if (!resolved) {
      await p.log("FBK", `Skipping unknown file: ${edit.filePath}`);
      continue;
    }
    resolvedEdits.push({ filePath: resolved, instruction: edit.instruction });
  }

  if (resolvedEdits.length === 0) {
    await p.log("FBK", "No valid files to edit after resolution");
    return;
  }

  await p.log(
    "FBK",
    `Plan: ${resolvedEdits.length} file(s) to edit (${plan.tokens} tokens)`,
    undefined,
    plan.prompt,
    plan.raw,
  );
  for (const e of resolvedEdits) {
    await p.log("FBK", `  • ${e.filePath}: ${e.instruction}`);
  }

  // Start a fresh ledger for this feedback pass.
  await initLedger(p.projectId, feedback);

  // ── Step 2: APPLY — surgical edit first, whole-file rewrite as fallback ──
  let appliedCount = 0;
  for (const edit of resolvedEdits) {
    if (p.aborted) break;

    const fullPath = path.join(outDir, edit.filePath);
    if (!fs.existsSync(fullPath)) {
      await p.log("FBK", `Missing file: ${edit.filePath} — skipping`);
      continue;
    }

    const original = fs.readFileSync(fullPath, "utf-8");
    if (original.trim().length === 0) {
      await p.log("FBK", `${edit.filePath} is empty — skipping`);
      continue;
    }

    // Backup before modifying
    const backupPath = fullPath + ".bak";
    fs.writeFileSync(backupPath, original, "utf-8");

    await p.log("FBK", `Editing ${edit.filePath}: ${edit.instruction}`);

    const surgicalOk = await trySurgicalFeedbackEdit(p, 
      edit.filePath,
      edit.instruction,
      original,
      fullPath,
    );

    if (surgicalOk) {
      appliedCount++;
    } else {
      // Fall back to whole-file rewrite via the developer agent.
      const wholeFileOk = await tryWholeFileFeedbackEdit(p, 
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
        await p.log(
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
    for (const file of p.manifest) {
      if (p.aborted) break;
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
          await p.log(
            "FBK",
            `Propagating rename "${pair.from}"→"${pair.to}" into ${file.path}`,
          );
          const propInstruction = `Rename ${pair.from} to ${pair.to}`;
          const backupPath = fullPath + ".bak";
          fs.writeFileSync(backupPath, content, "utf-8");
          const ok = await trySurgicalFeedbackEdit(p, 
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

  await finalizeLedger(p.projectId);

  await p.log(
    "FBK",
    `Feedback pass complete — ${appliedCount}/${resolvedEdits.length} file(s) updated`,
  );
}

/**
 * Surgical feedback edit: locate a window, ask the editor for a small replace,
 * verify postconditions, and apply. Returns true if applied.
 */
export async function trySurgicalFeedbackEdit(
  p: Pipeline,
  filePath: string,
  instruction: string,
  original: string,
  fullPath: string,
): Promise<boolean> {
  const candidates: LocateCandidate[] = locateWindows(original, instruction);
  if (candidates.length === 0) {
    await p.log(
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

  const ledgerId = await appendLedgerItem(p.projectId, {
    kind: "edit",
    status: "active",
    file: filePath,
    instruction,
    window: { startLine: candidate.startLine, endLine: candidate.endLine },
  });

  await p.log(
    "FBK",
    `${filePath}: locator chose lines ${candidate.startLine}-${candidate.endLine} (${candidate.why})`,
  );

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (p.aborted) {
      await updateLedgerItem(p.projectId, ledgerId, {
        status: "failed",
        evidence: "aborted",
      });
      return false;
    }

    // Drift check: window content must still hash to what the locator saw.
    const liveSnippet = sliceLines(
      currentContent,
      candidate.startLine,
      candidate.endLine,
    );
    const liveHash = hashString(liveSnippet);
    if (liveHash !== candidate.hash && attempt === 1) {
      // First attempt only — re-locate from current content.
      const refreshed = locateWindows(currentContent, instruction);
      if (refreshed.length === 0) {
        await p.log(
          "FBK",
          `${filePath}: window drifted, re-locate failed`,
        );
        await updateLedgerItem(p.projectId, ledgerId, {
          status: "failed",
          evidence: "snippet hash drift, re-locate empty",
        });
        return false;
      }
      candidate = refreshed[0];
      await p.log(
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
      p.model,
      filePath,
      instruction,
      windowSnippet,
      candidate.startLine,
      candidate.endLine,
      lastEvidence,
    );

    await updateLedgerItem(p.projectId, ledgerId, { attempts: attempt });

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
        hash: hashString(sliceLines(currentContent, start, end)),
        why: `widened: ${result.needsWiderWindow.reason}`,
      };
      await p.log(
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
      await p.log(
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
      await p.log(
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
      await p.log(
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
      await p.log(
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
        await p.log(
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
        await p.log(
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
    const before = sliceLines(
      currentContent,
      edit.startLine,
      edit.endLine,
    );
    const after = cleanedReplace;

    await p.writeOutputFile(filePath, proposed);
    currentContent = proposed;
    await p.log(
      "FBK",
      `${filePath}: surgical edit applied (lines ${edit.startLine}-${edit.endLine}, ${result.tokens} tokens)`,
      undefined,
      result.prompt,
      result.raw,
    );
    await updateLedgerItem(p.projectId, ledgerId, {
      status: "done",
      window: { startLine: edit.startLine, endLine: edit.endLine },
      before,
      after,
    });
    return true;
  }

  await updateLedgerItem(p.projectId, ledgerId, {
    status: "failed",
    evidence: lastEvidence ?? "max attempts reached",
  });
  return false;
}

/** Extract a 1-indexed inclusive line range from content. */
export function sliceLines(
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
export async function tryWholeFileFeedbackEdit(
  p: Pipeline,
  filePathRel: string,
  instructionIn: string,
  feedback: string,
  fullPath: string,
  original: string,
): Promise<boolean> {
  const ledgerId = await appendLedgerItem(p.projectId, {
    kind: "rewrite",
    status: "active",
    file: filePathRel,
    instruction: instructionIn,
  });

  let currentContent = original;
  let instruction = instructionIn;

  for (
    let attempt = 1;
    attempt <= MAX_SELF_HEAL_ATTEMPTS;
    attempt++
  ) {
    await updateLedgerItem(p.projectId, ledgerId, { attempts: attempt });
    await p.log(
      "FBK",
      `${filePathRel} whole-file attempt ${attempt}/${MAX_SELF_HEAL_ATTEMPTS}`,
    );

    let userMessage = `Project: ${p.projectName} — ${p.projectDescription}\n\n`;
    userMessage += `User feedback: "${feedback}"\n\n`;
    userMessage += `Specifically in ${filePathRel}: ${instruction}\n\n`;
    userMessage += `Current ${filePathRel} (FULL FILE — do not truncate, output every line back):\n${currentContent}\n\n`;
    userMessage += `Apply the change above. Output the COMPLETE updated ${filePathRel} verbatim — every line that should remain, plus your changes. Do not abbreviate. Do not use "/* ... */" or "// rest unchanged". Do not change anything outside the requested edit.`;
    userMessage = p.withCustomInstructions(userMessage);

    const devResult = await runDeveloper(
      p.model,
      userMessage,
      filePathRel,
    );

    if (!devResult.block) {
      await p.log(
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
      await p.log("FBK", `Auto-repaired: ${fixes.join(", ")}`);
    }

    const validation = validateOutput(repaired, filePathRel);
    if (!validation.valid) {
      await p.log(
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
      await p.log(
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
      await p.log(
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
      await p.log(
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
        await p.log(
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

    await p.writeOutputFile(filePathRel, repaired);
    currentContent = repaired;
    await p.log(
      "FBK",
      `${filePathRel}: whole-file rewrite applied (${devResult.tokens} tokens)`,
      undefined,
      devResult.prompt,
      devResult.raw,
    );
    await updateLedgerItem(p.projectId, ledgerId, {
      status: "done",
      before: original.slice(0, 1200),
      after: repaired.slice(0, 1200),
    });
    return true;
  }

  await updateLedgerItem(p.projectId, ledgerId, { status: "failed" });
  return false;
}
