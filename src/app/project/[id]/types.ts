/** Shapes the project page reads from the API. */

export type Task = {
  id: number;
  projectId: number;
  parentId: number | null;
  description: string;
  status: string;
  depth: number;
  sortOrder: number;
  filePath: string | null;
  output: string | null;
  qAReason: string | null;
  stuckReason: string | null;
  retryCount: number;
  editRetryCount: number;
  parseRetryCount: number;
};

export type Project = {
  id: number;
  name: string;
  description: string;
  status: string;
  primaryModel: string;
  threadProfile: "low" | "med" | "high";
  completedStages: string;
  fileManifest: string | null;
  currentStage: string | null;
  currentActivity: string | null;
  activityCounter: number;
  stageStartedAt: number | null;
  feedbackLedger: string | null;
};

export type ManifestEntry = {
  path: string;
  type?: string;
  language?: string;
  description?: string;
};

export type LogEntry = {
  id: number;
  agent: string;
  message: string;
  taskId: number | null;
  createdAt: string;
  hasRaw?: boolean;
};

export type LogDetail = {
  rawPrompt: string | null;
  rawResponse: string | null;
};

export type LedgerStatus = "pending" | "active" | "done" | "failed" | "skipped";

export type LedgerItem = {
  id: string;
  kind: "locate" | "edit" | "verify" | "rewrite" | "note";
  status: LedgerStatus;
  file?: string;
  instruction?: string;
  window?: { startLine: number; endLine: number };
  attempts: number;
  evidence?: string;
  before?: string;
  after?: string;
  startedAt: number;
  updatedAt: number;
};

export type FeedbackLedger = {
  goal: string;
  startedAt: number;
  finishedAt?: number;
  items: LedgerItem[];
};
