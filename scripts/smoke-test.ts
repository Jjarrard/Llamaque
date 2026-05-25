/**
 * Smoke-test runner — drives a project through the full pipeline and shows
 * everything that happens.
 *
 * Usage (from the llamaque/ root):
 *
 *   npm run smoke
 *   # or directly:
 *   npx tsx --tsconfig tsconfig.json scripts/smoke-test.ts
 *
 * Options:
 *   --model     <string>   Ollama model (default: qwen3:1.7b)
 *   --stage     <string>   Pipeline stage to run (default: all)
 *   --feedback  <string>   Run a feedback pass after the main stage
 *   --desc      <string>   Project description
 *   --keep                 Keep the project + output in the DB after the run
 *
 * Examples:
 *   # Full run with default counter-app description
 *   npm run smoke
 *
 *   # Only the architect stage, then keep for inspection
 *   npm run smoke -- --stage architect --keep
 *
 *   # Full run + feedback pass
 *   npm run smoke -- --feedback "rename the + button to Increment"
 *
 *   # Custom project, keep to open in browser
 *   npm run smoke -- --keep \
 *     --desc "A React todo list with add, complete, and delete"
 */

import path from "path";
import fs from "fs";
import readline from "readline";

// Load .env.local so OLLAMA_NUM_THREAD and other vars are available when
// running via `npm run smoke` (tsx doesn't load .env.local automatically).
const envLocalPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envLocalPath)) {
  for (const line of fs.readFileSync(envLocalPath, "utf-8").split("\n")) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match && !(match[1] in process.env)) {
      process.env[match[1]] = match[2];
    }
  }
}

import { db } from "@/db";
import { projects } from "@/db/schema";
import { Pipeline, type PipelineStage } from "@/lib/pipeline";
import { getAvailableModels } from "@/lib/ollama";
import { eq } from "drizzle-orm";

// ── CLI args ──────────────────────────────────────────────────────────────────
function argStr(flag: string, fallback = ""): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1]
    ? (process.argv[i + 1] as string)
    : fallback;
}
function argFlag(f: string): boolean {
  return process.argv.includes(f);
}

// ── Colours ───────────────────────────────────────────────────────────────────
const R = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";

/** Interactive arrow-key picker. Returns the chosen item. */
async function pickFromList(prompt: string, items: string[]): Promise<string> {
  if (items.length === 0) throw new Error("No items to pick from");
  if (items.length === 1) {
    process.stdout.write(`${prompt} ${BOLD}${items[0]}${R} (only option)\n`);
    return items[0];
  }

  const rl = readline.createInterface({ input: process.stdin });
  let idx = 0;

  function render() {
    // Move cursor up by the number of lines we printed last time.
    process.stdout.write(`\x1b[${items.length + 1}A`);
    process.stdout.write(`${BOLD}${prompt}${R} (↑↓ select, Enter confirm)\n`);
    for (let i = 0; i < items.length; i++) {
      const cursor = i === idx ? `${GREEN}▶ ${R}` : "  ";
      process.stdout.write(`${cursor}${items[i]}\n`);
    }
  }

  // Print initial list.
  process.stdout.write(`${BOLD}${prompt}${R} (↑↓ select, Enter confirm)\n`);
  for (let i = 0; i < items.length; i++) {
    const cursor = i === idx ? `${GREEN}▶ ${R}` : "  ";
    process.stdout.write(`${cursor}${items[i]}\n`);
  }

  return new Promise((resolve) => {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (buf: Buffer) => {
      const key = buf.toString();
      if (key === "\x1b[A") {
        idx = (idx - 1 + items.length) % items.length;
        render();
      } else if (key === "\x1b[B") {
        idx = (idx + 1) % items.length;
        render();
      } else if (key === "\r" || key === "\n") {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.pause();
        rl.close();
        process.stdout.write(`\n  Selected: ${BOLD}${items[idx]}${R}\n`);
        resolve(items[idx]);
      } else if (key === "\x03") {
        // Ctrl-C
        process.exit(1);
      }
    });
  });
}

