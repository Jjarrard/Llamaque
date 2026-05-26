/**
 * Unified file-change validation pipeline.
 *
 * Both the full-rewrite (`runDeveloper`) and patch (`runDeveloperPatch`)
 * paths in pipeline.ts used to call validation primitives in slightly
 * different orders with slightly different conclusions. This module is
 * the ONE place to update when adding a new check — it returns a single
 * structured result both paths consume.
 *
 * Order of checks (cheap → expensive):
 *   1. Structural validity      (validateOutput from validate.ts)
 *   2. TypeScript syntax        (checkTypeScriptSyntax)
 *   3. TypeScript semantics     (checkTypeScriptSemantics)
 *   4. AST duplicate symbols    (findDuplicateSymbols)
 *   5. Truncation heuristics    (detectTruncation)
 *
 * Each check that fails contributes a short reason string. The first
 * failing category short-circuits the rest (no point semantic-checking
 * a file that won't parse).
 *
 * Returns:
 *   { ok: true,  reasons: [] }                          file is good
 *   { ok: false, category: "syntax", reasons: [...] }   first failing layer
 */

import { validateOutput, autoRepairOutput } from "@/lib/validate";
import {
  checkTypeScriptSyntax,
  checkTypeScriptSemantics,
} from "@/lib/ops/compiler";
import {
  findDuplicateSymbols,
  formatDuplicateIssue,
} from "@/lib/ops/duplicate-check";
import { detectTruncation } from "@/lib/ops/truncation-check";
import {
  findUndefinedIdentifiers,
  formatUndefIssue,
} from "@/lib/ops/undef-check";

export type ValidationCategory =
  | "structural"
  | "syntax"
  | "semantic"
  | "duplicate"
  | "undefined"
  | "truncation";

export interface FileValidationResult {
  ok: boolean;
  category?: ValidationCategory;
  /** Human-readable reasons for failure — used in retry prompts. */
  reasons: string[];
  /** Combined display string for logs (joined reasons). */
  summary: string;
  /** The (possibly auto-repaired) candidate content. */
  candidate: string;
  /** Auto-repair fixes applied, if any. */
  repairFixes: string[];
}

export interface FileValidationOptions {
  /** Pass true when validating a per-step intermediate scaffold (lenient). */
  allowScaffold?: boolean;
  /** Min line count expected for this file — used by truncation check. */
  minExpectedLines?: number;
}

/**
 * Run the full validation chain. Auto-repair fires first; the repaired
 * candidate is then validated.
 */
export function validateFileChange(
  filePath: string,
  content: string,
  opts: FileValidationOptions = {},
): FileValidationResult {
  // Step 0 — auto-repair (strip TTM wrappers, fix common formatting)
  const { repaired, fixes } = autoRepairOutput(content, filePath);
  const candidate = fixes.length > 0 ? repaired : content;

  const make = (
    ok: boolean,
    category?: ValidationCategory,
    reasons: string[] = [],
  ): FileValidationResult => ({
    ok,
    category,
    reasons,
    summary: reasons.join("; "),
    candidate,
    repairFixes: fixes,
  });

  // Step 1 — structural validity
  const structural = validateOutput(candidate, filePath, {
    allowScaffold: opts.allowScaffold,
  });
  if (!structural.valid) {
    return make(false, "structural", [
      structural.reason || "structural validation failed",
    ]);
  }

  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const isCode = ["ts", "tsx", "jsx", "js"].includes(ext);

  if (isCode) {
    // Step 2 — TypeScript syntax
    const syntax = checkTypeScriptSyntax(filePath, candidate);
    if (syntax.length > 0) {
      return make(false, "syntax", syntax);
    }

    // Step 3 — TypeScript semantics (filtered)
    const semantic = checkTypeScriptSemantics(filePath, candidate);
    if (semantic.length > 0) {
      return make(false, "semantic", semantic);
    }

    // Step 4 — AST duplicate symbol check
    const dupes = findDuplicateSymbols(filePath, candidate);
    if (dupes.length > 0) {
      return make(false, "duplicate", dupes.map(formatDuplicateIssue));
    }

    // Step 4b — Undefined-identifier check (catches handlers referenced
    // in JSX but never declared — the most common runtime-failure-with-clean-tsc
    // pattern from small models).
    const undefs = findUndefinedIdentifiers(filePath, candidate);
    if (undefs.length > 0) {
      return make(false, "undefined", undefs.map(formatUndefIssue));
    }
  }

  // Step 5 — Truncation (any code/text file)
  const truncation = detectTruncation(filePath, candidate, {
    minExpectedLines: opts.minExpectedLines,
  });
  if (truncation.length > 0) {
    return make(false, "truncation", truncation);
  }

  return make(true);
}
