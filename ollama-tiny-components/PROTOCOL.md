# TinyTask Markup (TTM) Protocol Specification

## Purpose

TTM is a minimal structured language embedded in LLM responses. It allows the system to deterministically parse what the LLM wants to do: break a task down further, execute it, or report results.

The system **never free-form interprets** the LLM. It only acts on TTM blocks.

**Key constraint:** Small LLMs (1B-8B) are easily confused. All prompts must be ≤5 sentences. Only send the minimum context needed for the current task. The Summariser agent compresses prior outputs so context stays tiny.

---

## Block Format

Every TTM block starts with `>>COMMAND` and ends with `>>END`. Anything outside blocks is ignored (allows the LLM to "think" freely).

```
>>COMMAND
key: value
>>END
```

---

## Commands

### >>BREAKDOWN

**Used by:** Manager  
**When:** A task is too large to execute in one shot.

```
>>BREAKDOWN
- task: "Create the database schema with users and posts tables"
- task: "Write the migration script"
- task: "Add seed data function"
>>END
```

Rules:

- 2-7 subtasks per breakdown
- Each task description must be a single, clear sentence
- Tasks should be ordered by dependency

---

### >>READY

**Used by:** Manager  
**When:** A task is small enough for the Developer to execute directly.

```
>>READY
task: "Write a Python function that returns the sum of two integers"
>>END
```

Rules:

