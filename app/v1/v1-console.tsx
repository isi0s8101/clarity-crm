"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

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

type View = "crm" | "config" | "automations" | "webhooks" | "forms";
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
type TimelineItem = {
  id: number;
  eventType: string;
  summary: string;
  actorId: string;
  createdAt: string;
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
  const [view, setView] = useState<View>("crm");
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
  const [configForm, setConfigForm] = useState({ kind: "object", name: "Nouvelle configuration", definition: pretty(CONFIG_EXAMPLES.object) });
  const [automationRuns, setAutomationRuns] = useState<Array<Record<string, unknown>>>([]);
  const [webhookDeliveries, setWebhookDeliveries] = useState<Array<Record<string, unknown>>>([]);
  const [forms, setForms] = useState<ConfigurationItem[]>([]);
  const [selectedFormKey, setSelectedFormKey] = useState("");
  const [formValues, setFormValues] = useState(pretty({ title: "Nouvel enregistrement" }));

  const isAdmin = session?.role === "admin";
  const typeLabel = useMemo(() => TYPES.find(([key]) => key === type)?.[1] ?? type, [type]);

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

  useEffect(() => {
    request("/api/session")
      .then((payload) => setSession(payload.user as SessionUser))
      .catch((error) => setMessage(errorMessage(error)));
  }, [request]);

  useEffect(() => {
    if (view === "crm") void loadRecords();
    if (view === "config") void loadConfigurations();
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
        .then((payload) => setAutomationRuns(Array.isArray(payload.runs) ? payload.runs as Array<Record<string, unknown>> : []))
        .catch((error) => setMessage(errorMessage(error)));
    }
    if (view === "webhooks" && isAdmin) {
      request("/api/webhooks")
        .then((payload) => setWebhookDeliveries(Array.isArray(payload.deliveries) ? payload.deliveries as Array<Record<string, unknown>> : []))
        .catch((error) => setMessage(errorMessage(error)));
    }
  }, [isAdmin, loadConfigurations, loadRecords, request, selectedFormKey, view]);

  useEffect(() => {
    setRecordForm({ title: "", status: "active", data: pretty(EXAMPLES[type] ?? {}) });
    setSelected(null);
    setTimeline([]);
  }, [type]);

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
      const values = parseJsonObject(formValues);
      const payload = await request("/api/forms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: selectedFormKey, values }),
      });
      setMessage(`Formulaire soumis : ${String((payload.item as RecordItem | undefined)?.title ?? "OK")}`);
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
            {(["crm", "forms", "config", "automations", "webhooks"] as View[]).map((item) => (
              <button key={item} className={`w-full rounded-xl px-3 py-2 text-left text-sm font-medium ${view === item ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100"}`} onClick={() => setView(item)}>
                {item === "crm" ? "CRM universel" : item === "forms" ? "Formulaires" : item === "config" ? "Configuration" : item === "automations" ? "Automatisations" : "Webhooks"}
              </button>
            ))}
          </nav>
          <div className="mt-5 border-t border-slate-100 pt-4 text-xs text-slate-500">Données persistantes D1 · RBAC serveur · isolation tenant</div>
        </aside>

        <section className="min-w-0 space-y-5">
          {message ? <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm">{message}</div> : null}

          {view === "crm" ? (
            <>
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap gap-2">{TYPES.map(([key, label]) => <button key={key} onClick={() => setType(key)} className={`rounded-lg px-3 py-2 text-sm ${type === key ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-700"}`}>{label}</button>)}</div>
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
              {selected ? <div className="grid gap-5 xl:grid-cols-2"><div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">{selected.title}</h2><p className="text-sm text-slate-500">{selected.type} · {selected.status}</p></div><button disabled={busy} onClick={() => void archiveSelected()} className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-700">Archiver</button></div><pre className="mt-4 max-h-80 overflow-auto rounded-xl bg-slate-950 p-4 text-xs text-slate-100">{pretty(selected.data)}</pre></div><div className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Timeline</h2><div className="mt-3 divide-y divide-slate-100">{timeline.map((item) => <div key={item.id} className="py-3"><strong className="text-sm">{item.summary}</strong><p className="text-xs text-slate-500">{item.eventType} · {new Date(item.createdAt).toLocaleString("fr-FR")}</p></div>)}</div></div></div> : null}
            </>
          ) : null}

          {view === "config" ? <div className="grid gap-5 xl:grid-cols-[1fr_420px]"><div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="mb-4 flex items-center justify-between"><div><h2 className="font-semibold">Configuration versionnée</h2><p className="text-sm text-slate-500">Objets, champs, pipelines, formulaires, modules, automations et webhooks.</p></div><button onClick={() => void loadConfigurations()} className="rounded-lg border px-3 py-2 text-sm">Actualiser</button></div>{isAdmin ? <div className="mb-5 flex flex-wrap gap-2">{["services", "appointments", "field-service"].map((key) => <button disabled={busy} key={key} onClick={() => void applyTemplate(key)} className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white">Template {key}</button>)}</div> : null}<div className="divide-y divide-slate-100">{configs.map((item) => <div key={item.id} className="py-3"><div className="flex justify-between gap-3"><strong className="text-sm">{item.name}</strong><span className="text-xs text-slate-500">{item.kind} · v{item.version} · {item.active ? "actif" : "inactif"}</span></div><code className="mt-1 block truncate text-xs text-slate-400">{String(item.definition.key ?? item.id)}</code></div>)}</div></div>{isAdmin ? <form onSubmit={createConfiguration} className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Nouvelle configuration</h2><select className="mt-4 w-full rounded-lg border px-3 py-2" value={configForm.kind} onChange={(event) => setConfigForm({ kind: event.target.value, name: "Nouvelle configuration", definition: pretty(CONFIG_EXAMPLES[event.target.value] ?? {}) })}>{Object.keys(CONFIG_EXAMPLES).map((key) => <option key={key}>{key}</option>)}</select><input className="mt-3 w-full rounded-lg border px-3 py-2" value={configForm.name} onChange={(event) => setConfigForm({ ...configForm, name: event.target.value })} /><textarea rows={14} className="mt-3 w-full rounded-lg border p-3 font-mono text-xs" value={configForm.definition} onChange={(event) => setConfigForm({ ...configForm, definition: event.target.value })} /><button disabled={busy} className="mt-3 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white">Créer et versionner</button></form> : <div className="rounded-2xl border bg-white p-5 text-sm text-slate-500">Lecture seule pour le profil utilisateur.</div>}</div> : null}

          {view === "forms" ? <div className="grid gap-5 xl:grid-cols-[1fr_420px]"><div className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Formulaires actifs</h2><div className="mt-4 divide-y">{forms.map((item) => <button key={item.id} onClick={() => setSelectedFormKey(String(item.definition.key ?? ""))} className="w-full py-3 text-left"><strong className="text-sm">{item.name}</strong><p className="text-xs text-slate-500">{String(item.definition.key ?? "")}</p></button>)}</div></div><form onSubmit={submitConfiguredForm} className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Soumettre un formulaire</h2><input className="mt-4 w-full rounded-lg border px-3 py-2" value={selectedFormKey} onChange={(event) => setSelectedFormKey(event.target.value)} placeholder="form_key" /><textarea rows={12} className="mt-3 w-full rounded-lg border p-3 font-mono text-xs" value={formValues} onChange={(event) => setFormValues(event.target.value)} /><button disabled={busy || !selectedFormKey} className="mt-3 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white">Valider et créer</button></form></div> : null}

          {view === "automations" ? <div className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Journal des automatisations</h2><p className="mb-4 text-sm text-slate-500">Exécutions réelles, bornées et auditables.</p><pre className="max-h-[620px] overflow-auto rounded-xl bg-slate-950 p-4 text-xs text-slate-100">{pretty(automationRuns)}</pre></div> : null}
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
