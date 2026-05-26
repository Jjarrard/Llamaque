/**
 * Component Analyzer — deterministic static analysis of React component source.
 *
 * Extracts facts from the AST/text without asking the LLM to guess.
 * Used by the test writer to produce correct queries on the first attempt,
 * and by the repair loop to explain what the DOM actually contains.
 *
 * This is intentionally regex-based (no TypeScript compiler API) so it works
 * fast inside the pipeline without spawning a separate process.
 */

export interface ComponentAnalysis {
  /** Props that have no `?` — the component will crash without them. */
  requiredProps: string[];
  /** Props that have `?` — safe to omit in tests. */
  optionalProps: string[];
  /** Literal string children of <button> elements (no dynamic expressions). */
  buttonTexts: string[];
  /** True if any <input element appears in JSX. */
  hasInput: boolean;
  /** placeholder= attribute values */
  inputPlaceholders: string[];
  /** aria-label= attribute values */
  ariaLabels: string[];
  /** Literal text inside <h1>–<h6> elements. */
  headingTexts: string[];
  /** Literal text inside <label> elements. */
  labelTexts: string[];
}

/**
 * Analyze a component's source code and return structured facts.
 * All extracted values are literals only — dynamic `{expression}` content is skipped.
 */
export function analyzeComponent(source: string): ComponentAnalysis {
  return {
    requiredProps: extractRequiredProps(source),
    optionalProps: extractOptionalProps(source),
    buttonTexts: extractButtonTexts(source),
    hasInput: /<input\b/.test(source),
    inputPlaceholders: extractAttrValues(source, "placeholder"),
    ariaLabels: extractAttrValues(source, "aria-label"),
    headingTexts: extractTagLiterals(source, "h[1-6]"),
    labelTexts: extractTagLiterals(source, "label"),
  };
}

// ─── Props extraction ────────────────────────────────────────────────────────

function extractRequiredProps(source: string): string[] {
  return extractPropsOfKind(source, "required");
}

function extractOptionalProps(source: string): string[] {
  return extractPropsOfKind(source, "optional");
}

/**
 * Find a Props interface or type alias and return field lines.
 * Handles both:
 *   interface FooProps { name: string; onDelete: () => void }
 *   type FooProps = { name: string; onDelete?: () => void }
 */
function extractPropsOfKind(
  source: string,
  kind: "required" | "optional",
): string[] {
  // Match the body of any interface/type named *Props
  // interface Foo { ... }  →  no `=`, just `{`
  // type Foo = { ... }    →  `= {`
  const propsBodyMatch = source.match(
    /(?:interface|type)\s+\w*Props(?:\s+extends\s+\w+)?\s*(?:=\s*)?\{([^}]+)\}/,
  );
  if (!propsBodyMatch) return [];

  const body = propsBodyMatch[1];
  const fields: string[] = [];

  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim().replace(/;$/, "");
    // Skip comments and blank lines
    if (!line || line.startsWith("//") || line.startsWith("*")) continue;
    // Distinguish required (name: T) from optional (name?: T)
    const isOptional = /\w+\?:/.test(line);
    if (kind === "required" && !isOptional) fields.push(line);
    if (kind === "optional" && isOptional) fields.push(line);
  }

  return fields;
}

// ─── Button text extraction ───────────────────────────────────────────────────

/**
 * Extract literal text from <button> elements.
 * Skips buttons whose children are purely dynamic ({expression}).
 * Handles self-closing content, conditional ternaries, and emoji.
 *
 * Examples that ARE extracted:
 *   <button>Add</button>                          → "Add"
 *   <button>Done Today ✅</button>                → "Done Today ✅"
 *   <button aria-label="delete">×</button>        → "×"
 *
 * Examples that are SKIPPED (dynamic only):
 *   <button>{label}</button>
 *   <button onClick={…}>{isDone ? "Done" : "Not"}</button>
 */
export function extractButtonTexts(source: string): string[] {
  const texts: string[] = [];

  // Match <button ...>content</button> — non-greedy, single-line and multiline
  const buttonRe = /<button\b[^>]*>([\s\S]*?)<\/button>/g;
  let m: RegExpExecArray | null;

  while ((m = buttonRe.exec(source)) !== null) {
    const inner = m[1];

    // Strip any HTML child tags — keep only text nodes
    const textOnly = inner.replace(/<[^>]+>/g, "").trim();

    // Skip if empty
    if (!textOnly) continue;

    // Check ternary BEFORE the generic dynamic skip:
    // {isDone ? "Done ✅" : "Mark as Done"} → extract both branches
    const ternaryMatch = textOnly.match(
      /^\{[^}]*\?\s*["']([^"']+)["']\s*:\s*["']([^"']+)["']\s*\}$/,
    );
    if (ternaryMatch) {
      texts.push(ternaryMatch[1], ternaryMatch[2]);
      continue;
    }

    // Skip entirely dynamic expressions like {label}
    if (/^\{[^}]*\}$/.test(textOnly)) continue;

    // If text mixes literals and braces (e.g. "Delete {name}"), skip
    if (textOnly.includes("{") || textOnly.includes("}")) continue;

    texts.push(textOnly);
  }

  // Deduplicate while preserving order
  return [...new Set(texts)];
}

// ─── Generic attribute value extraction ─────────────────────────────────────

/**
 * Extract all values from a given attribute across the whole source.
 * Works for placeholder="…", aria-label="…", etc.
 * Only extracts static string literals (single or double quotes).
 */
function extractAttrValues(source: string, attr: string): string[] {
  const escaped = attr.replace(/-/g, "\\-");
  const re = new RegExp(`${escaped}=["']([^"']+)["']`, "g");
  const values: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    values.push(m[1]);
  }
  return [...new Set(values)];
}

