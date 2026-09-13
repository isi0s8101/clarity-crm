"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import styles from "./v12-workspace.module.css";

type Tab = "planning" | "public" | "inbox" | "quality" | "intelligence" | "admin";
type Session = { email: string; displayName: string; role: string; tenantId: string; teamId: string };
type Slot = { startsAt: string; endsAt: string; timezone: string };
type Conversation = { id: string; subject: string; status: string; unreadCount: number; relatedRecordId: string | null; assigneeId: string | null; lastMessageAt: string | null };
type InboxMessage = { id: string; direction: string; senderKind: string; body: string; createdAt: string; readAt: string | null };
type Publication = { id: string; publicId: string; kind: string; objectType: string; status: string; formName: string; formKey: string; expiresAt: string | null };
type ConfigItem = { id: string; kind: string; name: string; version: number; active: boolean; definition: Record<string, unknown> };
type DuplicateCandidate = { recordId: string; title: string; classification: string; confidence: number; reasons: Array<{ criterionId: string; kind: string; reason: string; compared: string }> };
type Recommendation = { id: string; action: string; reason: string; priority: number; dueAt: string | null; requiresConfirmation: boolean; triggeringData: Record<string, unknown> };

const CONFIG_KINDS = ["availability", "duplicate_rule", "scoring_rule", "inactivity_rule", "next_action_rule"] as const;

