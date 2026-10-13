# Llamaque

![Llamaque](public/llamaque.png)

An experiment in how far small local models can get building a small app when
the harness does most of the work. Describe a project in a sentence, and a
chain of narrow LLM agents plans it, writes the code, writes tests and runs QA,
all locally via Ollama.

It doesn't always work. Most of the code here isn't prompting, it's checking:
the TypeScript compiler, vitest, a headless browser render, and detectors for
truncated files, duplicate symbols and undefined identifiers. When a check
fails, the failure goes back to a model with the exact error, and it tries
again. If the output is still known to be broken at the end, the project
finishes as **review** instead of **done**, rather than handing you a build
that doesn't run.

Generated projects are typically a small single-page React + TypeScript app.

## Prerequisites

- [Node.js](https://nodejs.org) 20.9+ (required by Next.js 16)
- [Ollama](https://ollama.com) running locally

Pull a model:

```bash
ollama pull qwen2.5-coder:14b
```
NOTE: This model makes a 24GB M4 Pro pretty hot

Any model works. Smaller ones (3B-8B) are faster, larger ones produce better code.

## Setup

```bash
git clone https://github.com/Jjarrard/Llamaque.git
cd Llamaque
npm install
npx playwright install chromium   # optional: enables the browser render checks
npm run dev
```

Open http://localhost:3000.

## Usage

1. **Create a project** and give it a name and description
2. The pipeline runs through these stages:
   - **Architect**: decides which files to create, scaffolds them, and writes shared types
   - **Decompose**: breaks the idea into epics
   - **Breakdown**: breaks epics into features
   - **Execute**: writes the code, file by file in dependency order
   - **TDD**: writes tests against the code that now exists
   - **QA**: runs the tests and repairs failures, fixes problems one at a time,
     and renders the app in a headless browser to catch runtime errors
   - **Feedback**: describe changes and re-run
3. Click **Preview** to try the app, **Files** to browse the output, or
   **Download** to get a ZIP. The **Timeline** tab shows where the time went.

Run stages individually or retry any with the refresh button on the stage tracker.

## Configuration

Optional, in `.env.local`:

| variable                  | does                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `OLLAMA_BASE_URL`         | Ollama server (default `http://localhost:11434`)                                       |
| `OLLAMA_NUM_THREAD`       | cap CPU threads to keep the machine cooler (default: Ollama decides)                   |
| `LLAMAQUE_FALLBACK_MODEL` | a bigger model to try as a last resort when a file keeps failing, e.g. `qwen2.5-coder:32b` |

## Tech Stack

- **Next.js** (App Router, API Routes)
- **SQLite** via Drizzle ORM — persisted in `data/`
- **Ollama** — local LLM inference
- **CSS Modules** — no UI framework

The pipeline itself is in [`src/lib/pipeline/`](src/lib/pipeline/), one module
per stage; the agents it calls are in [`src/lib/agents/`](src/lib/agents/).

## Other Commands

```bash
npm run build       # production build
npm run test:unit   # Llamaque's own tests
npm test            # runs the tests generated for projects in output/
```

## Disclaimer

This software is provided as-is, without warranty of any kind. Use at your own risk.
