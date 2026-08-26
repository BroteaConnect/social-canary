// social.ts — domain vocabulary + PocketBase access for the social calendar.
//
// The enumerations here are the SAME closed sets as pb/schema.json's `select`
// values (docs/social-factory-buildout.md §4.1). If one side changes, both
// change: the UI must never offer a value the collection would reject.
//
// This module is imported by client scripts, so it deliberately does NOT import
// the i18n runtime (that would inline every dictionary into the bundle). Copy
// travels as data: the page renders `runtimeStrings()` into a JSON island and
// the browser reads it back with `copy()`.
import { create, list, remove, update, type ListResult } from './pb';
import { signOutAndAnnounce } from './auth';

export const NETWORKS = ['youtube', 'facebook', 'instagram', 'tiktok', 'linkedin'] as const;
/** Networks the gateway will publish to automatically (F2/F4). */
export const PUBLISHING_NETWORKS = ['youtube', 'facebook', 'instagram', 'tiktok'] as const;
/** LinkedIn's API Terms forbid automated posting: handoff is its only path. */
export const HANDOFF_NETWORKS = ['linkedin'] as const;
export const VARIANT_STATES = [
  'draft', 'scheduled', 'queued', 'published', 'failed', 'handoff', 'skipped',
] as const;
export const POST_STATUSES = [
  'draft', 'in_review', 'approved', 'scheduled', 'published', 'failed',
] as const;
export const ASSET_KINDS = ['image', 'video', 'audio', 'document'] as const;

export type Network = (typeof NETWORKS)[number];
export type VariantState = (typeof VARIANT_STATES)[number];
export type PostStatus = (typeof POST_STATUSES)[number];
export type AssetKind = (typeof ASSET_KINDS)[number];

export const isHandoffNetwork = (n: string): boolean =>
  (HANDOFF_NETWORKS as readonly string[]).includes(n);

/**
 * The only states a handoff network may hold. `scheduled` and `queued` are absent
 * on purpose: F1's runner and F4's gateway will select rows BY STATE, so a
 * LinkedIn row sitting in `queued` is exactly the row automation would pick up —
 * and LinkedIn's API Terms prohibit automated posting (decision 1; a rejected app
 * is burned permanently). A recorded decision cannot depend on an operator not
 * touching a dropdown, so the closed set lives here, next to the vocabulary.
 */
export const HANDOFF_STATES = ['handoff', 'published', 'skipped'] as const;

/** The states this network's variant may legally hold. */
export const statesFor = (n: string): readonly VariantState[] =>
  (isHandoffNetwork(n) ? HANDOFF_STATES : VARIANT_STATES);

export const isAllowedState = (n: string, state: string): boolean =>
  (statesFor(n) as readonly string[]).includes(state);

/** The state a fresh variant starts in — handoff networks are never queued. */
export const initialState = (n: string): VariantState => (isHandoffNetwork(n) ? 'handoff' : 'draft');

export interface Brand {
  id: string;
  name: string;
  /**
   * KNOWN LIMIT (not fixed here): stored and editable, but nothing reads it —
   * the week board and the composer both work in the operator's local time. The
   * brand's clock is F4's, and until it owns it this input has no effect.
   */
  timezone: string;
  default_locale: string;
}

export interface Asset {
  id: string;
  collectionId: string;
  brand: string;
  file: string;
  kind: string;
  alt_text: string;
  checksum: string;
}

export interface Post {
  id: string;
  brand: string;
  title: string;
  body: string;
  slot_at: string;
  status: string;
  approved_by: string;
}

export interface Variant {
  id: string;
  post: string;
  network: string;
  body: string;
  media: string;
  first_comment: string;
  state: string;
  gateway_job_id: string;
  network_url: string;
  telegram_message_id: number;
  last_error: string;
}

// -- dates --------------------------------------------------------------------
// Weeks are Monday-first. The brand's own time zone is F1's job (the plan's
// §4.5); until the clock exists, the operator's local week is the honest view.

export function startOfWeek(from: Date, weekOffset = 0): Date {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - dow + weekOffset * 7);
  return d;
}

export const weekDays = (start: Date): Date[] =>
  Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });

export const endOfWeek = (start: Date): Date => {
  const d = new Date(start);
  d.setDate(d.getDate() + 7);
  return d;
};

/** PocketBase compares dates as UTC 'YYYY-MM-DD HH:mm:ss' strings. */
export const pbDate = (d: Date): string => d.toISOString().slice(0, 19).replace('T', ' ');

