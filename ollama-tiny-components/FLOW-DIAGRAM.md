# Ollama Tiny Components — Pipeline Flow Diagram

> A complete logic flow of how the system takes a user's idea and turns it into a working React TSX component using small local LLMs with TDD.

---

## High-Level Pipeline Overview

```
User Idea → Decompose → Plan → Merge → Generate Tests → Execute → Test QA → Structural Review → (Conditional LLM QA) → Output
```

The system generates a **single file**: `Component.tsx` (+ `Component.test.tsx` for QA) — stored in `output/{projectId}/`.
Preview uses React 18 CDN + Babel standalone — no build step required.

---

## 1. Project Creation

```
User fills in form:
  - Project name (e.g. "Pixel Art Editor")
  - Description (e.g. "A pixel art editor with color picker and grid")
  - Model selection (e.g. "qwen3:4b")
       │
       ▼
  30-second duplicate guard
       │
       ▼
  Project record saved to SQLite
  Status: "pending"
```

---

## 2. Pipeline Startup

```
User clicks "Run All" (or individual stage button)
       │
       ▼
  Health check Ollama API + verify model available
       │
       ├── Fail → Show error
       │
       └── Pass ↓
              │
              ▼
        Pipeline starts (fire-and-forget)
        Project status → "running"
        SSE stream → UI log entries
              │
              ▼
        Create scaffold: output/{id}/
          - Component.tsx (basic starter component)
```

---

## 3. Phase 1: DECOMPOSE — Break Idea into Epics

```
Project Manager Agent → 3-5 high-level epics
       │
       ▼
Reviewer Agent → filter redundant/irrelevant epics
       │
       ▼
Cap at 5 epics, insert as depth-1 tasks
Pipeline pauses → User reviews & approves epics
```

---

## 4. Phase 2: PLAN — Break Epics into Features

```
For each approved epic:
       │
       ▼
  Manager Agent → 2-3 features per epic
  All features target "Component.tsx" (single-file model)
       │
       ▼
  isVagueOrCircular() filter → reject bad features
       │
       ▼
  Insert as depth-2 tasks, status "ready"
```

---

## 5. Phase 3: MERGE — Deduplicate and Fill Gaps (No LLM)

```
Collect all "ready" depth-2 tasks
       │
       ▼
  Group by file → deduplicate (60% word overlap threshold)
       │
       ▼
  Cap at 8 requirements for Component.tsx
       │
       ▼
  ensureBasicSpecs() → add defaults if no features generated
       │
       ▼
  Result: requirements[] ready for test generation + execution
```

---

## 6. Phase 3b: TDD — Generate Tests BEFORE Code ★ NEW

```
Test Writer Agent
  Input:  project name + description + merged requirements[]
  Role:   "Write 3-5 tests using vitest + @testing-library/react"
  Rules:  render checks, element presence, user interactions
  Output: Component.test.tsx (>>RESULT block)
       │
       ├── Parse failure → Skip TDD, fall back to LLM-based QA
       │
       └── Success ↓
              │
              ▼
        autoRepairOutput() → strip fences, fix braces
              │
              ▼
        Write output/{id}/Component.test.tsx
              │
              ▼
        Tests exist BEFORE Component.tsx is written
        Developer Agent will see tests as part of its context
```

**Test file structure:**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import PixelArtEditor from "./Component";

describe("PixelArtEditor", () => {
  it("renders without crashing", () => { ... });
  it("has a color picker", () => { ... });
  it("has a canvas element", () => { ... });
  // 3-5 practical tests
});
```

---

## 7. Phase 4: EXECUTE — Generate Component Code

````
For each requirement (one at a time, sequential):
       │
       ▼
  Build prompt with current Component.tsx + requirement
       │
       ▼
  Self-healing loop (up to 3 attempts):
    Developer Agent → code output
         │
         ▼
    autoRepairOutput():
      - Strip markdown fences (```tsx)
      - Strip trailing English text after code
      - Auto-close unclosed braces/parens/brackets
         │
         ▼
    validateOutput() (lenient, allows scaffold):
      ✓ Not empty
      ✓ Has export default function
      ✓ Has return statement with JSX
      ✓ Not truncated
      ✓ No placeholder code
         │
         ├── Invalid → Feed error back to LLM, retry
         │
         └── Valid → Write to file, next requirement
