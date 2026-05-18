/**
 * Feedback progress ledger — code-owned, never written by an LLM.
 *
 * One JSON column on `projects.feedbackLedger`. The pipeline appends/updates
 * items as it works. The UI reads the column to render Done / Now / Next.
 */

import { db } from "@/db";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";

export type LedgerItemStatus =
  | "pending"
  | "active"
  | "done"
  | "failed"
  | "skipped";

export type LedgerItemKind = "locate" | "edit" | "verify" | "rewrite" | "note";

export interface LedgerItem {
  id: string;
  kind: LedgerItemKind;
  status: LedgerItemStatus;
  file?: string;
  instruction?: string;
  window?: { startLine: number; endLine: number };
  attempts: number;
  evidence?: string;
  /** Snippet of file content before the edit (truncated). */
  before?: string;
  /** Snippet of file content after the edit (truncated). */
  after?: string;
  startedAt: number;
  updatedAt: number;
}

export interface FeedbackLedger {
  goal: string;
  startedAt: number;
  finishedAt?: number;
  items: LedgerItem[];
}

async function readLedger(projectId: number): Promise<FeedbackLedger | null> {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });
  if (!project?.feedbackLedger) return null;
  try {
    return JSON.parse(project.feedbackLedger) as FeedbackLedger;
  } catch {
    return null;
  }
}

async function writeLedger(
  projectId: number,
  ledger: FeedbackLedger,
): Promise<void> {
  await db
    .update(projects)
    .set({ feedbackLedger: JSON.stringify(ledger) })
    .where(eq(projects.id, projectId));
}

export async function initLedger(
  projectId: number,
  goal: string,
): Promise<void> {
  const ledger: FeedbackLedger = {
    goal,
    startedAt: Date.now(),
    items: [],
  };
  await writeLedger(projectId, ledger);
}

let counter = 0;
function newId(): string {
  counter = (counter + 1) % 1_000_000;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}

export async function appendLedgerItem(
  projectId: number,
  partial: Omit<LedgerItem, "id" | "attempts" | "startedAt" | "updatedAt"> & {
    attempts?: number;
  },
): Promise<string> {
  const ledger = (await readLedger(projectId)) ?? {
    goal: "",
    startedAt: Date.now(),
    items: [],
  };
  const id = newId();
  const now = Date.now();
  ledger.items.push({
    id,
    attempts: partial.attempts ?? 0,
    ...partial,
    startedAt: now,
    updatedAt: now,
  });
  await writeLedger(projectId, ledger);
  return id;
}

export async function updateLedgerItem(
  projectId: number,
  id: string,
  patch: Partial<Omit<LedgerItem, "id" | "startedAt">>,
): Promise<void> {
  const ledger = await readLedger(projectId);
  if (!ledger) return;
  const item = ledger.items.find((i) => i.id === id);
  if (!item) return;
  Object.assign(item, patch, { updatedAt: Date.now() });
  await writeLedger(projectId, ledger);
}

export async function finalizeLedger(projectId: number): Promise<void> {
  const ledger = await readLedger(projectId);
  if (!ledger) return;
  ledger.finishedAt = Date.now();
  await writeLedger(projectId, ledger);
}