// ─── Tag literal text extraction ─────────────────────────────────────────────

/**
 * Extract literal text content from matched HTML-like tags.
 * Skips elements whose children are purely dynamic.
 *
 * @param tagPattern  regex fragment matching the tag name, e.g. "h[1-6]" or "label"
 */
function extractTagLiterals(source: string, tagPattern: string): string[] {
  const re = new RegExp(`<(${tagPattern})\\b[^>]*>([^<{}]+)<\\/\\1>`, "g");
  const texts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const text = m[2].trim();
    if (text) texts.push(text);
  }
  return [...new Set(texts)];
}

// ─── DOM roles tree extraction (from vitest failure output) ──────────────────

/**
 * When testing-library can't find an element, vitest prints the accessible roles:
 *
 *   Here are the accessible roles:
 *     heading:
 *       Name "Habit Tracker":
 *         <h1 />
 *     button:
 *       Name "Add":
 *         <button />
 *
 * Extract this block so the repair prompt can include real DOM info.
 * Returns null if the error doesn't contain a roles tree.
 */
export function extractRolesTree(vitestError: string): string | null {
  const start = vitestError.indexOf("Here are the accessible roles:");
  if (start === -1) return null;

  const slice = vitestError.slice(start);

  // The tree ends at known terminators — NOT blank lines, which appear between sections.
  // Priority: "Ignored nodes:" (testing-library footer), vitest separator, error labels.
  const terminators = [
    "\nIgnored nodes:",
    "\n\u2500\u2500\u2500", // ─── vitest separator
    "\nReceived",
    "\n✕ ",
    "\nExpect",
  ];
  let end = slice.length;
  for (const t of terminators) {
    const idx = slice.indexOf(t);
    if (idx !== -1 && idx < end) end = idx;
  }

  return slice.slice(0, end).trim();
}

/**
 * Produce a human-readable summary of a ComponentAnalysis for injection into prompts.
 *
 * Example output:
 *   Component structure (extracted from source):
 *   - No required props (container component — render with no props)
 *   - Heading: "Habit Tracker"
 *   - Buttons: "Add", "×"
 *   - Text input (placeholder: "Enter habit name")
 *   Interaction: INPUT EXISTS → type + submit pattern
 */
export function formatAnalysisForPrompt(
  analysis: ComponentAnalysis,
  componentName: string,
): string {
  const lines: string[] = [
    `Component structure (extracted from ${componentName} source — use these EXACT values):`,
  ];

  // Props
  if (analysis.requiredProps.length === 0) {
    lines.push(
      "- No required props (container component — render as <" +
        componentName +
        " />)",
    );
  } else {
    lines.push(
      `- Required props: ${analysis.requiredProps.map((p) => p.split(":")[0].trim()).join(", ")}`,
    );
    lines.push(
      `  Full types: ${analysis.requiredProps.map((p) => p).join(" | ")}`,
    );
  }

  // Heading
  if (analysis.headingTexts.length > 0) {
    lines.push(`- Heading text: "${analysis.headingTexts[0]}"`);
  }

  // Buttons
  if (analysis.buttonTexts.length > 0) {
    lines.push(
      `- Button labels (exact text from source): ${analysis.buttonTexts.map((b) => `"${b}"`).join(", ")}`,
    );
  }

  // Input
  if (analysis.hasInput) {
    const ph =
      analysis.inputPlaceholders.length > 0
        ? ` (placeholder: "${analysis.inputPlaceholders[0]}")`
        : "";
    lines.push(`- Text input present${ph}`);
  } else {
    lines.push("- No text input");
  }

  // Aria labels (useful for icon-only buttons)
  if (analysis.ariaLabels.length > 0) {
    lines.push(
      `- aria-labels: ${analysis.ariaLabels.map((a) => `"${a}"`).join(", ")}`,
    );
  }

  // Labels
  if (analysis.labelTexts.length > 0) {
    lines.push(
      `- Labels: ${analysis.labelTexts.map((l) => `"${l}"`).join(", ")}`,
    );
  }

  // Interaction guidance — derived from facts, not guesses
  lines.push("");
  if (analysis.hasInput) {
    const addBtn = analysis.buttonTexts.find((b) =>
      /add|submit|save|create|go|ok/i.test(b),
    );
    lines.push("INTERACTION TEST: text input exists → use this pattern:");
    lines.push("  const input = screen.getByRole('textbox');");
    lines.push(
      "  fireEvent.change(input, { target: { value: 'TestItem-Alpha-999' } });",
    );
    if (addBtn) {
      lines.push(
        `  fireEvent.click(screen.getByRole('button', { name: /${addBtn}/i }));`,
      );
    } else {
      lines.push("  fireEvent.click(screen.getAllByRole('button')[0]);");
    }
    lines.push(
      "  expect(screen.getByText('TestItem-Alpha-999')).toBeTruthy();",
    );
  } else if (analysis.buttonTexts.length > 0) {
    lines.push(
      "INTERACTION TEST: no text input → click a button and assert a visible change:",
    );
    lines.push(
      `  fireEvent.click(screen.getByRole('button', { name: /${analysis.buttonTexts[0]}/i }));`,
    );
    lines.push("  // assert a text change or count change is visible");
    lines.push(
      "  // If button name query fails: use screen.getAllByRole('button')[0] instead",
    );
  } else {
    lines.push(
      "INTERACTION TEST: no input or buttons found — use getAllByRole('button')[0] if any exist, or check getByRole('checkbox').",
    );
  }

  return lines.join("\n");
}
