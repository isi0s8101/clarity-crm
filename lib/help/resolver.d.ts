import type { HelpContext, HelpPermission, HelpProcedure } from "./types";

export function hasPermission(permissions?: HelpPermission[], required?: HelpPermission[]): boolean;
export function procedureVisibleForContext(procedure: HelpProcedure, rawContext?: HelpContext): boolean;
export function filterProcedures(rawContext?: HelpContext, catalog?: HelpProcedure[]): HelpProcedure[];
export function scoreProcedure(procedure: HelpProcedure, rawContext?: HelpContext): number;
export function recommendProcedures(rawContext?: HelpContext, limit?: number, catalog?: HelpProcedure[]): HelpProcedure[];
export function getProcedure(id: string, catalog?: HelpProcedure[]): HelpProcedure | null;