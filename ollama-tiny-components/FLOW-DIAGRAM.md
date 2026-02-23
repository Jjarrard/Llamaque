# Ollama Tiny Tasks — Application Flow Diagram

> A complete logic flow of how the system takes a user's idea and turns it into a working HTML/CSS/JS application using small local LLMs.

---

## High-Level Pipeline Overview

```
User Idea → Decompose → Plan → Merge → Execute → Improve → Consistency → Output Files
```

The system generates exactly **3 files**: `index.html`, `style.css`, `script.js` — stored in `output/{projectId}/`.

---

## 1. Project Creation

```
User fills in form:
  - Project name (e.g. "Todo App")
  - Description (e.g. "A simple todo list with add, remove, complete")
  - Model selection (e.g. "qwen3:4b")
       │
       ▼
  30-second duplicate guard
  (same name within 30s returns existing project)
       │
       ▼
  Project record saved to SQLite
  Status: "pending"
       │
       ▼
  User lands on Project Page
  Sees: "Ready to start" status bar
```

---

## 2. Pipeline Startup

```
User clicks "Run All" (or individual stage button)
       │
       ▼
  Health check Ollama API
  Verify selected model is available
       │
       ├── Fail → Show error: "Ollama not available or model not loaded"
       │
       └── Pass ↓
              │
              ▼
        Pipeline starts in background (fire-and-forget)
        Project status → "running"
        SSE stream begins sending log entries to UI
              │
              ▼
        Create scaffold: output/{id}/
          - index.html  (basic HTML5 skeleton)
          - style.css   (empty with comment header)
          - script.js   (empty with comment header)
```

---

## 3. Phase 1: DECOMPOSE — Break Idea into Epics

```
Project Manager (PM) Agent
  Input:  project name + description
  Role:   "Break this idea into 3-5 high-level epics"
  Rules:  Each epic must be a CORE FEATURE, not files or tech details
  Output: Structured list of epics (>>BREAKDOWN block)
       │
       ├── Parse failure → Retry once
       │
       └── Success ↓
              │
              ▼
        Reviewer Agent
          Input:  Numbered list of PM's epics
          Role:   "Which epics are relevant? Remove duplicates/unrelated"
          Rule:   "When in doubt, KEEP"
          Output: List of numbers to keep, or "KEEP: ALL"
               │
               ├── Parse failure → Keep everything (safe default)
               │
               └── Filtered epics ↓
                      │
                      ▼
                Cap at 5 epics maximum
                      │
                      ▼
                Insert as depth-1 tasks
                Status: "awaiting_approval"
                      │
                      ▼
                Pipeline pauses → User reviews epics
                User can: ✓ Approve  ✕ Reject  or "Approve All"
```

**Example:** "Todo App" → Epics: "Task list display", "Add new tasks", "Mark tasks complete", "Delete tasks"

---

## 4. Phase 2: PLAN — Break Epics into File-Targeted Features

```
For each approved epic (depth 1, status "pending"):
       │
       ▼
  Set epic status → "decomposing"
       │
       ▼
  Manager Agent
    Input:  Epic description + project context
    Role:   "Break into 2-3 features, each targeting ONE file"
    Rule:   "The project has exactly 3 files: index.html, style.css, script.js"
    Rule:   "End each feature with 'in index.html' / 'in style.css' / 'in script.js'"
    Output: Structured feature list (>>BREAKDOWN block)
       │
       ├── Parse failure → Retry up to 2 times
       │
       ├── Returns >>READY at depth 1 → Force re-prompt
       │   (Epics MUST be broken down, never marked ready directly)
       │
       └── Success ↓
              │
              ▼
        Validate each subtask:
          isVagueOrCircular() check
            - Filters stop words, computes keyword overlap with parent
            - Rejects: "handle the rest", "finish up", circular descriptions
            - Allows narrower descriptions (< 75% parent length) even with overlap
            - Flags: same length as parent AND > 80% keyword overlap
               │
               ├── ALL subtasks rejected → Retry with stronger prompt
               │   └── Still all rejected → Mark epic as "stuck"
               │
               └── Valid subtasks ↓
                      │
                      ▼
                Cap at 3 features per epic
                      │
                      ▼
                Resolve file path for each feature:
                  Keyword heuristic:
                    CSS words → style.css  (style, color, font, grid, hover, etc.)
                    JS words  → script.js  (click, event, function, logic, toggle, etc.)
                    Default   → index.html
                      │
                      ▼
                Insert as depth-2 tasks, status "ready"
                Set epic status → "done"
```

