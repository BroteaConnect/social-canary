// i18n runtime — copied into every app as src/lib/i18n.ts by
// `brotea new` / `brotea i18n sync`. GENERATED FILE: fix it in the factory
// (i18n/runtime/i18n.ts) and re-sync, never here — same rule as theme.css.
//
// Zero dependencies. Works in Astro and in Vite/React because the dictionaries
// are collected with import.meta.glob at BUILD time: adding a language is
// dropping src/locales/<code>.json and listing it in config.json. Nothing to
// import, no codegen, no runtime fetch — a static host serves it fine and the
// crawler sees real translated HTML.
import config from '../locales/config.json';

export type Locale = string;
export type Vars = Record<string, string | number> & { count?: number };

// eager glob: every dictionary is inlined in the bundle at build time
const mods = import.meta.glob('../locales/*.json', { eager: true }) as Record<string, unknown>;
const DICTS: Record<string, Record<string, string>> = {};
for (const [path, mod] of Object.entries(mods)) {
  const code = path.slice(path.lastIndexOf('/') + 1, -'.json'.length);
  if (code === 'config') continue;
  DICTS[code] = ((mod as { default?: Record<string, string> }).default ?? mod) as Record<string, string>;
}

export const LOCALES: Locale[] = config.locales;
export const DEFAULT_LOCALE: Locale = config.defaultLocale;
export const REQUIRED: Locale[] = config.required;
export const NATIVE: Record<string, string> = config.native;

export const isLocale = (v: unknown): v is Locale => typeof v === 'string' && LOCALES.includes(v);
export const dirOf = (locale: Locale): 'ltr' | 'rtl' =>
  (config.dir as Record<string, 'ltr' | 'rtl'>)[locale] ?? 'ltr';
export const intlOf = (locale: Locale): string =>
  (config.intl as Record<string, string>)[locale] ?? locale;

const interpolate = (s: string, vars: Vars) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] != null ? String(vars[k]) : `{${k}}`));

/**
 * Translate `key` for `locale`.
 * - `vars.count` selects a plural form via Intl.PluralRules: the dictionary
 *   holds `key.one` / `key.other` (and `.few` / `.many` for the languages that
 *   need them — the rule name comes from Intl, so a new language needs no code).
 * - A key missing in `locale` falls back to the default locale, then to the key
 *   itself. Never throws: a broken string must not take a page down.
 */
export function t(locale: Locale, key: string, vars?: Vars): string {
  const dict = DICTS[locale] ?? {};
  const base = DICTS[DEFAULT_LOCALE] ?? {};
  // An EMPTY value counts as missing, not as "translated to nothing": that is
  // exactly what a language being translated looks like (`brotea i18n add`
  // creates the keys empty), and `??` alone would happily render blanks.
  const pick = (d: Record<string, string>, k: string) => {
    const v = d[k];
    return v != null && String(v).trim() !== '' ? v : undefined;
  };
  let raw: string | undefined;
  if (vars && typeof vars.count === 'number') {
    const rule = new Intl.PluralRules(intlOf(locale)).select(vars.count);
    raw = pick(dict, `${key}.${rule}`) ?? pick(dict, `${key}.other`)
      ?? pick(base, `${key}.${rule}`) ?? pick(base, `${key}.other`);
  }
  raw ??= pick(dict, key) ?? pick(base, key);
  if (raw == null) {
    if (import.meta.env?.DEV) console.warn(`[i18n] missing key '${key}' (${locale})`);
    return key;
  }
  return vars ? interpolate(raw, vars) : raw;
}

/** Bind t() to a locale — `const _ = tt(locale); _('nav.home')`. */
export const tt = (locale: Locale) => (key: string, vars?: Vars) => t(locale, key, vars);

/**
 * Is there real copy for this key? `t()` falls back to the key itself, so a
 * page cannot tell "translated" from "missing" by looking at what it got back.
 *
 * This is what lets a page be built out of sections that exist only when
 * somebody wrote them: the copy is the content, not a placeholder waiting to be
 * filled in. Presence is judged in the DEFAULT locale, so a section does not
 * appear and disappear depending on which language a visitor reads — a page
 * that is structurally different per language is a page nobody can review.
 */
export const has = (key: string): boolean => {
  const v = (DICTS[DEFAULT_LOCALE] ?? {})[key];
  return v != null && String(v).trim() !== '';
};

/**
 * The numbers a series actually has, from a pattern with `{n}` in it:
 * `series('features.{n}.title')`, `series('how.step{n}')`.
 *
 * The pattern says where the number goes rather than the function guessing,
 * because guessing produced `how.step.1` for keys named `how.step1` and the
 * section simply did not render — no error, no empty heading, nothing.
 *
 * Counting stops at the first gap: a series with a hole is a mistake, and
 * rendering around it would hide it.
 */
