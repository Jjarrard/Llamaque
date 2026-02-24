# Ollama Tiny Tasks

A recursive task decomposition system with a simple web UI. Users describe an idea, and a pipeline of LLM-powered agents breaks it down into tiny, executable tasks — small enough for a small language model to implement one at a time.

## How It Works

1. **User inputs** a project name + description via the UI
2. **Project Manager** agent breaks the idea into high-level epics
3. **Manager** agent breaks each epic into smaller tasks
4. **Developer** agent executes tiny tasks by calling the Ollama API
5. **QA** agent validates each completed task

Each breakdown step asks Ollama: _"Is this task small enough to execute directly, or does it need further decomposition?"_ — using a structured protocol (see below).

## Architecture

```
┌─────────────┐
│   Web UI    │  (Name + describe idea)
└──────┬──────┘
       │
       ▼
┌─────────────────┐
│ Project Manager  │  Breaks idea → epics
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│    Manager       │  Breaks epics → tasks (recursive until tiny)
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│   Developer      │  Executes tiny tasks via Ollama API
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│      QA          │  Validates output of each task
└─────────────────┘
```

## Tech Stack

| Layer    | Tech                                |
| -------- | ----------------------------------- |
| Frontend | Next.js (React, App Router)         |
| Backend  | Next.js API Routes (Route Handlers) |
| LLM      | Ollama (local, any model)           |
| State    | SQLite via Drizzle ORM              |
| Styling  | CSS Modules                         |

## Design Constraints: Small LLMs Are Dumb

This system is designed to work with small, local language models (e.g. 1B-8B params). These models are:

- **Easily confused** by long prompts or multi-step instructions
- **Bad at holding context** — they forget what they were doing
- **Prone to rambling** if not tightly constrained
- **Decent at one tiny thing at a time** if you spell it out clearly

So every design decision follows from this:

| Principle                  | Rule                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Short prompts**          | Every agent prompt is ≤5 sentences. Include ONE short example of expected TTM output.                                                        |
| **Minimal context window** | Only send what's needed for the current task. Never dump the whole project.                                                                  |
| **One job per call**       | Each LLM call does exactly one thing: break down, execute, or validate.                                                                      |
| **Structured output**      | TTM blocks are simple enough that even a bad model can produce them.                                                                         |
| **Summariser agent**       | Compresses prior context so downstream agents get a tight summary, not a full history.                                                       |
| **Vanilla output only**    | LLM-generated code must be plain HTML, JS, and CSS. No frameworks, no Node, no build tools. Small LLMs can't handle framework APIs reliably. |

### Hardening Against Small LLM Failures

| Problem                               | Mitigation                                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Preamble junk** ("Sure! Here's...") | Prefill the assistant response with `>>` so the model starts mid-format. Strip everything outside TTM blocks.               |
| **Malformed TTM blocks**              | Fuzzy parser that recovers from minor errors — missing `>>END`, extra whitespace, trailing text. Separate from QA failures. |
| **Model rambles past the block**      | Use `>>END` as a **stop sequence** in the Ollama API call so generation halts immediately.                                  |
| **Temperature drift**                 | Force `temperature: 0` for all agents except PM (where slight creativity helps for decomposition).                          |
| **Token waste**                       | Set `num_predict` (max output tokens) per role: PM=300, Manager=200, Developer=500, QA=150, Summariser=100.                 |
| **Total parse failure**               | If no valid TTM block found, auto-retry twice with a simpler rephrasing prompt before marking STUCK.                        |
| **Model too weak**                    | If a task is STUCK with the configured model, optionally escalate to a larger model before giving up.                       |
| **Recursion bomb**                    | Max decomposition depth of 4 levels. Global task cap of 50 per project. Exceeding either halts and asks the user.           |
| **Circular / vague tasks**            | System checks child tasks against parent — if >60% keyword overlap, reject and re-prompt. Catches "handle the rest" loops.  |
| **Crash mid-pipeline**                | Every task status is persisted to SQLite before the next step. On restart, resume from the first non-completed task.        |
| **Fragment assembly**                 | Tasks specify a `filePath` and `section` so outputs get written to the right file in the right order.                       |

## Roles

### Project Manager

- Receives the raw idea from the user
- Produces 3-7 high-level epics
- Decides project structure and ordering

### Manager

- Receives an epic or task
- Evaluates size: can a small LLM do this in one shot?
- If NO → breaks it down further (recursive)
- If YES → marks it as `READY` for the Developer

### Developer

- Receives `READY` tasks one at a time
- Sends each to Ollama with a focused prompt
- Stores the result (code, text, config, etc.)

### QA

- Receives a completed task + its output
- Asks Ollama to validate: does the output satisfy the task?
- Marks task `PASS` or `FAIL` (failures go back to Developer)

### Summariser

- Sits between agents to compress context
- Takes completed task outputs and produces a 1-3 sentence summary
- Ensures downstream agents never receive more context than they need
- Keeps the effective context window as small as possible
- Example: after 5 tasks complete, the Developer doesn't see all 5 outputs — it sees the Summariser's compressed version

### Editor

- Handles surgical fixes to existing files when QA finds issues
- Never sees the full file — only a small window of lines around the problem area
- Receives: the file path, the problem description, and ~20 lines of context
- Produces a `>>EDIT` block specifying exact line replacements
- This avoids the small LLM having to comprehend or regenerate an entire file

## The Protocol: TinyTask Markup (TTM)

A minimal structured language the LLM uses in its responses so the system can parse decisions deterministically.

### Commands

