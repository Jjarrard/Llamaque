# Overhaul Plan: Spec-Based Execution

## The Core Problem

Small models (1-8B) can do **one small thing** reliably. The current system asks them to do too many things:

1. Manager recursively decomposes epics → features → tasks (3 levels deep)
2. By depth 3, there are 15-45 overlapping task descriptions per file
3. Developer receives "implement ALL of these: [19 requirements]" and produces garbage — duplicate functions, HTML in JS files, placeholder code
4. Each decomposition level adds noise, hallucination, and duplication

**Evidence from projects 20, 25, 27:**

- Project 20: Developer wrote HTML into script.js, 19+ overwrites destroyed work
- Project 25: Developer wrote `// Your code here` for script.js (only 24 tokens)
- Project 27: script.js had `checkUnlockedButtons()` declared 3x, `const game` declared 2x, raw HTML `<button>` tags inside JS

## The Fix: Specification-Based Execution

**Key insight:** Use the task tree for PLANNING visibility, but execute from MERGED SPECS, not individual tasks.

### Current Flow (broken)

```
Idea → 5 Epics → 15 Features → 45 Tasks → Group 19 tasks for script.js → Developer chokes
```

### New Flow (proposed)

```
Idea → 3-5 Epics → 2-3 Features per Epic → MERGE features by file → 1 short spec per file → Developer writes clean file
```

## Architecture

```
┌─────────────────────────────────────────────┐
│  Phase 1: DECOMPOSE                         │
│                                             │
│  PM → 3-5 Epics (high-level feature areas)  │
│  Reviewer → Filter unrelated epics          │
│                                             │
│  Task tree: depth 1 = Epics                 │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  Phase 2: PLAN                              │
│                                             │
│  For each Epic:                             │
│    Manager → 2-3 features (each targets     │
│              ONE of: index.html,            │
│              style.css, script.js)          │
│                                             │
│  Task tree: depth 2 = Features              │
│  Max 3 features per epic, max 15 total      │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  Phase 3: MERGE  (no LLM — pure code)       │
│                                             │
│  1. Collect all depth-2 features            │
│  2. Group by target file                    │
│  3. Deduplicate (string similarity)         │
│  4. Produce per-file spec (max 8 bullets)   │
│                                             │
│  Result: 3 short specs, one per file        │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  Phase 4: EXECUTE  (1 LLM call per file)    │
│                                             │
│  Write in order:                            │
│    1. index.html (spec only)                │
│    2. style.css  (spec + full HTML context) │
│    3. script.js  (spec + full HTML context) │
│                                             │
│  Each file: Developer → QA → retry if fail  │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  Phase 5: IMPROVE                           │
│                                             │
│  Improver reads all 3 files + original req  │
│  If bugs → Developer rewrites affected file │
└─────────────────────────────────────────────┘
```

## How Models Communicate (Context Flow)

This is the critical piece. Each model gets exactly what it needs — no more, no less.

| Step | Agent            | Input Context                           | Why                                |
| ---- | ---------------- | --------------------------------------- | ---------------------------------- |
| 1    | PM               | Project name + description              | Only needs the user's idea         |
| 2    | Reviewer         | User request + proposed epics           | Decides relevance                  |
| 3    | Manager          | Project info + ONE epic                 | Breaks into file-targeted features |
| 4    | Developer (HTML) | Project info + HTML spec                | Writes the structure               |
| 5    | Developer (CSS)  | Project info + CSS spec + **full HTML** | Sees exact classes/IDs to style    |
| 6    | Developer (JS)   | Project info + JS spec + **full HTML**  | Sees exact elements to manipulate  |
| 7    | Improver         | Original request + **all 3 files**      | Cross-file bug review              |

**The HTML file IS the contract.** Once written, CSS and JS get the full HTML as context so they can reference the exact IDs, classes, and structure. No guessing. No hallucinating element names.

## Product History (How Files Stay Consistent)

**Problem before:** Each Developer call overwrote the file, destroying previous work. Models had no idea what other files contained.

**Solution:** Files are written exactly once, in dependency order:

```
1. Write index.html  →  save to disk
2. Write style.css   →  read index.html from disk as context  →  save to disk
3. Write script.js   →  read index.html from disk as context  →  save to disk
```

After step 1, the ACTUAL HTML content (not a summary, not a truncation) becomes the shared context for steps 2 and 3. This is the "product history" — it's the real files on disk.

## No Duplicate Work

**Problem before:** 19 tasks all targeting script.js, many near-identical ("add click handler for button", "add event listener for click", "handle button click event").

**Solution:** The MERGE phase is deterministic code, not an LLM:

