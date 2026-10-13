import styles from "./project.module.css";
import { parseLedger } from "./helpers";

/** Done / Now / Next view of the feedback pass's ledger. Renders nothing when there is none. */
export default function FeedbackLedgerPanel({
  ledgerJson,
}: {
  ledgerJson: string | null;
}) {
  const ledger = parseLedger(ledgerJson);
  if (!ledger || ledger.items.length === 0) return null;
  const done = ledger.items.filter((i) => i.status === "done");
  const now = ledger.items.filter((i) => i.status === "active");
  const next = ledger.items.filter((i) => i.status === "pending");
  const failed = ledger.items.filter((i) => i.status === "failed");
  return (
    <div className={styles.feedbackPanel}>
      <div className={styles.feedbackHeader}>
        <span className={styles.feedbackTitle}>✎ Feedback progress</span>
      </div>
      <div style={{ fontSize: "0.85rem", padding: "0.5rem 0.75rem" }}>
        <div style={{ opacity: 0.75, marginBottom: "0.5rem" }}>
          Goal: {ledger.goal}
        </div>
        {now.length > 0 && (
          <div style={{ marginBottom: "0.5rem" }}>
            <strong>Now:</strong>
            <ul style={{ margin: "0.25rem 0", paddingLeft: "1.25rem" }}>
              {now.map((i) => (
                <li key={i.id}>
                  {i.file ?? "—"}: {i.instruction ?? i.kind}
                  {i.window
                    ? ` (L${i.window.startLine}-${i.window.endLine})`
                    : ""}
                  {i.attempts > 0 ? ` · attempt ${i.attempts}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
        {next.length > 0 && (
          <div style={{ marginBottom: "0.5rem" }}>
            <strong>Next:</strong>
            <ul style={{ margin: "0.25rem 0", paddingLeft: "1.25rem" }}>
              {next.map((i) => (
                <li key={i.id}>
                  {i.file ?? "—"}: {i.instruction ?? i.kind}
                </li>
              ))}
            </ul>
          </div>
        )}
        {done.length > 0 && (
          <div style={{ marginBottom: "0.5rem" }}>
            <strong>Done ({done.length}):</strong>
            <ul style={{ margin: "0.25rem 0", paddingLeft: "1.25rem" }}>
              {done.map((i) => (
                <li key={i.id}>
                  <div>
                    ✓ {i.file ?? "—"}: {i.instruction ?? i.kind}
                    {i.window
                      ? ` (L${i.window.startLine}-${i.window.endLine})`
                      : ""}
                  </div>
                  {(i.before || i.after) && (
                    <details style={{ marginTop: "0.15rem" }}>
                      <summary
                        style={{ cursor: "pointer", opacity: 0.7 }}
                      >
                        diff
                      </summary>
                      {i.before && (
                        <pre
                          style={{
                            margin: "0.25rem 0",
                            padding: "0.25rem 0.5rem",
                            background: "rgba(255,0,0,0.08)",
                            fontSize: "0.75rem",
                            whiteSpace: "pre-wrap",
                            borderLeft: "2px solid #c33",
                          }}
                        >
                          {i.before}
                        </pre>
                      )}
                      {i.after && (
                        <pre
                          style={{
                            margin: "0.25rem 0",
                            padding: "0.25rem 0.5rem",
                            background: "rgba(0,180,0,0.08)",
                            fontSize: "0.75rem",
                            whiteSpace: "pre-wrap",
                            borderLeft: "2px solid #2a7",
                          }}
                        >
                          {i.after}
                        </pre>
                      )}
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {failed.length > 0 && (
          <div>
            <strong>Failed ({failed.length}):</strong>
            <ul style={{ margin: "0.25rem 0", paddingLeft: "1.25rem" }}>
              {failed.map((i) => (
                <li
                  key={i.id}
                  style={{ color: "var(--color-error, #c33)" }}
                >
                  ✗ {i.file ?? "—"}: {i.instruction ?? i.kind}
                  {i.evidence ? ` — ${i.evidence}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
