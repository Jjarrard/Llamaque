/**
 * stream-state.ts
 *
 * Process-level store for in-flight LLM token streams.
 * Uses AsyncLocalStorage so callOllama can pick up the project-bound
 * onChunk callback without any changes to agent call sites.
 */
import { AsyncLocalStorage } from "async_hooks";

// ---------- AsyncLocalStorage context ----------------------------------

export interface StreamContext {
  onChunk: (token: string) => void;
  /** Optional: notify the host of pipeline activity ("Loading model...", etc.) */
  onActivity?: (message: string) => void;
  /** Runtime LLM thread profile for this pipeline execution. */
  threadProfile?: "low" | "med" | "high";
}

export const streamingStorage = new AsyncLocalStorage<StreamContext>();

// ---------- Per-project streaming buffer --------------------------------

interface StreamBuffer {
  /** Accumulated partial text for the current LLM call */
  text: string;
  /** Agent/role doing the call */
  agent: string;
  /** When this buffer was last updated (ms since epoch) */
  updatedAt: number;
}

const buffers = new Map<number, StreamBuffer>();

export function setStreamText(projectId: number, text: string, agent: string) {
  buffers.set(projectId, { text, agent, updatedAt: Date.now() });
}

export function clearStreamText(projectId: number) {
  buffers.delete(projectId);
}

export function getStreamSnapshot(projectId: number): StreamBuffer | null {
  return buffers.get(projectId) ?? null;
}