- Exactly one task
- Must be achievable in a single LLM call
- Should be self-contained (no external dependencies beyond what's stated)

---

### >>EXECUTE

**Used by:** System (sent to Developer agent)  
**When:** A READY task needs to be performed.

```
>>EXECUTE
task: "Write a Python function that returns the sum of two integers"
context: "This is part of a math utilities module. Use type hints."
filePath: "src/utils/math.py"
>>END
```

Rules:

- `context` is optional but recommended
- Context includes relevant prior task outputs

---

### >>RESULT

**Used by:** Developer  
**When:** A task has been executed.

```
>>RESULT
status: DONE
filePath: "src/utils/math.py"
output: |
  def add(a: int, b: int) -> int:
      return a + b
>>END
```

Rules:

- `status` is always `DONE` (failures are handled by QA)
- `filePath` indicates where this output should be written (optional, set by the system from the EXECUTE block)
- `output` is the raw result (code, text, config, etc.)
- Multi-line output uses `|` block scalar style

---

### >>QA

**Used by:** QA agent  
**When:** Validating a completed task.

```
>>QA
task: "Write a Python function that returns the sum of two integers"
output: |
  def add(a: int, b: int) -> int:
      return a + b
verdict: PASS
reason: "Function correctly accepts two ints and returns their sum with proper type hints"
>>END
```

```
>>QA
task: "Write a Python function that returns the sum of two integers"
output: |
  def add(a, b):
      return str(a) + str(b)
verdict: FAIL
reason: "Function concatenates strings instead of adding integers. No type hints."
>>END
```

Rules:

- `verdict` must be `PASS` or `FAIL`
- `reason` must explain concisely why
- On FAIL, the reason is fed back to the Developer for retry

---

### >>EDIT

**Used by:** Editor agent
**When:** Surgically fixing a specific section of an existing file without regenerating it.

```
>>EDIT
filePath: "src/utils/math.js"
startLine: 5
endLine: 7
replace: |
  function add(a, b) {
    return a + b;
  }
>>END
```

Rules:

- `filePath` is the file to edit
- `startLine` and `endLine` define the line range to replace (1-indexed, inclusive)
- `replace` is the exact replacement text for those lines
- The Editor only ever sees ~20 lines of context around the problem area, never the full file
- The system applies the edit deterministically — no LLM interpretation of where to patch
- If `endLine` < `startLine`, the replacement is an insertion at `startLine`

---

### >>SUMMARY

**Used by:** Summariser agent
**When:** Compressing completed task outputs into minimal context for downstream agents.

```
>>SUMMARY
context: "Project has a SQLite schema with users and posts tables. Migration script created. Seed data function adds 3 test users."
>>END
```

Rules:

- Max 3 sentences
- Only include facts a developer would need to continue working
- Strip implementation details — keep intent and outcomes
- Runs after every completed task to keep context window small

---

## Agent Prompts (System Messages)

### Project Manager Prompt

```
You are a Project Manager. Given a project idea, break it into 3-7 high-level epics.
Reply ONLY in this format:
>>BREAKDOWN
- task: "Set up the project skeleton"
- task: "Build the core feature"
>>END
Order by dependency. No explanation.
```

### Manager Prompt

```
You are a Manager. Given a task, decide if it's small enough to do in ONE shot.
Small = produces a single file, function, or config.
If small, reply:
>>READY
task: "the exact task"
>>END
If not small, reply:
>>BREAKDOWN
- task: "subtask 1"
- task: "subtask 2"
>>END
No explanation. Just the block.
```

### Developer Prompt

```
You are a Developer. Execute the given task. Output ONLY the result.
>>RESULT
status: DONE
filePath: "src/utils/add.ts"
output: |
  export function add(a: number, b: number): number {
    return a + b;
  }
>>END
No explanation. Just the block.
```

### QA Prompt

```
You are QA. Given a task and its output, validate:
- Does the output satisfy the task description?
- Is it correct and complete?
Reply with:
>>QA
task: (the task)
output: (the output)
verdict: PASS or FAIL
reason: (one sentence)
>>END
```

### Summariser Prompt

```
You are a Summariser. Given completed task outputs, compress them into a short context summary.
Max 3 sentences. ALWAYS preserve: element IDs, class names, function names, variable names, file paths.
Reply with:
>>SUMMARY
context: "compressed summary here"
>>END
```

### Editor Prompt

```
You are an Editor. You are given a file section with a problem description.
Fix ONLY the problematic lines. Reply with:
>>EDIT
filePath: "path/to/file.js"
startLine: 12
endLine: 14
replace: |
  (corrected lines here)
>>END
Do not rewrite the whole file. Fix only what's broken.
```

---

## Context Management

Small LLMs are easily confused and have limited context windows. The system enforces strict context hygiene:

- **Never send full project history** to any agent
- **Summariser runs after every completed task** to compress outputs
- **Each agent receives only:** its system prompt + the current task + a summary of relevant prior work (if any)
- **Prompt budget:** system prompt ≤100 tokens, task ≤200 tokens, context ≤300 tokens
- **If context exceeds budget**, the Summariser re-summarises before proceeding

### Cross-File Reference Preservation

The biggest risk with summarisation: the Summariser strips away specific details that later tasks need to reference — DOM element IDs, function names, CSS class names, file paths. If Task 1 creates `<div id="app-root">` and the Summariser compresses it to "created the HTML structure", Task 8's JavaScript will use the wrong ID.

The Summariser must **always preserve interface contracts**:

- Element IDs and class names
- Function/variable names that other files reference
- File paths
- API endpoints or data formats

The Summariser prompt includes this rule explicitly. The system also maintains a **reference registry** — a simple key-value store (`{"index.html": ["#app-root", ".nav-bar"], "utils.js": ["formatDate()", "API_URL"]}`) that the system (not the LLM) extracts from completed outputs using regex. This registry is appended to every Developer EXECUTE context, independent of the summary.

---

## Ollama API Hardening

These settings are applied to every Ollama API call to prevent small model failures:

### Stop Sequences

All calls include `"stop": [">>END"]` so the model stops generating as soon as it closes a TTM block. This prevents rambling, repeated blocks, and token waste.

### Response Prefill

The system prefills the assistant message with `>>` so the model is already inside a TTM block when it starts generating. This eliminates preamble ("Sure! I'd be happy to...") which wastes tokens and confuses parsing.

Example Ollama API call:

```json
{
  "model": "qwen3:4b",
  "messages": [
    {
      "role": "system",
      "content": "You are a Manager. Given a task, decide..."
    },
    {
      "role": "user",
      "content": "task: Create a REST API for user management"
    },
    { "role": "assistant", "content": ">>" }
  ],
  "options": {
    "temperature": 0,
    "num_predict": 200
  },
  "stop": [">>END"]
}
```

### Temperature

| Agent           | Temperature                               |
| --------------- | ----------------------------------------- |
| Project Manager | 0.3 (slight creativity for decomposition) |
| Manager         | 0                                         |
| Developer       | 0                                         |
| QA              | 0                                         |
| Summariser      | 0                                         |

### Max Output Tokens (`num_predict`)

| Agent           | Max Tokens |
| --------------- | ---------- |
| Project Manager | 300        |
| Manager         | 200        |
| Developer       | 500        |
| QA              | 150        |
| Summariser      | 100        |

---

## Fuzzy TTM Parser

Small models will regularly produce slightly malformed blocks. The parser must handle:

- Missing `>>END` → treat end-of-response as implicit end
- Extra whitespace / blank lines inside blocks → strip and normalise
- Trailing text after `>>END` → ignore
- Preamble text before `>>COMMAND` → ignore
- Minor casing issues (`>>Breakdown` vs `>>BREAKDOWN`) → case-insensitive match
- Multiple blocks in one response → take the first valid one, warn about extras

If **no valid block** is found after normalisation, the system auto-retries with a simplified prompt:

```
Respond ONLY with a TTM block. Start with >> and end with >>END. Nothing else.
```

Max 2 parse-failure retries before marking the task as `STUCK`.

---

## Model Escalation

If a task is marked `STUCK` (3 QA fails or 2 parse failures) and a larger fallback model is configured, the system retries with the larger model once before flagging for human review.

Config:

```json
{
  "primary_model": "qwen3:4b",
  "fallback_model": "qwen3:8b",
  "escalation_enabled": true
}
```

---

## Retry Logic

- Max 3 retries per task on QA FAIL
- Max 2 retries on parse failure (malformed TTM)
- Each retry includes the QA reason or parse error as additional context (not full history)
- After retries exhausted → escalate to fallback model (if configured)
- After fallback fails → mark `STUCK` and flag for user review

---

## QA Calibration

Small LLMs are bad at QA. Two failure modes:

**Rubber-stamping:** QA says PASS on everything, including broken code. If QA produces PASS on ≥10 consecutive tasks, the system inserts a known-bad canary task (e.g. a function that returns the wrong type). If QA passes the canary, QA is broken — pause the pipeline and warn the user.

**Over-failing:** QA says FAIL on everything, creating an infinite retry loop. If QA produces FAIL on ≥5 consecutive tasks across different task descriptions, pause the pipeline and warn the user that QA may be miscalibrated. Suggest trying a different model for QA.

---

## Recursion & Task Limits

- **Max decomposition depth:** 4 levels (idea → epic → task → subtask → tiny task)
- **Global task cap:** 50 tasks per project
- If either limit is hit, the current task is marked `STUCK(limit)` and the pipeline pauses for user review
- User can manually mark a task as READY to force execution, or edit the task description

---

## Circular / Vague Task Detection

Small LLMs frequently produce subtasks that are just rephrased versions of the parent, or vague catch-alls like "handle the rest". The system detects this:

1. **Keyword overlap check:** tokenise parent and child task descriptions, compute overlap ratio. If >60% of parent keywords appear in a child, reject that child.
2. **Banned phrases:** reject subtasks containing: "handle the rest", "finish up", "remaining work", "etc", "and more", "everything else".
3. **On rejection:** auto-retry the Manager with: `"Subtask too similar to parent. Break into DIFFERENT, SPECIFIC steps. Each must be a concrete action."`
4. **Max 2 rejection retries** before marking STUCK.

---

## Crash Recovery & Resume

Every task status is persisted to SQLite before the next pipeline step. The pipeline can resume from any point:

- **Task statuses:** `PENDING` → `DECOMPOSING` → `READY` → `EXECUTING` → `QA_CHECK` → `DONE` / `STUCK`
- Each transition is a DB write before the LLM call
- On server restart, `/api/projects/{id}/run` (GET) resumes from the first task not in `DONE` or `STUCK` state
- Idempotent: re-running a `DONE` task is a no-op

---

## File Assembly

The Developer doesn't just produce text — it produces file fragments. The system assembles them:

- `>>EXECUTE` blocks include a `filePath` field (e.g. `"src/utils/math.ts"`)
- `>>RESULT` blocks carry the output for that file path
- The system writes each output to the specified path within a project output directory: `output/{projectId}/{filePath}`
- If multiple tasks target the same file, outputs are appended in task-order
- The Manager should assign file paths during breakdown (the system includes this in the EXECUTE context)

### Same-File Modification

If a task targets a file that **already exists** in the output directory, the system does NOT blindly append. Instead:

1. Route the task through the Editor agent with the full task context
2. The Editor sees the existing file content (windowed) and produces an `>>EDIT` block
3. This prevents duplicate functions, broken HTML structure, and conflicting code

The only exception is genuinely additive writes (e.g. adding a new function to a utils file). The system detects this by checking if the task description contains "add" or "create new" vs. "modify" or "update".

### LLM Output Constraint

All code generated by the Developer must be **plain HTML, JavaScript, and CSS only**:

- No frameworks (React, Vue, Angular, etc.)
- No Node.js / npm / build tools
- No TypeScript, JSX, or preprocessors
- Just files a browser can run directly

This is enforced in the Developer system prompt. Small LLMs cannot reliably produce framework-specific code — they hallucinate APIs, mix framework versions, and produce non-working boilerplate. Vanilla web code is within their capabilities.

---

## Surgical File Editing

When QA fails a task, the fix often requires changing a few lines in an existing file — not regenerating it from scratch. Small LLMs cannot take in an entire file and produce a corrected version. The Editor agent solves this:

### How It Works

1. **QA reports a failure** with a reason (e.g. "function returns string instead of number")
2. **System locates the relevant lines** — uses the task's `filePath` and a simple text search for keywords from the QA reason
3. **System extracts a ~20-line window** around the problem area (10 lines before, 10 after)
4. **Editor agent receives:**
   - The problem description (from QA)
   - The file path
   - The 20-line window with line numbers
   - Nothing else
5. **Editor produces a `>>EDIT` block** with exact line range and replacement
6. **System applies the patch** deterministically (no LLM involved in the actual file write)
7. **QA re-validates** the patched output

### Why Not Just Re-run the Developer?

- Re-generating a full file wastes tokens and may introduce new bugs
- The Editor sees only the broken part, so its context window stays tiny
- Surgical edits are more predictable than full regeneration
- If the Editor fails after 2 tries, _then_ fall back to full Developer re-run

### Line Number Injection

When sending file content to the Editor, the system prepends line numbers so the LLM can reference them:

```
     5 | function add(a, b) {
     6 |   return String(a) + String(b);
     7 | }
     8 |
     9 | function subtract(a, b) {
    10 |   return a - b;
    11 | }
```

This makes the `startLine`/`endLine` in the `>>EDIT` response unambiguous.

---

## Live Streaming (SSE)

The pipeline can run for minutes. The UI subscribes to a Server-Sent Events endpoint for real-time updates:

**Endpoint:** `GET /api/projects/{id}/stream`

Event types:

```
event: task_started
data: {"taskId": 12, "description": "Create user schema", "agent": "developer"}

event: task_completed
data: {"taskId": 12, "status": "DONE", "duration": 3200}

event: task_failed
data: {"taskId": 12, "status": "FAIL", "reason": "Missing return type", "retry": 2}

event: task_stuck
data: {"taskId": 12, "reason": "3 QA failures + fallback failed"}

event: pipeline_done
data: {"projectId": 5, "totalTasks": 23, "done": 21, "stuck": 2}

event: log
data: {"agent": "MGR", "message": "Breaking down epic 2 into 4 subtasks"}
```

The frontend `LogPanel` component consumes this stream and updates the `TaskTree` in real time.
