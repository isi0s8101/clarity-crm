"use client";

import { HelpDrawer } from "./help-drawer";

export function HelpButton({ open, onOpenChange, view, recordType, action }: { open: boolean; onOpenChange: (open: boolean) => void; view: string; recordType?: string; action?: string }) {
  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        ? Aide
      </button>
      <HelpDrawer open={open} onOpenChange={onOpenChange} view={view} recordType={recordType} action={action} />
    </>
  );
}