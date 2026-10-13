"use client";

import { useState } from "react";
import styles from "./project.module.css";
import type { Project } from "./types";
import { generateRunInstructions } from "./helpers";

/** Generated files viewer, with a tab for how to run the output. */
export default function OutputFilesPanel({
  project,
  outputFiles,
  selectedFile,
  setSelectedFile,
  onClose,
}: {
  project: Project;
  outputFiles: { path: string; content: string }[];
  selectedFile: string | null;
  setSelectedFile: (path: string) => void;
  onClose: () => void;
}) {
  const [showRunInstructions, setShowRunInstructions] = useState(false);

  return (
    <div className={styles.outputPanel}>
      <div className={styles.outputHeader}>
        <div className={styles.outputTabs}>
          <button
            className={`${styles.outputTab} ${!showRunInstructions ? styles.outputTabActive : ""}`}
            onClick={() => setShowRunInstructions(false)}
          >
            📄 Files
          </button>
          <button
            className={`${styles.outputTab} ${showRunInstructions ? styles.outputTabActive : ""}`}
            onClick={() => setShowRunInstructions(true)}
          >
            🚀 How to Run
          </button>
        </div>
        <button
          className={styles.outputCloseBtn}
          onClick={onClose}
          title="Close"
        >
          ✕
        </button>
      </div>

      {showRunInstructions ? (
        <div className={styles.outputRunInstructions}>
          <pre className={styles.outputRunPre}>
            {project?.fileManifest
              ? generateRunInstructions(
                  JSON.parse(project.fileManifest),
                  project.name,
                )
              : "No output files yet."}
          </pre>
        </div>
      ) : (
        <div className={styles.outputBody}>
          {/* File sidebar */}
          <div className={styles.outputFileList}>
            {outputFiles.map((f) => (
              <button
                key={f.path}
                className={`${styles.outputFileItem} ${selectedFile === f.path ? styles.outputFileActive : ""}`}
                onClick={() => setSelectedFile(f.path)}
                title={f.path}
              >
                {f.path}
              </button>
            ))}
            {outputFiles.length === 0 && (
              <p className={styles.outputEmpty}>No files generated yet.</p>
            )}
          </div>

          {/* Code viewer */}
          <div className={styles.outputCodeViewer}>
            {selectedFile ? (
              <pre className={styles.outputCode}>
                <code>
                  {outputFiles.find((f) => f.path === selectedFile)
                    ?.content || ""}
                </code>
              </pre>
            ) : (
              <p className={styles.outputEmpty}>
                Select a file to view its contents.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
