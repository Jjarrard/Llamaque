# Llamaque

![Llamaque](public/llamaque.png)

An AI pipeline that turns a one-line idea into working code. Describe a project, and a colony of LLM agents decomposes it into tasks, writes tests, implements code, and runs QA. All locally via Ollama.

## Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Ollama](https://ollama.com) running locally

Pull a model:

```bash
ollama pull qwen2.5-coder:14b
```

Any model works. Smaller ones (3B-8B) are faster, larger ones produce better code.

## Setup

```bash
cd llamaque
npm install --legacy-peer-deps
npm run dev
```

Open http://localhost:3000.

## Usage

1. **Create a project** and give it a name and description
2. The pipeline runs automatically through 7 stages:
   - **Architect**: decides what files to create
   - **Decompose**: breaks the idea into epics
   - **Breakdown**: breaks epics into tasks
   - **TDD**: generates test files
   - **Execute**: writes the code
   - **QA**: validates output quality
   - **Feedback**: describe changes and re-run
3. Click **Files** to browse output, or **Download** to get a ZIP

Run stages individually or retry any with the refresh button on the stage tracker.

## Tech Stack

- **Next.js** (App Router, API Routes)
- **SQLite** via Drizzle ORM — persisted in `data/`
- **Ollama** — local LLM inference
- **CSS Modules** — no UI framework

## Other Commands

```bash
npm run build   # production build
npm test        # run tests (vitest)
```
