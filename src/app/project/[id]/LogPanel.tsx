"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./project.module.css";
import type { LogDetail, LogEntry } from "./types";

export const agentClass: Record<string, string> = {
  PM: styles.logAgentPM,
  MGR: styles.logAgentMGR,
  DEV: styles.logAgentDEV,
  QA: styles.logAgentQA,
  EDT: styles.logAgentEDT,
  SYS: styles.logAgentSYS,
  RECOVER: styles.logAgentRECOVER,
  ARCH: styles.logAgentARCH,
  TDD: styles.logAgentTDD,
  JUDGE: styles.logAgentJUDGE,
  SUM: styles.logAgentSUM,
  CHK: styles.logAgentCHK,
  FBK: styles.logAgentFBK,
  IMP: styles.logAgentIMP,
  PLAN: styles.logAgentPLAN,
};

/** Log panel: filterable agent log with raw prompt/response, and the timing timeline. */
export default function LogPanel({
  logEntries,
  effectiveRunning,
}: {
  logEntries: LogEntry[];
  effectiveRunning: boolean;
}) {
  const [expandedLogs, setExpandedLogs] = useState<
    Record<number, LogDetail | null>
  >({});
  const [logFilter, setLogFilter] = useState<string | null>(null);
  const [showTimeline, setShowTimeline] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  // ── Timeline / benchmark computation ─────────────────────────────────────
  type TLEvent = LogEntry & { offsetMs: number };
  type TLStage = {
    /** Position in the timeline; stage + start time can repeat */
    id: number;
    stage: string;
    startMs: number;
    endMs: number;
    durationMs: number;
    events: TLEvent[];
  };
  type TimelineData = {
    groups: TLStage[];
    totalMs: number;
    startMs: number;
    retryCount: number;
    recoveryCount: number;
    recoverySuccessCount: number;
    stuckCount: number;
  };

  const timelineData = useMemo((): TimelineData | null => {
    if (!logEntries.length) return null;
    const sorted = [...logEntries].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const startMs = new Date(sorted[0].createdAt).getTime();
    const endMs = new Date(sorted[sorted.length - 1].createdAt).getTime();
    const groups: TLStage[] = [];
    let cur: { stage: string; startMs: number; events: TLEvent[] } | null =
      null;
    for (const entry of sorted) {
      const ms = new Date(entry.createdAt).getTime();
      if (entry.agent === "STAGE") {
        if (cur)
          groups.push({
            ...cur,
            id: groups.length,
            endMs: ms,
            durationMs: ms - cur.startMs,
          });
        cur = { stage: entry.message, startMs: ms, events: [] };
      } else {
        if (!cur) cur = { stage: "init", startMs, events: [] };
        cur.events.push({ ...entry, offsetMs: ms - cur.startMs });
      }
    }
    if (cur) {
      groups.push({
        ...cur,
        id: groups.length,
        endMs: endMs,
        durationMs: endMs - cur.startMs,
      });
    }
    let retryCount = 0,
      recoveryCount = 0,
      recoverySuccessCount = 0,
      stuckCount = 0;
    for (const e of sorted) {
      if (e.agent === "QA" && /attempt \d+ FAIL/i.test(e.message)) retryCount++;
      if (e.agent === "RECOVER" && /Layer 1:/i.test(e.message)) recoveryCount++;
      if (e.agent === "RECOVER" && /SUCCESS/i.test(e.message))
        recoverySuccessCount++;
      if (e.agent === "QA" && /short-circuiting/i.test(e.message)) stuckCount++;
    }
    return {
      groups,
      totalMs: endMs - startMs,
      startMs,
      retryCount,
      recoveryCount,
      recoverySuccessCount,
      stuckCount,
    };
  }, [logEntries]);

  const fmtMs = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  };

  const toggleLogDetail = async (logId: number) => {
    if (expandedLogs[logId] !== undefined) {
      setExpandedLogs((prev) => {
        const next = { ...prev };
        delete next[logId];
        return next;
      });
      return;
    }
    setExpandedLogs((prev) => ({ ...prev, [logId]: null }));
    try {
      const res = await fetch(`/api/logs/${logId}`);
      if (res.ok) {
        const data = await res.json();
        setExpandedLogs((prev) => ({
          ...prev,
          [logId]: { rawPrompt: data.rawPrompt, rawResponse: data.rawResponse },
        }));
      }
    } catch {
      // Ignore
    }
  };

  // Auto-scroll log panel when new entries arrive
  const userScrolledUpRef = useRef(false);
  const logListRef = useRef<HTMLDivElement>(null);

  // Detect if user has scrolled up (so we don't fight them)
  const handleLogScroll = useCallback(() => {
    const el = logListRef.current;
    if (!el) return;
    // If user is within 80px of the bottom, consider them "following"
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    userScrolledUpRef.current = !atBottom;
  }, []);

  // Scroll to bottom when new log entries arrive (unless user scrolled up)
  useEffect(() => {
    const el = logListRef.current;
    if (!userScrolledUpRef.current && el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logEntries, logFilter]);

  // STAGE entries are internal - hide from log panel
  const visibleLogs = logEntries.filter((e) => e.agent !== "STAGE");
  const filteredLogs = logFilter
    ? visibleLogs.filter((e) => e.agent === logFilter)
    : visibleLogs;

  // Unique agent names for filter (exclude STAGE)
  const logAgents = Array.from(new Set(visibleLogs.map((e) => e.agent)));

  return (
    <div className={styles.logPanel}>
      <div className={styles.logPanelHeader}>
        <div className={styles.logPanelTitleRow}>
          <div className={styles.logPanelTabs}>
            <button
              className={`${styles.logTab} ${!showTimeline ? styles.logTabActive : ""}`}
              onClick={() => setShowTimeline(false)}
            >
              Log
            </button>
            <button
              className={`${styles.logTab} ${showTimeline ? styles.logTabActive : ""}`}
              onClick={() => setShowTimeline(true)}
              title="Timing benchmark &amp; event timeline"
            >
              Timeline
            </button>
          </div>
          <span className={styles.logCount}>
            {!showTimeline && filteredLogs.length > 0
              ? `${filteredLogs.length} entries`
              : ""}
            {effectiveRunning && (
              <span className={styles.logLiveIndicator}>● LIVE</span>
            )}
          </span>
        </div>
        {!showTimeline && logAgents.length > 1 && (
          <div className={styles.logFilters}>
            <button
              className={`${styles.logFilterBtn} ${!logFilter ? styles.logFilterActive : ""}`}
              onClick={() => setLogFilter(null)}
            >
              All
            </button>
            {logAgents.map((agent) => (
              <button
                key={agent}
                className={`${styles.logFilterBtn} ${logFilter === agent ? styles.logFilterActive : ""} ${agentClass[agent] || ""}`}
                onClick={() =>
                  setLogFilter(logFilter === agent ? null : agent)
                }
              >
                {agent}
              </button>
            ))}
          </div>
        )}
      </div>

      {showTimeline ? (
        <div className={styles.tlContainer}>
          {!timelineData ? (
            <p className={styles.tlEmpty}>No log data yet.</p>
          ) : (
            <>
              {/* ── Stats bar ── */}
              <div className={styles.tlStats}>
                <div className={styles.tlStat}>
                  <span className={styles.tlStatVal}>
                    {fmtMs(timelineData.totalMs)}
                  </span>
                  <span className={styles.tlStatLabel}>total</span>
                </div>
                <div className={styles.tlStat}>
                  <span
                    className={`${styles.tlStatVal} ${timelineData.retryCount > 0 ? styles.tlStatWarn : ""}`}
                  >
                    {timelineData.retryCount}
                  </span>
                  <span className={styles.tlStatLabel}>QA retries</span>
                </div>
                <div className={styles.tlStat}>
                  <span
                    className={`${styles.tlStatVal} ${timelineData.recoveryCount > 0 ? styles.tlStatDanger : ""}`}
                  >
                    {timelineData.recoveryCount}
                  </span>
                  <span className={styles.tlStatLabel}>recoveries</span>
                </div>
                <div className={styles.tlStat}>
                  <span
                    className={`${styles.tlStatVal} ${timelineData.recoverySuccessCount > 0 ? styles.tlStatSuccess : ""}`}
                  >
                    {timelineData.recoverySuccessCount}
                  </span>
                  <span className={styles.tlStatLabel}>rescued</span>
                </div>
                <div className={styles.tlStat}>
                  <span
                    className={`${styles.tlStatVal} ${timelineData.stuckCount > 0 ? styles.tlStatDanger : ""}`}
                  >
                    {timelineData.stuckCount}
                  </span>
                  <span className={styles.tlStatLabel}>short-circuits</span>
                </div>
              </div>

              {/* ── Stage timing bars ── */}
              {timelineData.totalMs > 0 && (
                <div className={styles.tlBars}>
                  {timelineData.groups
                    .filter((g) => g.stage !== "init" && g.durationMs > 500)
                    .sort((a, b) => b.durationMs - a.durationMs)
                    .map((g) => {
                      const pct = Math.max(
                        2,
                        Math.round(
                          (g.durationMs / timelineData.totalMs) * 100,
                        ),
                      );
                      const isRecovery =
                        g.stage === "recover" || g.stage === "RECOVER";
                      return (
                        <div
                          key={g.id}
                          className={styles.tlBar}
                        >
                          <span className={styles.tlBarLabel}>
                            {g.stage.toUpperCase()}
                          </span>
                          <div className={styles.tlBarTrack}>
                            <div
                              className={`${styles.tlBarFill} ${isRecovery ? styles.tlBarFillRecovery : ""}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className={styles.tlBarTime}>
                            {fmtMs(g.durationMs)}
                          </span>
                        </div>
                      );
                    })}
                </div>
              )}

              {/* ── Event groups ── */}
              <div className={styles.tlGroups}>
                {timelineData.groups.map((g) => (
                  <details
                    key={g.id}
                    className={styles.tlGroup}
                    open={g.events.some(
                      (e) =>
                        e.agent === "RECOVER" ||
                        /FAIL|stuck|short-circuit/i.test(e.message),
                    )}
                  >
                    <summary className={styles.tlGroupHeader}>
                      <span
                        className={`${styles.tlGroupStage} ${agentClass[g.stage.toUpperCase()] || ""}`}
                      >
                        {g.stage.toUpperCase()}
                      </span>
                      <span className={styles.tlGroupDuration}>
                        {fmtMs(g.durationMs)}
                      </span>
                      <span className={styles.tlGroupCount}>
                        {g.events.length} events
                      </span>
                    </summary>
                    <div className={styles.tlEvents}>
                      {g.events.map((e) => {
                        const isFail =
                          /FAIL|failed|stuck|short-circuit/i.test(
                            e.message,
                          );
                        const isSuccess =
                          /SUCCESS|success|approved|passed|clean/i.test(
                            e.message,
                          );
                        const isRecover = e.agent === "RECOVER";
                        return (
                          <div
                            key={e.id}
                            className={`${styles.tlEvent} ${isFail ? styles.tlEventFail : ""} ${isSuccess ? styles.tlEventSuccess : ""} ${isRecover ? styles.tlEventRecover : ""}`}
                          >
                            <span className={styles.tlEventDelta}>
                              +{fmtMs(e.offsetMs)}
                            </span>
                            <span
                              className={`${styles.tlEventAgent} ${agentClass[e.agent] || ""}`}
                            >
                              [{e.agent}]
                            </span>
                            <span className={styles.tlEventMsg}>
                              {e.message}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </details>
                ))}
              </div>
            </>
          )}
        </div>
      ) : (
        <div
          className={styles.logList}
          ref={logListRef}
          onScroll={handleLogScroll}
        >
          {filteredLogs.map((entry) => (
            <div key={entry.id} className={styles.logEntry}>
              <div
                className={`${styles.logRow} ${entry.hasRaw ? styles.logClickable : ""}`}
                onClick={() => entry.hasRaw && toggleLogDetail(entry.id)}
              >
                <span className={styles.logTimestamp}>
                  {new Date(entry.createdAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </span>
                <span
                  className={`${styles.logAgent} ${agentClass[entry.agent] || ""}`}
                >
                  [{entry.agent}]
                </span>
                <span className={styles.logMessage}>{entry.message}</span>
                {entry.hasRaw && (
                  <span className={styles.logExpandIcon}>
                    {expandedLogs[entry.id] !== undefined ? "▾" : "▸"}
                  </span>
                )}
              </div>
              {expandedLogs[entry.id] !== undefined && (
                <div className={styles.logDetailBox}>
                  {expandedLogs[entry.id] === null ? (
                    <p className={styles.logDetailLoading}>Loading…</p>
                  ) : (
                    <>
                      <div className={styles.logDetailSection}>
                        <span className={styles.logDetailLabel}>
                          Prompt
                        </span>
                        <pre className={styles.logDetailPre}>
                          {expandedLogs[entry.id]!.rawPrompt || "(none)"}
                        </pre>
                      </div>
                      <div className={styles.logDetailSection}>
                        <span className={styles.logDetailLabel}>
                          Response
                        </span>
                        <pre className={styles.logDetailPre}>
                          {expandedLogs[entry.id]!.rawResponse || "(none)"}
                        </pre>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      )}
    </div>
  );
}
