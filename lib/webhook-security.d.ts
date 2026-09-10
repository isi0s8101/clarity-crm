export class WebhookResponseTooLargeError extends Error {
  limitBytes: number;
  constructor(limitBytes: number);
}

export type WebhookTargetValidation =
  | { ok: true; url: string; addresses: string[] }
  | { ok: false; error: string };

export function validateWebhookTargetUrl(
  value: unknown,
  options?: {
    allowPrivate?: boolean;
    allowedHosts?: string | string[] | null;
    resolveHost?: (hostname: string) => Promise<Array<string | { address: string; family?: number }>>;
  },
): Promise<WebhookTargetValidation>;

export function resolveWebhookHost(hostname: string): Promise<Array<{ address: string; family: number }>>;
export function hostMatchesAllowedWebhookHosts(hostname: string, allowedHosts?: string | string[] | null): boolean;
export function parseAllowedHosts(value?: string | string[] | null): string[];
export function isPublicIpAddress(value: unknown): boolean;
export function readLimitedResponseText(response: Response, limitBytes?: number): Promise<string>;
