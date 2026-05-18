/**
 * Deterministic line-window locator.
 *
 * Given a file's content and a natural-language instruction, returns a
 * bounded `[startLine, endLine]` window that's most likely the region the
 * instruction refers to. No LLM call — purely keyword/regex/AST-style search.
 *
 * Used by the feedback pipeline so the Editor agent receives a small, focused
 * region instead of the whole file.
 */

export interface LocateCandidate {
  startLine: number;
  endLine: number;
  /** 0..1 — derived from hit density and keyword strength */
  score: number;
  /** Why this region matched (for logs + retry prompts) */
  why: string;
  /** Snippet hash so callers can detect drift before applying patches */
  hash: string;
  /** Numbered snippet ready for the Editor agent */
  snippet: string;
}

export interface LocateOptions {
  /** Soft cap on window size. Default 80 lines. */
  maxWindow?: number;
  /** Padding lines on each side of a hit cluster. Default 8. */
  padding?: number;
}

/**
 * Top-level entry point: locate the most relevant window for an instruction.
 * Returns up to 3 candidates ordered by score, or empty if no signal.
 */
export function locateWindows(
  content: string,
  instruction: string,
  options: LocateOptions = {},
): LocateCandidate[] {
  const maxWindow = options.maxWindow ?? 80;
  const padding = options.padding ?? 8;

  const lines = content.split("\n");
  if (lines.length === 0) return [];

  const keywords = extractKeywords(instruction);
  if (keywords.length === 0) return [];

  // Score every line by how many keywords appear in it.
  const lineScores: number[] = new Array(lines.length).fill(0);
  const lineHits: string[][] = lines.map(() => []);

  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    for (const kw of keywords) {
      if (lower.includes(kw.pattern)) {
        lineScores[i] += kw.weight;
        lineHits[i].push(kw.label);
      }
    }
  }

  // Cluster hits into windows. A cluster is a run of lines where any line
  // within `padding` distance has score > 0.
  const clusters: { start: number; end: number; score: number }[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lineScores[i] === 0) {
      i++;
      continue;
    }
    let clusterEnd = i;
    let clusterScore = 0;
    for (let j = i; j < lines.length; j++) {
      if (lineScores[j] > 0) {
        clusterEnd = j;
        clusterScore += lineScores[j];
      } else if (j - clusterEnd > padding) {
        break;
      }
    }
    clusters.push({ start: i, end: clusterEnd, score: clusterScore });
    i = clusterEnd + 1;
  }

  if (clusters.length === 0) return [];

  // Expand each cluster to a padded window, then cap at maxWindow.
  const candidates: LocateCandidate[] = clusters.map((c) => {
    let startIdx = Math.max(0, c.start - padding);
    let endIdx = Math.min(lines.length - 1, c.end + padding);

    // Clip to maxWindow — prefer keeping the cluster centered.
    if (endIdx - startIdx + 1 > maxWindow) {
      const center = Math.floor((c.start + c.end) / 2);
      const half = Math.floor(maxWindow / 2);
      startIdx = Math.max(0, center - half);
      endIdx = Math.min(lines.length - 1, startIdx + maxWindow - 1);
    }

    // Snap to a sensible boundary (start at a non-indented line if possible)
    startIdx = snapToBlockStart(lines, startIdx);
    endIdx = snapToBlockEnd(lines, endIdx);

    const startLine = startIdx + 1;
    const endLine = endIdx + 1;
    const windowLines = lines.slice(startIdx, endIdx + 1);
    const snippet = windowLines
      .map((l, idx) => `${String(startIdx + idx + 1).padStart(6)} | ${l}`)
      .join("\n");

    // Collect unique hit labels for the "why" text.
    const labels = new Set<string>();
    for (let k = c.start; k <= c.end; k++) {
      for (const lbl of lineHits[k]) labels.add(lbl);
    }
    const why = `Matched: ${Array.from(labels).slice(0, 4).join(", ")}`;

    return {
      startLine,
      endLine,
      score: c.score,
      why,
      hash: hashString(windowLines.join("\n")),
      snippet,
    };
  });

  // Sort by score, keep top 3.
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 3);
}

/**
 * Convenience: return only the best candidate, or null if no hits.
 */
export function locateBestWindow(
  content: string,
  instruction: string,
  options: LocateOptions = {},
): LocateCandidate | null {
  const candidates = locateWindows(content, instruction, options);
  return candidates[0] ?? null;
}

/**
 * Tokenize the instruction into search keywords with weights.
 * Heavier weight = more specific phrase.
 *
 * Examples:
 *   "remove the signup screen" → ["signup", "sign up", "signup screen"]
 *   "rename Submit to Save"    → ["submit", "save", "rename"]
 *   "make the button bigger"   → ["button", "bigger"]
 */
