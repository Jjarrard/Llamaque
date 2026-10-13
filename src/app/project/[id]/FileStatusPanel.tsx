import styles from "./project.module.css";
import type { ManifestEntry } from "./types";

export type FileStatus = "pending" | "writing" | "done";

/** One chip per manifest file, showing whether it is pending, being written, or done. */
export default function FileStatusPanel({
  manifestFiles,
  fileStatusMap,
}: {
  manifestFiles: ManifestEntry[];
  fileStatusMap: Record<string, FileStatus>;
}) {
  return (
    <div className={styles.fileStatusPanel}>
      <div className={styles.fileStatusHeader}>
        <span className={styles.fileStatusTitle}>Files</span>
        <span className={styles.fileStatusCount}>
          {Object.values(fileStatusMap).filter((s) => s === "done").length}/
          {manifestFiles.length} done
        </span>
      </div>
      <div className={styles.fileStatusGrid}>
        {manifestFiles.map((f) => {
          const st = fileStatusMap[f.path] ?? "pending";
          return (
            <div
              key={f.path}
              className={`${styles.fileStatusItem} ${styles[`fileStatus_${st}`]}`}
            >
              <span className={styles.fileStatusDot} />
              <span className={styles.fileStatusPath}>{f.path}</span>
              {st === "writing" && (
                <span className={styles.fileStatusWriting}>writing…</span>
              )}
              {st === "done" && (
                <span className={styles.fileStatusDoneLabel}>✓</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
