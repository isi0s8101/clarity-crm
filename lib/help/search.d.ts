import type { HelpContext, HelpProcedure } from "./types";

export function searchHelp(query: string, context?: HelpContext, catalog?: HelpProcedure[]): HelpProcedure[];