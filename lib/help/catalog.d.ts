import type { HelpProcedure } from "./types";

export const CORE_RECORD_TYPES: Array<[string, string, string]>;
export const helpCatalog: HelpProcedure[];
export const helpCategories: Array<{ id: string; title: string; contexts: string[] }>;