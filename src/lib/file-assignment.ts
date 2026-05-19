/**
 * Pure helper for assigning feature/task descriptions to manifest files.
 *
 * Extracted from Pipeline so it can be unit-tested without spinning up a
 * Pipeline instance. The Pipeline holds the round-robin cursor as state.
 *
 * Strategy (in priority order):
 *   1. If the description starts with [Path.ext] and Path matches a manifest
 *      entry, use it. This is the explicit assignment from Manager.
 *   2. If a specific filePath was supplied and it matches a manifest entry, use it.
 *   3. Otherwise score each manifest file by keyword overlap between the task
 *      description and the file's *path stem + description*.
 *   4. Use the highest-scoring file. On ties (or when nothing scores), pick a
 *      file via the round-robin cursor passed by the caller.
 */

export interface ManifestEntry {
  path: string;
  description: string;
}

const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "file",
  "code",
  "main",
  "app",
  "component",
  "function",
  "render",
  "handles",
  "displays",
  "implements",
  "implement",
  "create",
  "creates",
  "adds",
  "shows",
  "uses",
  "their",
  "respective",
  "between",
  "based",
]);

function tokensForFile(file: ManifestEntry): Set<string> {
  const pathStem = file.path
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase();
  const blob = `${pathStem} ${file.description.toLowerCase()}`;
  return new Set(
    blob.split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)),
  );
}

export interface AssignResult {
  path: string;
  /** Updated cursor — caller should persist this to keep round-robin moving. */
  cursor: number;
}

/**
 * Pick a manifest file for a given task description. Stateless; the caller
 * supplies and updates the round-robin cursor.
 */
export function assignFileForTask(
  manifest: ManifestEntry[],
  filePath: string | null,
  description: string,
  cursor: number,
): AssignResult {
  if (manifest.length === 0) return { path: "output.txt", cursor };
  if (manifest.length === 1) return { path: manifest[0].path, cursor };

  // [Path.ext] prefix from Manager — explicit, authoritative assignment.
  const prefixMatch = description.match(/^\s*\[\s*([^\]\s][^\]]*?)\s*\]/);
  if (prefixMatch) {
    const explicit = prefixMatch[1];
    const match = manifest.find(
      (f) => f.path.toLowerCase() === explicit.toLowerCase(),
    );
    if (match) return { path: match.path, cursor };
  }

  if (filePath) {
    const match = manifest.find(
      (f) => f.path.toLowerCase() === filePath.toLowerCase(),
    );
    if (match) return { path: match.path, cursor };
  }

  const descLower = description.toLowerCase();
  let topScore = -1;
  const candidates: number[] = [];
  for (let i = 0; i < manifest.length; i++) {
    const toks = tokensForFile(manifest[i]);
    let score = 0;
    for (const t of toks) {
      if (descLower.includes(t)) score++;
    }
    if (score > topScore) {
      topScore = score;
      candidates.length = 0;
      candidates.push(i);
    } else if (score === topScore) {
      candidates.push(i);
    }
  }

  if (topScore > 0 && candidates.length === 1) {
    return { path: manifest[candidates[0]].path, cursor };
  }

  const pool = candidates.length > 0 ? candidates : manifest.map((_, i) => i);
  const pick = pool[cursor % pool.length];
  return { path: manifest[pick].path, cursor: cursor + 1 };
}
