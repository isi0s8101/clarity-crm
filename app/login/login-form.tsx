"use client";

import { FormEvent, useState } from "react";
import { useSearchParams } from "next/navigation";

export function LoginForm() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          returnTo: searchParams.get("returnTo") ?? "/",
        }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; returnTo?: string };
      if (!response.ok) throw new Error(payload.error ?? "Connexion refusée.");
      window.location.assign(payload.returnTo ?? "/");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Connexion refusée.");
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="mb-7">
        <p className="text-xs font-semibold uppercase tracking-[.16em] text-blue-600">Clarity CRM</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-950">Connexion</h1>
        <p className="mt-2 text-sm text-slate-500">Authentification native Clarity CRM.</p>
      </div>
      <label className="block text-sm font-medium text-slate-700">
        Adresse e-mail
        <input
          required
          autoComplete="username"
          inputMode="email"
          type="email"
          maxLength={254}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-blue-500"
        />
      </label>
      <label className="mt-4 block text-sm font-medium text-slate-700">
        Mot de passe
        <input
          required
          autoComplete="current-password"
          type="password"
          maxLength={256}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-blue-500"
        />
      </label>
      {error ? <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
      <button
        type="submit"
        disabled={busy}
        className="mt-6 w-full rounded-lg bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
      >
        {busy ? "Connexion…" : "Se connecter"}
      </button>
    </form>
  );
}
