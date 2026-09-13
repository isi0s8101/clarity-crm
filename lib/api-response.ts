import { NextResponse } from "next/server";

export function apiError(
  message: string,
  status: number,
  code: string,
  details?: unknown,
) {
  return NextResponse.json(
    details === undefined
      ? { error: message, code }
      : { error: message, code, details },
    { status },
  );
}

export function parsePagination(
  searchParams: URLSearchParams,
  options: { defaultLimit?: number; maxLimit?: number; maxOffset?: number } = {},
) {
  const defaultLimit = options.defaultLimit ?? 100;
  const maxLimit = options.maxLimit ?? 200;
  const maxOffset = options.maxOffset ?? 10_000;
  const rawLimit = searchParams.get("limit");
  const rawOffset = searchParams.get("offset");
  const limit = rawLimit === null ? defaultLimit : Number(rawLimit);
  const offset = rawOffset === null ? 0 : Number(rawOffset);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new ApiInputError(`limit doit être un entier entre 1 et ${maxLimit}.`);
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > maxOffset) {
    throw new ApiInputError(`offset doit être un entier entre 0 et ${maxOffset}.`);
  }
  return { limit, offset };
}

export class ApiInputError extends Error {}
