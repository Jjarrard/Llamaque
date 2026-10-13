import type { ReactNode } from "react";
import styles from "./project.module.css";

/** Modal yes/cancel prompt. */
export default function ConfirmDialog({
  children,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel,
}: {
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className={styles.confirmOverlay}>
      <div className={styles.confirmDialog}>
        <p className={styles.confirmText}>{children}</p>
        <div className={styles.confirmActions}>
          <button
            className={danger ? styles.confirmDanger : styles.confirmYes}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
          <button className={styles.confirmNo} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