```typescript
// Pseudocode for merge
function mergeFeatures(features: Task[]): Record<string, string[]> {
  const specs: Record<string, string[]> = {};

  for (const feature of features) {
    const file = resolveFilePath(feature);
    if (!specs[file]) specs[file] = [];

    // Skip if we already have something very similar
    const isDuplicate = specs[file].some(
      (existing) => stringSimilarity(existing, feature.description) > 0.6,
    );
    if (!isDuplicate) {
      specs[file].push(feature.description);
    }
  }

  // Cap each file at 8 requirements max
  for (const file of Object.keys(specs)) {
    specs[file] = specs[file].slice(0, 8);
  }

  return specs;
}
```

Since merge is programmatic:

- No LLM hallucination
- Deterministic deduplication
- Hard cap prevents overload
- Each file gets a clean, short bullet list

## Developer Prompt Design

The Developer prompt must be ultra-simple. One file, one spec, minimal context.

### For index.html:

```
[SYSTEM]
You are a Developer. Write a complete HTML file.
No frameworks. Plain HTML only.
NEVER write placeholder comments. Write REAL working code.

Reply:
>>RESULT
status: DONE
filePath: index.html
output: |
  (the complete HTML file)
>>END

[USER]
Project: Click Counter — A click counter with plus/minus buttons

Write the complete index.html file. It must include:
1. A counter display showing the current number
2. A plus button to increment
3. A minus button to decrement
4. Link to style.css and script.js
```

### For script.js (with HTML context):

```
[SYSTEM]
You are a Developer. Write a complete JavaScript file.
No frameworks. Plain JavaScript only.
NEVER write placeholder comments. Write REAL working code.
Write ONLY JavaScript. NO HTML tags. NO <!DOCTYPE>.

Reply:
>>RESULT
status: DONE
filePath: script.js
output: |
  (the complete JavaScript file)
>>END

[USER]
Project: Click Counter — A click counter with plus/minus buttons

The HTML file contains:
<div class="counter-display">0</div>
<button class="btn plus">+</button>
<button class="btn minus">-</button>

Write the complete script.js file. It must include:
1. Counter variable starting at 0
2. Click handler for plus button to increment
3. Click handler for minus button to decrement
4. Update the display when counter changes
```

**Why this works for dumb models:**

- System prompt is 4 lines
- User prompt is SHORT (project + spec + HTML reference)
- Only ONE file type per call
- The spec is 4-8 bullet points, not 19 overlapping tasks
- The HTML reference shows EXACT element selectors to use

## What Changes in Code

### Remove

- `MAX_DEPTH = 3` → change to `2` (planning stops at features)
- `decomposeAll()` deep recursion → single-pass Manager for each epic
- `executeFileGroup()` task combining → replaced by spec-based execution
- `executeTask()` individual task execution → not needed
- Summariser agent → not needed (context = actual files)
- Editor agent → not needed (full-file rewrite on failure)
- Depth 3 task creation → features are the planning leaves

### Add

- `mergeFeatureSpecs()` → groups features by file, deduplicates, caps at 8
- `executeFromSpecs()` → writes each file from its merged spec
- Better Developer prompt per file type (HTML vs CSS vs JS)

### Keep (proven to work)

- Project Manager → produces good epics
- Reviewer → filters extras effectively
- Manager → simplified to one depth only (epic → features)
- QA/validate → catches HTML-in-JS, duplicates, placeholders, bad syntax
- Improver → cross-file bug review
- TTM protocol + parser
- Prefill `>>` + stop sequence `>>END`
- `autoRepairOutput()` → fixes truncation
- Content-type validation in JS/CSS

### Simplify

- Manager → one prompt only (no depth-aware prompts needed)
- Developer → file-type-specific prompts (3 short templates)
- Pipeline flow → linear phases instead of recursive

## Token Budget Analysis

With `num_ctx = 4096`:

| Component                 | Tokens (approx) |
| ------------------------- | --------------- |
| System prompt             | 80              |
| Project name/desc         | 40              |
| File spec (8 bullets)     | 160             |
| HTML context (for CSS/JS) | 400-800         |
| Protocol overhead         | 30              |
| **Total prompt**          | **~710-1110**   |
| **Available for output**  | **~2986-3386**  |

Even a small HTML file (30 lines) fits in 400 tokens of context. And the output budget of ~3000 tokens is enough for any reasonable single file.

Compare to current: 19 task descriptions + HTML context + system prompt often pushes past 2000 prompt tokens, leaving only ~2000 for output — which gets eaten by duplicate functions.

## Logic Verification

Let me trace through a "Click Counter" project:

### Phase 1: DECOMPOSE

- PM input: "Click Counter — plus/minus buttons, number display"
- PM output: 3 epics:
  1. "Counter display and layout"
  2. "Button click interactions"
  3. "Visual styling"
- Reviewer: keeps all 3 (all relate to a counter)

### Phase 2: PLAN

- Epic 1 → Manager produces:
  - "Create counter display with value element in index.html"
  - "Add increment/decrement logic in script.js"
