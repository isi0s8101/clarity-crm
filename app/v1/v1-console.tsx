"use client";

import React, { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

const TYPES = [
  ["company", "Sociétés"],
  ["contact", "Contacts"],
  ["lead", "Leads"],
  ["opportunity", "Opportunités"],
  ["task", "Tâches"],
  ["appointment", "Rendez-vous"],
  ["note", "Notes"],
  ["document", "Documents"],
  ["product", "Produits"],
  ["service", "Services"],
  ["quote", "Devis"],
  ["invoice", "Factures"],
  ["contract", "Contrats"],
] as const;

type View = "dashboard" | "crm" | "config" | "automations" | "webhooks" | "forms";
type SessionUser = { email: string; displayName: string; role: "admin" | "user"; tenantId: string; teamId: string };
type RecordItem = {
  id: string;
  type: string;
  title: string;
  status: string;
  data: Record<string, unknown>;
  ownerId: string;
  teamId: string;
  createdAt: string;
  updatedAt: string;
};
type ConfigurationItem = {
  id: string;
  kind: string;
  name: string;
  version: number;
  active: boolean;
  definition: Record<string, unknown>;
};
type ConfigurationVersion = ConfigurationItem & { createdAt?: string };
type TimelineItem = {
  id: number;
  eventType: string;
  summary: string;
  actorId: string;
  createdAt: string;
};
type DashboardMetrics = {
  openOpportunities: number;
  pipelineAmountCents: number;
  stageCounts: Record<string, number>;
  wonOpportunities: number;
  openTasks: number;
  overdueTasks: number;
  activity: TimelineItem[];
};

const EXAMPLES: Record<string, Record<string, unknown>> = {
  company: { website: "https://example.com" },
  contact: { email: "contact@example.com" },
  lead: { source: "website" },
  opportunity: { amountCents: 100000, probability: 40, stage: "qualification" },
  task: { dueAt: "2026-09-15T09:00:00Z", completed: false },
  appointment: { startsAt: "2026-09-15T09:00:00Z", endsAt: "2026-09-15T10:00:00Z" },
  note: { body: "Compte rendu" },
  document: { fileName: "document.pdf", mimeType: "application/pdf", url: "https://example.com/document.pdf" },
  product: { unitPriceCents: 10000, currency: "EUR" },
  service: { unitPriceCents: 10000, currency: "EUR" },
  quote: { currency: "EUR", lines: [{ description: "Service", quantity: 1, unitPriceCents: 10000, taxRateBasisPoints: 2000 }] },
  invoice: { currency: "EUR", lines: [{ description: "Service", quantity: 1, unitPriceCents: 10000, taxRateBasisPoints: 2000 }] },
  contract: { startDate: "2026-09-15", endDate: "2027-09-14" },
};

const CONFIG_EXAMPLES: Record<string, Record<string, unknown>> = {
  object: { key: "asset", label: "Équipement", fields: [{ key: "serial", label: "N° de série", type: "text", required: true }] },
  pipeline: { key: "sales_custom", objectType: "opportunity", stages: [{ key: "new", label: "Nouveau" }, { key: "won", label: "Gagné" }] },
  form: { key: "lead_form", objectType: "lead", fields: [{ key: "title", required: true }, { key: "source" }] },
  automation: { key: "followup", trigger: { event: "record.created", type: "opportunity" }, conditions: [], actions: [{ kind: "create_task", title: "Suivre {{title}}" }] },
  module: { key: "service_ops", dependsOn: [] },
  webhook: { key: "crm_out", direction: "outbound", event: "record.created", url: "https://example.com/webhook" },
};

export function V1Console({ user }: { user: { email: string; displayName: string } }) {
  const [view, setView] = useState<View>("dashboard");
  const [session, setSession] = useState<SessionUser | null>(null);
  const [type, setType] = useState("company");
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [selected, setSelected] = useState<RecordItem | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [recordForm, setRecordForm] = useState({ title: "", status: "active", data: pretty(EXAMPLES.company) });
  const [configs, setConfigs] = useState<ConfigurationItem[]>([]);
  const [configHistory, setConfigHistory] = useState<Record<string, ConfigurationVersion[]>>({});
  const [configForm, setConfigForm] = useState({ kind: "object", name: "Nouvelle configuration", definition: pretty(CONFIG_EXAMPLES.object) });
  const [automationRuns, setAutomationRuns] = useState<Array<Record<string, unknown>>>([]);
  const [automationConfigs, setAutomationConfigs] = useState<ConfigurationItem[]>([]);
  const [webhookDeliveries, setWebhookDeliveries] = useState<Array<Record<string, unknown>>>([]);
  const [forms, setForms] = useState<ConfigurationItem[]>([]);
  const [selectedFormKey, setSelectedFormKey] = useState("");
  const [formFieldValues, setFormFieldValues] = useState<Record<string, string>>({ title: "Nouvel enregistrement" });
  const [dashboard, setDashboard] = useState<DashboardMetrics | null>(null);

  const isAdmin = session?.role === "admin";
  const typeLabel = useMemo(() => TYPES.find(([key]) => key === type)?.[1] ?? type, [type]);
  const selectedForm = forms.find((item) => String(item.definition.key ?? "") === selectedFormKey);
  const selectedFormFields = Array.isArray(selectedForm?.definition.fields)
    ? selectedForm.definition.fields as Array<Record<string, unknown>>
    : [];

  const request = useCallback(async (url: string, init?: RequestInit) => {
    const response = await fetch(url, init);
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`);
    return payload;
  }, []);

  const loadRecords = useCallback(async () => {
    try {
      const params = new URLSearchParams({ type });
      if (query.trim()) params.set("q", query.trim());
      const payload = await request(`/api/crm?${params.toString()}`);
      setRecords(Array.isArray(payload.items) ? payload.items as RecordItem[] : []);
    } catch (error) {
      setRecords([]);
      setMessage(errorMessage(error));
    }
  }, [query, request, type]);

  const loadConfigurations = useCallback(async () => {
    try {
      const payload = await request(`/api/configurations${isAdmin ? "?all=1" : ""}`);
      setConfigs(Array.isArray(payload.items) ? payload.items as ConfigurationItem[] : []);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }, [isAdmin, request]);

  const loadDashboard = useCallback(async () => {
    try {
      const payload = await request("/api/dashboard") as unknown as DashboardMetrics;
      setDashboard(payload);
    } catch (error) {
      setDashboard(null);
      setMessage(errorMessage(error));
    }
  }, [request]);

  useEffect(() => {
    request("/api/session")
      .then((payload) => setSession(payload.user as SessionUser))
      .catch((error) => setMessage(errorMessage(error)));
  }, [request]);

  useEffect(() => {
    if (view === "dashboard") void Promise.resolve().then(loadDashboard);
    if (view === "crm") void Promise.resolve().then(loadRecords);
    if (view === "config") void Promise.resolve().then(loadConfigurations);
    if (view === "forms") {
      request("/api/configurations?kind=form")
        .then((payload) => {
          const next = Array.isArray(payload.items) ? payload.items as ConfigurationItem[] : [];
          setForms(next);
          if (!selectedFormKey && next[0]) setSelectedFormKey(String(next[0].definition.key ?? ""));
        })
        .catch((error) => setMessage(errorMessage(error)));
    }
    if (view === "automations") {
      request("/api/automations")
        .then((payload) => {
          setAutomationRuns(Array.isArray(payload.runs) ? payload.runs as Array<Record<string, unknown>> : []);
          setAutomationConfigs(Array.isArray(payload.configurations) ? payload.configurations as ConfigurationItem[] : []);
        })
        .catch((error) => setMessage(errorMessage(error)));
    }
    if (view === "webhooks" && isAdmin) {
      request("/api/webhooks")
        .then((payload) => setWebhookDeliveries(Array.isArray(payload.deliveries) ? payload.deliveries as Array<Record<string, unknown>> : []))
        .catch((error) => setMessage(errorMessage(error)));
    }
  }, [isAdmin, loadConfigurations, loadDashboard, loadRecords, request, selectedFormKey, view]);

  const changeType = (nextType: string) => {
    setType(nextType);
    setRecordForm({
      title: "",
      status: "active",
      data: pretty(EXAMPLES[nextType] ?? {}),
    });
    setSelected(null);
    setTimeline([]);
  };

  const createRecord = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const data = parseJsonObject(recordForm.data);
      await request("/api/crm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, title: recordForm.title, status: recordForm.status, data }),
      });
      setRecordForm((current) => ({ ...current, title: "" }));
      setMessage(`${typeLabel} : enregistrement créé.`);
      await loadRecords();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const openRecord = async (item: RecordItem) => {
    setSelected(item);
    try {
      const payload = await request(`/api/crm/timeline?recordId=${encodeURIComponent(item.id)}`);
      setTimeline(Array.isArray(payload.items) ? payload.items as TimelineItem[] : []);
    } catch (error) {
      setTimeline([]);
      setMessage(errorMessage(error));
    }
  };

  const archiveSelected = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await request(`/api/crm?id=${encodeURIComponent(selected.id)}`, { method: "DELETE" });
      setSelected(null);
      setTimeline([]);
      await loadRecords();
      setMessage("Enregistrement archivé.");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const createConfiguration = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const definition = parseJsonObject(configForm.definition);
      await request("/api/configurations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: configForm.kind, name: configForm.name, definition }),
      });
      setMessage("Configuration créée et versionnée.");
      await loadConfigurations();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const loadHistory = async (id: string) => {
    try {
      const payload = await request(`/api/configurations?historyId=${encodeURIComponent(id)}`);
      setConfigHistory((current) => ({ ...current, [id]: Array.isArray(payload.items) ? payload.items as ConfigurationVersion[] : [] }));
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };

  const restoreVersion = async (id: string, version: number) => {
    setBusy(true);
    try {
      await request("/api/configurations", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, restoreVersion: version }) });
      setMessage(`Version v${version} restaurée.`);
      await loadConfigurations();
      await loadHistory(id);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const toggleAutomation = async (item: ConfigurationItem) => {
    setBusy(true);
    try {
      await request("/api/configurations", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: item.id, active: !item.active }) });
      setMessage(item.active ? "Automatisation désactivée." : "Automatisation activée.");
      const payload = await request("/api/automations");
      setAutomationConfigs(Array.isArray(payload.configurations) ? payload.configurations as ConfigurationItem[] : []);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const applyTemplate = async (templateKey: string) => {
    setBusy(true);
    try {
      await request("/api/configurations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "apply-template", templateKey }),
      });
      setMessage(`Template « ${templateKey} » appliqué.`);
      await loadConfigurations();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const submitConfiguredForm = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const values = formFieldValues;
      const payload = await request("/api/forms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: selectedFormKey, values }),
      });
      setMessage(`Formulaire soumis : ${String((payload.item as RecordItem | undefined)?.title ?? "OK")}`);
      setFormFieldValues({});
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b border-slate-200 bg-white px-5 py-4 lg:px-8">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3">
          <div><p className="text-xs font-semibold uppercase tracking-[.16em] text-blue-600">Clarity CRM v1.0</p><h1 className="text-xl font-semibold">Espace métier réel</h1></div>
          <div className="text-right text-sm"><strong>{user.displayName}</strong><p className="text-slate-500">{session ? `${session.role} · ${session.tenantId}` : user.email}</p></div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1600px] gap-5 p-5 lg:grid-cols-[220px_1fr] lg:p-8">
        <aside className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
          <nav className="space-y-1">
            {(["dashboard", "crm", "forms", "config", "automations", "webhooks"] as View[]).map((item) => (
              <button key={item} className={`w-full rounded-xl px-3 py-2 text-left text-sm font-medium ${view === item ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100"}`} onClick={() => setView(item)}>
                {item === "dashboard" ? "Dashboard" : item === "crm" ? "CRM universel" : item === "forms" ? "Formulaires" : item === "config" ? "Configuration" : item === "automations" ? "Automatisations" : "Webhooks"}
              </button>
            ))}
          </nav>
          <div className="mt-5 border-t border-slate-100 pt-4 text-xs text-slate-500">Données PostgreSQL persistantes · RBAC serveur · isolation tenant</div>
        </aside>

        <section className="min-w-0 space-y-5">
          {message ? <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm">{message}</div> : null}

          {view === "dashboard" ? <section className="space-y-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Dashboard réel</h2><p className="text-sm text-slate-500">Indicateurs calculés uniquement à partir des données accessibles dans le tenant courant.</p></div><button onClick={() => void loadDashboard()} className="rounded-lg border px-3 py-2 text-sm">Actualiser</button></div>{dashboard ? <><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"><Metric title="Opportunités ouvertes" value={String(dashboard.openOpportunities)} /><Metric title="Pipeline ouvert" value={formatCents(dashboard.pipelineAmountCents)} /><Metric title="Opportunités gagnées" value={String(dashboard.wonOpportunities)} /><Metric title="Tâches ouvertes" value={String(dashboard.openTasks)} /><Metric title="Tâches échues" value={String(dashboard.overdueTasks)} /><Metric title="Étapes visibles" value={String(Object.keys(dashboard.stageCounts).length)} /></div><div className="grid gap-5 xl:grid-cols-[.9fr_1.1fr]"><div className="rounded-2xl border border-slate-200 bg-white p-5"><h3 className="font-semibold">Répartition du pipeline</h3><div className="mt-4 space-y-3">{Object.keys(dashboard.stageCounts).length ? Object.entries(dashboard.stageCounts).map(([stage, count]) => <div className="flex items-center justify-between border-b border-slate-100 pb-3 text-sm" key={stage}><span>{stage}</span><strong>{count}</strong></div>) : <p className="text-sm text-slate-500">Aucune opportunité accessible.</p>}</div></div><div className="rounded-2xl border border-slate-200 bg-white p-5"><h3 className="font-semibold">Activité récente</h3><div className="mt-4 divide-y divide-slate-100">{dashboard.activity.length ? dashboard.activity.map((item) => <div key={item.id} className="py-3"><strong className="text-sm">{item.summary}</strong><p className="mt-1 text-xs text-slate-500">{item.eventType} · {new Date(item.createdAt).toLocaleString("fr-FR")}</p></div>) : <p className="text-sm text-slate-500">Aucune activité visible.</p>}</div></div></div></> : <p className="rounded-2xl border border-dashed border-slate-200 bg-white p-6 text-sm text-slate-500">Chargement des données du dashboard…</p>}</section> : null}

          {view === "crm" ? (
            <>
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap gap-2">{TYPES.map(([key, label]) => <button key={key} onClick={() => changeType(key)} className={`rounded-lg px-3 py-2 text-sm ${type === key ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-700"}`}>{label}</button>)}</div>
              </div>
              <div className="grid gap-5 xl:grid-cols-[1fr_420px]">
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="mb-4 flex items-center justify-between gap-3"><div><h2 className="font-semibold">{typeLabel}</h2><p className="text-sm text-slate-500">{records.length} enregistrement(s) visible(s) selon votre scope.</p></div><input className="rounded-lg border border-slate-200 px-3 py-2 text-sm" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void loadRecords(); }} placeholder="Rechercher" /></div>
                  <div className="divide-y divide-slate-100">{records.length === 0 ? <p className="py-8 text-center text-sm text-slate-500">Aucune donnée.</p> : records.map((item) => <button key={item.id} onClick={() => void openRecord(item)} className="flex w-full items-center justify-between gap-3 py-3 text-left hover:bg-slate-50"><div className="min-w-0"><strong className="block truncate text-sm">{item.title}</strong><span className="text-xs text-slate-500">{item.status} · {new Date(item.updatedAt).toLocaleString("fr-FR")}</span></div><code className="max-w-40 truncate text-[11px] text-slate-400">{item.id}</code></button>)}</div>
                </div>
                <form onSubmit={createRecord} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h2 className="font-semibold">Créer · {typeLabel}</h2><p className="mb-4 text-sm text-slate-500">Le tenant, l’équipe et le propriétaire sont imposés côté serveur.</p>
                  <label className="mb-3 block text-sm">Titre<input required maxLength={160} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" value={recordForm.title} onChange={(event) => setRecordForm({ ...recordForm, title: event.target.value })} /></label>
                  <label className="mb-3 block text-sm">Statut<input className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" value={recordForm.status} onChange={(event) => setRecordForm({ ...recordForm, status: event.target.value })} /></label>
                  <label className="block text-sm">Données métier JSON<textarea rows={12} className="mt-1 w-full rounded-lg border border-slate-200 p-3 font-mono text-xs" value={recordForm.data} onChange={(event) => setRecordForm({ ...recordForm, data: event.target.value })} /></label>
                  <button disabled={busy} className="mt-4 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Créer l’enregistrement</button>
                </form>
              </div>
              {selected ? <section className="grid gap-5 xl:grid-cols-[minmax(260px,.8fr)_minmax(320px,1.35fr)_minmax(240px,.7fr)]"><div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-[.12em] text-blue-700">{TYPES.find(([key]) => key === selected.type)?.[1] ?? selected.type}</p><h2 className="mt-1 truncate text-lg font-semibold">{selected.title}</h2><p className="mt-1 text-sm text-slate-500">{selected.status}</p></div><button disabled={busy} onClick={() => void archiveSelected()} className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-700">Archiver</button></div><dl className="mt-5 space-y-3 text-sm">{Object.entries(selected.data).slice(0, 5).map(([key, value]) => <div key={key} className="border-b border-slate-100 pb-3"><dt className="text-xs font-medium text-slate-500">{key}</dt><dd className="mt-1 break-words text-slate-900">{typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "Valeur structurée"}</dd></div>)}</dl><details className="mt-4 rounded-xl border border-slate-200 p-3"><summary className="cursor-pointer text-sm font-medium">Afficher les données avancées</summary><pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-100">{pretty(selected.data)}</pre></details></div><div className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Activité</h2><p className="mt-1 text-sm text-slate-500">Événements rattachés à cet enregistrement.</p><div className="mt-4 divide-y divide-slate-100">{timeline.length ? timeline.map((item) => <div key={item.id} className="py-4"><strong className="text-sm">{item.summary}</strong><p className="mt-1 text-xs text-slate-500">{item.eventType} · {new Date(item.createdAt).toLocaleString("fr-FR")}</p></div>) : <p className="rounded-xl border border-dashed border-slate-200 p-4 text-sm text-slate-500">Aucune activité visible pour le moment.</p>}</div></div><aside className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Contexte</h2><dl className="mt-4 space-y-4 text-sm"><div><dt className="text-xs font-medium text-slate-500">Responsable</dt><dd className="mt-1 break-all">{selected.ownerId}</dd></div><div><dt className="text-xs font-medium text-slate-500">Équipe</dt><dd className="mt-1 break-all">{selected.teamId}</dd></div><div><dt className="text-xs font-medium text-slate-500">Créé le</dt><dd className="mt-1">{new Date(selected.createdAt).toLocaleString("fr-FR")}</dd></div><div><dt className="text-xs font-medium text-slate-500">Mis à jour</dt><dd className="mt-1">{new Date(selected.updatedAt).toLocaleString("fr-FR")}</dd></div></dl></aside></section> : null}
            </>
          ) : null}

          {view === "config" ? <div className="grid gap-5 xl:grid-cols-[1fr_420px]"><div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="mb-4 flex items-center justify-between"><div><h2 className="font-semibold">Studio de configuration</h2><p className="text-sm text-slate-500">Objets, champs, pipelines, formulaires et automatisations, avec version active visible.</p></div><button onClick={() => void loadConfigurations()} className="rounded-lg border px-3 py-2 text-sm">Actualiser</button></div>{isAdmin ? <div className="mb-5 flex flex-wrap gap-2">{["services", "appointments", "field-service"].map((key) => <button disabled={busy} key={key} onClick={() => void applyTemplate(key)} className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white">Template {key}</button>)}</div> : null}<div className="divide-y divide-slate-100">{configs.length === 0 ? <p className="py-8 text-sm text-slate-500">Aucune configuration active dans votre périmètre.</p> : configs.map((item) => <div key={item.id} className="py-4"><div className="flex flex-wrap justify-between gap-3"><div><strong className="text-sm">{item.name}</strong><p className="mt-1 text-xs text-slate-500">{item.kind} · clé {String(item.definition.key ?? item.id)}</p></div><span className={`h-fit rounded-full px-2 py-1 text-xs ${item.active ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-500"}`}>v{item.version} · {item.active ? "Actif" : "Inactif"}</span></div><details className="mt-3 rounded-lg border border-slate-100 p-3"><summary className="cursor-pointer text-xs font-medium">Afficher la définition</summary><pre className="mt-2 max-h-48 overflow-auto rounded bg-slate-950 p-3 text-[11px] text-slate-100">{pretty(item.definition)}</pre></details>{isAdmin ? <details className="mt-2 rounded-lg border border-slate-100 p-3" onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open && !configHistory[item.id]) void loadHistory(item.id); }}><summary className="cursor-pointer text-xs font-medium">Historique et restauration</summary><div className="mt-2 space-y-2">{(configHistory[item.id] ?? []).map((version) => <div key={version.version} className="flex items-center justify-between gap-2 text-xs"><span>v{version.version} · {version.active ? "actif" : "inactif"}</span>{version.version !== item.version ? <button disabled={busy} type="button" onClick={() => void restoreVersion(item.id, version.version)} className="rounded border px-2 py-1">Restaurer</button> : <span className="text-green-700">Version courante</span>}</div>)}</div></details> : null}</div>)}</div></div>{isAdmin ? <form onSubmit={createConfiguration} className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Nouvelle configuration</h2><p className="mt-1 text-sm text-slate-500">Les champs avancés restent disponibles sans surcharger le parcours principal.</p><label className="mt-4 block text-sm">Type<select className="mt-1 w-full rounded-lg border px-3 py-2" value={configForm.kind} onChange={(event) => setConfigForm({ kind: event.target.value, name: "Nouvelle configuration", definition: pretty(CONFIG_EXAMPLES[event.target.value] ?? {}) })}>{Object.keys(CONFIG_EXAMPLES).map((key) => <option key={key}>{key}</option>)}</select></label><label className="mt-3 block text-sm">Nom<input required className="mt-1 w-full rounded-lg border px-3 py-2" value={configForm.name} onChange={(event) => setConfigForm({ ...configForm, name: event.target.value })} /></label><details className="mt-3 rounded-lg border border-slate-200 p-3" open><summary className="cursor-pointer text-sm font-medium">Définition avancée (JSON)</summary><textarea required rows={14} className="mt-3 w-full rounded-lg border p-3 font-mono text-xs" value={configForm.definition} onChange={(event) => setConfigForm({ ...configForm, definition: event.target.value })} /><p className="mt-2 text-xs text-slate-500">La validation complète et les permissions restent côté serveur.</p></details><button disabled={busy} className="mt-3 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white">Créer et versionner</button></form> : <div className="rounded-2xl border bg-white p-5 text-sm text-slate-500">Lecture seule pour le profil utilisateur. Les actions d’administration sont contrôlées par le serveur.</div>}</div> : null}

          {view === "forms" ? <div className="grid gap-5 xl:grid-cols-[280px_1fr]"><div className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Formulaires actifs</h2><p className="mt-1 text-sm text-slate-500">Choisissez un parcours configuré par votre équipe.</p><div className="mt-4 divide-y">{forms.length === 0 ? <p className="py-6 text-sm text-slate-500">Aucun formulaire publié.</p> : forms.map((item) => <button key={item.id} onClick={() => { const key = String(item.definition.key ?? ""); setSelectedFormKey(key); setFormFieldValues({}); }} className={`w-full rounded-lg py-3 text-left ${selectedFormKey === String(item.definition.key ?? "") ? "bg-blue-50 px-3" : ""}`}><strong className="text-sm">{item.name}</strong><p className="text-xs text-slate-500">{String(item.definition.key ?? "")} · {Array.isArray(item.definition.fields) ? item.definition.fields.length : 0} champs</p></button>)}</div></div><form onSubmit={submitConfiguredForm} className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">{selectedForm?.name ?? "Soumettre un formulaire"}</h2><p className="mt-1 text-sm text-slate-500">Les champs requis sont indiqués. La validation métier reste côté serveur.</p>{selectedForm ? <div className="mt-5 space-y-4">{selectedFormFields.map((field, index) => { const key = typeof field.key === "string" ? field.key : `field_${index + 1}`; const label = typeof field.label === "string" ? field.label : key; const fieldType = typeof field.type === "string" ? field.type : "text"; const value = formFieldValues[key] ?? ""; const common = { className: "mt-1 w-full rounded-lg border border-slate-200 px-3 py-2", value, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setFormFieldValues((current) => ({ ...current, [key]: event.target.value })) }; return <label key={key} className="block text-sm">{label}{field.required ? <span className="ml-1 text-red-600">*</span> : null}{fieldType === "textarea" ? <textarea {...common} rows={4} /> : <input {...common} type={fieldType === "number" || fieldType === "email" || fieldType === "date" ? fieldType : "text"} />}</label>; })}</div> : <div className="mt-5 rounded-lg border border-dashed p-4 text-sm text-slate-500">Sélectionnez un formulaire pour afficher ses champs.</div>}<button disabled={busy || !selectedFormKey} className="mt-5 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white">Valider et créer</button></form></div> : null}

          {view === "automations" ? <div className="grid gap-5 xl:grid-cols-[1fr_420px]"><div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold">Workflow builder</h2><p className="mt-1 text-sm text-slate-500">Visualisation des workflows existants, sans créer de second moteur.</p></div><button onClick={() => setView("config")} className="rounded-lg border px-3 py-2 text-sm">Configurer</button></div><div className="mt-5 space-y-4">{automationConfigs.length === 0 ? <p className="rounded-lg border border-dashed p-6 text-sm text-slate-500">Aucune automatisation configurée.</p> : automationConfigs.map((item) => <article key={item.id} className="rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-medium">{item.name}</h3><p className="text-xs text-slate-500">{String(item.definition.key ?? item.id)} · v{item.version}</p></div>{isAdmin ? <button disabled={busy} onClick={() => void toggleAutomation(item)} className={`rounded-lg px-3 py-2 text-xs font-medium ${item.active ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-600"}`}>{item.active ? "Actif · désactiver" : "Inactif · activer"}</button> : <span className="text-xs text-slate-500">{item.active ? "Actif" : "Inactif"}</span>}</div><div className="mt-4 grid gap-3 md:grid-cols-3"><WorkflowStep title="Déclencheur" value={formatWorkflowValue(item.definition.trigger)} /><WorkflowStep title="Conditions" value={formatWorkflowValue(item.definition.conditions)} /><WorkflowStep title="Actions" value={formatWorkflowValue(item.definition.actions)} /></div><details className="mt-4"><summary className="cursor-pointer text-xs font-medium">Voir le flux complet</summary><pre className="mt-2 max-h-52 overflow-auto rounded-lg bg-slate-950 p-3 text-[11px] text-slate-100">{pretty(item.definition)}</pre></details></article>)}</div></div><aside className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Exécutions réelles</h2><p className="mb-4 mt-1 text-sm text-slate-500">Journal auditable, limité au tenant courant.</p><pre className="max-h-[520px] overflow-auto rounded-xl bg-slate-950 p-4 text-xs text-slate-100">{pretty(automationRuns)}</pre></aside></div> : null}
          {view === "webhooks" ? <div className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Livraisons webhook</h2><p className="mb-4 text-sm text-slate-500">HMAC-SHA256, journalisation et politique SSRF côté serveur.</p>{isAdmin ? <pre className="max-h-[620px] overflow-auto rounded-xl bg-slate-950 p-4 text-xs text-slate-100">{pretty(webhookDeliveries)}</pre> : <p className="text-sm text-slate-500">Réservé à l’administration.</p>}</div> : null}
        </section>
      </div>
    </main>
  );
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Le JSON doit être un objet.");
  return parsed as Record<string, unknown>;
}

function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Erreur inattendue.";
}

function formatWorkflowValue(value: unknown) {
  if (Array.isArray(value)) return value.length ? `${value.length} élément(s)` : "Aucune";
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 2);
    return entries.length ? entries.map(([key, entry]) => `${key}: ${String(entry)}`).join(" · ") : "Défini";
  }
  return value === undefined || value === null || value === "" ? "Non défini" : String(value);
}

function WorkflowStep({ title, value }: { title: string; value: string }) {
  return <div className="rounded-lg border border-slate-200 bg-slate-50 p-3"><p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</p><p className="mt-2 text-sm text-slate-900">{value}</p></div>;
}

function Metric({ title, value }: { title: string; value: string }) {
  return <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-sm text-slate-500">{title}</p><strong className="mt-2 block text-2xl tracking-tight">{value}</strong></div>;
}

function formatCents(value: number) {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value / 100);
}
