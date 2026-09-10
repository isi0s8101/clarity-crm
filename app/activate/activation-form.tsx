"use client";

import { FormEvent, useState } from "react";
import { useSearchParams } from "next/navigation";

export function ActivationForm() {
  const params = useSearchParams();
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const email = params.get("email") ?? "";
  const token = params.get("token") ?? "";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirm) {
      setError("Les mots de passe ne correspondent pas.");
      return;
    }
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, token, displayName, password }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; loginRequired?: boolean; returnTo?: string };
      if (!response.ok) throw new Error(payload.error ?? "Activation refusée.");
      window.location.assign(payload.loginRequired ? `/login?returnTo=${encodeURIComponent("/")}` : (payload.returnTo ?? "/"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Activation refusée.");
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[.16em] text-blue-600">Clarity CRM</p>
      <h1 className="mt-2 text-2xl font-semibold">Activer votre compte</h1>
      <p className="mt-2 text-sm text-slate-500">{email || "Invitation invalide"}</p>
      <label className="mt-6 block text-sm">Nom affiché
        <input required maxLength={160} value={displayName} onChange={(event) => setDisplayName(event.target.value)} className="mt-2 w-full rounded-lg border px-3 py-2.5" />
      </label>
      <label className="mt-4 block text-sm">Mot de passe
        <input required type="password" autoComplete="new-password" minLength={12} maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 w-full rounded-lg border px-3 py-2.5" />
      </label>
      <label className="mt-4 block text-sm">Confirmation
        <input required type="password" autoComplete="new-password" minLength={12} maxLength={256} value={confirm} onChange={(event) => setConfirm(event.target.value)} className="mt-2 w-full rounded-lg border px-3 py-2.5" />
      </label>
      {error ? <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
      <button disabled={busy || !email || !token} className="mt-6 w-full rounded-lg bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
        {busy ? "Activation…" : "Activer le compte"}
      </button>
    </form>
  );
}
