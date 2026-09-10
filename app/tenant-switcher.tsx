"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Building2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

type TenantItem = {
  tenantId: string;
  name: string;
  role: "admin" | "user";
  teamId: string | null;
  access: "membership" | "invitation";
  status: string;
};

export function TenantSwitcher() {
  const [items, setItems] = useState<TenantItem[]>([]);
  const [currentTenant, setCurrentTenant] = useState("");
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    let active = true;

    Promise.all([
      fetch("/api/tenants").then(async (response) =>
        response.ok ? (response.json() as Promise<{ items: TenantItem[] }>) : { items: [] },
      ),
      fetch("/api/session").then(async (response) =>
        response.ok ? (response.json() as Promise<{ user: { tenantId: string } }>) : null,
      ),
    ])
      .then(([tenantPayload, sessionPayload]) => {
        if (!active) return;
        setItems(Array.isArray(tenantPayload.items) ? tenantPayload.items : []);
        setCurrentTenant(sessionPayload?.user.tenantId ?? "");
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, []);

  if (items.length <= 1) return null;

  const selectTenant = async (tenantId: string) => {
    if (!tenantId || tenantId === currentTenant) return;
    setSwitching(true);
    try {
      const response = await fetch("/api/session/tenant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Sélection de l’organisation refusée.");
      }
      window.location.reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Sélection impossible.");
      setSwitching(false);
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-xl border border-slate-200 bg-white/95 p-2 shadow-lg backdrop-blur">
      <Building2 className="ml-1 size-4 text-slate-500" />
      <Select value={currentTenant || undefined} onValueChange={selectTenant} disabled={switching}>
        <SelectTrigger className="w-[220px] bg-white" aria-label="Organisation active">
          <SelectValue placeholder="Choisir une organisation" />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem
              key={item.tenantId}
              value={item.tenantId}
              disabled={item.access === "membership" && item.status !== "active"}
            >
              {item.name}{item.access === "invitation" ? " · invitation" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {switching ? (
        <Button size="icon" variant="ghost" disabled aria-label="Changement d’organisation en cours">
          <RefreshCw className="size-4 animate-spin" />
        </Button>
      ) : null}
    </div>
  );
}
