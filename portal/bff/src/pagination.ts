// Cursor pagination per 05-programming.md §3: `?cursor=&limit=`, default limit
// 100, hard maximum 1000. Cursors are opaque to clients; only the server
// encodes/decodes them.

export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 1000;

export interface Pagination {
  readonly cursor: string | null;
  readonly limit: number;
}

export interface CursorPage<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

export function clampLimit(value: unknown): number {
  if (value === null || value === undefined || value === "") {
    return DEFAULT_PAGE_LIMIT;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return DEFAULT_PAGE_LIMIT;
  }
  if (parsed < 1) {
    return 1;
  }
  if (parsed > MAX_PAGE_LIMIT) {
    return MAX_PAGE_LIMIT;
  }
  return parsed;
}

export function parsePagination(query: URLSearchParams): Pagination {
  const rawCursor = query.get("cursor");
  const cursor = rawCursor !== null && rawCursor.length > 0 ? rawCursor : null;
  return { cursor, limit: clampLimit(query.get("limit")) };
}

export function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | null): number {
  if (cursor === null || cursor.length === 0) {
    return 0;
  }
  const decoded = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Number.isInteger(decoded) || decoded < 0) {
    return 0;
  }
  return decoded;
}

export function paginate<T>(items: readonly T[], pagination: Pagination): CursorPage<T> {
  const start = decodeCursor(pagination.cursor);
  const page = items.slice(start, start + pagination.limit);
  const nextOffset = start + page.length;
  return {
    items: page,
    nextCursor: nextOffset < items.length ? encodeCursor(nextOffset) : null,
  };
}