export function V12Workspace() {
  const [tab, setTab] = useState<Tab>("planning");
  const [session, setSession] = useState<Session | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const request = useCallback(async (url: string, init?: RequestInit) => {
    const response = await fetch(url, init);
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`);
    return payload;
  }, []);

  const run = useCallback(async <T,>(operation: () => Promise<T>) => {
    setBusy(true); setError(""); setMessage("");
    try { return await operation(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Erreur inconnue."); return undefined; }
    finally { setBusy(false); }
  }, []);

  useEffect(() => {
    request("/api/session")
      .then((payload) => setSession((payload.user ?? null) as Session | null))
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Session indisponible."));
  }, [request]);

  return (
    <section className={styles.workspace} aria-label="Clarity CRM v1.2">
      <div className={styles.header}>
        <div>
          <h2>Clarity CRM v1.2 — espace proactif</h2>
          <p>Planning avancé, publications publiques, Inbox CRM, qualité des données, scoring explicable et Next Best Action dans le shell existant.</p>
        </div>
        <span className={styles.badge}>{session ? `${session.displayName} · ${session.role}` : "session…"}</span>
      </div>
      <nav className={styles.tabs} aria-label="Fonctions v1.2">
        {([
          ["planning", "Planning"], ["public", "Public"], ["inbox", "Inbox"], ["quality", "Doublons / fusion"],
          ["intelligence", "Scoring / NBA"], ["admin", "Administration"],
        ] as Array<[Tab, string]>).map(([key, label]) => (
          <button key={key} type="button" className={`${styles.tab} ${tab === key ? styles.tabActive : ""}`} onClick={() => setTab(key)}>{label}</button>
        ))}
      </nav>
      {error ? <div className={`${styles.notice} ${styles.error}`} role="alert">{error}</div> : null}
      {message ? <div className={styles.notice} role="status">{message}</div> : null}
      {tab === "planning" ? <PlanningPanel session={session} request={request} run={run} busy={busy} notify={setMessage} /> : null}
      {tab === "public" ? <PublicPanel request={request} run={run} busy={busy} notify={setMessage} /> : null}
      {tab === "inbox" ? <InboxPanel request={request} run={run} busy={busy} notify={setMessage} /> : null}
      {tab === "quality" ? <QualityPanel request={request} run={run} busy={busy} notify={setMessage} /> : null}
      {tab === "intelligence" ? <IntelligencePanel request={request} run={run} busy={busy} notify={setMessage} /> : null}
      {tab === "admin" ? <AdminPanel session={session} request={request} run={run} busy={busy} notify={setMessage} /> : null}
    </section>
  );
}

type Shared = {
  request: (url: string, init?: RequestInit) => Promise<Record<string, unknown>>;
  run: <T>(operation: () => Promise<T>) => Promise<T | undefined>;
  busy: boolean;
  notify: (message: string) => void;
};

function PlanningPanel({ session, request, run, busy, notify }: Shared & { session: Session | null }) {
  const now = useMemo(() => new Date(), []);
  const [from, setFrom] = useState(toLocalInput(now));
  const [to, setTo] = useState(toLocalInput(new Date(now.getTime() + 7 * 86_400_000)));
  const [title, setTitle] = useState("Rendez-vous CRM");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [reservations, setReservations] = useState<Array<Record<string, unknown>>>([]);

  const teamId = session?.teamId ?? "";
  const queryBase = () => {
    if (!teamId) throw new Error("Équipe de session indisponible.");
    return new URLSearchParams({ resourceKind: "team", resourceId: teamId, from: toIso(from), to: toIso(to) });
  };

  const loadAvailability = async () => {
    const payload = await run(async () => request(`/api/planning?mode=availability&${queryBase()}`));
    if (!payload) return;
    const availability = payload as { slots?: Slot[] };
    setSlots(Array.isArray(availability.slots) ? availability.slots : []);
    notify(`${Array.isArray(availability.slots) ? availability.slots.length : 0} créneau(x) disponible(s).`);
  };
  const loadReservations = async () => {
    const payload = await run(async () => request(`/api/planning?mode=reservations&${queryBase()}`));
    if (!payload) return;
    setReservations(Array.isArray(payload.items) ? payload.items as Array<Record<string, unknown>> : []);
  };
  const book = async (slot: Slot) => {
    if (!teamId) return;
    const payload = await run(async () => request("/api/planning", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, startsAt: slot.startsAt, endsAt: slot.endsAt, timezone: slot.timezone, resourceKind: "team", resourceId: teamId, idempotencyKey: crypto.randomUUID() }),
    }));
    if (!payload) return;
    notify("Rendez-vous réservé après revalidation serveur du créneau.");
    await Promise.all([loadAvailability(), loadReservations()]);
  };

  return <div className={styles.grid}>
    <article className={styles.card}>
      <h3>Disponibilités et créneaux</h3>
      <div className={styles.form}>
        <label className={styles.label}>Début<input className={styles.input} type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label className={styles.label}>Fin<input className={styles.input} type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <label className={styles.label}>Objet du rendez-vous<input className={styles.input} value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} /></label>
        <div className={styles.row}><button className={styles.button} disabled={busy || !teamId} onClick={() => void loadAvailability()}>Rechercher les créneaux</button><button className={styles.button} disabled={busy || !teamId} onClick={() => void loadReservations()}>Actualiser le planning</button></div>
      </div>
      <div className={styles.list}>
        {slots.slice(0, 40).map((slot) => <div className={styles.item} key={slot.startsAt}>
          <strong>{formatDate(slot.startsAt)} → {formatTime(slot.endsAt)}</strong>
          <div className={styles.meta}>{slot.timezone}</div>
          <button className={styles.button} disabled={busy || !title.trim()} onClick={() => void book(slot)}>Réserver ce créneau</button>
        </div>)}
        {!slots.length ? <p className={styles.meta}>Aucun créneau chargé. Une règle de disponibilité active est nécessaire.</p> : null}
      </div>
    </article>
    <article className={styles.card}>
      <h3>Rendez-vous réservés</h3>
      <div className={styles.list}>{reservations.map((item) => <div className={styles.item} key={String(item.id)}>
        <strong>{String(item.title ?? "Rendez-vous")}</strong>
        <div className={styles.meta}>{formatDate(String(item.startsAt))} → {formatTime(String(item.endsAt))}</div>
        <div className={styles.meta}>Ressource {String(item.resourceKind)} · {String(item.status)}</div>
      </div>)}</div>
    </article>
  </div>;
}

function PublicPanel({ request, run, busy, notify }: Shared) {
  const [items, setItems] = useState<Publication[]>([]);
  const [formKey, setFormKey] = useState("appointment_booking");
  const [kind, setKind] = useState("appointment_booking");
  const [fields, setFields] = useState("title,email,phone");

  const load = async () => {
    const payload = await run(async () => request("/api/publications"));
    if (payload) setItems(Array.isArray(payload.items) ? payload.items as Publication[] : []);
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const exposedFields = fields.split(",").map((value) => value.trim()).filter(Boolean);
    const payload = await run(async () => request("/api/publications", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ formKey, kind, exposedFields, policy: { rateLimitPerHour: 20 } }),
    }));
    if (!payload) return;
    notify("Publication explicite créée avec identifiant opaque.");
    await load();
  };
  const revoke = async (id: string) => {
    if (!window.confirm("Révoquer cette publication publique ?")) return;
    const payload = await run(async () => request("/api/publications", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }));
    if (!payload) return;
    notify("Publication révoquée."); await load();
  };

  return <div className={styles.grid}>
    <article className={styles.card}><h3>Publier un formulaire</h3><form className={styles.form} onSubmit={create}>
      <label className={styles.label}>Clé du formulaire interne<input className={styles.input} value={formKey} onChange={(event) => setFormKey(event.target.value)} /></label>
      <label className={styles.label}>Type de publication<select className={styles.select} value={kind} onChange={(event) => setKind(event.target.value)}><option value="appointment_booking">Réservation</option><option value="form">Formulaire public</option></select></label>
      <label className={styles.label}>Champs explicitement exposés<input className={styles.input} value={fields} onChange={(event) => setFields(event.target.value)} /></label>
      <div className={styles.row}><button className={styles.button} disabled={busy}>Publier</button><button type="button" className={styles.button} disabled={busy} onClick={() => void load()}>Actualiser</button></div>
    </form></article>
    <article className={styles.card}><h3>Publications</h3><div className={styles.list}>{items.map((item) => <div className={styles.item} key={item.id}>
      <strong>{item.formName} · {item.kind}</strong><div className={styles.meta}>ID public : {item.publicId}</div><div className={styles.meta}>Statut : {item.status}{item.expiresAt ? ` · expire ${formatDate(item.expiresAt)}` : ""}</div>
      <div className={styles.row}>{item.status === "active" ? <><a className={styles.button} href={item.kind === "appointment_booking" ? `/public/booking/${item.publicId}` : `/public/forms/${item.publicId}`} target="_blank" rel="noreferrer">Ouvrir</a><button className={styles.button} disabled={busy} onClick={() => void revoke(item.id)}>Révoquer</button></> : null}</div>
    </div>)}</div></article>
  </div>;
}

function InboxPanel({ request, run, busy, notify }: Shared) {
  const [items, setItems] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [subject, setSubject] = useState("");
  const [relatedRecordId, setRelatedRecordId] = useState("");
  const [body, setBody] = useState("");
  const [query, setQuery] = useState("");

  const load = async () => {
    const params = new URLSearchParams(); if (query.trim()) params.set("q", query.trim());
    const payload = await run(async () => request(`/api/inbox?${params}`));
    if (payload) setItems(Array.isArray(payload.items) ? payload.items as Conversation[] : []);
  };
  const open = async (conversation: Conversation) => {
    const payload = await run(async () => request(`/api/inbox?conversationId=${encodeURIComponent(conversation.id)}`));
    if (!payload) return;
    setSelected(payload.item as Conversation); setMessages(Array.isArray(payload.messages) ? payload.messages as InboxMessage[] : []);
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const payload = await run(async () => request("/api/inbox", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subject, relatedRecordId: relatedRecordId || null }) }));
    if (!payload) return;
    setSubject(""); notify("Conversation CRM créée."); await load();
  };
  const send = async (event: FormEvent) => {
    event.preventDefault(); if (!selected) return;
    const payload = await run(async () => request("/api/inbox", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent: "message", conversationId: selected.id, body, direction: "internal" }) }));
    if (!payload) return;
    setBody(""); notify("Message interne ajouté."); await open(selected);
  };
  const markRead = async () => {
    if (!selected) return;
    const payload = await run(async () => request("/api/inbox", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: selected.id, markRead: true }) }));
    if (!payload) return;
    notify("Conversation marquée comme lue."); await Promise.all([open(selected), load()]);
  };

  return <div className={styles.grid}>
    <article className={styles.card}><h3>Conversations</h3><div className={styles.row}><input className={styles.input} placeholder="Rechercher…" value={query} onChange={(event) => setQuery(event.target.value)} /><button className={styles.button} disabled={busy} onClick={() => void load()}>Rechercher</button></div>
      <form className={styles.form} onSubmit={create}><label className={styles.label}>Objet<input className={styles.input} value={subject} onChange={(event) => setSubject(event.target.value)} required /></label><label className={styles.label}>Fiche CRM liée (optionnel)<input className={styles.input} value={relatedRecordId} onChange={(event) => setRelatedRecordId(event.target.value)} /></label><button className={styles.button} disabled={busy}>Nouvelle conversation</button></form>
      <div className={styles.list}>{items.map((item) => <button type="button" className={styles.item} key={item.id} onClick={() => void open(item)}><strong>{item.subject}</strong><span className={styles.meta}>{item.status} · {item.unreadCount} non lu(s)</span></button>)}</div>
    </article>
    <article className={styles.card}><h3>{selected?.subject ?? "Conversation"}</h3>{selected ? <><div className={styles.row}><button className={styles.button} disabled={busy} onClick={() => void markRead()}>Marquer lu</button><span className={styles.meta}>Fiche liée : {selected.relatedRecordId ?? "aucune"}</span></div><div className={styles.list}>{messages.map((item) => <div className={styles.item} key={item.id}><strong>{item.direction} · {item.senderKind}</strong><div>{item.body}</div><div className={styles.meta}>{formatDate(item.createdAt)}</div></div>)}</div><form className={styles.form} onSubmit={send}><textarea className={styles.textarea} value={body} onChange={(event) => setBody(event.target.value)} placeholder="Message interne…" required /><button className={styles.button} disabled={busy}>Ajouter</button></form></> : <p className={styles.meta}>Sélectionnez une conversation.</p>}</article>
  </div>;
}

function QualityPanel({ request, run, busy, notify }: Shared) {
  const [recordId, setRecordId] = useState("");
  const [candidates, setCandidates] = useState<DuplicateCandidate[]>([]);
  const [secondaryId, setSecondaryId] = useState("");
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);

  const detect = async () => {
    const payload = await run(async () => request(`/api/duplicates?recordId=${encodeURIComponent(recordId)}`));
    if (!payload) return;
    setCandidates(Array.isArray(payload.candidates) ? payload.candidates as DuplicateCandidate[] : []); setPreview(null);
    notify(`${Array.isArray(payload.candidates) ? payload.candidates.length : 0} candidat(s) détecté(s), sans fusion automatique.`);
  };
  const previewMerge = async (candidateId: string) => {
    setSecondaryId(candidateId);
    const payload = await run(async () => request("/api/merge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent: "preview", primaryId: recordId, secondaryId: candidateId }) }));
    if (payload) setPreview(payload.item as Record<string, unknown>);
  };
  const merge = async () => {
    if (!secondaryId || !preview) return;
    if (!window.confirm("Confirmer la fusion ? La fiche secondaire sera archivée et la transaction sera auditée.")) return;
    const payload = await run(async () => request("/api/merge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ primaryId: recordId, secondaryId, resolution: {}, confirm: true }) }));
    if (!payload) return;
    notify("Fusion confirmée : fiche secondaire archivée, liens réaffectés et ledger créé."); setPreview(null); setSecondaryId(""); await detect();
  };

  return <div className={styles.grid}>
    <article className={styles.card}><h3>Détection explicable</h3><div className={styles.form}><label className={styles.label}>ID de la fiche principale<input className={styles.input} value={recordId} onChange={(event) => setRecordId(event.target.value)} /></label><button className={styles.button} disabled={busy || !recordId} onClick={() => void detect()}>Détecter</button></div><div className={styles.list}>{candidates.map((item) => <div className={styles.item} key={item.recordId}><strong>{item.title} · {item.classification} · {item.confidence}%</strong>{item.reasons.map((reason) => <div className={styles.reason} key={reason.criterionId}>{reason.reason} <span className={styles.meta}>({reason.compared})</span></div>)}<button className={styles.button} disabled={busy} onClick={() => void previewMerge(item.recordId)}>Comparer</button></div>)}</div></article>
    <article className={styles.card}><h3>Fusion assistée</h3>{preview ? <><p className={styles.meta}>Principal : {recordId} · secondaire : {secondaryId}</p><pre className={styles.pre}>{JSON.stringify(preview, null, 2)}</pre><button className={styles.button} disabled={busy} onClick={() => void merge()}>Confirmer la fusion</button></> : <p className={styles.meta}>La fusion nécessite une prévisualisation puis une confirmation explicite.</p>}</article>
  </div>;
}

function IntelligencePanel({ request, run, busy, notify }: Shared) {
  const [recordId, setRecordId] = useState("");
  const [score, setScore] = useState<Record<string, unknown> | null>(null);
  const [inactivity, setInactivity] = useState<Record<string, unknown> | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);

  const inspect = async () => {
    const inactivityPayload = await run(async () => request(`/api/inactivity?recordId=${encodeURIComponent(recordId)}`));
    if (inactivityPayload) setInactivity(inactivityPayload.item as Record<string, unknown>);
    const scorePayload = await run(async () => request(`/api/scoring?recordId=${encodeURIComponent(recordId)}`));
    if (scorePayload) setScore(scorePayload.item as Record<string, unknown>);
    const nbaPayload = await run(async () => request(`/api/next-actions?recordId=${encodeURIComponent(recordId)}`));
    if (nbaPayload) setRecommendations(Array.isArray(nbaPayload.recommendations) ? nbaPayload.recommendations as Recommendation[] : []);
  };
  const recalc = async () => {
    await run(async () => request("/api/inactivity", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recordId }) }));
    await run(async () => request("/api/scoring", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recordId }) }));
    notify("Inactivité et scoring recalculés côté serveur."); await inspect();
  };
  const accept = async (item: Recommendation) => {
    if (!window.confirm(`Créer la tâche recommandée « ${item.action} » ?`)) return;
    const payload = await run(async () => request("/api/next-actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recordId, recommendationId: item.id }) }));
    if (!payload) return;
    notify("Action recommandée validée par l'utilisateur et matérialisée en tâche CRM."); await inspect();
  };

  const positive = Array.isArray(score?.positiveFactors) ? score?.positiveFactors as Array<Record<string, unknown>> : [];
  const negative = Array.isArray(score?.negativeFactors) ? score?.negativeFactors as Array<Record<string, unknown>> : [];
  return <div className={styles.grid}>
    <article className={styles.card}><h3>Analyse déterministe</h3><div className={styles.form}><label className={styles.label}>ID lead / opportunité / client<input className={styles.input} value={recordId} onChange={(event) => setRecordId(event.target.value)} /></label><div className={styles.row}><button className={styles.button} disabled={busy || !recordId} onClick={() => void inspect()}>Analyser</button><button className={styles.button} disabled={busy || !recordId} onClick={() => void recalc()}>Recalculer et tracer</button></div></div>{score ? <><div className={styles.score}>{String(score.score)}</div><div className={styles.meta}>Niveau {String(score.level)} · {String(score.calculatedAt)}</div><p>{String(score.justification ?? "")}</p><h4>Facteurs positifs</h4>{positive.map((factor) => <div className={styles.reason} key={`${factor.ruleId}:${factor.ruleVersion}`}>+{String(factor.weight)} — {String(factor.reason)}</div>)}<h4>Facteurs négatifs</h4>{negative.map((factor) => <div className={styles.reason} key={`${factor.ruleId}:${factor.ruleVersion}`}>{String(factor.weight)} — {String(factor.reason)}</div>)}</> : null}{inactivity ? <><h4>Inactivité</h4><pre className={styles.pre}>{JSON.stringify(inactivity, null, 2)}</pre></> : null}</article>
    <article className={styles.card}><h3>Next Best Action</h3><div className={styles.list}>{recommendations.map((item) => <div className={styles.item} key={item.id}><strong>P{item.priority} · {item.action}</strong><div className={styles.reason}>{item.reason}</div><div className={styles.meta}>{item.dueAt ? `Échéance ${formatDate(item.dueAt)}` : "Sans échéance"} · confirmation obligatoire</div><details><summary>Données déclenchantes</summary><pre className={styles.pre}>{JSON.stringify(item.triggeringData, null, 2)}</pre></details><button className={styles.button} disabled={busy} onClick={() => void accept(item)}>Valider cette action</button></div>)}{!recommendations.length ? <p className={styles.meta}>Aucune recommandation chargée.</p> : null}</div></article>
  </div>;
}

function AdminPanel({ session, request, run, busy, notify }: Shared & { session: Session | null }) {
  const [kind, setKind] = useState<(typeof CONFIG_KINDS)[number]>("availability");
  const [name, setName] = useState("Disponibilité équipe");
  const [definition, setDefinition] = useState(() => JSON.stringify(defaultDefinition("availability", "TEAM_ID"), null, 2));
  const [items, setItems] = useState<ConfigItem[]>([]);

  useEffect(() => {
    const teamId = session?.teamId ?? "TEAM_ID";
    setDefinition(JSON.stringify(defaultDefinition(kind, teamId), null, 2));
  }, [kind, session?.teamId]);

  const load = async () => {
    const payload = await run(async () => request("/api/configurations/v12"));
    if (payload) setItems(Array.isArray(payload.items) ? payload.items as ConfigItem[] : []);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(definition) as Record<string, unknown>; }
    catch { throw new Error("JSON de configuration invalide."); }
    const payload = await run(async () => request("/api/configurations/v12", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, name, active: true, definition: parsed }) }));
    if (!payload) return;
    notify("Configuration v1.2 créée et versionnée."); await load();
  };

  return <div className={styles.grid}>
    <article className={styles.card}><h3>Règles versionnées</h3><form className={styles.form} onSubmit={save}><label className={styles.label}>Type<select className={styles.select} value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>{CONFIG_KINDS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label className={styles.label}>Nom<input className={styles.input} value={name} onChange={(event) => setName(event.target.value)} /></label><label className={styles.label}>Définition<textarea className={styles.textarea} value={definition} onChange={(event) => setDefinition(event.target.value)} /></label><div className={styles.row}><button className={styles.button} disabled={busy || session?.role !== "admin"}>Créer la règle</button><button type="button" className={styles.button} disabled={busy} onClick={() => void load()}>Actualiser</button></div></form><p className={styles.meta}>Les seuils et poids sont des paramètres administratifs de triage, pas des valeurs métier imposées par le code.</p></article>
    <article className={styles.card}><h3>Configurations v1.2</h3><div className={styles.list}>{items.map((item) => <div className={styles.item} key={item.id}><strong>{item.name}</strong><div className={styles.meta}>{item.kind} · v{item.version} · {item.active ? "active" : "inactive"}</div><details><summary>Définition</summary><pre className={styles.pre}>{JSON.stringify(item.definition, null, 2)}</pre></details></div>)}</div></article>
  </div>;
}

function defaultDefinition(kind: (typeof CONFIG_KINDS)[number], teamId: string): Record<string, unknown> {
  if (kind === "availability") return { key: "team_standard_hours", resourceKind: "team", resourceId: teamId, timezone: "Europe/Paris", weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: "09:00", end: "17:00" })), exceptions: [], durationMinutes: 30, slotMinutes: 15, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 };
  if (kind === "duplicate_rule") return { key: "contacts_duplicates", targetType: "contact", criteria: [{ id: "email_exact", kind: "email", weight: 60, reason: "Adresse e-mail normalisée identique." }, { id: "phone_exact", kind: "phone", weight: 40, reason: "Téléphone normalisé identique." }] };
  if (kind === "scoring_rule") return { key: "lead_score_default", targetType: "lead", bounds: { min: 0, max: 100 }, baseScore: 0, rules: [{ id: "email_present", version: 1, active: true, conditions: [{ field: "email", operator: "exists" }], weight: 10, reason: "Le lead possède un moyen de contact e-mail vérifiable." }] };
  if (kind === "inactivity_rule") return { key: "commercial_inactivity", targetTypes: ["lead", "opportunity", "company", "contact"], inactiveDays: 30, dueSoonDays: 7, requirePlannedAction: true };
  return { key: "lead_next_actions", targetType: "lead", rules: [{ id: "inactive_followup", version: 1, active: true, priority: 70, action: "Relancer le lead", reason: "Le lead est inactif selon la règle configurée.", conditions: [{ field: "inactive", operator: "eq", value: true }], dueInDays: 1 }] };
}

function toLocalInput(date: Date) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}
function toIso(value: string) { const date = new Date(value); if (Number.isNaN(date.getTime())) throw new Error("Date invalide."); return date.toISOString(); }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString("fr-FR"); }
function formatTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }); }
