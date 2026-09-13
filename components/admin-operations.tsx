"use client";

import { useCallback, useEffect, useState } from "react";

type Job = {
  id: string;
  event: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  correlationId: string;
  idempotencyKey: string;
  availableAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string;
  createdAt: string;
  payload?: Record<string, unknown>;
};

type Run = {
  id: string;
  automationId: string;
  status: string;
  error: string;
  correlationId: string;
  attempt: number;
  createdAt: string;
};

type WebhookConfig = {
  id: string;
  name: string;
  active: boolean;
  version: number;
  definition: Record<string, unknown>;
};

type Delivery = {
  id: string;
  webhookId: string;
  direction: string;
  event: string;
  status: string;
  responseCode: number | null;
  error: string;
  createdAt: string;
  correlationId?: string;
  jobId?: string;
};

type SecretMetadata = {
  key: string;
  secret: string;
  masked: boolean;
  fingerprint: string;
  algorithm: string;
};

const jobStatuses = ["", "pending", "running", "retrying", "success", "failed"];
const deliveryStatuses = ["", "success", "failure"];

export function AdminOperations() {
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <AutomationOperations />
      <WebhookOperations />
    </div>
  );
}

function AutomationOperations() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [metrics, setMetrics] = useState<Record<string, number>>({});
  const [status, setStatus] = useState("");
  const [detail, setDetail] = useState<Job | null>(null);
  const [detailRuns, setDetailRuns] = useState<Run[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: "50", offset: "0" });
    if (status) params.set("status", status);
    const response = await fetch(`/api/automations?${params.toString()}`);
    const payload = await readPayload(response);
    if (!response.ok) throw new Error(errorText(payload));
    setJobs(Array.isArray(payload.jobs) ? (payload.jobs as Job[]) : []);
    setRuns(Array.isArray(payload.runs) ? (payload.runs as Run[]) : []);
    setMetrics(isRecord(payload.metrics) ? numberRecord(payload.metrics) : {});
  }, [status]);

  useEffect(() => {
    void load().catch((error) => setMessage(errorMessage(error)));
  }, [load]);

  const inspect = async (jobId: string) => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/automations?jobId=${encodeURIComponent(jobId)}`);
      const payload = await readPayload(response);
      if (!response.ok) throw new Error(errorText(payload));
      const nextJobs = Array.isArray(payload.jobs) ? (payload.jobs as Job[]) : [];
      setDetail(nextJobs[0] ?? null);
      setDetailRuns(Array.isArray(payload.runs) ? (payload.runs as Run[]) : []);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const act = async (jobId: string, action: "retry" | "cancel") => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/automations", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId, action }),
      });
      const payload = await readPayload(response);
      if (!response.ok) throw new Error(errorText(payload));
      setMessage(action === "retry" ? "Job remis en file." : "Job annulé avant exécution.");
      setDetail(null);
      setDetailRuns([]);
      await load();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Exploitation automatisations</h2>
          <p className="mt-1 text-sm text-slate-500">Queue PostgreSQL du tenant courant · actions administratives auditées.</p>
        </div>
        <button type="button" onClick={() => void load()} className="rounded-lg border px-3 py-2 text-xs">Actualiser</button>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5">
        {["pending", "running", "retrying", "success", "failed"].map((key) => (
          <div key={key} className="rounded-lg border bg-slate-50 p-2 text-center">
            <strong className="block text-sm">{metrics[key] ?? 0}</strong>
            <span className="text-[10px] uppercase text-slate-500">{key}</span>
          </div>
        ))}
      </div>

      <label className="mt-4 block text-sm">
        Filtrer par statut
        <select className="mt-1 w-full rounded-lg border px-3 py-2" value={status} onChange={(event) => setStatus(event.target.value)}>
          {jobStatuses.map((value) => <option key={value} value={value}>{value || "Tous"}</option>)}
        </select>
      </label>

      <div className="mt-4 max-h-[430px] space-y-2 overflow-auto">
        {jobs.length ? jobs.map((job) => (
          <article key={job.id} className="rounded-xl border p-3 text-xs">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <strong className="text-sm">{job.event}</strong>
                <p className="mt-1 break-all text-slate-500">{job.id}</p>
              </div>
              <span className="rounded bg-slate-100 px-2 py-1 font-medium">{job.status}</span>
            </div>
            <dl className="mt-3 grid gap-1 text-slate-600">
              <div><dt className="inline font-medium">Tentatives :</dt> <dd className="inline">{job.attempts}/{job.maxAttempts}</dd></div>
              <div><dt className="inline font-medium">Correlation :</dt> <dd className="inline break-all">{job.correlationId}</dd></div>
              <div><dt className="inline font-medium">Idempotence :</dt> <dd className="inline break-all">{job.idempotencyKey}</dd></div>
              <div><dt className="inline font-medium">Créé :</dt> <dd className="inline">{formatDate(job.createdAt)}</dd></div>
              {job.lastError ? <div className="text-red-700"><dt className="inline font-medium">Erreur :</dt> <dd className="inline">{job.lastError}</dd></div> : null}
            </dl>
            <div className="mt-3 flex flex-wrap gap-2">
              <button disabled={busy} type="button" onClick={() => void inspect(job.id)} className="rounded border px-2 py-1">Détail / logs</button>
              {job.status === "failed" ? <button disabled={busy} type="button" onClick={() => void act(job.id, "retry")} className="rounded border border-blue-200 px-2 py-1 text-blue-700">Relancer</button> : null}
              {job.status === "pending" || job.status === "retrying" ? <button disabled={busy} type="button" onClick={() => void act(job.id, "cancel")} className="rounded border border-red-200 px-2 py-1 text-red-700">Annuler</button> : null}
            </div>
          </article>
        )) : <p className="rounded-lg border border-dashed p-4 text-sm text-slate-500">Aucun job pour ce filtre.</p>}
      </div>

      {detail ? (
        <details open className="mt-4 rounded-xl border p-3">
          <summary className="cursor-pointer text-sm font-medium">Détail {detail.id}</summary>
          <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-slate-950 p-3 text-[11px] text-slate-100">{JSON.stringify({ job: detail, runs: detailRuns }, null, 2)}</pre>
        </details>
      ) : null}
      {runs.length ? <p className="mt-3 text-xs text-slate-500">{runs.length} exécution(s) récente(s) chargée(s).</p> : null}
      {message ? <p className="mt-3 text-sm">{message}</p> : null}
    </section>
  );
}

function WebhookOperations() {
  const [configs, setConfigs] = useState<WebhookConfig[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [metrics, setMetrics] = useState<Record<string, number>>({});
  const [status, setStatus] = useState("");
  const [secretMetadata, setSecretMetadata] = useState<SecretMetadata | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: "50", offset: "0" });
    if (status) params.set("status", status);
    const response = await fetch(`/api/webhooks?${params.toString()}`);
    const payload = await readPayload(response);
    if (!response.ok) throw new Error(errorText(payload));
    setConfigs(Array.isArray(payload.configurations) ? (payload.configurations as WebhookConfig[]) : []);
    setDeliveries(Array.isArray(payload.deliveries) ? (payload.deliveries as Delivery[]) : []);
    setMetrics(isRecord(payload.metrics) ? numberRecord(payload.metrics) : {});
  }, [status]);

  useEffect(() => {
    void load().catch((error) => setMessage(errorMessage(error)));
  }, [load]);

  const inspectSecret = async (key: string) => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/webhooks/secret?key=${encodeURIComponent(key)}`);
      const payload = await readPayload(response);
      if (!response.ok) throw new Error(errorText(payload));
      setSecretMetadata(payload as unknown as SecretMetadata);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const retry = async (deliveryId: string) => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/webhooks", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deliveryId, action: "retry" }),
      });
      const payload = await readPayload(response);
      if (!response.ok) throw new Error(errorText(payload));
      setMessage(`Relance mise en file : ${String(payload.jobId ?? "job créé")}.`);
      await load();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Exploitation webhooks</h2>
          <p className="mt-1 text-sm text-slate-500">Secrets masqués · SSRF/signature côté serveur · relance via queue durable.</p>
        </div>
        <button type="button" onClick={() => void load()} className="rounded-lg border px-3 py-2 text-xs">Actualiser</button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <div className="rounded-lg border bg-slate-50 p-2 text-center"><strong className="block">{metrics.success ?? 0}</strong><span className="text-xs text-slate-500">succès</span></div>
        <div className="rounded-lg border bg-slate-50 p-2 text-center"><strong className="block">{metrics.failure ?? 0}</strong><span className="text-xs text-slate-500">échecs</span></div>
      </div>

      <div className="mt-4 space-y-2">
        {configs.map((config) => {
          const key = String(config.definition.key ?? "");
          return (
            <article key={config.id} className="rounded-xl border p-3 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div><strong className="text-sm">{config.name}</strong><p className="text-slate-500">{key} · v{config.version}</p></div>
                <span className="rounded bg-slate-100 px-2 py-1">{config.active ? "actif" : "inactif"}</span>
              </div>
              <p className="mt-2 text-slate-600">{String(config.definition.direction ?? "")} · {String(config.definition.event ?? "")}</p>
              {key && config.active ? <button disabled={busy} type="button" onClick={() => void inspectSecret(key)} className="mt-2 rounded border px-2 py-1">Voir empreinte du secret</button> : null}
            </article>
          );
        })}
      </div>

      {secretMetadata ? (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs">
          <strong>Secret {secretMetadata.secret}</strong>
          <p className="mt-1">{secretMetadata.algorithm} · {secretMetadata.fingerprint}</p>
          <p className="mt-1 text-slate-600">La valeur réelle n’est jamais renvoyée par l’API.</p>
        </div>
      ) : null}

      <label className="mt-4 block text-sm">
        Filtrer les livraisons
        <select className="mt-1 w-full rounded-lg border px-3 py-2" value={status} onChange={(event) => setStatus(event.target.value)}>
          {deliveryStatuses.map((value) => <option key={value} value={value}>{value || "Toutes"}</option>)}
        </select>
      </label>

      <div className="mt-4 max-h-[430px] space-y-2 overflow-auto">
        {deliveries.length ? deliveries.map((delivery) => (
          <article key={delivery.id} className="rounded-xl border p-3 text-xs">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0"><strong className="text-sm">{delivery.event}</strong><p className="break-all text-slate-500">{delivery.id}</p></div>
              <span className="rounded bg-slate-100 px-2 py-1">{delivery.status}</span>
            </div>
            <p className="mt-2 text-slate-600">{delivery.direction} · HTTP {delivery.responseCode ?? "—"} · {formatDate(delivery.createdAt)}</p>
            {delivery.correlationId ? <p className="mt-1 break-all text-slate-500">Correlation: {delivery.correlationId}</p> : null}
            {delivery.jobId ? <p className="mt-1 break-all text-slate-500">Job: {delivery.jobId}</p> : null}
            {delivery.error ? <p className="mt-2 text-red-700">{delivery.error}</p> : null}
            {delivery.status === "failure" && delivery.direction === "outbound" ? <button disabled={busy} type="button" onClick={() => void retry(delivery.id)} className="mt-2 rounded border border-blue-200 px-2 py-1 text-blue-700">Relancer cette livraison</button> : null}
          </article>
        )) : <p className="rounded-lg border border-dashed p-4 text-sm text-slate-500">Aucune livraison pour ce filtre.</p>}
      </div>
      {message ? <p className="mt-3 text-sm">{message}</p> : null}
    </section>
  );
}

async function readPayload(response: Response) {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

function errorText(payload: Record<string, unknown>) {
  return typeof payload.error === "string" ? payload.error : "Opération impossible.";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Erreur inattendue.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberRecord(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, Number(entry) || 0]));
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("fr-FR");
}
