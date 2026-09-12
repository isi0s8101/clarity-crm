import type { PermissionAction, PermissionScope } from "@/lib/authz";

export type HelpRole = "user" | "admin";

export type HelpPermission = {
  object?: string;
  action?: PermissionAction;
  scope?: PermissionScope;
};

export type HelpStep = {
  title: string;
  instruction: string;
  expected?: string;
};

export type HelpProcedure = {
  id: string;
  version: number;
  title: string;
  description: string;
  roles: HelpRole[];
  contexts: string[];
  permissions?: HelpPermission[];
  recordTypes?: string[];
  prerequisites: string[];
  tags: string[];
  steps: HelpStep[];
  result: string;
  troubleshooting?: {
    condition: string;
    message: string;
    procedureId?: string;
  }[];
};

export type HelpContext = {
  view?: string;
  role?: HelpRole;
  permissions?: HelpPermission[];
  recordType?: string;
  action?: string;
  tenantId?: string;
};

export type HelpProgress = {
  version: number;
  step: number;
  completed: boolean;
};