const LIST_MODELS = argFlag("--list-models");
const MODEL_ARG = argStr("--model");
const STAGE = argStr("--stage", "all") as PipelineStage;
const FEEDBACK = argStr("--feedback", "");
const KEEP = argFlag("--keep");
const DESC = argStr(
  "--desc",
  "A minimal React counter app. One component: a number displayed on screen " +
    "with a + button and a − button. No routing, no external libraries.",
);
const NAME = `smoke-${Date.now()}`;

const STAGE_COLOUR: Record<string, string> = {
  ARC: CYAN,
  DEC: CYAN,
  BRK: CYAN,
  TDD: CYAN,
  EXE: GREEN,
  QA: BLUE,
  IMP: CYAN,
  FBK: YELLOW,
  SYS: DIM,
};

function label(stage: string) {
  const c = STAGE_COLOUR[stage] ?? R;
  return `${c}[${stage}]${R}`;
}

function hr(title: string) {
  const pad = Math.max(2, 68 - title.length - 4);
  console.log(`\n${BOLD}${MAGENTA}── ${title} ${"─".repeat(pad)}${R}`);
}

// ── Event callback ────────────────────────────────────────────────────────────
let lastStage = "";
const stageTimes: { name: string; ms: number }[] = [];
let stageStart = Date.now();

