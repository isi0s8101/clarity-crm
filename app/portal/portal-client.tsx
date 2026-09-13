"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

 type PortalTicket = {
  id: string;
  title: string;
  status: string;
  priority: string;
  category: string;
  description: string;
  stage: string;
  slaState: string;
  updatedAt: string;
};

type PortalDocument = { id: string; originalName: string; mimeType: string; sizeBytes: number; createdAt: string };

export function PortalClient() {
  const [tickets, setTickets] = useState<PortalTicket[]>([]);
  const [selected, setSelected] = useState<PortalTicket | null>(null);
  const [documents, setDocuments] = useState<PortalDocument[]>([]);
  const [form, setForm] = useState({ title: "", description: "", priority: "normal", category: "support" });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const request = useCallback(async (url: string, init?: RequestInit) => {
    const response = await fetch(url, init);
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`);
    return payload;
  }, []);

  const load = useCallback(async () => {
    try {
      const payload = await request("/api/portal/tickets");
      setTickets(Array.isArray(payload.items) ? payload.items as PortalTicket[] : []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Portail indisponible.");
    }
  }, [request]);

  useEffect(() => { void load(); }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      await request("/api/portal/tickets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
      setForm({ title: "", description: "", priority: "normal", category: "support" });
      setMessage("Ticket créé."); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Création impossible."); }
    finally { setBusy(false); }
  }

  async function open(ticket: PortalTicket) {
    setSelected(ticket); setDocuments([]); setMessage("");
    try {
      const payload = await request(`/api/portal/documents?ticketId=${encodeURIComponent(ticket.id)}`);
      setDocuments(Array.isArray(payload.items) ? payload.items as PortalDocument[] : []);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Documents indisponibles."); }
  }

  async function saveDescription() {
    if (!selected) return; setBusy(true); setMessage("");
    try {
      const payload = await request("/api/portal/tickets", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: selected.id, description: selected.description }) });
      setSelected(payload.item as PortalTicket); setMessage("Mise à jour enregistrée."); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Mise à jour impossible."); }
    finally { setBusy(false); }
  }

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6 md:p-10">
      <header><p className="text-sm text-slate-500">Clarity CRM</p><h1 className="text-3xl font-semibold">Portail client</h1><p className="mt-2 text-sm text-slate-600">Créez et suivez uniquement vos propres demandes.</p></header>
      {message ? <div className="rounded-lg border bg-white p-3 text-sm">{message}</div> : null}
      <section className="grid gap-6 lg:grid-cols-[360px_1fr]">
        <form onSubmit={create} className="space-y-3 rounded-xl border bg-white p-5">
          <h2 className="font-semibold">Nouveau ticket</h2>
          <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Objet de la demande" required />
          <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Décrivez la situation" required rows={6} />
          <div className="grid grid-cols-2 gap-2">
            <select className="rounded-md border p-2 text-sm" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}><option value="low">Basse</option><option value="normal">Normale</option><option value="high">Haute</option><option value="urgent">Urgente</option></select>
            <select className="rounded-md border p-2 text-sm" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}><option value="support">Support</option><option value="sav">SAV</option></select>
          </div>
          <Button disabled={busy} type="submit">Créer</Button>
        </form>
        <div className="space-y-4">
          <div className="rounded-xl border bg-white p-5"><h2 className="font-semibold">Mes tickets</h2><div className="mt-3 space-y-2">{tickets.map((ticket) => <button key={ticket.id} onClick={() => void open(ticket)} className="block w-full rounded-lg border p-3 text-left hover:bg-slate-50"><span className="font-medium">{ticket.title}</span><span className="mt-1 block text-xs text-slate-500">{ticket.category} · {ticket.priority} · {ticket.stage || ticket.status}</span></button>)}{tickets.length === 0 ? <p className="text-sm text-slate-500">Aucun ticket.</p> : null}</div></div>
          {selected ? <div className="space-y-4 rounded-xl border bg-white p-5"><div><h2 className="font-semibold">{selected.title}</h2><p className="text-xs text-slate-500">SLA : {selected.slaState}</p></div><Textarea value={selected.description} onChange={(e) => setSelected({ ...selected, description: e.target.value })} rows={6}/><Button disabled={busy} onClick={() => void saveDescription()}>Enregistrer ma description</Button><div><h3 className="font-medium">Documents autorisés</h3><div className="mt-2 space-y-1">{documents.map((doc) => <a className="block text-sm underline" key={doc.id} href={`/api/portal/documents/download?id=${encodeURIComponent(doc.id)}`}>{doc.originalName}</a>)}{documents.length === 0 ? <p className="text-sm text-slate-500">Aucun document partagé.</p> : null}</div></div></div> : null}
        </div>
      </section>
    </main>
  );
}