/**
 * Parse a date the way PocketBase actually serialises it: `2026-08-04
 * 19:30:00.000Z` — a SPACE separator and a trailing `Z` in the same string. Both
 * halves matter: assuming a `T` builds `…T19:30:00.000ZZ` (Invalid Date), and
 * appending `Z` unconditionally does the same to a value that already carries a
 * zone. Every read of a stored date goes through here — `new Date(raw)` only
 * works because V8 is lenient, and Safari rejects the space form outright.
 */
export const parsePbDate = (s: string): Date => {
  const iso = String(s).trim().replace(' ', 'T');
  return new Date(/([Zz]|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`);
};

/** `<input type="datetime-local">` wants local time with no zone suffix. */
export const toLocalInput = (iso: string): string => {
  if (!iso) return '';
  const d = parsePbDate(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const fromLocalInput = (v: string): string => (v ? new Date(v).toISOString() : '');

/** The ISO day key a slot belongs to, in the operator's local time. */
export const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// -- data ---------------------------------------------------------------------

// `totalPages` is not decoration: `ListResult` gained it in db@1.1.0 (#42, "read
// whole collections, not first pages") and this literal was never updated, so
// this brick has not type-checked against its own dependency since. Nothing
// noticed because no app installs it and CI composes the canary without ever
// building it.
const EMPTY = <T>(): ListResult<T> => ({ page: 1, perPage: 0, totalPages: 0, totalItems: 0, items: [] });

// KNOWN LIMIT (not fixed here): every list below asks for a single page —
// listPosts caps at 200 rows and listVariantsOf at 500, with no pagination. It
// is enough for one brand's first months; a real backlog needs paging (or a
// filter by week for the picker), which is F1's job together with the clock.
export const listBrands = () => list<Brand>('brands', { sort: 'name', perPage: '200' });

export const listAssets = () => list<Asset>('assets', { sort: '-created', perPage: '200' });

export const listPosts = () => list<Post>('posts', { sort: '-slot_at', perPage: '200' });

export const listPostsBetween = (from: Date, to: Date) =>
  list<Post>('posts', {
    filter: `slot_at >= "${pbDate(from)}" && slot_at < "${pbDate(to)}"`,
    sort: 'slot_at',
    perPage: '200',
  });

/** Variants of the given posts. One row per network — never a blob. */
export const listVariantsOf = (postIds: string[]) =>
  (postIds.length
    ? list<Variant>('variants', {
      filter: postIds.map((id) => `post = "${id}"`).join(' || '),
      sort: 'network',
      perPage: '500',
    })
    : Promise.resolve(EMPTY<Variant>()));

export const savePost = (id: string | null, data: Partial<Post>) =>
  (id ? update<Post>('posts', id, data) : create<Post>('posts', data));

/**
 * The compliance guard lives in the data layer, not only in the form: the UI
 * hides the illegal states, but nothing else may write them either.
 */
export function saveVariant(id: string | null, data: Partial<Variant>) {
  if (data.network && data.state && !isAllowedState(data.network, data.state)) {
    return Promise.reject(new Error(
      `social: ${data.network} is handoff-only, so '${data.state}' is refused (allowed: ${statesFor(data.network).join(', ')})`,
    ));
  }
  return id ? update<Variant>('variants', id, data) : create<Variant>('variants', data);
}

export const createBrand = (data: Partial<Brand>) => create<Brand>('brands', data);

export const uploadAsset = (fd: FormData) => create<Asset>('assets', fd);

export const deleteAsset = (id: string) => remove('assets', id);

/** The live row of one post+network, re-read from PocketBase. */
export async function variantOf(postId: string, network: string): Promise<Variant | null> {
  const res = await list<Variant>('variants', {
    filter: `post = "${postId}" && network = "${network}"`, sort: 'created', perPage: '1',
  });
  return res.items[0] ?? null;
}

/**
 * One variant row per network for a post — the fan-out the whole model rests
 * on (§2: "never one blob with a list of networks"). Idempotent: networks that
 * already have a row are left exactly as they are.
 *
 * It re-reads the post's variants itself instead of trusting a caller-held list.
 * `UNIQUE (post, network)` is not expressible through pb-schema.mjs, so
 * PocketBase would happily accept a second row for a network — and a duplicate
 * is invisible in the UI (the boards resolve a network with `.find()`), so it
 * could neither be seen nor deleted. Re-listing is the only guard we have, and
 * it also makes a retry after a partial failure safe.
 */
export async function fanOut(postId: string): Promise<Variant[]> {
  const have = new Set((await listVariantsOf([postId])).items.map((v) => v.network));
  const made: Variant[] = [];
  for (const network of NETWORKS) {
    if (have.has(network)) continue;
    // Re-check immediately before the write: the loop awaits, and a second tab
    // (or a queued click) may have created this exact row in the meantime.
    if (await variantOf(postId, network)) continue;
    made.push(await create<Variant>('variants', {
      post: postId, network, state: initialState(network), body: '',
    }));
  }
  return made;
}

// -- session ------------------------------------------------------------------

/**
 * pb.ts's `isLoggedIn()` only checks that a token STRING exists and nothing ever
 * clears a rejected one, so an expired session leaves the page looking signed in
 * while every board 401s into a generic error — a dead end with no way back to
 * the form. pb.ts belongs to the `db` brick and is shared fleet-wide, so the
 * repair lives here: each board calls this from its catch.
 *
 * What it announces is the AUTH brick's event, not one of ours. This brick used
 * to publish `social:session-lost` and its own sign-in panel to listen for it —
 * a second door into the app that went straight to PocketBase and never touched
 * the identity plane. `AuthGate` reopens on `SIGNED_OUT_EVENT`, so the way back
 * to the form is now the same one every app in the fleet has.
 */
export const isAuthError = (e: unknown): boolean =>
  /\bpb (401|403)\b/.test(e instanceof Error ? e.message : String(e));

export function handleAuthError(e: unknown): boolean {
  if (!isAuthError(e)) return false;
  // Clears BOTH sessions — the Supabase one and the PocketBase token — and
  // announces the loss. `logout()` alone would leave the identity plane
  // believing in a session the app can no longer use.
  signOutAndAnnounce();
  return true;
}

// -- copy ---------------------------------------------------------------------
// Every string the browser needs, resolved server-side by t() and shipped as
// data. No user-facing literal may appear in a client script (CLAUDE.md).

export const RUNTIME_KEYS: string[] = [
  ...NETWORKS.map((n) => `social.network.${n}`),
  ...VARIANT_STATES.map((s) => `social.state.${s}`),
  ...POST_STATUSES.map((s) => `social.status.${s}`),
  ...ASSET_KINDS.map((k) => `social.kind.${k}`),
  'social.assets.alt',
  'social.assets.brand',
  'social.assets.checksum',
  'social.assets.delete',
  'social.assets.empty',
  'social.assets.error',
  'social.assets.kind',
  'social.assets.loading',
  'social.assets.uploaded',
  'social.assets.uploading',
  'social.auth.required',
  'social.calendar.edit',
  'social.calendar.emptyday',
  'social.calendar.error',
  'social.calendar.loading',
  'social.calendar.week',
  'social.composer.brandnone',
  'social.composer.error',
  'social.composer.loading',
  'social.composer.nopost',
  'social.composer.saved',
  'social.composer.saving',
  'social.composer.untitled',
  'social.variant.body',
  'social.variant.firstcomment',
  'social.variant.lasterror',
  'social.variant.media',
  'social.variant.nomedia',
  'social.variant.save',
  'social.variant.state',
  'social.variant.url',
];

/** Build the copy payload for the JSON island (called in Astro frontmatter). */
export const runtimeStrings = (tr: (key: string) => string): Record<string, string> =>
  Object.fromEntries(RUNTIME_KEYS.map((k) => [k, tr(k)]));

export const COPY_ISLAND_ID = 'social-copy';

/** Read the copy payload back in the browser. */
export function copy(): Record<string, string> {
  const el = typeof document !== 'undefined' ? document.getElementById(COPY_ISLAND_ID) : null;
  try {
    return el ? (JSON.parse(el.textContent || '{}') as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** `{name}` interpolation for strings that carry placeholders. */
export const fill = (s: string, vars: Record<string, string | number>): string =>
  String(s).replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] != null ? String(vars[k]) : `{${k}}`));

// -- DOM helpers --------------------------------------------------------------
// The boards render PocketBase rows at runtime. Nodes built here carry no Astro
// scope attribute, so every style that reaches them lives inside `:global(...)`.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

export function option(value: string, label: string, selected = false): HTMLOptionElement {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  node.selected = selected;
  return node;
}

// -- misc ---------------------------------------------------------------------

/**
 * Above this size the digest is skipped. `arrayBuffer()` buffers the WHOLE file
 * in memory, so a video either throws (aborting an upload that would otherwise
 * have worked) or kills the tab. The checksum is an F6 dedupe hint, never a
 * precondition for storing the file.
 */
export const CHECKSUM_MAX_BYTES = 32 * 1024 * 1024;

/** SHA-256 of an upload, so F6 can dedupe media. Needs a secure context. */
export async function checksumOf(file: File): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return '';
  if (file.size > CHECKSUM_MAX_BYTES) return '';
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // Out of memory, or a file the browser cannot read twice: never let a
    // missing dedupe hint be the reason an upload fails.
    return '';
  }
}
