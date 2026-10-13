"use client";

import type { Dispatch, SetStateAction } from "react";
import styles from "./project.module.css";
import { PIPELINE_STAGES, type StageKey, type StageState } from "@/lib/status";

/** The row of stage pills: state per stage, plus run / re-run / approve controls. */
export default function StageTracker({
  stageStates,
  effectiveRunning,
  handleRun,
  handleRunQA,
  handleApproveAll,
  setResetStage,
  setShowFeedbackInput,
}: {
  stageStates: Record<StageKey, StageState>;
  effectiveRunning: boolean;
  handleRun: (stage?: string, breakdownDepth?: number) => void;
  handleRunQA: () => void;
  handleApproveAll: () => void;
  setResetStage: (stage: string | null) => void;
  setShowFeedbackInput: Dispatch<SetStateAction<boolean>>;
}) {
  return (
    <div className={styles.stageTracker}>
      {PIPELINE_STAGES.map((stage, i) => {
        const state = stageStates[stage.key];
        const isFirst = i === 0;
        // Can run this stage if upstream is done and not currently running
        const upstreamDone =
          isFirst || stageStates[PIPELINE_STAGES[i - 1].key] === "done";
        const canRun =
          !effectiveRunning && state === "pending" && upstreamDone;
        const canRetry = !effectiveRunning && state === "done";
        const isApproval = state === "approval";

        return (
          <div key={stage.key} className={styles.stageItem}>
            {i > 0 && (
              <div
                className={`${styles.stageConnector} ${
                  state === "done" || state === "active"
                    ? styles.stageConnectorActive
                    : ""
                }`}
              />
            )}
            <div
              className={`${styles.stageChip} ${
                state === "done"
                  ? styles.stageChipDone
                  : state === "active"
                    ? styles.stageChipActive
                    : state === "approval"
                      ? styles.stageChipApproval
                      : styles.stageChipPending
              }`}
            >
              <span className={styles.stageIcon}>
                {state === "done" && "✓"}
                {state === "active" && (
                  <span className={styles.stageSpinner} />
                )}
                {state === "pending" && "○"}
                {state === "approval" && "⚠"}
              </span>
              <span className={styles.stageLabel}>{stage.label}</span>
              {canRun && (
                <button
                  className={styles.stageRunBtn}
                  onClick={() => {
                    if (stage.key === "feedback") {
                      setShowFeedbackInput(true);
                    } else if (stage.key === "qa") {
                      handleRunQA();
                    } else {
                      handleRun(stage.runStage);
                    }
                  }}
                  title={
                    stage.key === "feedback"
                      ? "Add Feedback"
                      : `Run ${stage.label}`
                  }
                >
                  {stage.key === "feedback" ? "✎" : "▶"}
                </button>
              )}
              {canRetry && (
                <button
                  className={styles.stageRetryBtn}
                  onClick={() => {
                    if (stage.key === "feedback") {
                      setShowFeedbackInput(true);
                    } else {
                      setResetStage(stage.runStage);
                    }
                  }}
                  title={
                    stage.key === "feedback"
                      ? "Add More Feedback"
                      : `Re-run ${stage.label}`
                  }
                >
                  {stage.key === "feedback" ? "✎" : "↻"}
                </button>
              )}
              {isApproval && (
                <button
                  className={styles.stageApproveBtn}
                  onClick={handleApproveAll}
                  title="Approve all epics"
                >
                  ✓ Approve
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