export function series(pattern: string, max = 24): number[] {
  const out: number[] = [];
  for (let n = 1; n <= max; n += 1) {
    if (!has(pattern.replace('{n}', String(n)))) break;
    out.push(n);
  }
  return out;
}

// -- URLs ---------------------------------------------------------------------
// The default locale is unprefixed ('/'), every other locale lives under
// '/<code>/'. Retrofitting a live site therefore never changes its URLs.
export function localePath(locale: Locale, path = '/'): string {
  const clean = `/${String(path).replace(/^\/+/, '')}`;
  if (locale === DEFAULT_LOCALE) return clean;
  return clean === '/' ? `/${locale}/` : `/${locale}${clean}`;
}

/** The locale a pathname belongs to (default when there is no prefix). */
export function localeFromPath(pathname: string): Locale {
  const seg = pathname.split('/').filter(Boolean)[0];
  return isLocale(seg) && seg !== DEFAULT_LOCALE ? seg : DEFAULT_LOCALE;
}

/** The same pathname without its locale prefix ('/en/precios' → '/precios'). */
export function stripLocale(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean);
  if (isLocale(parts[0])) parts.shift();
  return `/${parts.join('/')}`;
}

/**
 * Astro pages live at `src/pages/[...lang]/<page>.astro` and do
 * `export const getStaticPaths = localePaths;` — one line, and adding a
 * language to config.json generates its pages with no new files.
 */
export const localePaths = () => LOCALES.map((locale) => ({
  params: { lang: locale === DEFAULT_LOCALE ? undefined : locale },
  props: { locale },
}));

/**
 * The locale of THIS render — from the props when the page was generated at
 * build time, from the URL when it is rendered per request.
 *
 * A page must use this instead of `Astro.props.locale`, because a page that
 * reads only the props is correct on a static stack and silently monolingual
 * on a server one: `getStaticPaths` is IGNORED when `output: 'server'`, so
 * `props.locale` is undefined on every request and `t()` falls back to the
 * default language. `/en/` then renders Spanish, with a green build and a
 * warning nobody reads. Measured on the first SSR canary.
 */
export function localeOf(ctx: { props?: { locale?: unknown }; params?: { lang?: unknown } }): Locale {
  if (isLocale(ctx?.props?.locale)) return ctx.props!.locale as Locale;
  // `lang` is a rest parameter: '' at the root, 'en' under /en/, and
  // 'en/deeper' for a nested route that reuses it.
  const raw = ctx?.params?.lang;
  const seg = (Array.isArray(raw) ? raw[0] : typeof raw === 'string' ? raw.split('/')[0] : '') ?? '';
  return isLocale(seg) ? seg : DEFAULT_LOCALE;
}

/**
 * True when the URL names a language that does not exist (`/de/` on a
 * Spanish+English app). On a static stack those URLs simply were not
 * generated; on a server one they render the default language at a made-up
 * address, which is a 200 for a page that should not exist. Pages answer 404.
 */
export function unknownLocale(ctx: { params?: { lang?: unknown } }): boolean {
  const raw = ctx?.params?.lang;
  const segs = (Array.isArray(raw) ? raw : String(raw ?? '').split('/')).filter(Boolean);
  if (segs.length === 0) return false;
  // `[...lang]` is a REST parameter: on a server stack it answers
  // /anything/at/all with whatever page owns the route, so a URL nobody wrote
  // renders the home page and returns 200. A page whose route is
  // `[...lang]/x.astro` only ever sees the locale here, so more than one
  // segment means the URL is not this page's.
  return segs.length > 1 || !isLocale(segs[0]);
}

/** hreflang alternates for <head> — every locale, plus x-default. */
export const alternates = (path = '/') =>
  LOCALES.map((locale) => ({ locale, href: localePath(locale, path), hreflang: locale }));

// -- Intl formatting ----------------------------------------------------------
// Here so no app hand-rolls number/date/currency formatting per locale again.
export const fmtNumber = (locale: Locale, n: number, o?: Intl.NumberFormatOptions) =>
  new Intl.NumberFormat(intlOf(locale), o).format(n);
export const fmtMoney = (locale: Locale, n: number, currency: string) =>
  new Intl.NumberFormat(intlOf(locale), { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
export const fmtDate = (locale: Locale, d: Date | string | number,
  o: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }) =>
  new Intl.DateTimeFormat(intlOf(locale), o).format(new Date(d));
