"use client";

import { useEffect, useState, FormEvent } from "react";
import Link from "next/link";
import styles from "./page.module.css";

type Project = {
  id: number;
  name: string;
  description: string;
  status: string;
  primaryModel: string;
};

const badgeClass: Record<string, string> = {
  pending: styles.badgePending,
  running: styles.badgeRunning,
  paused: styles.badgePaused,
  done: styles.badgeDone,
};

export default function Home() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [primaryModel, setPrimaryModel] = useState("");
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const fetchProjects = async () => {
    const res = await fetch("/api/projects");
    if (res.ok) setProjects(await res.json());
  };

  const fetchModels = async () => {
    setModelsLoading(true);
    try {
      const res = await fetch("/api/models");
      if (res.ok) {
        const models: string[] = await res.json();
        setAvailableModels(models);
        if (models.length > 0 && !primaryModel) {
          setPrimaryModel(models[0]);
        }
      }
    } finally {
      setModelsLoading(false);
    }
  };

  useEffect(() => {
    fetchProjects();
    fetchModels();
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !description.trim()) return;
    if (submitting) return; // Guard against double-submit
    setSubmitting(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          primaryModel,
        }),
      });
      if (res.ok) {
        setName("");
        setDescription("");
        await fetchProjects();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent, projectId: number) => {
    e.preventDefault(); // Don't navigate via the Link
    e.stopPropagation();
    if (!confirm("Delete this project and all its data?")) return;
    await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
    await fetchProjects();
  };

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1 className={styles.title}>
          Ollama <span className={styles.headerAccent}>Tiny Tasks</span>
        </h1>
      </header>

      <form className={styles.formCard} onSubmit={handleSubmit}>
        <h2 className={styles.formTitle}>New Project</h2>
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Project Name</label>
          <input
            className={styles.fieldInput}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Personal Budget Tracker"
            required
          />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Describe your idea</label>
          <textarea
            className={styles.fieldTextarea}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="A web app that lets users track income and expenses with charts..."
            required
          />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Model</label>
          {modelsLoading ? (
            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
              Loading models from Ollama…
            </p>
          ) : availableModels.length === 0 ? (
            <p style={{ fontSize: "0.85rem", color: "var(--danger)" }}>
              No models found. Is Ollama running?
            </p>
          ) : (
            <select
              className={styles.fieldInput}
              value={primaryModel}
              onChange={(e) => setPrimaryModel(e.target.value)}
            >
              {availableModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}
        </div>
        <button
          className={styles.submitBtn}
          type="submit"
          disabled={submitting}
        >
          {submitting ? "Creating..." : "Create Project"}
        </button>
      </form>

      <div className={styles.projectList}>
        {projects.length === 0 && (
          <p className={styles.empty}>No projects yet. Create one above!</p>
        )}
        {projects.map((p) => (
          <Link
            key={p.id}
            href={`/project/${p.id}`}
            className={styles.projectCard}
          >
            <div className={styles.projectInfo}>
              <h3 className={styles.projectName}>{p.name}</h3>
              <p className={styles.projectDesc}>{p.description}</p>
            </div>
            <div className={styles.projectActions}>
              <span className={badgeClass[p.status] || styles.badgePending}>
                {p.status}
              </span>
              <button
                className={styles.deleteBtn}
                onClick={(e) => handleDelete(e, p.id)}
                title="Delete project"
              >
                ✕
              </button>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
