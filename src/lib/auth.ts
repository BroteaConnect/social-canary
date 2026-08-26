// auth.ts — sign in with a Brotea account (Supabase Auth) and become an
// authorized user of this app's PocketBase.
//
// The shape of the thing, because it is easy to get backwards:
//
//   Supabase Auth  authenticates  → says WHO you are (one identity, whole fleet)
//   PocketBase     authorizes     → says WHAT you may do (rules over `role`)
//
// The browser never holds a client secret: Supabase's publishable key is public
// by design, and the exchange that turns an identity into PocketBase access
// happens inside PocketBase (`POST /api/brotea-auth`, see the brick's
// pb/hooks/brotea-auth.pb.js). After sign-in the app keeps using pb.ts exactly
// as before — same token, same CRUD, same rules.
//
// Dependency-free on purpose, like pb.ts: no supabase-js, no PKCE library. A
// brick that drags a dependency tree into every app of the fleet is a brick
// that ages badly.

import { pbUrl, setAuthToken, logout as pbLogout } from './pb';

const meta = (name: string): string =>
  (typeof document !== 'undefined'
    ? document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') || ''
    : '');

const SUPABASE_URL: string = (
  (import.meta.env.PUBLIC_SUPABASE_URL as string | undefined)?.trim() || meta('supabase-url')
).replace(/\/+$/, '');

const ANON_KEY: string =
  (import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string | undefined)?.trim() || meta('supabase-anon-key');

const SESSION_KEY = 'brotea_session';
const VERIFIER_KEY = 'brotea_pkce_verifier';
const USER_KEY = 'brotea_user';

export interface BroteaUser {
  id: string;
  email: string;
  name: string;
  /**
   * Role in THIS app, decided by the bridge from Supabase app_metadata.
   * Closed and ordered, strongest first — the same set the hook enforces
   * (feature-templates/auth/pb/hooks/brotea-roles.js).
   */
  role: 'superadmin' | 'admin' | 'member';
}

interface Session {
  access_token: string;
  refresh_token: string;
  /** epoch seconds */
  expires_at: number;
}

export const isConfigured = (): boolean => !!SUPABASE_URL && !!ANON_KEY;

// -- pure helpers (exported for tests) ----------------------------------------

export function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * What did the identity provider send us back to /auth/callback with?
 *
 * Supabase uses the PKCE flow (`?code=`) for new projects and the implicit
 * flow (`#access_token=`) for older ones, and the project's setting is not
 * something an app can detect. Reading both is three lines and removes a whole
 * class of "works on my project" failure.
 */
