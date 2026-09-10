"use client";

import { useState } from "react";

export function LogoutButton() {
  const [busy, setBusy] = useState(false);
  const logout = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ returnTo: "/login" }),
      });
      if (!response.ok) throw new Error("Déconnexion refusée.");
      window.location.assign("/login");
    } catch {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void logout()}
      disabled={busy}
      className="fixed right-4 top-4 z-50 rounded-lg border border-slate-200 bg-white/95 px-3 py-2 text-xs font-medium text-slate-600 shadow-sm disabled:opacity-50"
    >
      {busy ? "Déconnexion…" : "Déconnexion"}
    </button>
  );
}
