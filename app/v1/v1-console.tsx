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
  ["document", "Documents (fiches)"],
  ["product", "Produits"],
  ["service", "Services"],
  ["quote", "Devis"],
  ["invoice", "Factures"],
  ["contract", "Contrats"],
] as const;

type View = "dashboard" | "crm" | "views" | "preferences" | "config" | "automations" | "webhooks" | "forms" | "notifications";
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
type RelationItem = { relation: { id: string; relationType: string }; related: RecordItem };
type DashboardMetrics = {
  openOpportunities: number;
  pipelineAmountCents: number;
  stageCounts: Record<string, number>;
  wonOpportunities: number;
  openTasks: number;
  overdueTasks: number;
  activity: TimelineItem[];
};
type DocumentItem = { id: string; originalName: string; normalizedName: string; mimeType: string; sizeBytes: number; createdAt: string };
type NotificationItem = { id: string; type: string; message: string; resourceType: string; resourceId: string; readAt: string | null; createdAt: string };
type SavedView = { id: string; name: string; objectType: string; scope: "personal" | "team" | "tenant"; definition: Record<string, unknown>; isDefault: boolean; version: number; updatedAt: string };
type PreferenceItem = { settings: Record<string, unknown>; version: number };
type FavoriteItem = { id: string; resourceType: string; resourceId: string };
type CrmFilter = { field: string; operator: string; value: string };
type PersistedDashboard = { id: string; name: string; scope: "personal" | "team" | "tenant"; isDefault: boolean; version: number; widgets: Array<{ id: string; widgetType: string; configuration: Record<string, unknown> }> };