---

## 5. Phase 3: MERGE — Deduplicate and Fill Gaps (No LLM)

This phase is entirely programmatic — no LLM calls.

```
Collect all depth-2 "ready" tasks
       │
       ▼
  Group by resolved file path
  (index.html group, style.css group, script.js group)
       │
       ▼
  Deduplicate within each group:
    - Normalize descriptions (lowercase, strip quotes)
    - Strip trailing "in index.html" / "in style.css" / "in script.js"
    - Compute word overlap between pairs
    - If overlap > 60% → drop the duplicate
       │
       ▼
  Apply per-file caps:
    - index.html: max 5 requirements
    - style.css:  max 4 requirements
    - script.js:  max 3 requirements
       │
       ▼
  Fill gaps (ensureBasicSpecs):
    - No HTML spec?  → Generate default HTML requirements from all features
    - No CSS spec?   → Generate styling requirements based on detected keywords
    - No JS spec but needs interactivity? → Generate JS requirements
       │
       ▼
  Result: File specs ready for execution
    { "index.html": [...requirements], "style.css": [...], "script.js": [...] }
```

---

## 6. Phase 4: EXECUTE — Generate Code (HTML → CSS → JS)

Files are processed in strict order: **HTML first, then CSS, then JS** — so each file can reference the previous ones.

### Sub-phase A: Deterministic Pre-Pass (No LLM)

```
For ALL files simultaneously:
       │
       ▼
  Compiler: requirements → operations
    Pattern-matches keywords in requirements to generate operations:
      - "form", "input"  → ensureHtmlElement (input, form, button)
      - "list"           → ensureHtmlElement (ul container)
      - "priority"       → ensureHtmlElement (select dropdown)
      - "style", "hover" → ensureCssRule (styling declarations)
      - "click", "add"   → ensureJsFunction (handler + state + render)
       │
       ▼
  Executor: operations → code
    Applies operations idempotently to file bundle:
      - HTML: Insert elements into parent by ID (regex-based)
      - CSS:  Merge rules (update existing declarations, add new)
      - JS:   Add functions/consts (skip if name already exists)
       │
       ▼
  Save as "deterministic draft" (fallback for if LLM fails)
  Write to output files
```

This guarantees a **working baseline** before any LLM touches the code. The deterministic compiler produces syntactically valid CRUD app code.

### Sub-phase B: Sequential LLM Enhancement

```
For each file (HTML → CSS → JS):
  For each requirement (one at a time):
       │
       ▼
    Mark corresponding task(s) → "executing"
       │
       ▼
    Build context:
      - Read current file content (includes previous steps' changes)
      - Read HTML context (for CSS/JS files)
      - Read CSS context (for JS files)
       │
       ▼
    Developer Agent
      If file has content:
        "ENHANCE the file, keep ALL existing code, add ONLY this feature: ..."
      If file is empty:
        "Write the complete file implementing this feature: ..."
      Includes file-specific rules:
        - HTML: "Include stylesheet/script links, use unique IDs"
        - CSS:  "Write ONLY CSS, keep existing rules, add more"
        - JS:   "Declare each function EXACTLY ONCE, no duplicates"
       │
       ├── Parse failure → Skip this step, mark tasks done
       │
       └── Got code output ↓
              │
              ▼
        Auto-Repair Pipeline:
          - JS/CSS: Auto-close unclosed braces/parens/brackets
          - HTML: Fix truncated charset (UTF- → UTF-8)
          - HTML: Move misplaced <script> to before </body>
          - HTML: Remove malformed closing tags
          - HTML: Fix self-closing block tags (<form/> → <form>)
          - HTML: Remove content after </html>
          - HTML: Auto-close unclosed block tags
          - JS:   Wrap unguarded top-level DOM bindings in DOMContentLoaded
              │
              ▼
        Validate (lenient mode, allows scaffolds):
          ✓ Not empty / too short
          ✓ Not echoing prompt template
          ✓ Not placeholder code ("// your code here", "// TODO")
          ✓ Per-file minimum requirements (size, tags, syntax)
          ✓ Not an instruction dump (model parroting system prompt)
          ✓ No content-type contamination (JS containing HTML, etc.)
          ✓ Balanced braces/brackets/parens
              │
              ├── Invalid → Discard, keep previous version, continue
              │
              └── Valid → Write to file, mark step tasks "done"
                          Next requirement sees updated file content
```