````

---

## 8. Phase 5: TEST QA — Run Tests, Fix Failures One at a Time ★ NEW

This is the **primary QA mechanism** — objective, deterministic, no LLM judgment.

```
fixTestImport():
  Detect actual export name (e.g. "PixelArtEditor")
  Fix test imports to match (replace "Component" → "PixelArtEditor")
       │
       ▼
  Run: vitest run --reporter=json output/{id}/Component.test.tsx
       │
       ├── vitest CRASHED (syntax error, bad import)?
       │     │
       │     ▼
       │   repairTestFile() — LLM fixes the test file itself
       │   Retry up to 2 times
       │     │
       │     ├── Still crashing → Delete bad test file, skip to LLM QA
       │     │
       │     └── Fixed → Continue with test results ↓
       │
       └── Got results ↓
              │
              ▼
        All passing? → Done! Skip to Phase 6 ✓
              │
              ▼
        Fix loop (up to 8 rounds):
          │
          ▼
        Pick FIRST failing test
          │
          ▼
        Build fix prompt (context-aware, truncated for small models):
          - Current Component.tsx (truncated to ~100 lines)
          - Only the FAILING test block (extracted, not full file)
          - Failing test name + error message (capped at 500 chars)
          - "Fix the Component.tsx so this test passes"
          │
          ▼
        Developer Agent → fixed Component.tsx
          │
          ▼
        autoRepairOutput() → validateOutput()
          │
          ├── Invalid → Skip this fix, continue
          │
          └── Valid → Write file, re-run ALL tests
                │
                ├── Fewer failures → Progress! Continue fixing next failure
                │
                ├── Same/more failures after 2 attempts on same test →
                │   Test might be wrong → repairSingleTest()
                │   LLM fixes/removes the bad test → re-run
                │
                └── All passing → Done! ✓
```

**Key principle:** Tests are treated as the source of truth. The component gets fixed to match the tests. Only when the component CAN'T pass a test do we consider the test wrong.

---

## 9. Phase 6: HOLISTIC REVIEW — Structural Quality Checks (Programmatic Only)

```
Programmatic checks (checkOutputQuality):
  ✓ Has default export
  ✓ Uses inline styles (no external CSS)
  ✓ Has return statement + JSX
  ✓ Balanced braces
  ✓ Minimum code length
       │
       ├── All pass → Done ✓
       │
       └── Issues found → Developer Agent fixes (no LLM review step)
```

LLM holistic review is **skipped entirely** — small models hallucinate phantom issues
and introduce bugs while "fixing" them. Tests + structural checks are sufficient.

---

## 10. Phase 7: ITERATIVE QA — LLM Find-One-Fix-One (Only When Tests Fail)

```
** SKIPPED if all TDD tests pass ** (saves LLM calls + prevents bug introduction)

Loop up to 5 rounds:
  │
  ▼
  Iterative QA Agent
    "Find ONE bug in this component"
    Returns: { file, problem, fix } or NO_ISSUES
       │
       ├── NO_ISSUES → Done ✓
       │
       └── Issue found → Developer Agent fixes → validate → write
           Track previousFixes[] to avoid re-reporting
```

This is the **fallback** QA — only runs when tests couldn't verify quality.

---

## 11. Phase 8: IMPROVE — Component Bug Review (Only When Tests Fail)

```
** SKIPPED if all TDD tests pass **

Improver Agent reviews component for remaining bugs
  ├── No issues → Skip
  └── Issues → Developer fixes each → validate → write
```

---

## 12. Phase 9: CONSISTENCY — Final Validation

```
Single-component model → lightweight pass (structural validation only)
```

---

## 13. Feedback Loop — User-Driven Iteration

