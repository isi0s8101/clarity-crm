export type IntegrationKeyring = { activeKeyId: string; keys: Map<string, Buffer> };
export type IntegrationEnvelope = {
  algorithm: "aes-256-gcm";
  keyId: string;
  ivB64: string;
  authTagB64: string;
  ciphertextB64: string;
};
export function loadIntegrationKeyring(env?: NodeJS.ProcessEnv): IntegrationKeyring;
export function encryptIntegrationValue(value: string, options?: { env?: NodeJS.ProcessEnv; keyring?: IntegrationKeyring; keyId?: string; aad?: string }): IntegrationEnvelope;
export function decryptIntegrationValue(envelope: IntegrationEnvelope, options?: { env?: NodeJS.ProcessEnv; keyring?: IntegrationKeyring; aad?: string }): string;
export function rotateIntegrationEnvelope(envelope: IntegrationEnvelope, options?: { env?: NodeJS.ProcessEnv; keyring?: IntegrationKeyring; aad?: string }): { envelope: IntegrationEnvelope; rotated: boolean };
export function generatePkcePair(): { verifier: string; challenge: string; method: "S256" };
export function randomOpaque(bytes?: number): string;
export function hashOpaque(value: unknown): string;
export function safeHashEqual(expectedHex: string, value: unknown): boolean;