### Sub-phase C: Final QA (Per File)

```
Read final file content
       │
       ├── File still empty?
       │     ├── Use deterministic draft as fallback
       │     └── Still empty? → Mark all file tasks "stuck"
       │
       └── Has content ↓
              │
              ▼
        Full auto-repair pass
              │
              ▼
        Strict validation (no scaffold allowed):
          All checks from lenient mode, PLUS:
          ✓ JS scaffold detection (empty function bodies)
          ✓ CSS scaffold detection (only reset rules, no feature styling)
          ✓ Duplicate JS declarations (function/const/let/var)
          ✓ Excessive CSS selector duplication (same selector >4 times)
          ✓ HTML tag balance check
              │
              ├── JS duplicates found → removeDuplicateJsDeclarations()
              │   (strips second occurrence of top-level declarations)
              │
              ├── Valid → Mark all file tasks "done" ✓
              │
              └── Invalid → Enter retry logic...
```

---

## 7. Retry Logic (QA Failures)

```
Validation failed on a file
       │
       ▼
  Check failure type:
       │
       ├── Instruction dump? → Use deterministic fallback immediately
       │
       ├── CSS brace error? → Use deterministic fallback immediately
       │
       ├── JS duplicates (after 1+ retry)? → Use deterministic fallback
       │
       └── Other failure ↓
              │
              ▼
        retryCount < 2?
              │
              ├── Yes → Reset tasks to "ready" with qAReason
              │         Re-run entire executeSpec() for this file
              │         (Developer sees QA feedback on first step)
              │
              └── No (retries exhausted) ↓
                     │
                     ▼
               Try deterministic fallback one last time
                     │
                     ├── Fallback passes validation → Use it ✓
                     │
                     └── Fallback also fails → Mark tasks "stuck" ✗
                         (User can retry/skip/edit from UI)
```

The deterministic fallback (compiler-generated code) is always syntactically valid, making it a reliable safety net.

---

## 8. Phase 5: IMPROVE — Cross-File Bug Review

```
Read all 3 output files (HTML, CSS, JS)
       │
       ▼
  Improver Agent
    Input:  All 3 files + project description
    Role:   "Find cross-file bugs"
    Checks: Duplicate functions, placeholders, broken structure,
            invalid syntax, mismatched references, unnecessary code
    Output: List of fixes per file, or "NO_ISSUES"
       │
       ├── No issues → Skip, move on ✓
       │
       └── Issues found ↓
              │
              ▼
        Group fixes by file
        For each file with fixes:
              │
              ▼
          Developer Agent
            Input:  Current file + list of fixes to apply
            Output: Fixed file content
              │
              ▼
          Auto-repair → Validate
              │
              ├── Valid → Write updated file ✓
              │
              └── Invalid → Keep original file (don't make it worse)
```

---

## 9. Phase 6: CONSISTENCY — Cross-File Validation

```
Read all 3 output files
       │
       ▼
  Programmatic cross-file validation (no LLM):
    ✓ JS getElementById() targets exist in HTML
    ✓ JS querySelector() targets exist in HTML
    ✓ JS class references exist in HTML
    ✓ CSS ID selectors reference real HTML IDs
    ✓ HTML includes <link href="style.css">
    ✓ HTML includes <script src="script.js">
    ✓ If HTML has interactive elements → JS should have event listeners
    ✓ If JS has logic → HTML should have IDs/classes to target
       │
       ├── All pass → Done ✓
       │
       └── Errors found ↓
              │
              ▼
        Group errors by file
        For each file with errors:
              │
              ▼
          Developer Agent fixes → Auto-repair → Validate → Write if valid
              │
              ▼
        Project status → "done" (or "paused" if any tasks stuck)
```

---

## 10. LLM Communication Details

```
Every LLM call follows this pattern:

  Build system prompt (agent-specific)
  Build user message (task-specific)
       │
       ▼
  callOllama(model, role, systemPrompt, userMessage)
       │
       ▼
  Hardening for small models:
    - Prefill trick: inject { role: "assistant", content: ">>" }
      (Forces model to start in structured output mode)
    - Stop sequence: ">>END" (prevents rambling)
    - Low temperature (0 for most agents, 0.3 for PM)
    - Fixed context window: 4096 tokens
    - Per-agent token limits (100-600 depending on role)
    - 30-minute keep-alive (model stays loaded between calls)
       │
       ▼
  Parse response using TTM (TinyTask Markup):
    Regex extracts: >>COMMAND\nkey: value\n>>END blocks
    Fuzzy matching (case-insensitive, handles missing >>END)
    Handles prefill consuming the ">>" prefix
       │
       ├── Parse success → Return structured data
       │
       └── Parse failure → Retry (up to MAX_PARSE_RETRIES = 2)
```

