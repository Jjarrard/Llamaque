/**
 * Aider-style SEARCH/REPLACE patch protocol.
 *
 * Used by the developer agent during incremental edits (steps 2..N of a file).
 * Lets capable models emit ONLY the changed regions instead of rewriting the
 * whole file — which causes drift, lost code, and 5x the tokens.
 *
 * Block format (whitespace-sensitive on the SEARCH side):
 *
 *   <<<<<<< SEARCH
 *   exact existing lines to find (verbatim, including indentation)
 *   =======
 *   new lines that replace them
 *   >>>>>>> REPLACE
 *
 * Special cases:
 *   - Empty SEARCH section → APPEND mode: REPLACE is appended to end of file
 *     (useful for adding a new helper function or import)
 *   - Multiple blocks in a single response are applied in order
 *   - SEARCH must match EXACTLY ONCE in the current file (or zero times for APPEND)
 */

export interface PatchBlock {
  search: string;
  replace: string;
}

export interface ApplyPatchResult {
  ok: boolean;
  content: string;
  blocksApplied: number;
  reason?: string;
}

/**
 * Parse zero or more SEARCH/REPLACE blocks from a model response.
 * Tolerant of:
 *   - leading/trailing prose
 *   - fenced code wrappers (```diff, ```, etc.)
 *   - 5+ `<` or `>` (some models emit 7 or 8)
 *   - 5+ `=` divider
 */
export function parsePatch(text: string): PatchBlock[] {
  const blocks: PatchBlock[] = [];
  // Permissive markers: at least 5 of each char
  const blockRegex =
    /<{5,}\s*SEARCH\s*\n([\s\S]*?)\n={5,}\s*\n([\s\S]*?)\n>{5,}\s*REPLACE/g;

  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(text)) !== null) {
    const search = match[1] ?? "";
    const replace = match[2] ?? "";
    blocks.push({ search, replace });
  }
  return blocks;
}

/**
 * Find SEARCH in content. First tries exact match (must be unique).
 * Falls back to whitespace-tolerant match: collapses all runs of whitespace
 * within each line and re-scans line-by-line. This is what Aider does for
 * small/medium models that paraphrase indentation.
 *
 * Returns the [startIdx, endIdx] of the matched substring in `content`,
 * or null if no unique match.
 */
function findSearchMatch(
  content: string,
  search: string,
): { start: number; end: number; ambiguous: boolean } | null {
  // Exact match first
  const firstIdx = content.indexOf(search);
  if (firstIdx !== -1) {
    const secondIdx = content.indexOf(search, firstIdx + 1);
    if (secondIdx !== -1) return { start: 0, end: 0, ambiguous: true };
    return {
      start: firstIdx,
      end: firstIdx + search.length,
      ambiguous: false,
    };
  }

  // Whitespace-tolerant fallback. Compare line-by-line ignoring leading/
  // trailing whitespace and collapsing internal whitespace runs.
  const normalize = (s: string) =>
    s
      .split("\n")
      .map((line) => line.trim().replace(/\s+/g, " "))
      .filter((line) => line.length > 0)
      .join("\n");

  const normSearch = normalize(search);
  if (normSearch.length === 0) return null;

  const contentLines = content.split("\n");
  const searchLineCount = search.split("\n").filter((l) => l.trim()).length;

  const matches: { start: number; end: number }[] = [];
  for (let i = 0; i <= contentLines.length - searchLineCount; i++) {
    // Try windows of varying sizes (search may have blank lines stripped)
    for (
      let windowSize = searchLineCount;
      windowSize <= Math.min(searchLineCount + 2, contentLines.length - i);
      windowSize++
    ) {
      const window = contentLines.slice(i, i + windowSize).join("\n");
      if (normalize(window) === normSearch) {
        // Compute char offsets for this window in original content
        const charStart =
          contentLines.slice(0, i).join("\n").length + (i > 0 ? 1 : 0);
        const charEnd = charStart + window.length;
        matches.push({ start: charStart, end: charEnd });
        break;
      }
    }
  }

  if (matches.length === 0) return null;
  if (matches.length > 1) return { start: 0, end: 0, ambiguous: true };
  return { ...matches[0], ambiguous: false };
}

/**
 * Apply a list of SEARCH/REPLACE blocks to a file's content.
 * - SEARCH must occur exactly once (or be empty for APPEND mode).
 * - Falls back to whitespace-tolerant matching if exact match fails.
 * - Blocks are applied in order; later blocks see earlier edits.
 * - If any block fails, returns `ok: false` with a reason.
 */
export function applyPatch(
  original: string,
  blocks: PatchBlock[],
): ApplyPatchResult {
  if (blocks.length === 0) {
    return {
      ok: false,
      content: original,
      blocksApplied: 0,
      reason: "no SEARCH/REPLACE blocks found in response",
    };
  }

  let content = original;
  let applied = 0;

  for (let i = 0; i < blocks.length; i++) {
    const { search, replace } = blocks[i];

    // APPEND mode: empty search
    if (search.trim() === "") {
      content = content.trimEnd() + "\n\n" + replace.trimEnd() + "\n";
      applied++;
      continue;
    }

    const match = findSearchMatch(content, search);
    if (!match) {
      return {
        ok: false,
        content,
        blocksApplied: applied,
        reason: `block ${i + 1}/${blocks.length}: SEARCH text not found in file`,
      };
    }
    if (match.ambiguous) {
      return {
        ok: false,
        content,
        blocksApplied: applied,
        reason: `block ${i + 1}/${blocks.length}: SEARCH text matches multiple locations (must be unique)`,
      };
    }

    content =
      content.slice(0, match.start) + replace + content.slice(match.end);
    applied++;
  }

  return { ok: true, content, blocksApplied: applied };
}
