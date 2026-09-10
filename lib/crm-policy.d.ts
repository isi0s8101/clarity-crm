export const CORE_RECORD_TYPES: readonly string[];
export const CONFIG_KINDS: readonly string[];

export type PolicySuccess<T> = { ok: true; value: T };
export type PolicyFailure = { ok: false; error: string };

export type ValidatedRecord = {
  type: string;
  title: string;
  status: string;
  data: Record<string, unknown>;
};

export function normalizeRecordType(value: unknown): string | null;
export function isCoreRecordType(value: unknown): boolean;
export function normalizeRecordStatus(value: unknown, fallback?: string | null): string | null;
export function validateRecordInput(
  input: unknown,
  options?: { type?: string; status?: string },
): PolicySuccess<ValidatedRecord> | PolicyFailure;
export function calculateCommercialDocument(data: Record<string, unknown>): Record<string, unknown> & {
  currency: string;
  lines: Array<Record<string, unknown>>;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
};
export function extractKnownRecordRefs(data: Record<string, unknown>): string[];
export function validateConfiguration(
  kind: string,
  definition: unknown,
): PolicySuccess<Record<string, unknown>> | PolicyFailure;
export function evaluateAutomationConditions(
  conditions: unknown[],
  record: Record<string, unknown>,
): boolean;
export function renderAutomationTemplate(value: unknown, record: Record<string, unknown>): string;
export function normalizeWebhookUrl(
  value: unknown,
  options?: { allowPrivate?: boolean },
): string | null;
export function isValidConfigKind(value: unknown): boolean;
