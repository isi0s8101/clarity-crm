"use client";

import { useCallback, useEffect, useState } from "react";

import styles from "./v12-workspace.module.css";

type ConfigItem = {
  id: string;
  kind: string;
  name: string;
  version: number;
  active: boolean;
  definition: Record<string, unknown>;
};
type ConfigVersion = ConfigItem & {
  configurationId: string;
  createdBy?: string;
  createdAt?: string;
};

export function V12ConfigurationHistory() {
  const [items, setItems] = useState<ConfigItem[]>([]);
  const [history, setHistory] = useState<Record<string, ConfigVersion[]>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const request = useCallback(async (url: string, init?: RequestInit) => {
    const response = await fetch(url, init);
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`);
    return payload;
  }, []);

  const load = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const payload = await request("/api/configurations/v12");
      setItems(Array.isArray(payload.items) ? payload.items as ConfigItem[] : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Configurations indisponibles.");
    } finally { setBusy(false); }
  }, [request]);

  useEffect(() => {
    let cancelled = false;
    void request("/api/configurations/v12")
      .then((payload) => {
        if (!cancelled) setItems(Array.isArray(payload.items) ? payload.items as ConfigItem[] : []);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Configurations indisponibles.");
      });
    return () => { cancelled = true; };
  }, [request]);

  const loadHistory = async (item: ConfigItem) => {
    setBusy(true); setError(""); setMessage("");
    try {
      const payload = await request(`/api/configurations/v12?historyId=${encodeURIComponent(item.id)}`);
      setHistory((current) => ({
        ...current,
        [item.id]: Array.isArray(payload.items) ? payload.items as ConfigVersion[] : [],
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Historique indisponible.");
    } finally { setBusy(false); }
  };

  const restore = async (item: ConfigItem, version: number) => {
    if (!window.confirm(`Restaurer la configuration « ${item.name} » depuis la version ${version} ? Une nouvelle version sera créée.`)) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const payload = await request("/api/configurations/v12", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: item.id, restoreVersion: version, expectedVersion: item.version }),
      });
      const restored = payload.item as ConfigItem;
      setMessage(`Version ${version} restaurée sous forme de nouvelle version v${restored.version}.`);
      await load();
      await loadHistory(restored);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Restauration impossible.");
    } finally { setBusy(false); }
  };

  return (
    <section className={styles.workspace} aria-label="Historique des règles v1.2">
      <div className={styles.header}>
        <div>
          <h2>Administration v1.2 — historique et rollback</h2>
          <p>Chaque restauration crée une nouvelle version, conserve l’historique et produit un événement d’audit.</p>
        </div>
        <button type="button" className={styles.button} disabled={busy} onClick={() => void load()}>Actualiser</button>
      </div>
      {error ? <div className={`${styles.notice} ${styles.error}`} role="alert">{error}</div> : null}
      {message ? <div className={styles.notice} role="status">{message}</div> : null}
      <div className={styles.list}>
        {items.map((item) => (
          <article className={styles.item} key={item.id}>
            <strong>{item.name}</strong>
            <div className={styles.meta}>{item.kind} · version courante v{item.version} · {item.active ? "active" : "inactive"}</div>
            <div className={styles.row}>
              <button type="button" className={styles.button} disabled={busy} onClick={() => void loadHistory(item)}>Historique</button>
            </div>
            {(history[item.id] ?? []).length ? (
              <div className={styles.list}>
                {history[item.id].map((snapshot) => (
                  <div className={styles.item} key={`${item.id}:${snapshot.version}`}>
                    <strong>v{snapshot.version}</strong>
                    <div className={styles.meta}>{snapshot.active ? "active" : "inactive"}{snapshot.createdAt ? ` · ${new Date(snapshot.createdAt).toLocaleString("fr-FR")}` : ""}</div>
                    <details><summary>Définition</summary><pre className={styles.pre}>{JSON.stringify(snapshot.definition, null, 2)}</pre></details>
                    {snapshot.version !== item.version ? (
                      <button type="button" className={styles.button} disabled={busy} onClick={() => void restore(item, snapshot.version)}>Restaurer cette version</button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}