```
User provides feedback (e.g. "make the grid larger")
       │
       ▼
  Backup Component.tsx → Component.tsx.bak
       │
       ▼
  Self-healing loop (up to 3 attempts):
    Feed feedback + current code to LLM → output
    autoRepairOutput() → validateOutput()
       │
       ├── Valid → Write file
       │
       └── All attempts fail → Restore backup
              │
              ▼
  Run full QA pipeline:
    - tests
    - structural review
    - iterative QA + improve (only if tests fail)
       │
       ▼
  Pause → User can provide more feedback
```

---

## 14. LLM Communication Protocol

```
Every LLM call:
  System prompt (agent-specific, concise)
  User message (task-specific, with context)
       │
       ▼
  Ollama API with hardening:
    - Prefill: { role: "assistant", content: ">>" }
    - Stop sequence: ">>END"
    - Temperature: 0 (most agents), 0.3 (PM)
    - Context window: 32768 tokens
    - Unlimited output: numPredict = -1
    - 30m keep-alive
       │
       ▼
  Parse TTM (TinyTask Markup):
    >>COMMAND\nkey: value\noutput: |\n  (code)\n>>END
    Fuzzy: case-insensitive, handles missing >>END
       │
       ├── Success → Structured data
       └── Failure → Retry (2x)
```

---

## 15. Test Infrastructure

```
vitest.config.mts:
  environment: jsdom
  globals: true
  include: output/**/Component.test.tsx
  setupFiles: vitest.setup.mts (@testing-library/jest-dom)

Test Runner (src/lib/test-runner.ts):
  execSync("vitest run --reporter=json ...")
  Parses JSON → { passed, failed, total, tests[], crashed, crashError }

Test Writer Agent (src/lib/agents/test-writer.ts):
  Input: project name + description + requirements
  Output: Component.test.tsx with 3-8 practical tests

Dependencies:
  vitest, @testing-library/react, @testing-library/dom,
  @testing-library/jest-dom, @testing-library/user-event, jsdom
```

---

## 16. Error Recovery & Safety Nets

| Layer                      | Mechanism                                 | Purpose                                      |
| -------------------------- | ----------------------------------------- | -------------------------------------------- |
| **Test-Based QA**          | vitest run → JSON results                 | Objective, deterministic code validation     |
| **Test Self-Repair**       | LLM fixes crashed/bad tests               | Tests aren't sacred — fix or remove bad ones |
| **Component Self-Heal**    | Feed validation errors back → retry (3x)  | LLM sees its own mistakes                    |
| **Code Auto-Repair**       | Strip fences, trailing text, close braces | Fix common small-LLM output errors           |
| **Output Validation**      | Programmatic checks (export, return, JSX) | Catch invalid code before writing            |
| **Backup + Restore**       | Feedback backs up before modifying        | Never lose working code                      |
| **Deterministic Fallback** | Pre-pass draft as safety net              | Working baseline if LLM completely fails     |
| **Test Import Fix**        | Auto-detect export name → fix imports     | Tests work regardless of component name      |
| **LLM Parse Retry**        | Up to 2 parse retries per call            | Handle garbled TTM output                    |
| **Stuck State**            | User can retry/skip from UI               | Manual escape hatch                          |

---

## 17. Complete End-to-End Sequence

```
 1. User creates project with name + description + model
 2. User clicks "Run All"
 3. Ollama health check passes
 4. Scaffold created (starter Component.tsx)
 5. PM decomposes idea → 3-5 epics
 6. Reviewer filters epics
 7. User reviews and approves epics
 8. Manager breaks each epic → 2-3 features
 9. Vague/circular features rejected
10. Features deduplicated, capped at 8
11. ★ Test Writer generates Component.test.tsx from requirements
12. Developer writes Component.tsx (sequential, one requirement at a time)
13. Each step: auto-repair → validate → write only if valid
14. ★ Run vitest — fix failing tests one at a time (up to 8 rounds)
15. Holistic review (structural checks + LLM)
16. Iterative QA (LLM find-one-fix-one, up to 5 rounds)
17. Improver reviews for remaining bugs
18. Final consistency check
19. Project marked "done" → Component.tsx + Component.test.tsx
20. Preview: React CDN + Babel standalone renders in iframe
```