export function parseCallback(search: string, hash: string): {
  kind: 'code' | 'session' | 'error' | 'none';
  code?: string;
  session?: Session;
  error?: string;
} {
  const q = new URLSearchParams(search.replace(/^\?/, ''));
  const h = new URLSearchParams(hash.replace(/^#/, ''));
  const err = q.get('error_description') || q.get('error') || h.get('error_description') || h.get('error');
  if (err) return { kind: 'error', error: err };
  const code = q.get('code');
  if (code) return { kind: 'code', code };
  const access = h.get('access_token');
  if (access) {
    return {
      kind: 'session',
      session: {
        access_token: access,
        refresh_token: h.get('refresh_token') || '',
        expires_at: Number(h.get('expires_at') || 0) || nowSeconds() + Number(h.get('expires_in') || 3600),
      },
    };
  }
  return { kind: 'none' };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A session is "usable" with a minute of margin — never on the exact edge. */
export const sessionIsLive = (s: Session | null, now = nowSeconds()): boolean =>
  !!s && !!s.access_token && s.expires_at > now + 60;

// -- storage ------------------------------------------------------------------

const readJson = <T>(key: string): T | null => {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

const session = () => readJson<Session>(SESSION_KEY);
export const currentUser = (): BroteaUser | null => readJson<BroteaUser>(USER_KEY);
export const isSignedIn = (): boolean => !!currentUser();
const RANK: Record<string, number> = { superadmin: 0, admin: 1, member: 2 };

/** Does the signed-in person reach this role? Never a substitute for a rule. */
export const hasRole = (needed: BroteaUser['role']): boolean => {
  const have = currentUser()?.role;
  return have !== undefined && RANK[have] !== undefined && RANK[have] <= RANK[needed];
};

export const isAdmin = (): boolean => hasRole('admin');

// -- Supabase calls -----------------------------------------------------------

async function gotrue<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY, ...(init.headers as object) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AuthError(data?.error_description || data?.msg || data?.message || `auth ${res.status}`, res.status);
  return data as T;
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  expires_at?: number;
}

const store = (t: TokenResponse): Session => {
  const s: Session = {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: t.expires_at || nowSeconds() + (t.expires_in || 3600),
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  return s;
};

// -- the bridge into PocketBase ------------------------------------------------

/**
 * Exchange a Supabase access token for a PocketBase auth token. The 403 here
 * is not a bug to smooth over: it is a real identity with no role in this app,
 * and it must reach the user as "you have no access", never as "wrong
 * password".
 */
export async function bridgeToPocketBase(accessToken: string): Promise<BroteaUser> {
  const res = await fetch(`${pbUrl()}/api/brotea-auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: accessToken }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AuthError(data?.message || `bridge ${res.status}`, res.status);
  setAuthToken(data.token);
  const user = data.record as BroteaUser;
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  return user;
}

// -- the second factor ---------------------------------------------------------
//
// The bridge refuses an `aal1` session from an identity with a verified factor,
// which is the rule that makes enrolment mean anything. It also means the
// browser MUST be able to reach `aal2` on its own: without the exchange below,
// the first person to enrol would be locked out of every app in the fleet, and
// an enrolment screen shipped alone would be a door that only closes.

export interface Factor {
  id: string;
  status: string;
  factor_type?: string;
  friendly_name?: string;
}

/** Raised by a sign-in that got a live session the bridge will not accept yet. */
export class MfaRequiredError extends AuthError {
  factorId: string;

  constructor(factorId: string) {
    super('second factor required', 401);
    this.factorId = factorId;
  }
}

/**
 * The `aal` the token itself claims. Parsed without verifying, exactly as the
 * PocketBase hook does and for the same reason: Supabase minted this token and
 * we are asking what it says about itself, not whether to trust it.
 */
function aalOf(accessToken: string): string {
  try {
    const body = accessToken.split('.')[1];
    const json = atob(body.replace(/-/g, '+').replace(/_/g, '/'));
    return String(JSON.parse(json).aal || 'aal1');
  } catch {
    // Unreadable means "not proven aal2", never "fine".
    return 'aal1';
  }
}

const authed = <T>(path: string, accessToken: string, init: RequestInit = {}) =>
  gotrue<T>(path, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers as object) },
  });

/** Every factor on this identity, verified or not. */
export async function listFactors(accessToken = session()?.access_token || ''): Promise<Factor[]> {
  const user = await authed<{ factors?: Factor[] }>('/user', accessToken);
  // Supabase OMITS `factors` entirely when there are none. Treating that as an
  // error locked out every user without MFA on the canary, which is almost
  // everyone.
  return Array.isArray(user.factors) ? user.factors : [];
}

/** Start enrolling a TOTP factor. Returns what the authenticator app needs. */
export async function enrollTotp(friendlyName: string): Promise<{ id: string; secret: string; uri: string; qr: string }> {
  const r = await authed<{ id: string; totp?: { secret?: string; uri?: string; qr_code?: string } }>(
    '/factors',
    session()?.access_token || '',
    { method: 'POST', body: JSON.stringify({ factor_type: 'totp', friendly_name: friendlyName }) },
  );
  return { id: r.id, secret: r.totp?.secret || '', uri: r.totp?.uri || '', qr: r.totp?.qr_code || '' };
}

/**
 * Answer a challenge for a factor and KEEP the session it returns.
 *
 * The response is a new, `aal2` token pair: storing it is the whole point, both
 * when finishing enrolment and when signing in. Returning without storing would
 * leave the browser holding the aal1 session the bridge refuses.
 */
export async function verifyTotp(factorId: string, code: string): Promise<Session> {
  const token = session()?.access_token || '';
  const challenge = await authed<{ id: string }>(`/factors/${factorId}/challenge`, token, { method: 'POST' });
  const upgraded = await authed<TokenResponse>(`/factors/${factorId}/verify`, token, {
    method: 'POST',
    body: JSON.stringify({ challenge_id: challenge.id, code }),
  });
  return store(upgraded);
}

/** Finish a sign-in that stopped at MfaRequiredError. */
export async function completeMfa(factorId: string, code: string): Promise<BroteaUser> {
  return bridgeToPocketBase((await verifyTotp(factorId, code)).access_token);
}

export async function unenrollFactor(factorId: string): Promise<void> {
  await authed(`/factors/${factorId}`, session()?.access_token || '', { method: 'DELETE' });
}

/**
 * Is this live session one the bridge will refuse? Returns the factor to
 * challenge, or null.
 */
async function pendingFactor(accessToken: string): Promise<string | null> {
  if (aalOf(accessToken) === 'aal2') return null;
  const verified = (await listFactors(accessToken)).filter((f) => f.status === 'verified');
  return verified.length ? verified[0].id : null;
}

// -- sign-in flows -------------------------------------------------------------

/** Email + password, the flow that needs no redirect and no provider config. */
export async function signInWithPassword(email: string, password: string): Promise<BroteaUser> {
  const token = await gotrue<TokenResponse>('/token?grant_type=password', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  const s = store(token);
  // Ask BEFORE the bridge does. Letting the bridge answer would surface as a
  // 403 "you have no access", which sends somebody to ask for permissions they
  // already have instead of opening their authenticator.
  const factor = await pendingFactor(s.access_token);
  if (factor) throw new MfaRequiredError(factor);
  return bridgeToPocketBase(s.access_token);
}

/**
 * Magic link. `create_user: false` is deliberate and load-bearing: a link
 * request must never be a way to create a Brotea account. Account creation is
 * an act of the factory, not of a form.
 */
export async function sendMagicLink(email: string, redirectPath = '/auth/callback'): Promise<void> {
  await gotrue(`/otp?redirect_to=${encodeURIComponent(absolute(redirectPath))}`, {
    method: 'POST',
    body: JSON.stringify({ email, create_user: false }),
  });
}

/** Redirect to an external provider (google, github, …) via PKCE. */
export async function signInWithProvider(provider: string, redirectPath = '/auth/callback'): Promise<void> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(digest));
  const url =
    `${SUPABASE_URL}/auth/v1/authorize?provider=${encodeURIComponent(provider)}` +
    `&redirect_to=${encodeURIComponent(absolute(redirectPath))}` +
    `&code_challenge=${challenge}&code_challenge_method=s256`;
  location.assign(url);
}

const absolute = (path: string) => new URL(path, location.origin).toString();

/**
 * Finish a redirect sign-in. Call it from the /auth/callback page; it returns
 * null when the page was opened with nothing to complete.
 */
export async function completeCallback(): Promise<BroteaUser | null> {
  const parsed = parseCallback(location.search, location.hash);
  if (parsed.kind === 'error') throw new AuthError(parsed.error || 'callback error');
  if (parsed.kind === 'none') return null;

  let accessToken: string;
  if (parsed.kind === 'code') {
    const verifier = sessionStorage.getItem(VERIFIER_KEY) || '';
    sessionStorage.removeItem(VERIFIER_KEY);
    const token = await gotrue<TokenResponse>('/token?grant_type=pkce', {
      method: 'POST',
      body: JSON.stringify({ auth_code: parsed.code, code_verifier: verifier }),
    });
    accessToken = store(token).access_token;
  } else {
    localStorage.setItem(SESSION_KEY, JSON.stringify(parsed.session));
    accessToken = parsed.session!.access_token;
  }
  // The tokens travelled in the URL; do not leave them in history or in the
  // Referer of the next request.
  history.replaceState({}, '', location.pathname);
  return bridgeToPocketBase(accessToken);
}

/**
 * Re-establish PocketBase access from a stored Supabase session, refreshing it
 * first when it is close to expiry. Returns null when the user must sign in
 * again — the caller shows the gate, it does not throw at them.
 */
export async function restore(): Promise<BroteaUser | null> {
  let s = session();
  if (!s) return null;
  if (!sessionIsLive(s)) {
    if (!s.refresh_token) return null;
    try {
      s = store(
        await gotrue<TokenResponse>('/token?grant_type=refresh_token', {
          method: 'POST',
          body: JSON.stringify({ refresh_token: s.refresh_token }),
        }),
      );
    } catch {
      signOut();
      return null;
    }
  }
  try {
    return await bridgeToPocketBase(s.access_token);
  } catch {
    signOut();
    return null;
  }
}

/**
 * Re-establish the PocketBase session after it expires mid-visit.
 *
 * PocketBase tokens are deliberately short (one hour) so that revoking someone
 * upstream actually revokes. That makes a 401 an ordinary event in a long
 * session, not an error: refresh at Supabase, cross the bridge again, retry
 * once. Wrap the calls that matter:
 *
 *   const docs = await withFreshSession(() => list('documents'));
 *
 * Returns null when the user really must sign in again, so the caller can show
 * the gate instead of throwing at them.
 */
export async function withFreshSession<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (err) {
    const status = err instanceof AuthError ? err.status : Number(String((err as Error)?.message).match(/pb (\d+)/)?.[1]);
    if (status !== 401) throw err;
    const user = await restore();
    if (!user) return null;
    return call();
  }
}

// -- the runtime protocol ------------------------------------------------------
// A brick that wants to react to a session has to listen for something, and
// until now that something was a string typed by hand in each component. The
// social calendar grew its own pair (`social:auth`, `social:session-lost`) and
// its own sign-in form beside this one, because nothing here was named, exported
// or documented. Two doors into one app is not a duplication of code, it is a
// duplication of the ATTACK SURFACE — and the second one bypassed the identity
// plane entirely.
//
// So the protocol is exported. `brotea:signedin` carries the BroteaUser;
// `brotea:signedout` carries nothing and means "there is no session any more",
// whether a person pressed the button or a request came back 401.

export const SIGNED_IN_EVENT = 'brotea:signedin';
export const SIGNED_OUT_EVENT = 'brotea:signedout';

/**
 * Sign out and tell the page. Always use this rather than `signOut()` alone:
 * without the event the gate stays closed over an app whose every request now
 * fails, which is a dead end with no way back to the form.
 */
export function signOutAndAnnounce(): void {
  signOut();
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent(SIGNED_OUT_EVENT));
  }
}

export function signOut(): void {
  const s = session();
  if (s?.access_token) {
    // best-effort: the local session is gone either way
    fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${s.access_token}` },
    }).catch(() => {});
  }
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(USER_KEY);
  pbLogout();
}
