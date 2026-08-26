// pb.ts — dependency-free PocketBase browser client for Brotea apps.
// The instance URL is inlined at build time (C1 contract); at runtime the
// <meta name="pb-url"> tag is the fallback so plain scripts can use it too.
// Covers what factory apps need: password auth, CRUD, files and realtime.

const PB_URL: string =
  (import.meta.env.PUBLIC_PB_URL as string | undefined)?.trim() ||
  (typeof document !== 'undefined'
    ? document.querySelector('meta[name="pb-url"]')?.getAttribute('content') || ''
    : '');

const TOKEN_KEY = 'pb_token';

export const pbUrl = () => PB_URL;
export const authToken = () => (typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null);
export const isLoggedIn = () => !!authToken();
export const logout = () => localStorage.removeItem(TOKEN_KEY);

/**
 * Install a token obtained somewhere other than `login()` — today that means
 * the `auth` brick, which trades a Brotea identity for a PocketBase token.
 * Everything downstream (CRUD, files, realtime) then works unchanged: this
 * module stays the single place that knows where the token lives.
 */
export const setAuthToken = (token: string) => localStorage.setItem(TOKEN_KEY, token);

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (!(init.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const token = authToken();
  if (token) headers['Authorization'] = token;
  const res = await fetch(`${PB_URL}${path}`, { ...init, headers });
  if (!res.ok) throw new Error(`pb ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? (undefined as T) : res.json();
}

/** Password login against a PocketBase auth collection (default: users). */
export async function login(identity: string, password: string, collection = 'users') {
  const data = await request<{ token: string; record: unknown }>(
    `/api/collections/${collection}/auth-with-password`,
    { method: 'POST', body: JSON.stringify({ identity, password }) },
  );
  localStorage.setItem(TOKEN_KEY, data.token);
  return data.record;
}

export interface ListResult<T> {
  page: number;
  perPage: number;
  totalItems: number;
  /** PocketBase sends this; it used to be missing here, so callers guessed. */
  totalPages: number;
  items: T[];
}

export const list = <T>(collection: string, params: Record<string, string> = {}) =>
  request<ListResult<T>>(`/api/collections/${collection}/records?${new URLSearchParams(params)}`);

/**
 * Every row, not the first page of them.
 *
 * `list()` returns one page, and every screen in the fleet treated that page as
 * the whole set: the estate agency's CRM asked for 200 rows while the database
 * held 226 leads and 265 properties, so 26 clients and 65 properties were
 * simply not on screen with nothing saying so. A list that silently stops is
 * worse than one that fails, because the failure is invisible until somebody
 * asks where a record went.
 *
 * The cap is not a formality: without it, a collection that grows past what a
 * browser can hold turns a page into a hang. Reaching it warns rather than
 * truncating quietly — the whole point is that shortfalls are never silent.
 *
 * `read` exists so the paging loop can be tested without a server.
 */
export async function listAll<T>(
  collection: string,
  params: Record<string, string> = {},
  opts: { perPage?: number; maxPages?: number; read?: typeof list } = {},
): Promise<T[]> {
  const perPage = opts.perPage ?? 500;
  const maxPages = opts.maxPages ?? 20;
  const read = opts.read ?? list;
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await read<T>(collection, { ...params, perPage: String(perPage), page: String(page) });
    out.push(...res.items);
    if (!res.items.length) break;
    if (res.totalItems !== undefined && out.length >= res.totalItems) break;
    if (res.totalPages !== undefined && page >= res.totalPages) break;
    if (page === maxPages) {
      console.warn(`[pb] ${collection}: stopped at ${out.length} of ${res.totalItems} rows (page cap)`);
    }
  }
  return out;
}

export const getOne = <T>(collection: string, id: string) =>
  request<T>(`/api/collections/${collection}/records/${id}`);

/** Pass a FormData to upload files, or a plain object for JSON fields. */
export const create = <T>(collection: string, data: object | FormData) =>
  request<T>(`/api/collections/${collection}/records`, {
    method: 'POST', body: data instanceof FormData ? data : JSON.stringify(data),
  });

export const update = <T>(collection: string, id: string, data: object | FormData) =>
  request<T>(`/api/collections/${collection}/records/${id}`, {
    method: 'PATCH', body: data instanceof FormData ? data : JSON.stringify(data),
  });

export const remove = (collection: string, id: string) =>
  request<void>(`/api/collections/${collection}/records/${id}`, { method: 'DELETE' });

export const fileUrl = (record: { collectionId: string; id: string }, filename: string) =>
  `${PB_URL}/api/files/${record.collectionId}/${record.id}/${filename}`;

/**
 * Realtime via PocketBase's SSE protocol: open the stream, then register the
 * topics with the clientId it hands us. Returns an unsubscribe function.
 */
export function subscribe(
  topics: string[],
  onEvent: (topic: string, data: { action: string; record: unknown }) => void,
): () => void {
  const es = new EventSource(`${PB_URL}/api/realtime`);
  es.addEventListener('PB_CONNECT', async (e) => {
    const { clientId } = JSON.parse((e as MessageEvent).data);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = authToken();
    if (token) headers['Authorization'] = token;
    await fetch(`${PB_URL}/api/realtime`, {
      method: 'POST', headers,
      body: JSON.stringify({ clientId, subscriptions: topics }),
    });
  });
  for (const t of topics) {
    es.addEventListener(t, (e) => onEvent(t, JSON.parse((e as MessageEvent).data)));
  }
  return () => es.close();
}
