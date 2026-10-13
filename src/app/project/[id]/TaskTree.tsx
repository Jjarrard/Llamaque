"use client";

import { useState } from "react";
import styles from "./project.module.css";
import type { Task } from "./types";
import { buildTree } from "./helpers";

const DEPTH_LABELS: Record<number, string> = {
  1: "Epic",
  2: "Feature",
};

const DEPTH_LABEL_CLASS: Record<number, string> = {
  1: styles.depthLabelEpic,
  2: styles.depthLabelFeature,
};

const statusDotClass: Record<string, string> = {
  awaiting_approval: styles.statusAwaitingApproval,
  pending: styles.statusPending,
  decomposing: styles.statusDecomposing,
  ready: styles.statusReady,
  executing: styles.statusExecuting,
  qa_check: styles.statusQaCheck,
  editing: styles.statusEditing,
  done: styles.statusDone,
  stuck: styles.statusStuck,
};

/** Task tree panel: epics and features, with inline edit, approve/reject and stuck actions. */
export default function TaskTree({
  taskList,
  running,
  handleApprove,
  handleReject,
  handleStuckAction,
  onTaskEdited,
}: {
  taskList: Task[];
  running: boolean;
  handleApprove: (taskId: number) => void;
  handleReject: (taskId: number) => void;
  handleStuckAction: (taskId: number, action: "retry" | "skip") => void;
  /** Called after a task description is saved, to refresh the project */
  onTaskEdited: () => void;
}) {
  const [openAccordions, setOpenAccordions] = useState<Set<number>>(new Set());
  const [editingTask, setEditingTask] = useState<number | null>(null);
  const [editingDescription, setEditingDescription] = useState("");
  const tree = buildTree(taskList);
  const rootTasks = tree.get(null) || [];

  const toggleAccordion = (taskId: number) => {
    setOpenAccordions((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const handleEditTask = async (taskId: number) => {
    if (!editingDescription.trim()) return;
    await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "edit_description",
        description: editingDescription.trim(),
      }),
    });
    setEditingTask(null);
    setEditingDescription("");
    onTaskEdited();
  };

  const startEditTask = (task: Task) => {
    setEditingTask(task.id);
    setEditingDescription(task.description);
  };

  /** Render a task and its children recursively */
  const renderTask = (task: Task) => {
    const children = tree.get(task.id) || [];
    const depthLabel = DEPTH_LABELS[task.depth] || "Task";
    const depthLabelCls =
      DEPTH_LABEL_CLASS[task.depth] || styles.depthLabelTask;
    const isWorkParent = task.depth === 2 && children.length > 0;
    const isOpen = openAccordions.has(task.id);
    // Older projects stored model markdown in task titles
    const title = task.description.replace(/\*\*|__/g, "");

    return (
      <li key={task.id} className={styles.taskItem}>
        {editingTask === task.id ? (
          <div className={styles.taskEditRow}>
            <input
              className={styles.taskEditInput}
              value={editingDescription}
              onChange={(e) => setEditingDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleEditTask(task.id);
                if (e.key === "Escape") setEditingTask(null);
              }}
              autoFocus
            />
            <button
              className={styles.approveBtn}
              onClick={() => handleEditTask(task.id)}
            >
              ✓
            </button>
            <button
              className={styles.rejectBtn}
              onClick={() => setEditingTask(null)}
            >
              ✕
            </button>
          </div>
        ) : (
          <div
            className={`${styles.taskRow} ${task.status === "executing" ? styles.taskRowExecuting : ""}`}
          >
            <span className={`${styles.depthLabel} ${depthLabelCls}`}>
              {depthLabel}
            </span>
            <span
              className={`${styles.taskStatus} ${statusDotClass[task.status] || styles.statusPending}`}
            />
            <span
              className={`${styles.taskDesc} ${task.status === "stuck" ? styles.taskStuck : ""}`}
              title={title}
            >
              {isWorkParent ? (
                <button
                  className={styles.accordionToggle}
                  onClick={() => toggleAccordion(task.id)}
                >
                  <span className={styles.accordionIcon}>
                    {isOpen ? "▾" : "▸"}
                  </span>
                  {title}
                </button>
              ) : (
                title
              )}
            </span>
            <span className={styles.taskStatusLabel}>
              {task.status === "awaiting_approval"
                ? "awaiting"
                : task.status.replace("_", " ")}
            </span>
            {!running &&
              [
                "awaiting_approval",
                "pending",
                "ready",
                "stuck",
                "done",
              ].includes(task.status) && (
                <button
                  className={styles.taskEditBtn}
                  onClick={() => startEditTask(task)}
                  title="Edit description"
                >
                  ✎
                </button>
              )}
            {task.status === "awaiting_approval" && (
              <span className={styles.approvalActions}>
                <button
                  className={styles.approveBtn}
                  onClick={() => handleApprove(task.id)}
                >
                  ✓
                </button>
                <button
                  className={styles.rejectBtn}
                  onClick={() => handleReject(task.id)}
                >
                  ✕
                </button>
              </span>
            )}
          </div>
        )}
        {task.status === "stuck" && task.stuckReason && (
          <div className={styles.stuckInfo}>
            <span className={styles.stuckReason}>{task.stuckReason}</span>
            <div className={styles.stuckActions}>
              <button
                className={styles.stuckBtn}
                onClick={() => handleStuckAction(task.id, "retry")}
              >
                Retry
              </button>
              <button
                className={styles.stuckBtn}
                onClick={() => handleStuckAction(task.id, "skip")}
              >
                Skip
              </button>
            </div>
          </div>
        )}
        {/* Children: for work parent (depth 3), wrap in accordion */}
        {children.length > 0 && (
          <>
            {isWorkParent ? (
              isOpen && (
                <ul className={styles.workList}>
                  {children.map((c) => renderTask(c))}
                </ul>
              )
            ) : (
              <ul className={styles.childList}>
                {children.map((c) => renderTask(c))}
              </ul>
            )}
          </>
        )}
      </li>
    );
  };

  return (
    <div className={styles.taskPanel}>
      <h2 className={styles.taskPanelTitle}>
        Tasks
        <span className={styles.taskPanelStats}>
          <span className={styles.taskStatDone}>
            {taskList.filter((t) => t.status === "done").length} done
          </span>
          {taskList.filter((t) => t.status === "executing").length > 0 && (
            <span className={styles.taskStatExecuting}>
              {taskList.filter((t) => t.status === "executing").length}{" "}
              running
            </span>
          )}
          {taskList.filter((t) => t.status === "stuck").length > 0 && (
            <span className={styles.taskStatStuck}>
              {taskList.filter((t) => t.status === "stuck").length} stuck
            </span>
          )}
          <span className={styles.taskStatTotal}>/ {taskList.length}</span>
        </span>
      </h2>
      {taskList.length === 0 ? (
        <p className={styles.emptyTasks}>
          No tasks yet. Hit Decompose to start.
        </p>
      ) : (
        <ul className={styles.taskList}>
          {rootTasks.map((task) => renderTask(task))}
        </ul>
      )}
    </div>
  );
}
