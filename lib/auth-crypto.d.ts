export function normalizeEmail(value: unknown): string | null;
export function validatePassword(value: unknown): { ok: true } | { ok: false; error: string };
export function hashPassword(password: string): Promise<string>;
export function verifyPassword(password: string, encodedHash: string | null | undefined): Promise<boolean>;
export function randomSessionToken(): string;
export function hashOpaqueToken(value: unknown): string;
export function hashMetadata(value: unknown): string;
export function dummyPasswordHash(): string;