```
>>BREAKDOWN
- task: "Short description of subtask"
- task: "Another subtask"
- task: "One more"
>>END

>>READY
task: "Exact task description"
>>END

>>EXECUTE
task: "Task to perform"
context: "Any relevant context or prior output"
>>END

>>RESULT
status: DONE
output: |
  (the actual output here — code, text, etc.)
>>END

>>QA
task: "What was asked"
output: |
  (what was produced)
verdict: PASS | FAIL
reason: "Why it passed or failed"
>>END

>>EDIT
filePath: "path/to/file.js"
startLine: 12
endLine: 14
replace: |
  (corrected lines)
>>END
```

### Flow Logic (pseudocode)

```
function process(task, depth=0):
    if depth > MAX_DEPTH(4) or total_tasks > MAX_TASKS(50):
        mark task as STUCK("depth/task limit")
        return

    response = ollama.ask(Manager, "Is this small enough? Reply with >>READY or >>BREAKDOWN")

    if response contains >>BREAKDOWN:
        subtasks = parse_subtasks(response)
        if any subtask overlaps parent by >60%:
            retry with "Subtask too similar to parent. Break it into DIFFERENT smaller steps."
        for each subtask:
            process(subtask, depth+1)    # recurse

    elif response contains >>READY:
        result = ollama.ask(Developer, ">>EXECUTE task...")
        qa = ollama.ask(QA, ">>QA task... output...")

        if qa.verdict == FAIL:
            edit = ollama.ask(Editor, "fix lines X-Y, problem: ...")
            apply_edit(edit)         # surgical patch
            re-run QA
            if still FAIL after 2 edits:
                re-run Developer from scratch (max 3x total)

        summarise completed work for next task's context
```

## Project Structure

```
ollama-tiny-tasks/
├── README.md
├── PROTOCOL.md
├── package.json
├── next.config.js
├── tsconfig.json
├── drizzle.config.ts
├── src/
│   ├── db/
│   │   ├── schema.ts             # Drizzle schema (Project, Task)
│   │   └── index.ts              # Drizzle client + connection
├── src/
│   ├── app/
│   │   ├── layout.tsx            # Root layout
│   │   ├── page.tsx              # Home page (project list + create)
│   │   ├── projects/
│   │   │   └── [id]/
│   │   │       └── page.tsx      # Project detail (task tree + log)
│   │   └── api/
│   │       ├── projects/
│   │       │   ├── route.ts      # GET list, POST create
│   │       │   └── [id]/
│   │       │       ├── route.ts  # GET project detail
│   │       │       └── run/
│   │       │           └── route.ts  # POST start pipeline
│   │       └── tasks/
│   │           └── [id]/
│   │               └── route.ts  # GET task detail
│   ├── lib/
│   │   ├── ollama.ts             # Ollama API wrapper
│   │   ├── protocol.ts           # TTM parser
│   │   └── agents/
│   │       ├── project-manager.ts
│   │       ├── manager.ts
│   │       ├── developer.ts
│   │       ├── qa.ts
│   │       ├── summariser.ts
│   │       └── editor.ts
│   └── components/
│       ├── ProjectForm.tsx       # Name + description form
│       ├── TaskTree.tsx          # Recursive task tree display
│       └── LogPanel.tsx          # Live log output
└── __tests__/
    └── protocol.test.ts          # TTM parsing tests
```

## API Endpoints

| Method | Path                        | Description                                           |
| ------ | --------------------------- | ----------------------------------------------------- |
| POST   | `/api/projects`             | Create a new project (name + desc)                    |
| GET    | `/api/projects`             | List all projects                                     |
| GET    | `/api/projects/{id}`        | Get project with full task tree                       |
| POST   | `/api/projects/{id}/run`    | Start the decomposition pipeline                      |
| GET    | `/api/projects/{id}/run`    | Resume a stopped/crashed pipeline                     |
| GET    | `/api/tasks/{id}`           | Get a single task + status                            |
| GET    | `/api/projects/{id}/stream` | SSE stream of live pipeline events                    |
| PATCH  | `/api/tasks/{id}`           | User intervention (edit, skip, provide output, split) |

## UI Wireframe

```
┌──────────────────────────────────────────────┐
│  Ollama Tiny Tasks                           │
├──────────────────────────────────────────────┤
│                                              │
│  Project Name: [__________________________]  │
│  Description:  [__________________________]  │
│                [__________________________]  │
│                [__________________________]  │
│                                              │
│  [Break It Down]                             │
│                                              │
├──────────────────────────────────────────────┤
│  Task Tree:                                  │
│                                              │
│  ▼ Epic 1: Set up project structure          │
│    ▼ Task 1.1: Create directory layout  ✅   │
│    ▼ Task 1.2: Write config file        ✅   │
│    ► Task 1.3: Initialize database      🔄   │
│  ► Epic 2: Build API layer              ⏳   │
│  ► Epic 3: Create frontend              ⏳   │
│                                              │
│  Stuck Tasks:                                │
│  ⚠ Task 2.3: Parse config     [Edit] [Skip] │
│                               [Provide] [Split]│
│                                              │
│  Log:                                        │
│  [PM] Breaking down idea into 3 epics...     │
│  [MGR] Epic 1 needs 3 subtasks               │
│  [DEV] Executing Task 1.1...                 │
│  [QA] Task 1.1 → PASS                       │
│                                              │
└──────────────────────────────────────────────┘
```

## Getting Started

```bash
# Install dependencies
npm install

# Set up the database
npx drizzle-kit push

# Make sure Ollama is running
ollama serve

# Run the dev server
npm run dev
```

Then open `http://localhost:3000` in your browser.
