import type { HelpProcedure, HelpProgress } from "./types";

export function progressStorageKey(procedureId: string): string;
export function normalizeProgress(value: unknown, procedure: HelpProcedure): HelpProgress;
export function readProgress(storage: Storage, procedure: HelpProcedure): HelpProgress;
export function writeProgress(storage: Storage, procedure: HelpProcedure, progress: HelpProgress): HelpProgress;
export function resetProgress(storage: Storage, procedureId: string): void;