---

## 11. Task Tree Structure

```
Project
  └── Depth 0: Root (implicit)
        └── Depth 1: Epics (3-5 high-level features)
              │   Status flow: awaiting_approval → pending → decomposing → done
              │
              └── Depth 2: Features (2-3 per epic, file-targeted)
                    Status flow: pending → ready → executing → qa_check → done
                                                             → editing → done
                                                             → stuck (terminal)
```

### Task Status Transitions

```
awaiting_approval ──[user approves]──→ pending
pending           ──[breakdown starts]──→ decomposing
decomposing       ──[subtasks created]──→ done (epic itself)
pending           ──[auto at max depth]──→ ready
ready             ──[execute starts]──→ executing
executing         ──[code generated]──→ done
executing         ──[QA failure]──→ ready (retry)
executing         ──[max retries]──→ stuck
stuck             ──[user retries]──→ ready
stuck             ──[user skips]──→ done
```

---

## 12. UI Data Flow

```
                    ┌──────────────────────┐
                    │   Project Page (UI)   │
                    └──────┬───────────────┘
                           │
              ┌────────────┼────────────────┐
              │            │                │
              ▼            ▼                ▼
        SSE Stream    HTTP Polling     User Actions
        (live logs)   (task status     (run, stop, approve,
         via          every 5s         reject, retry, skip,
         EventSource  while running)   delete, re-run stage)
              │            │                │
              └────────────┼────────────────┘
                           │
                           ▼
                    Status Bar derives
                    current state from
                    task statuses:
                      - "Ready to start"
                      - "Decomposing..."
                      - "Executing — {task}..."
                      - "QA checking..."
                      - "Editing — fixing..."
                      - "X tasks stuck"
                      - "Paused — X/Y done"
                      - "Complete"
```

---

## 13. Error Recovery & Safety Nets

| Layer                      | Mechanism                                                   | Purpose                                        |
| -------------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| **LLM Parse**              | Parse retry (2x)                                            | Handle garbled TTM output                      |
| **Vague Detection**        | isVagueOrCircular()                                         | Prevent circular task decomposition            |
| **Auto-Repair**            | Brace closing, script relocation, charset fix, DOM wrapping | Fix common small-LLM output errors             |
| **Validation**             | Programmatic checks (not LLM)                               | Catch invalid code before writing              |
| **Deterministic Fallback** | Compiler → Executor                                         | Guaranteed working baseline if LLM fails       |
| **QA Retry**               | Re-execute with feedback (2x)                               | Give LLM another chance with error info        |
| **Stuck State**            | User intervention                                           | Manual retry/skip/edit for unrecoverable tasks |
| **Validate-Before-Write**  | Every LLM output checked                                    | Never overwrite good code with bad code        |
| **Cross-File Consistency** | Programmatic reference checks                               | Catch broken ID/class references across files  |

---

## 14. Complete End-to-End Sequence

```
1.  User creates project with name + description
2.  User clicks "Run All"
3.  Ollama health check passes
4.  Scaffold created (3 empty files)
5.  PM agent decomposes idea into 3-5 epics
6.  Reviewer agent filters epics
7.  User reviews and approves epics
8.  Manager agent breaks each epic into 2-3 file-targeted features
9.  Vague/circular features rejected
10. Features grouped by file, deduplicated, capped
11. Gap-filling adds missing file specs
12. Deterministic compiler generates baseline code for all files
13. LLM enhances HTML (one requirement at a time, accumulating)
14. LLM enhances CSS (with HTML context, one requirement at a time)
15. LLM enhances JS  (with HTML+CSS context, one requirement at a time)
16. Each step: auto-repair → validate → write only if valid
17. Final QA per file (strict validation + retry up to 2x)
18. Fallback to deterministic code if LLM repeatedly fails
19. Improver agent reviews all 3 files for cross-file bugs
20. Developer fixes any issues found
21. Programmatic cross-file consistency check
22. Developer fixes any reference mismatches
23. Project marked "done" → 3 working output files
```