- Epic 2 → Manager produces:
  - "Add plus and minus buttons in index.html"
  - "Add click event handlers for buttons in script.js"
- Epic 3 → Manager produces:
  - "Style counter container and buttons in style.css"
  - "Add hover and active states for buttons in style.css"

### Phase 3: MERGE

- **index.html** features:
  1. "Create counter display with value element"
  2. "Add plus and minus buttons"
     → Spec: 2 items (no duplicates)

- **style.css** features:
  1. "Style counter container and buttons"
  2. "Add hover and active states for buttons"
     → Spec: 2 items

- **script.js** features:
  1. "Add increment/decrement logic"
  2. "Add click event handlers for buttons"
     → Spec: 2 items (very similar but kept because one is logic, one is events)

### Phase 4: EXECUTE

1. Developer writes index.html from 2-item spec → produces clean HTML
2. Developer writes style.css from 2-item spec + full HTML → matches real classes
3. Developer writes script.js from 2-item spec + full HTML → uses real selectors

### Phase 5: IMPROVE

- Improver sees all 3 files → checks JS uses correct selectors from HTML ✅

**Total LLM calls: 3 (PM) + 1 (Reviewer) + 3 (Manager × 3 epics) + 3 (Developer × 3 files) + 1 (Improver) = 11 calls**

Compare to current: PM + Reviewer + Manager(5 epics × 2 levels) + Developer(3 files) + Improver = often 15-25 calls, with worse results.

## Failure Modes and Mitigations

| Failure                                              | Detection                        | Recovery                                                  |
| ---------------------------------------------------- | -------------------------------- | --------------------------------------------------------- |
| PM produces no epics                                 | Parse check                      | Retry once with simpler prompt                            |
| PM produces too many epics                           | `slice(0, 5)`                    | Hard cap                                                  |
| Manager produces no features                         | Parse check                      | Retry once                                                |
| Manager produces vague features                      | `isVagueOrCircular()`            | Retry with stricter prompt                                |
| Merge produces empty spec for a file                 | Check `specs[file].length === 0` | Skip that file (it's fine — not every file needs content) |
| Developer writes placeholder                         | QA placeholder detection         | Retry with "REAL code" emphasis                           |
| Developer writes HTML in JS                          | QA content-type check            | Retry with "ONLY JavaScript" emphasis                     |
| Developer writes duplicate functions                 | QA duplicate detection           | Retry with error message                                  |
| Developer output truncated                           | `autoRepairOutput()`             | Close braces/tags automatically                           |
| Developer can't produce valid output after 2 retries | Retry count check                | Mark stuck, continue with other files                     |
| Improver finds cross-file bugs                       | Parse fix list                   | Developer rewrites affected file                          |

## Task Tree (UI Visibility)

The user sees this in the task panel:

```
▼ Epic: Counter display and layout           ✅
  • Create counter display with value element (index.html)  ✅
  • Add increment/decrement logic (script.js)               ✅
▼ Epic: Button click interactions             ✅
  • Add plus and minus buttons (index.html)                 ✅
  • Add click event handlers for buttons (script.js)        ✅
▼ Epic: Visual styling                        ✅
  • Style counter container and buttons (style.css)         ✅
  • Add hover and active states (style.css)                 ✅
```

And in the log panel:

```
[PM]  Breaking down idea into epics...
[REV] All 3 features approved
[PM]  Created 3 epics
[MGR] Epic 1 → 2 features
[MGR] Epic 2 → 2 features
[MGR] Epic 3 → 2 features
[SYS] Merged 6 features into 3 file specs
[DEV] Writing index.html (2 requirements)
[QA]  PASS: index.html
[DEV] Writing style.css (2 requirements)
[QA]  PASS: style.css
[DEV] Writing script.js (2 requirements)
[QA]  PASS: script.js
[IMP] Reviewing all files for cross-file bugs...
[IMP] No issues found
```

## Summary

| Aspect                        | Before                                                         | After                                      |
| ----------------------------- | -------------------------------------------------------------- | ------------------------------------------ |
| Decomposition depth           | 3 levels (epic → feature → task)                               | 2 levels (epic → feature)                  |
| Tasks per file                | 10-19 (overlapping/duplicate)                                  | 2-8 (clean, deduplicated)                  |
| Developer calls               | 1 per file (with 19 requirements)                              | 1 per file (with 2-8 requirements)         |
| Context for CSS/JS            | Truncated HTML (300-1000 chars)                                | Full HTML (always fits with short spec)    |
| File overwrites               | Multiple (each task overwrote)                                 | Zero (each file written exactly once)      |
| LLM agents needed             | PM, Reviewer, Manager, Developer, Summariser, Editor, Improver | PM, Reviewer, Manager, Developer, Improver |
| Total LLM calls               | 15-25+                                                         | 8-12                                       |
| Probability of working output | ~30%                                                           | ~80%+                                      |