function onEvent(ev: { type: string; data: Record<string, unknown> }) {
  if (ev.type !== "log") return;
  // Pipeline emits { agent, message, taskId, hasRaw } — "agent" is the stage label.
  const agent = (ev.data.agent as string) ?? "SYS";
  const message = (ev.data.message as string) ?? "";

  if (agent !== lastStage) {
    if (lastStage)
      stageTimes.push({ name: lastStage, ms: Date.now() - stageStart });
    lastStage = agent;
    stageStart = Date.now();
    hr(agent);
  }
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`${DIM}${ts}${R} ${label(agent)} ${message}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // If --list-models, just print and exit.
  if (LIST_MODELS) {
    hr("available models");
    let models: string[];
    try {
      models = await getAvailableModels();
    } catch {
      models = [];
    }
    if (models.length === 0) {
      console.log(`  ${RED}Ollama returned no models. Is it running?${R}`);
    } else {
      models.forEach((m, i) =>
        console.log(`  ${DIM}${String(i + 1).padStart(2)}.${R} ${m}`),
      );
    }
    process.exit(0);
  }

  // Resolve model: CLI flag → interactive picker → hardcoded default.
  let MODEL = MODEL_ARG;
  if (!MODEL) {
    let available: string[] = [];
    try {
      available = await getAvailableModels();
    } catch {
      /* offline */
    }
    if (available.length > 0) {
      hr("select model");
      MODEL = await pickFromList("Model:", available);
    } else {
      MODEL = "qwen3:1.7b";
      console.log(`${YELLOW}Ollama unreachable — defaulting to ${MODEL}${R}`);
    }
  }

  hr("smoke-test");
  console.log(`  ${BOLD}model  ${R}: ${MODEL}`);
  console.log(`  ${BOLD}stage  ${R}: ${STAGE}`);
  console.log(
    `  ${BOLD}desc   ${R}: ${DESC.slice(0, 80)}${DESC.length > 80 ? "…" : ""}`,
  );
  if (FEEDBACK) console.log(`  ${BOLD}fbk    ${R}: ${FEEDBACK}`);
  console.log(`  ${BOLD}keep   ${R}: ${KEEP}`);

  // Create project
  hr("creating project");
  const [project] = await db
    .insert(projects)
    .values({
      name: NAME,
      description: DESC,
      primaryModel: MODEL,
      status: "pending",
    })
    .returning();
  console.log(`  id = ${project.id}`);

  const t0 = Date.now();

  // Run main stage
  hr(`running — ${STAGE}`);
  const pipeline = new Pipeline(project.id, MODEL, onEvent);
  try {
    await pipeline.run(STAGE);
  } catch (err) {
    console.error(`\n${RED}Pipeline error:${R}`, err);
  }

  // Optional feedback pass
  if (FEEDBACK) {
    hr("feedback pass");
    const fbPipeline = new Pipeline(project.id, MODEL, onEvent);
    try {
      await fbPipeline.run("feedback", undefined, FEEDBACK);
    } catch (err) {
      console.error(`\n${RED}Feedback error:${R}`, err);
    }
  }

  if (lastStage)
    stageTimes.push({ name: lastStage, ms: Date.now() - stageStart });
  const totalMs = Date.now() - t0;

  // Show generated files
  hr("generated files");
  const outDir = path.join(process.cwd(), "output", String(project.id));
  if (fs.existsSync(outDir)) {
    const walkFiles = (dir: string): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const results: string[] = [];
      for (const e of entries) {
        if (e.name.endsWith(".bak")) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) results.push(...walkFiles(full));
        else results.push(full);
      }
      return results;
    };
    const files = walkFiles(outDir);
    if (files.length === 0) {
      console.log("  (no output files generated)");
    }
    for (const file of files) {
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n");
      const rel = path.relative(outDir, file);
      console.log(
        `\n${BOLD}${YELLOW}  ▸ ${rel}${R} ${DIM}(${lines.length} lines)${R}`,
      );
      lines.slice(0, 60).forEach((l) => console.log(`    ${l}`));
      if (lines.length > 60) {
        console.log(`${DIM}    … ${lines.length - 60} more lines${R}`);
      }
    }
  } else {
    console.log(`  ${RED}No output directory at ${outDir}${R}`);
  }

  // Project state
  hr("project state");
  const final = await db.query.projects.findFirst({
    where: eq(projects.id, project.id),
  });
  console.log(`  status           : ${final?.status}`);
  console.log(`  currentStage     : ${final?.currentStage ?? "-"}`);
  console.log(`  completedStages  : ${final?.completedStages}`);
  if (final?.feedbackLedger) {
    try {
      const ledger = JSON.parse(final.feedbackLedger) as {
        goal: string;
        items: {
          kind: string;
          status: string;
          file?: string;
          instruction?: string;
        }[];
      };
      console.log(`  feedbackLedger   : ${ledger.items.length} item(s)`);
      console.log(`    goal: "${ledger.goal.slice(0, 80)}"`);
      for (const item of ledger.items) {
        const detail = item.instruction
          ? `  (${item.instruction.slice(0, 50)})`
          : "";
        console.log(
          `    ${item.status.padEnd(8)} ${item.kind.padEnd(8)} ${item.file ?? ""}${detail}`,
        );
      }
    } catch {
      console.log(`  feedbackLedger   : (parse error)`);
    }
  }

  // Timing summary — merge by agent name, drop sub-50ms rows
  hr("timings");
  const merged = new Map<string, number>();
  for (const { name, ms } of stageTimes) {
    merged.set(name, (merged.get(name) ?? 0) + ms);
  }
  // Filter noise: keep only rows with ≥ 50 ms
  const significant = [...merged.entries()].filter(([, ms]) => ms >= 50);
  // Sort descending by time
  significant.sort(([, a], [, b]) => b - a);
  const maxMs = Math.max(...significant.map(([, ms]) => ms), 1);
  for (const [name, ms] of significant) {
    const secs = (ms / 1000).toFixed(1);
    const bar = "█".repeat(Math.max(1, Math.round((ms / maxMs) * 30)));
    console.log(`  ${name.padEnd(8)} ${String(secs).padStart(7)}s  ${bar}`);
  }
  console.log(
    `\n  ${BOLD}total  ${String((totalMs / 1000).toFixed(1)).padStart(7)}s${R}`,
  );

  // Cleanup
  hr("cleanup");
  if (KEEP) {
    console.log(
      `  Kept project id=${project.id}  output: output/${project.id}/`,
    );
    if (final?.status === "done") {
      console.log(`  Open: http://localhost:3000/project/${project.id}`);
    }
  } else {
    await db.delete(projects).where(eq(projects.id, project.id));
    if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true });
    console.log(
      `  Deleted project ${project.id} and output.  (--keep to retain)`,
    );
  }
}

main().catch((err) => {
  console.error(`${RED}Fatal error:${R}`, err);
  process.exit(1);
});