const EXAMPLES: Record<string, Record<string, unknown>> = {
  company: { website: "https://example.com" },
  contact: { email: "contact@example.com" },
  lead: { source: "website" },
  opportunity: { amountCents: 100000, probability: 40, stage: "qualification" },
  task: { dueAt: "2026-09-15T09:00:00Z", completed: false },
  appointment: { startsAt: "2026-09-15T09:00:00Z", endsAt: "2026-09-15T10:00:00Z" },
  note: { body: "Compte rendu" },
  document: {},
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
  const [relations, setRelations] = useState<RelationItem[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [recordForm, setRecordForm] = useState({ title: "", status: "active", data: pretty(EXAMPLES.company) });
  const [editForm, setEditForm] = useState({ title: "", status: "active", data: "{}" });
  const [relationForm, setRelationForm] = useState({ toId: "", relationType: "related_to" });
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
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<Record<string, unknown> | null>(null);
  const [globalQuery, setGlobalQuery] = useState("");
  const [globalResults, setGlobalResults] = useState<RecordItem[]>([]);
  const [crmFilters, setCrmFilters] = useState<CrmFilter[]>([]);
  const [filterLogic, setFilterLogic] = useState<"and" | "or">("and");
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [savedViewForm, setSavedViewForm] = useState({ name: "", scope: "personal" as SavedView["scope"], isDefault: false });
  const [preferences, setPreferences] = useState<PreferenceItem>({ settings: {}, version: 0 });
  const [preferencesForm, setPreferencesForm] = useState({ homePage: "dashboard", pageSize: 50, density: "comfortable", timeZone: "UTC", dateFormat: "fr-FR" });
  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const [persistedDashboards, setPersistedDashboards] = useState<PersistedDashboard[]>([]);
  const [activeDashboardId, setActiveDashboardId] = useState("");
  const [dashboardForm, setDashboardForm] = useState({ name: "", scope: "personal" as PersistedDashboard["scope"], isDefault: false });

  const isAdmin = session?.role === "admin";
  const typeLabel = useMemo(() => TYPES.find(([key]) => key === type)?.[1] ?? type, [type]);
  const selectedForm = forms.find((item) => String(item.definition.key ?? "") === selectedFormKey);
  const activePersistedDashboard = persistedDashboards.find((item) => item.id === activeDashboardId) ?? persistedDashboards.find((item) => item.isDefault) ?? null;
  const displaysDashboardWidget = (widgetType: string, metric?: string) => !activePersistedDashboard || activePersistedDashboard.widgets.some((widget) => widget.widgetType === widgetType && (widgetType !== "metric" || widget.configuration.metric === metric));
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
      if (crmFilters.length) params.set("filters", JSON.stringify({ logic: filterLogic, rules: crmFilters }));
      const payload = await request(`/api/crm?${params.toString()}`);
      setRecords(Array.isArray(payload.items) ? payload.items as RecordItem[] : []);
    } catch (error) {
      setRecords([]);
      setMessage(errorMessage(error));
    }
  }, [crmFilters, filterLogic, query, request, type]);

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
    request("/api/favorites")
      .then((payload) => setFavorites(Array.isArray(payload.items) ? payload.items as FavoriteItem[] : []))
      .catch(() => setFavorites([]));
  }, [request]);

  useEffect(() => {
    if (view === "dashboard") void Promise.resolve().then(loadDashboard);
    if (view === "dashboard") {
      request("/api/dashboards")
        .then((payload) => {
          const items = Array.isArray(payload.items) ? payload.items as PersistedDashboard[] : [];
          setPersistedDashboards(items);
          setActiveDashboardId((current) => current && items.some((item) => item.id === current) ? current : items.find((item) => item.isDefault)?.id ?? items[0]?.id ?? "");
        })
        .catch((error) => setMessage(errorMessage(error)));
    }
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
    if (view === "notifications") {
      request("/api/notifications")
        .then((payload) => { setNotifications(Array.isArray(payload.items) ? payload.items as NotificationItem[] : []); setUnreadNotifications(typeof payload.unread === "number" ? payload.unread : 0); })
        .catch((error) => setMessage(errorMessage(error)));
    }
    if (view === "views") {
      request(`/api/views?objectType=${encodeURIComponent(type)}`)
        .then((payload) => setSavedViews(Array.isArray(payload.items) ? payload.items as SavedView[] : []))
        .catch((error) => setMessage(errorMessage(error)));
    }
    if (view === "preferences") {
      request("/api/preferences")
        .then((payload) => {
          const item = payload.item as PreferenceItem;
          setPreferences(item);
          setPreferencesForm({
            homePage: typeof item.settings.homePage === "string" ? item.settings.homePage : "dashboard",
            pageSize: typeof item.settings.pageSize === "number" ? item.settings.pageSize : 50,
            density: typeof item.settings.density === "string" ? item.settings.density : "comfortable",
            timeZone: typeof item.settings.timeZone === "string" ? item.settings.timeZone : "UTC",
            dateFormat: typeof item.settings.dateFormat === "string" ? item.settings.dateFormat : "fr-FR",
          });
        })
        .catch((error) => setMessage(errorMessage(error)));
    }
  }, [isAdmin, loadConfigurations, loadDashboard, loadRecords, request, selectedFormKey, type, view]);

  const changeType = (nextType: string) => {
    setType(nextType);
    setRecordForm({
      title: "",
      status: "active",
      data: pretty(EXAMPLES[nextType] ?? {}),
    });
    setSelected(null);
    setTimeline([]);
    setRelations([]);
    setDocuments([]);
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
    setBusy(true);
    setMessage("");
    try {
      const [recordPayload, timelinePayload, documentPayload, relationPayload] = await Promise.all([
        request(`/api/crm?id=${encodeURIComponent(item.id)}`),
        request(`/api/crm/timeline?recordId=${encodeURIComponent(item.id)}`),
        request(`/api/documents?recordId=${encodeURIComponent(item.id)}`),
        request(`/api/crm/relations?recordId=${encodeURIComponent(item.id)}`),
      ]);
      const current = recordPayload.item as RecordItem;
      setType(current.type);
      setSelected(current);
      setEditForm({ title: current.title, status: current.status, data: pretty(current.data) });
      setRelationForm({ toId: "", relationType: "related_to" });
      setTimeline(Array.isArray(timelinePayload.items) ? timelinePayload.items as TimelineItem[] : []);
      setDocuments(Array.isArray(documentPayload.items) ? documentPayload.items as DocumentItem[] : []);
      setRelations(Array.isArray(relationPayload.items) ? relationPayload.items as RelationItem[] : []);
    } catch (error) {
      setSelected(null);
      setTimeline([]);
      setRelations([]);
      setDocuments([]);
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const updateSelected = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setMessage("");
    try {
      const data = parseJsonObject(editForm.data);
      const payload = await request("/api/crm", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: selected.id, title: editForm.title, status: editForm.status, data }),
      });
      const item = payload.item as RecordItem;
      setSelected(item);
      setEditForm({ title: item.title, status: item.status, data: pretty(item.data) });
      setMessage("Fiche mise à jour.");
      await Promise.all([loadRecords(), loadDashboard()]);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const createRelation = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setMessage("");
    try {
      await request("/api/crm/relations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fromId: selected.id, toId: relationForm.toId, relationType: relationForm.relationType }),
      });
      setMessage("Relation créée.");
      await openRecord(selected);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const deleteRelation = async (id: string) => {
    if (!selected) return;
    setBusy(true);
    setMessage("");
    try {
      await request(`/api/crm/relations?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      setRelations((current) => current.filter((item) => item.relation.id !== id));
      setMessage("Relation supprimée.");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const searchGlobally = async (event: FormEvent) => {
    event.preventDefault();
    const q = globalQuery.trim();
    if (q.length < 2) {
      setMessage("La recherche globale doit contenir au moins 2 caractères.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const payload = await request(`/api/crm/search?q=${encodeURIComponent(q)}&limit=20`);
      setGlobalResults(Array.isArray(payload.items) ? payload.items as RecordItem[] : []);
    } catch (error) {
      setGlobalResults([]);
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const createSavedView = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const payload = await request("/api/views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...savedViewForm,
          objectType: type,
          definition: { search: query.trim(), filters: crmFilters, filterLogic, sort: { field: "updatedAt", direction: "desc" }, columns: ["title", "status", "updatedAt"], pageSize: preferencesForm.pageSize },
        }),
      });
      setSavedViews((current) => [payload.item as SavedView, ...current]);
      setSavedViewForm({ name: "", scope: "personal", isDefault: false });
      setMessage("Vue enregistrée.");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const applySavedView = async (item: SavedView) => {
    const search = typeof item.definition.search === "string" ? item.definition.search : "";
    const filters = Array.isArray(item.definition.filters)
      ? item.definition.filters.filter((entry): entry is CrmFilter => Boolean(entry) && typeof entry === "object" && typeof (entry as CrmFilter).field === "string" && typeof (entry as CrmFilter).operator === "string" && typeof (entry as CrmFilter).value === "string").slice(0, 20)
      : [];
    setType(item.objectType);
    setQuery(search);
    setCrmFilters(filters);
    setFilterLogic(item.definition.filterLogic === "or" ? "or" : "and");
    setView("crm");
  };

  const deleteSavedView = async (item: SavedView) => {
    setBusy(true);
    setMessage("");
    try {
      await request(`/api/views?id=${encodeURIComponent(item.id)}`, { method: "DELETE" });
      setSavedViews((current) => current.filter((entry) => entry.id !== item.id));
      setMessage("Vue archivée.");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const savePreferences = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const payload = await request("/api/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: preferences.version, settings: preferencesForm }),
      });
      const item = payload.item as PreferenceItem;
      setPreferences(item);
      setMessage("Préférences enregistrées.");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const createPersistedDashboard = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const payload = await request("/api/dashboards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: dashboardForm.name,
          scope: dashboardForm.scope,
          isDefault: dashboardForm.isDefault,
          widgets: [
            ...["openOpportunities", "pipelineAmountCents", "wonOpportunities", "openTasks", "overdueTasks"].map((metric) => ({ widgetType: "metric", configuration: { metric } as Record<string, unknown> })),
            { widgetType: "pipeline", configuration: {} }, { widgetType: "activity", configuration: {} },
          ],
        }),
      });
      const item = payload.item as PersistedDashboard;
      setPersistedDashboards((current) => [item, ...current]);
      setActiveDashboardId(item.id);
      setDashboardForm({ name: "", scope: "personal", isDefault: false });
      setMessage("Dashboard personnel créé.");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const deletePersistedDashboard = async (item: PersistedDashboard) => {
    setBusy(true);
    setMessage("");
    try {
      await request(`/api/dashboards?id=${encodeURIComponent(item.id)}`, { method: "DELETE" });
      setPersistedDashboards((current) => current.filter((entry) => entry.id !== item.id));
      setActiveDashboardId("");
      setMessage("Dashboard archivé.");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const openNotificationResource = async (item: NotificationItem) => {
    if (!item.resourceId) return;
    setView("crm");
    await openRecord({ id: item.resourceId, type: item.resourceType, title: "", status: "", data: {}, ownerId: "", teamId: "", createdAt: "", updatedAt: "" });
  };

  const uploadDocument = async (file: File) => {
    if (!selected) return;
    setBusy(true);
    try {
      const form = new FormData(); form.set("recordId", selected.id); form.set("file", file);
      const payload = await request("/api/documents", { method: "POST", body: form });
      setDocuments((current) => [payload.item as DocumentItem, ...current]);
      setMessage("Document téléversé et lié à la fiche.");
    } catch (error) { setMessage(errorMessage(error)); } finally { setBusy(false); }
  };

  const archiveDocument = async (id: string) => {
    try {
      await request("/api/documents", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      setDocuments((current) => current.filter((item) => item.id !== id));
      setMessage("Document archivé.");
    } catch (error) { setMessage(errorMessage(error)); }
  };

  const previewImport = async (confirm: boolean) => {
    if (!importFile) return;
    setBusy(true);
    try {
      const form = new FormData(); form.set("type", type); form.set("file", importFile); form.set("confirm", String(confirm));
      const payload = await request("/api/crm/import", { method: "POST", body: form });
      setImportPreview(payload);
      if (confirm) { setMessage("Import exécuté : consultez le rapport ci-dessous."); await loadRecords(); }
    } catch (error) { setMessage(errorMessage(error)); } finally { setBusy(false); }
  };

  const markNotificationRead = async (id: string) => {
    try {
      await request("/api/notifications", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      setNotifications((current) => current.map((item) => item.id === id ? { ...item, readAt: new Date().toISOString() } : item));
      setUnreadNotifications((count) => Math.max(0, count - 1));
    } catch (error) { setMessage(errorMessage(error)); }
  };

  const archiveSelected = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await request(`/api/crm?id=${encodeURIComponent(selected.id)}`, { method: "DELETE" });
      setSelected(null);
      setTimeline([]);
      setDocuments([]);
      await loadRecords();
      setMessage("Enregistrement archivé.");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const toggleFavorite = async () => {
    if (!selected) return;
    const current = favorites.find((item) => item.resourceType === "crm_record" && item.resourceId === selected.id);
    setBusy(true);
    setMessage("");
    try {
      if (current) {
        await request(`/api/favorites?id=${encodeURIComponent(current.id)}`, { method: "DELETE" });
        setFavorites((items) => items.filter((item) => item.id !== current.id));
        setMessage("Favori retiré.");
      } else {
        const payload = await request("/api/favorites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resourceType: "crm_record", resourceId: selected.id }) });
        setFavorites((items) => [payload.item as FavoriteItem, ...items]);
        setMessage("Ajouté aux favoris.");
      }
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
          <div><p className="text-xs font-semibold uppercase tracking-[.16em] text-blue-600">Clarity CRM v2 · fondations V1</p><h1 className="text-xl font-semibold">Espace métier réel</h1></div>
          <div className="text-right text-sm"><strong>{user.displayName}</strong><p className="text-slate-500">{session ? `${session.role} · ${session.tenantId}` : user.email}</p></div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1600px] gap-5 p-5 lg:grid-cols-[220px_1fr] lg:p-8">
        <aside className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
          <nav className="space-y-1">
            {(["dashboard", "crm", "views", "preferences", "forms", "config", "automations", "webhooks", "notifications"] as View[]).map((item) => (
              <button key={item} className={`w-full rounded-xl px-3 py-2 text-left text-sm font-medium ${view === item ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100"}`} onClick={() => setView(item)}>
                {item === "dashboard" ? "Dashboard" : item === "crm" ? "CRM universel" : item === "views" ? "Vues enregistrées" : item === "preferences" ? "Préférences" : item === "forms" ? "Formulaires" : item === "config" ? "Configuration" : item === "automations" ? "Automatisations" : item === "webhooks" ? "Webhooks" : `Notifications${unreadNotifications ? ` (${unreadNotifications})` : ""}`}
              </button>
            ))}
          </nav>
          <div className="mt-5 border-t border-slate-100 pt-4 text-xs text-slate-500">Données PostgreSQL persistantes · RBAC serveur · isolation tenant</div>
        </aside>

        <section className="min-w-0 space-y-5">
          {message ? <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm">{message}</div> : null}

          {view === "dashboard" ? <section className="space-y-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Dashboard réel</h2><p className="text-sm text-slate-500">Widgets persistants, calculés uniquement à partir des données autorisées du tenant courant.</p></div><button onClick={() => void loadDashboard()} className="rounded-lg border px-3 py-2 text-sm">Actualiser</button></div><div className="grid gap-5 xl:grid-cols-[1fr_360px]"><section className="rounded-2xl border border-slate-200 bg-white p-5"><h3 className="font-semibold">Mes dashboards</h3><div className="mt-3 divide-y divide-slate-100">{persistedDashboards.length ? persistedDashboards.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 py-3"><button type="button" onClick={() => setActiveDashboardId(item.id)} className={`text-left text-sm ${activePersistedDashboard?.id === item.id ? "font-semibold text-blue-700" : ""}`}>{item.name}<span className="ml-2 text-xs text-slate-500">{item.scope} · {item.widgets.length} widgets</span></button><button disabled={busy} type="button" onClick={() => void deletePersistedDashboard(item)} className="rounded border border-red-200 px-2 py-1 text-xs text-red-700">Archiver</button></div>) : <p className="py-3 text-sm text-slate-500">Aucun dashboard personnel. Le tableau standard reste disponible.</p>}</div></section><form onSubmit={createPersistedDashboard} className="rounded-2xl border border-slate-200 bg-white p-5"><h3 className="font-semibold">Nouveau dashboard</h3><p className="mt-1 text-xs text-slate-500">Les widgets métier standards sont créés côté serveur ; aucun KPI local.</p><input required maxLength={120} className="mt-4 w-full rounded-lg border px-3 py-2 text-sm" value={dashboardForm.name} onChange={(event) => setDashboardForm({ ...dashboardForm, name: event.target.value })} placeholder="Ex. Suivi commercial" /><select className="mt-3 w-full rounded-lg border px-3 py-2 text-sm" value={dashboardForm.scope} onChange={(event) => setDashboardForm({ ...dashboardForm, scope: event.target.value as PersistedDashboard["scope"] })}><option value="personal">Personnel</option><option value="team">Équipe</option>{isAdmin ? <option value="tenant">Tenant</option> : null}</select><label className="mt-3 flex items-center gap-2 text-xs"><input type="checkbox" checked={dashboardForm.isDefault} onChange={(event) => setDashboardForm({ ...dashboardForm, isDefault: event.target.checked })} />Définir comme défaut</label><button disabled={busy} className="mt-3 w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Créer</button></form></div>{dashboard ? <><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{([[["openOpportunities", "Opportunités ouvertes", String(dashboard.openOpportunities)]], [["pipelineAmountCents", "Pipeline ouvert", formatCents(dashboard.pipelineAmountCents)]], [["wonOpportunities", "Opportunités gagnées", String(dashboard.wonOpportunities)]], [["openTasks", "Tâches ouvertes", String(dashboard.openTasks)]], [["overdueTasks", "Tâches échues", String(dashboard.overdueTasks)]] ] as Array<Array<[string, string, string]>>).flat().filter(([metric]) => displaysDashboardWidget("metric", metric)).map(([metric, title, value]) => <Metric key={metric} title={title} value={value} />)}</div><div className="grid gap-5 xl:grid-cols-[.9fr_1.1fr]">{displaysDashboardWidget("pipeline") ? <div className="rounded-2xl border border-slate-200 bg-white p-5"><h3 className="font-semibold">Répartition du pipeline</h3><div className="mt-4 space-y-3">{Object.keys(dashboard.stageCounts).length ? Object.entries(dashboard.stageCounts).map(([stage, count]) => <div className="flex items-center justify-between border-b border-slate-100 pb-3 text-sm" key={stage}><span>{stage}</span><strong>{count}</strong></div>) : <p className="text-sm text-slate-500">Aucune opportunité accessible.</p>}</div></div> : null}{displaysDashboardWidget("activity") ? <div className="rounded-2xl border border-slate-200 bg-white p-5"><h3 className="font-semibold">Activité récente</h3><div className="mt-4 divide-y divide-slate-100">{dashboard.activity.length ? dashboard.activity.map((item) => <div key={item.id} className="py-3"><strong className="text-sm">{item.summary}</strong><p className="mt-1 text-xs text-slate-500">{item.eventType} · {new Date(item.createdAt).toLocaleString("fr-FR")}</p></div>) : <p className="text-sm text-slate-500">Aucune activité visible.</p>}</div></div> : null}</div></> : <p className="rounded-2xl border border-dashed border-slate-200 bg-white p-6 text-sm text-slate-500">Chargement des données du dashboard…</p>}</section> : null}

          {view === "views" ? <div className="grid gap-5 xl:grid-cols-[1fr_360px]"><section className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">Vues enregistrées · {typeLabel}</h2><p className="mt-1 text-sm text-slate-500">Les vues sont persistantes et restent soumises aux permissions et scopes du serveur.</p></div><button onClick={() => setView("crm")} className="rounded-lg border px-3 py-2 text-sm">Retour au CRM</button></div><div className="mt-5 divide-y divide-slate-100">{savedViews.length ? savedViews.map((item) => <article key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-4"><div><strong className="text-sm">{item.name}</strong><p className="mt-1 text-xs text-slate-500">{item.scope} · v{item.version}{item.isDefault ? " · vue par défaut" : ""}</p></div><div className="flex gap-2"><button type="button" onClick={() => void applySavedView(item)} className="rounded border px-2 py-1 text-xs">Appliquer</button><button disabled={busy} type="button" onClick={() => void deleteSavedView(item)} className="rounded border border-red-200 px-2 py-1 text-xs text-red-700">Archiver</button></div></article>) : <p className="py-8 text-sm text-slate-500">Aucune vue disponible pour cet objet.</p>}</div></section><form onSubmit={createSavedView} className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Enregistrer la vue courante</h2><p className="mt-1 text-sm text-slate-500">Recherche et colonnes actives sont enregistrées côté serveur.</p><label className="mt-4 block text-sm">Nom<input required maxLength={120} className="mt-1 w-full rounded-lg border px-3 py-2" value={savedViewForm.name} onChange={(event) => setSavedViewForm({ ...savedViewForm, name: event.target.value })} /></label><label className="mt-3 block text-sm">Partage<select className="mt-1 w-full rounded-lg border px-3 py-2" value={savedViewForm.scope} onChange={(event) => setSavedViewForm({ ...savedViewForm, scope: event.target.value as SavedView["scope"] })}><option value="personal">Privée</option><option value="team">Équipe</option>{isAdmin ? <option value="tenant">Tenant</option> : null}</select></label><label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={savedViewForm.isDefault} onChange={(event) => setSavedViewForm({ ...savedViewForm, isDefault: event.target.checked })} />Définir par défaut</label><button disabled={busy} className="mt-5 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Enregistrer</button></form></div> : null}

          {view === "preferences" ? <form onSubmit={savePreferences} className="max-w-2xl rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Préférences de l’utilisateur</h2><p className="mt-1 text-sm text-slate-500">Ces réglages sont persistés pour votre compte et le tenant courant.</p><div className="mt-5 grid gap-4 sm:grid-cols-2"><label className="text-sm">Page d’accueil<select className="mt-1 w-full rounded-lg border px-3 py-2" value={preferencesForm.homePage} onChange={(event) => setPreferencesForm({ ...preferencesForm, homePage: event.target.value })}><option value="dashboard">Dashboard</option><option value="crm">CRM</option></select></label><label className="text-sm">Taille des listes<input type="number" min="10" max="200" className="mt-1 w-full rounded-lg border px-3 py-2" value={preferencesForm.pageSize} onChange={(event) => setPreferencesForm({ ...preferencesForm, pageSize: Number(event.target.value) })} /></label><label className="text-sm">Densité<select className="mt-1 w-full rounded-lg border px-3 py-2" value={preferencesForm.density} onChange={(event) => setPreferencesForm({ ...preferencesForm, density: event.target.value })}><option value="comfortable">Confortable</option><option value="compact">Compacte</option></select></label><label className="text-sm">Fuseau horaire<input maxLength={120} className="mt-1 w-full rounded-lg border px-3 py-2" value={preferencesForm.timeZone} onChange={(event) => setPreferencesForm({ ...preferencesForm, timeZone: event.target.value })} /></label><label className="text-sm">Format de date<input maxLength={120} className="mt-1 w-full rounded-lg border px-3 py-2" value={preferencesForm.dateFormat} onChange={(event) => setPreferencesForm({ ...preferencesForm, dateFormat: event.target.value })} /></label></div><button disabled={busy} className="mt-5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Enregistrer les préférences</button></form> : null}

          {view === "crm" ? (
            <>
              <form onSubmit={searchGlobally} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <label className="text-sm font-medium">Recherche globale</label>
                <div className="mt-2 flex flex-wrap gap-2"><input className="min-w-52 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm" value={globalQuery} onChange={(event) => setGlobalQuery(event.target.value)} placeholder="Au moins 2 caractères" /><button disabled={busy} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50">Rechercher</button></div>
                {globalResults.length ? <div className="mt-3 divide-y divide-slate-100">{globalResults.map((item) => <button type="button" key={item.id} onClick={() => void openRecord(item)} className="flex w-full items-center justify-between gap-3 py-2 text-left text-sm hover:bg-slate-50"><span><strong>{item.title}</strong><span className="ml-2 text-xs text-slate-500">{TYPES.find(([key]) => key === item.type)?.[1] ?? item.type} · {item.status}</span></span><code className="text-[11px] text-slate-400">{item.id}</code></button>)}</div> : null}
              </form>
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap gap-2">{TYPES.map(([key, label]) => <button key={key} onClick={() => changeType(key)} className={`rounded-lg px-3 py-2 text-sm ${type === key ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-700"}`}>{label}</button>)}</div>
              </div>
              <div className="grid gap-5 xl:grid-cols-[1fr_420px]">
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="mb-4 flex items-center justify-between gap-3"><div><h2 className="font-semibold">{typeLabel}</h2><p className="text-sm text-slate-500">{records.length} enregistrement(s) visible(s) selon votre scope.</p></div><input className="rounded-lg border border-slate-200 px-3 py-2 text-sm" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void loadRecords(); }} placeholder="Rechercher" /></div>
                  <div className="mb-4 rounded-xl border border-slate-100 bg-slate-50 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-medium">Filtres serveur</p><div className="flex gap-2"><select className="rounded border px-2 py-1 text-xs" value={filterLogic} onChange={(event) => setFilterLogic(event.target.value as "and" | "or")}><option value="and">ET</option><option value="or">OU</option></select><button type="button" onClick={() => setCrmFilters((current) => current.length >= 20 ? current : [...current, { field: "title", operator: "contains", value: "" }])} className="rounded border px-2 py-1 text-xs">Ajouter un critère</button><button type="button" onClick={() => { setCrmFilters([]); void loadRecords(); }} className="rounded border px-2 py-1 text-xs">Effacer</button></div></div>{crmFilters.length ? <div className="mt-3 space-y-2">{crmFilters.map((filter, index) => <div key={`${filter.field}-${index}`} className="grid gap-2 sm:grid-cols-[150px_150px_1fr_auto]"><select className="rounded border px-2 py-1 text-xs" value={filter.field} onChange={(event) => setCrmFilters((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, field: event.target.value, operator: defaultFilterOperator(event.target.value) } : item))}><option value="title">Titre</option><option value="status">Statut</option><option value="data.amountCents">Montant (centimes)</option><option value="data.probability">Probabilité</option><option value="createdAt">Créé le</option><option value="updatedAt">Modifié le</option></select><select className="rounded border px-2 py-1 text-xs" value={filter.operator} onChange={(event) => setCrmFilters((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, operator: event.target.value } : item))}>{filterOperators(filter.field).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><input className="rounded border px-2 py-1 text-xs" value={filter.value} onChange={(event) => setCrmFilters((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))} placeholder="Valeur" /><button type="button" onClick={() => setCrmFilters((current) => current.filter((_, itemIndex) => itemIndex !== index))} className="rounded border border-red-200 px-2 py-1 text-xs text-red-700">Retirer</button></div>)}<button type="button" onClick={() => void loadRecords()} className="rounded border px-3 py-1 text-xs">Appliquer les filtres</button></div> : <p className="mt-2 text-xs text-slate-500">Les critères sont évalués en PostgreSQL après RBAC et scope.</p>}</div>
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
              <div className="grid gap-5 xl:grid-cols-2"><div className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Import CSV contrôlé</h2><p className="mt-1 text-sm text-slate-500">Aperçu obligatoire avant écriture · UTF-8 · doublons et validations serveur.</p><input className="mt-4 block w-full text-sm" type="file" accept=".csv,text/csv" onChange={(event) => { setImportFile(event.target.files?.[0] ?? null); setImportPreview(null); }} /><div className="mt-3 flex gap-2"><button disabled={busy || !importFile} onClick={() => void previewImport(false)} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50">Prévisualiser</button><button disabled={busy || !importPreview || !importFile} onClick={() => void previewImport(true)} className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50">Confirmer l’import</button></div>{importPreview ? <pre className="mt-4 max-h-48 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-100">{pretty(importPreview)}</pre> : null}</div><div className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Export contrôlé</h2><p className="mt-1 text-sm text-slate-500">Périmètre RBAC/scopes, limite de volume et protection contre les formules.</p><div className="mt-4 flex gap-2"><a className="rounded-lg border px-3 py-2 text-sm" href={`/api/crm/export?type=${encodeURIComponent(type)}`}>CSV UTF-8</a><a className="rounded-lg border px-3 py-2 text-sm" href={`/api/crm/export?type=${encodeURIComponent(type)}&format=xlsx`}>Excel (.xlsx)</a></div></div></div>
              {selected ? <section className="grid gap-5 xl:grid-cols-[minmax(260px,.8fr)_minmax(320px,1.35fr)_minmax(240px,.7fr)]"><div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-[.12em] text-blue-700">{TYPES.find(([key]) => key === selected.type)?.[1] ?? selected.type}</p><h2 className="mt-1 truncate text-lg font-semibold">{selected.title}</h2><p className="mt-1 text-sm text-slate-500">{selected.status}</p></div><div className="flex flex-col gap-2"><button disabled={busy} onClick={() => void toggleFavorite()} className="rounded-lg border px-3 py-2 text-sm">{favorites.some((item) => item.resourceType === "crm_record" && item.resourceId === selected.id) ? "Retirer des favoris" : "Ajouter aux favoris"}</button><button disabled={busy} onClick={() => void archiveSelected()} className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-700">Archiver</button></div></div><dl className="mt-5 space-y-3 text-sm">{Object.entries(selected.data).slice(0, 5).map(([key, value]) => <div key={key} className="border-b border-slate-100 pb-3"><dt className="text-xs font-medium text-slate-500">{key}</dt><dd className="mt-1 break-words text-slate-900">{typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "Valeur structurée"}</dd></div>)}</dl><details className="mt-4 rounded-xl border border-slate-200 p-3"><summary className="cursor-pointer text-sm font-medium">Afficher les données avancées</summary><pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-100">{pretty(selected.data)}</pre></details></div><div className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Activité</h2><p className="mt-1 text-sm text-slate-500">Événements rattachés à cet enregistrement.</p><div className="mt-4 divide-y divide-slate-100">{timeline.length ? timeline.map((item) => <div key={item.id} className="py-4"><strong className="text-sm">{item.summary}</strong><p className="mt-1 text-xs text-slate-500">{item.eventType} · {new Date(item.createdAt).toLocaleString("fr-FR")}</p></div>) : <p className="rounded-xl border border-dashed border-slate-200 p-4 text-sm text-slate-500">Aucune activité visible pour le moment.</p>}</div></div><aside className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Documents liés</h2><p className="mt-1 text-xs text-slate-500">Stockage POSIX protégé.</p><input disabled={busy} className="mt-3 block w-full text-xs" type="file" accept=".pdf,.txt,.csv,.jpg,.jpeg,.png,.docx,.xlsx" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadDocument(file); event.currentTarget.value = ""; }} /><div className="mt-3 space-y-2">{documents.length ? documents.map((document) => <div className="flex gap-2" key={document.id}><a className="block min-w-0 flex-1 rounded border p-2 text-xs hover:bg-slate-50" href={`/api/documents/download?id=${encodeURIComponent(document.id)}`}>{document.originalName} · {Math.ceil(document.sizeBytes / 1024)} Ko</a><button disabled={busy} onClick={() => void archiveDocument(document.id)} className="rounded border px-2 text-xs text-red-700">Archiver</button></div>) : <p className="text-xs text-slate-500">Aucun document actif.</p>}</div></aside></section> : null}
              {selected ? <section className="grid gap-5 xl:grid-cols-2">
                <form onSubmit={updateSelected} className="rounded-2xl border border-slate-200 bg-white p-5">
                  <h2 className="font-semibold">Modifier cette fiche</h2><p className="mt-1 text-sm text-slate-500">La modification utilise le PATCH CRM, avec validation, scope et audit côté serveur.</p>
                  <label className="mt-4 block text-sm">Titre<input required maxLength={160} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" value={editForm.title} onChange={(event) => setEditForm({ ...editForm, title: event.target.value })} /></label>
                  <label className="mt-3 block text-sm">Statut<input className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" value={editForm.status} onChange={(event) => setEditForm({ ...editForm, status: event.target.value })} /></label>
                  <label className="mt-3 block text-sm">Données métier JSON<textarea rows={9} className="mt-1 w-full rounded-lg border border-slate-200 p-3 font-mono text-xs" value={editForm.data} onChange={(event) => setEditForm({ ...editForm, data: event.target.value })} /></label>
                  <button disabled={busy} className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Enregistrer les modifications</button>
                </form>
                <div className="rounded-2xl border border-slate-200 bg-white p-5">
                  <h2 className="font-semibold">Relations</h2><p className="mt-1 text-sm text-slate-500">Les contrôles tenant, RBAC et scopes sont appliqués par l’API.</p>
                  <form onSubmit={createRelation} className="mt-4 grid gap-2 sm:grid-cols-[1fr_150px_auto]"><input required className="rounded-lg border border-slate-200 px-3 py-2 text-sm" placeholder="ID de la fiche liée" value={relationForm.toId} onChange={(event) => setRelationForm({ ...relationForm, toId: event.target.value })} /><input required maxLength={80} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" placeholder="related_to" value={relationForm.relationType} onChange={(event) => setRelationForm({ ...relationForm, relationType: event.target.value })} /><button disabled={busy} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50">Lier</button></form>
                  <div className="mt-4 divide-y divide-slate-100">{relations.length ? relations.map((item) => <div key={item.relation.id} className="flex items-center justify-between gap-3 py-3"><button type="button" onClick={() => void openRecord(item.related)} className="min-w-0 text-left hover:text-blue-700"><strong className="block truncate text-sm">{item.related.title}</strong><span className="text-xs text-slate-500">{item.relation.relationType} · {item.related.type}</span></button><button disabled={busy} type="button" onClick={() => void deleteRelation(item.relation.id)} className="rounded border border-red-200 px-2 py-1 text-xs text-red-700">Supprimer</button></div>) : <p className="py-4 text-sm text-slate-500">Aucune relation visible.</p>}</div>
                </div>
              </section> : null}
            </>
          ) : null}

          {view === "config" ? <div className="grid gap-5 xl:grid-cols-[1fr_420px]"><div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="mb-4 flex items-center justify-between"><div><h2 className="font-semibold">Studio de configuration</h2><p className="text-sm text-slate-500">Objets, champs, pipelines, formulaires et automatisations, avec version active visible.</p></div><button onClick={() => void loadConfigurations()} className="rounded-lg border px-3 py-2 text-sm">Actualiser</button></div>{isAdmin ? <div className="mb-5 flex flex-wrap gap-2">{["services", "appointments", "field-service"].map((key) => <button disabled={busy} key={key} onClick={() => void applyTemplate(key)} className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white">Template {key}</button>)}</div> : null}<div className="divide-y divide-slate-100">{configs.length === 0 ? <p className="py-8 text-sm text-slate-500">Aucune configuration active dans votre périmètre.</p> : configs.map((item) => <div key={item.id} className="py-4"><div className="flex flex-wrap justify-between gap-3"><div><strong className="text-sm">{item.name}</strong><p className="mt-1 text-xs text-slate-500">{item.kind} · clé {String(item.definition.key ?? item.id)}</p></div><span className={`h-fit rounded-full px-2 py-1 text-xs ${item.active ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-500"}`}>v{item.version} · {item.active ? "Actif" : "Inactif"}</span></div><details className="mt-3 rounded-lg border border-slate-100 p-3"><summary className="cursor-pointer text-xs font-medium">Afficher la définition</summary><pre className="mt-2 max-h-48 overflow-auto rounded bg-slate-950 p-3 text-[11px] text-slate-100">{pretty(item.definition)}</pre></details>{isAdmin ? <details className="mt-2 rounded-lg border border-slate-100 p-3" onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open && !configHistory[item.id]) void loadHistory(item.id); }}><summary className="cursor-pointer text-xs font-medium">Historique et restauration</summary><div className="mt-2 space-y-2">{(configHistory[item.id] ?? []).map((version) => <div key={version.version} className="flex items-center justify-between gap-2 text-xs"><span>v{version.version} · {version.active ? "actif" : "inactif"}</span>{version.version !== item.version ? <button disabled={busy} type="button" onClick={() => void restoreVersion(item.id, version.version)} className="rounded border px-2 py-1">Restaurer</button> : <span className="text-green-700">Version courante</span>}</div>)}</div></details> : null}</div>)}</div></div>{isAdmin ? <form onSubmit={createConfiguration} className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Nouvelle configuration</h2><p className="mt-1 text-sm text-slate-500">Les champs avancés restent disponibles sans surcharger le parcours principal.</p><label className="mt-4 block text-sm">Type<select className="mt-1 w-full rounded-lg border px-3 py-2" value={configForm.kind} onChange={(event) => setConfigForm({ kind: event.target.value, name: "Nouvelle configuration", definition: pretty(CONFIG_EXAMPLES[event.target.value] ?? {}) })}>{Object.keys(CONFIG_EXAMPLES).map((key) => <option key={key}>{key}</option>)}</select></label><label className="mt-3 block text-sm">Nom<input required className="mt-1 w-full rounded-lg border px-3 py-2" value={configForm.name} onChange={(event) => setConfigForm({ ...configForm, name: event.target.value })} /></label><details className="mt-3 rounded-lg border border-slate-200 p-3" open><summary className="cursor-pointer text-sm font-medium">Définition avancée (JSON)</summary><textarea required rows={14} className="mt-3 w-full rounded-lg border p-3 font-mono text-xs" value={configForm.definition} onChange={(event) => setConfigForm({ ...configForm, definition: event.target.value })} /><p className="mt-2 text-xs text-slate-500">La validation complète et les permissions restent côté serveur.</p></details><button disabled={busy} className="mt-3 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white">Créer et versionner</button></form> : <div className="rounded-2xl border bg-white p-5 text-sm text-slate-500">Lecture seule pour le profil utilisateur. Les actions d’administration sont contrôlées par le serveur.</div>}</div> : null}

          {view === "forms" ? <div className="grid gap-5 xl:grid-cols-[280px_1fr]"><div className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Formulaires actifs</h2><p className="mt-1 text-sm text-slate-500">Choisissez un parcours configuré par votre équipe.</p><div className="mt-4 divide-y">{forms.length === 0 ? <p className="py-6 text-sm text-slate-500">Aucun formulaire publié.</p> : forms.map((item) => <button key={item.id} onClick={() => { const key = String(item.definition.key ?? ""); setSelectedFormKey(key); setFormFieldValues({}); }} className={`w-full rounded-lg py-3 text-left ${selectedFormKey === String(item.definition.key ?? "") ? "bg-blue-50 px-3" : ""}`}><strong className="text-sm">{item.name}</strong><p className="text-xs text-slate-500">{String(item.definition.key ?? "")} · {Array.isArray(item.definition.fields) ? item.definition.fields.length : 0} champs</p></button>)}</div></div><form onSubmit={submitConfiguredForm} className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">{selectedForm?.name ?? "Soumettre un formulaire"}</h2><p className="mt-1 text-sm text-slate-500">Les champs requis sont indiqués. La validation métier reste côté serveur.</p>{selectedForm ? <div className="mt-5 space-y-4">{selectedFormFields.map((field, index) => { const key = typeof field.key === "string" ? field.key : `field_${index + 1}`; const label = typeof field.label === "string" ? field.label : key; const fieldType = typeof field.type === "string" ? field.type : "text"; const value = formFieldValues[key] ?? ""; const common = { className: "mt-1 w-full rounded-lg border border-slate-200 px-3 py-2", value, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setFormFieldValues((current) => ({ ...current, [key]: event.target.value })) }; return <label key={key} className="block text-sm">{label}{field.required ? <span className="ml-1 text-red-600">*</span> : null}{fieldType === "textarea" ? <textarea {...common} rows={4} /> : <input {...common} type={fieldType === "number" || fieldType === "email" || fieldType === "date" ? fieldType : "text"} />}</label>; })}</div> : <div className="mt-5 rounded-lg border border-dashed p-4 text-sm text-slate-500">Sélectionnez un formulaire pour afficher ses champs.</div>}<button disabled={busy || !selectedFormKey} className="mt-5 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white">Valider et créer</button></form></div> : null}

          {view === "automations" ? <div className="grid gap-5 xl:grid-cols-[1fr_420px]"><div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold">Workflow builder</h2><p className="mt-1 text-sm text-slate-500">Visualisation des workflows existants, sans créer de second moteur.</p></div><button onClick={() => setView("config")} className="rounded-lg border px-3 py-2 text-sm">Configurer</button></div><div className="mt-5 space-y-4">{automationConfigs.length === 0 ? <p className="rounded-lg border border-dashed p-6 text-sm text-slate-500">Aucune automatisation configurée.</p> : automationConfigs.map((item) => <article key={item.id} className="rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-medium">{item.name}</h3><p className="text-xs text-slate-500">{String(item.definition.key ?? item.id)} · v{item.version}</p></div>{isAdmin ? <button disabled={busy} onClick={() => void toggleAutomation(item)} className={`rounded-lg px-3 py-2 text-xs font-medium ${item.active ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-600"}`}>{item.active ? "Actif · désactiver" : "Inactif · activer"}</button> : <span className="text-xs text-slate-500">{item.active ? "Actif" : "Inactif"}</span>}</div><div className="mt-4 grid gap-3 md:grid-cols-3"><WorkflowStep title="Déclencheur" value={formatWorkflowValue(item.definition.trigger)} /><WorkflowStep title="Conditions" value={formatWorkflowValue(item.definition.conditions)} /><WorkflowStep title="Actions" value={formatWorkflowValue(item.definition.actions)} /></div><details className="mt-4"><summary className="cursor-pointer text-xs font-medium">Voir le flux complet</summary><pre className="mt-2 max-h-52 overflow-auto rounded-lg bg-slate-950 p-3 text-[11px] text-slate-100">{pretty(item.definition)}</pre></details></article>)}</div></div><aside className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Exécutions réelles</h2><p className="mb-4 mt-1 text-sm text-slate-500">Journal auditable, limité au tenant courant.</p><pre className="max-h-[520px] overflow-auto rounded-xl bg-slate-950 p-4 text-xs text-slate-100">{pretty(automationRuns)}</pre></aside></div> : null}
          {view === "notifications" ? <div className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">Notifications internes</h2><p className="mt-1 text-sm text-slate-500">{unreadNotifications} non lue(s), persistées par tenant et destinataire.</p><div className="mt-5 divide-y divide-slate-100">{notifications.length ? notifications.map((item) => <div key={item.id} className="flex items-start justify-between gap-4 py-4"><div><strong className="text-sm">{item.message}</strong><p className="mt-1 text-xs text-slate-500">{item.type} · {new Date(item.createdAt).toLocaleString("fr-FR")}</p>{item.resourceId ? <button onClick={() => void openNotificationResource(item)} className="mt-2 text-xs text-blue-700">Voir la ressource liée</button> : null}</div>{item.readAt ? <span className="text-xs text-slate-500">Lu</span> : <button onClick={() => void markNotificationRead(item.id)} className="rounded border px-2 py-1 text-xs">Marquer lue</button>}</div>) : <p className="py-8 text-sm text-slate-500">Aucune notification.</p>}</div></div> : null}
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

function filterOperators(field: string): Array<[string, string]> {
  if (field === "createdAt" || field === "updatedAt") return [["before", "avant"], ["after", "après"], ["gte", "à partir de"], ["lte", "jusqu’à"], ["eq", "égal"]];
  if (field.startsWith("data.")) return [["eq", "égal"], ["ne", "différent"], ["gte", "≥"], ["lte", "≤"], ["gt", ">"], ["lt", "<"], ["contains", "contient"]];
  return [["contains", "contient"], ["eq", "égal"], ["ne", "différent"]];
}

function defaultFilterOperator(field: string) { return filterOperators(field)[0][0]; }

function formatCents(value: number) {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value / 100);
}
