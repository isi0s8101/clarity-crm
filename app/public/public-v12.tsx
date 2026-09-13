"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

import styles from "./public-v12.module.css";

type PublicField = { key: string; label: string; type: string; required: boolean };
type PublicMetadata = { publicId: string; kind: string; name: string; fields: PublicField[]; expiresAt: string | null; serviceLabel: string | null; resourceSelection: "fixed" | "public" };
type Slot = { startsAt: string; endsAt: string; timezone: string };

export function PublicBooking({ publicId }: { publicId: string }) {
  const [metadata, setMetadata] = useState<PublicMetadata | null>(null);
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [state, setState] = useState<"loading" | "ready" | "submitting" | "confirmed">("loading");
  const [error, setError] = useState("");
  const [recordId, setRecordId] = useState("");

  useEffect(() => {
    fetch(`/api/public/booking/${encodeURIComponent(publicId)}`)
      .then(async (response) => {
        const payload = await response.json() as { item?: PublicMetadata; error?: string };
        if (!response.ok || !payload.item) throw new Error(payload.error ?? "Publication indisponible.");
        setMetadata(payload.item); setState("ready");
      })
      .catch((cause) => { setError(cause instanceof Error ? cause.message : "Publication indisponible."); setState("ready"); });
  }, [publicId]);

  const dayWindow = useMemo(() => {
    const start = new Date(`${day}T00:00:00`); const end = new Date(start.getTime() + 86_400_000);
    return { from: start.toISOString(), to: end.toISOString() };
  }, [day]);

  const loadSlots = async () => {
    setError(""); setSlot(null);
    try {
      const params = new URLSearchParams(dayWindow);
      const response = await fetch(`/api/public/booking/${encodeURIComponent(publicId)}?${params}`);
      const payload = await response.json() as { availability?: { slots?: Slot[] }; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Disponibilités indisponibles.");
      setSlots(Array.isArray(payload.availability?.slots) ? payload.availability?.slots ?? [] : []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Disponibilités indisponibles."); }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!slot || !metadata) return;
    setState("submitting"); setError("");
    try {
      const response = await fetch(`/api/public/booking/${encodeURIComponent(publicId)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ startsAt: slot.startsAt, endsAt: slot.endsAt, timezone: slot.timezone, values }),
      });
      const payload = await response.json() as { recordId?: string; error?: string };
      if (!response.ok || !payload.recordId) throw new Error(payload.error ?? "Réservation impossible.");
      setRecordId(payload.recordId); setState("confirmed");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Réservation impossible."); setState("ready"); }
  };

  return <main className={styles.shell}><section className={styles.card}>
    <h1>{metadata?.serviceLabel ?? metadata?.name ?? "Réservation"}</h1>
    <p>Choisissez un jour puis un créneau. Le serveur revérifie la disponibilité au moment de confirmer.</p>
    <div className={styles.steps}>{["Service", "Jour", "Créneau", "Informations", "Confirmation"].map((label, index) => <span key={label} className={`${styles.step} ${(state === "confirmed" ? index <= 4 : index <= (slot ? 3 : slots.length ? 2 : 1)) ? styles.active : ""}`}>{label}</span>)}</div>
    {error ? <div className={`${styles.notice} ${styles.error}`} role="alert">{error}</div> : null}
    {state === "loading" ? <p>Chargement…</p> : null}
    {state === "confirmed" ? <div className={styles.notice}><strong>Réservation confirmée.</strong><p>La réservation a été enregistrée. Référence : {recordId}</p></div> : null}
    {state !== "loading" && state !== "confirmed" && metadata ? <form className={styles.form} onSubmit={submit}>
      <label className={styles.label}>Jour<input className={styles.input} type="date" value={day} onChange={(event) => setDay(event.target.value)} /></label>
      <button className={styles.button} type="button" onClick={() => void loadSlots()}>Afficher les créneaux</button>
      <div className={styles.slots}>{slots.map((item) => <button key={item.startsAt} type="button" className={`${styles.slot} ${slot?.startsAt === item.startsAt ? styles.selected : ""}`} onClick={() => setSlot(item)}><strong>{new Date(item.startsAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</strong><div className={styles.meta}>{item.timezone}</div></button>)}</div>
      {slot ? <><div className={styles.notice}>Créneau sélectionné : {new Date(slot.startsAt).toLocaleString("fr-FR")}</div><Fields fields={metadata.fields} values={values} setValues={setValues} /><button className={styles.button} disabled={state === "submitting"}>Confirmer la réservation</button></> : null}
    </form> : null}
    <p className={styles.meta}>Aucune donnée CRM interne, utilisateur CRM ou autre rendez-vous n’est exposé par ce parcours.</p>
  </section></main>;
}

export function PublicForm({ publicId }: { publicId: string }) {
  const [metadata, setMetadata] = useState<PublicMetadata | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [recordId, setRecordId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`/api/public/forms/${encodeURIComponent(publicId)}`)
      .then(async (response) => {
        const payload = await response.json() as { item?: PublicMetadata; error?: string };
        if (!response.ok || !payload.item) throw new Error(payload.error ?? "Publication indisponible.");
        setMetadata(payload.item);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Publication indisponible."));
  }, [publicId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!metadata) return;
    setSubmitting(true); setError("");
    try {
      const response = await fetch(`/api/public/forms/${encodeURIComponent(publicId)}`, {
        method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ values }),
      });
      const payload = await response.json() as { recordId?: string; error?: string };
      if (!response.ok || !payload.recordId) throw new Error(payload.error ?? "Soumission impossible.");
      setRecordId(payload.recordId); setConfirmed(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Soumission impossible."); }
    finally { setSubmitting(false); }
  };

  return <main className={styles.shell}><section className={styles.card}>
    <h1>{metadata?.name ?? "Formulaire"}</h1>
    <p>Seuls les champs explicitement publiés sont affichés et acceptés.</p>
    {error ? <div className={`${styles.notice} ${styles.error}`} role="alert">{error}</div> : null}
    {confirmed ? <div className={styles.notice}><strong>Soumission enregistrée.</strong><p>Référence : {recordId}</p></div> : null}
    {!confirmed && metadata ? <form className={styles.form} onSubmit={submit}><Fields fields={metadata.fields} values={values} setValues={setValues} /><button className={styles.button} disabled={submitting}>{submitting ? "Envoi…" : "Envoyer"}</button></form> : null}
  </section></main>;
}

function Fields({ fields, values, setValues }: { fields: PublicField[]; values: Record<string, string>; setValues: (values: Record<string, string>) => void }) {
  return <>{fields.map((field) => {
    const value = values[field.key] ?? "";
    const common = { value, required: field.required, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setValues({ ...values, [field.key]: event.target.value }) };
    if (field.type === "textarea") return <label className={styles.label} key={field.key}>{field.label}<textarea className={styles.textarea} {...common} /></label>;
    return <label className={styles.label} key={field.key}>{field.label}<input className={styles.input} type={inputType(field.type)} maxLength={4000} {...common} /></label>;
  })}</>;
}

function inputType(type: string) {
  if (["email", "tel", "date", "datetime-local", "number"].includes(type)) return type;
  return "text";
}