export interface Keyword {
  pattern: string; // already lowercased
  label: string;
  weight: number;
}

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "to",
  "from",
  "in",
  "on",
  "of",
  "for",
  "with",
  "is",
  "are",
  "was",
  "be",
  "do",
  "does",
  "did",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "as",
  "at",
  "by",
  "if",
  "so",
  "than",
  "then",
  "into",
  "out",
  "up",
  "down",
  "all",
  "any",
  "some",
  "no",
  "not",
  "you",
  "your",
  "we",
  "our",
  "they",
  "their",
  "i",
  "me",
  "my",
  "should",
  "would",
  "could",
  "can",
  "will",
  "have",
  "has",
  "had",
  // Verbs that describe the *operation* but not the *thing* — they don't
  // help locate a region. Keep their objects instead.
  "remove",
  "delete",
  "add",
  "insert",
  "create",
  "rename",
  "replace",
  "change",
  "update",
  "modify",
  "fix",
  "make",
  "turn",
  "set",
  "ensure",
  "use",
]);

/**
 * Common synonyms — if the user says "signup" we should also match "sign up",
 * "register", "auth", "login". Conservative list; expand as needed.
 */
const SYNONYMS: Record<string, string[]> = {
  signup: ["sign up", "register", "auth", "login", "log in"],
  "sign up": ["signup", "register", "auth", "login", "log in"],
  login: ["log in", "signin", "sign in", "auth"],
  "log in": ["login", "signin", "sign in", "auth"],
  button: ["btn"],
  delete: ["remove", "trash"],
  submit: ["save", "confirm"],
  hero: ["banner", "splash", "intro"],
  navbar: ["nav", "header", "menu"],
  footer: ["bottom"],
  dark: ["theme", "night"],
  light: ["theme", "day"],
};

export function extractKeywords(instruction: string): Keyword[] {
  const out: Keyword[] = [];
  const seen = new Set<string>();

  const lower = instruction.toLowerCase();

  // Strip punctuation but keep quoted phrases as high-weight tokens.
  const quoted = Array.from(lower.matchAll(/"([^"]{2,40})"|'([^']{2,40})'/g))
    .map((m) => (m[1] ?? m[2] ?? "").trim())
    .filter(Boolean);

  for (const q of quoted) {
    if (!seen.has(q)) {
      out.push({ pattern: q, label: `"${q}"`, weight: 5 });
      seen.add(q);
    }
  }

  // Bigrams (adjacent non-stopword pairs) — high specificity.
  const tokens = lower
    .replace(/[^\w\s-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (STOP_WORDS.has(a) || STOP_WORDS.has(b)) continue;
    if (a.length < 3 && b.length < 3) continue;
    const bigram = `${a} ${b}`;
    if (!seen.has(bigram)) {
      out.push({ pattern: bigram, label: bigram, weight: 3 });
      seen.add(bigram);
    }
  }

  // Unigrams — lower weight, must be specific (>=4 chars and not stop word).
  for (const t of tokens) {
    if (STOP_WORDS.has(t)) continue;
    if (t.length < 4) continue;
    if (seen.has(t)) continue;
    out.push({ pattern: t, label: t, weight: 1 });
    seen.add(t);
  }

  // Synonyms — add same weight as the keyword they expand.
  const synonymsToAdd: Keyword[] = [];
  for (const kw of out) {
    const syns = SYNONYMS[kw.pattern];
    if (!syns) continue;
    for (const syn of syns) {
      if (seen.has(syn)) continue;
      synonymsToAdd.push({
        pattern: syn,
        label: `${syn} (≈${kw.label})`,
        weight: Math.max(1, kw.weight - 1),
      });
      seen.add(syn);
    }
  }
  out.push(...synonymsToAdd);

  return out;
}

/**
 * Move start index up to the nearest non-indented or function/class boundary
 * (within ~5 lines), so the window starts at something readable.
 */
function snapToBlockStart(lines: string[], idx: number): number {
  const max = Math.min(idx, 5);
  for (let back = 0; back <= max; back++) {
    const i = idx - back;
    if (i <= 0) return 0;
    const line = lines[i];
    if (!line.trim()) continue;
    // Top-level constructs we like to anchor at.
    if (
      /^(export|import|function|class|const|let|var|interface|type|async)/.test(
        line.trimStart(),
      ) &&
      /^\S/.test(line)
    ) {
      return i;
    }
  }
  return idx;
}

/**
 * Move end index down to the closing brace at the same depth, within ~5 lines.
 */
function snapToBlockEnd(lines: string[], idx: number): number {
  const max = Math.min(lines.length - 1 - idx, 5);
  for (let fwd = 0; fwd <= max; fwd++) {
    const i = idx + fwd;
    if (i >= lines.length) return lines.length - 1;
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^[})\]]/.test(line.trimStart())) {
      return i;
    }
  }
  return idx;
}

/**
 * Tiny non-crypto hash for snippet-drift detection.
 * (FNV-1a 32-bit; collisions are fine — we only need "did this change?".)
 */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
