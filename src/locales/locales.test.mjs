// locales.test.mjs — the i18n gate, run by `npm test` (and therefore by CI).
// Copied into every app as src/locales/locales.test.mjs by `brotea new` /
// `brotea i18n sync`. GENERATED FILE: fix it in the factory
// (i18n/runtime/locales.test.mjs) and re-sync, never here.
//
// Why a test and not a bespoke tool: the gate has to run in the project's CI,
// where the factory CLI does not exist. `node --test` is already there.
//
// What it enforces (only for `required` locales — a locale being translated
// lives in `locales` but not in `required`, so work in progress never blocks a
// deploy while t() falls back to the default language):
//   · declared locales exist and no dictionary is undeclared
//   · same key set as the default locale, no empty values
//   · keys sorted (stable diffs; the copy editor rewrites these files)
//   · placeholders survive translation ({name} dropped = broken UI)
//   · plural keys keep .other (and .one where the language has it)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));
const config = read('config.json');
const dict = (code) => read(`${code}.json`);
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const PLURAL = /\.(zero|one|two|few|many|other)$/;

test('config.json is coherent', () => {
  assert.ok(config.locales.includes(config.defaultLocale), 'defaultLocale must be in locales');
  for (const code of config.required) {
    assert.ok(config.locales.includes(code), `required locale '${code}' missing from locales`);
  }
  for (const code of config.locales) {
    assert.ok(config.native[code], `locale '${code}' has no native name`);
    assert.ok(config.intl[code], `locale '${code}' has no Intl tag`);
  }
});

test('every declared locale has a dictionary, and every dictionary is declared', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'config.json');
  const codes = files.map((f) => f.replace(/\.json$/, '')).sort();
  assert.deepEqual(codes, [...config.locales].sort());
});

test('required locales are complete: same keys as the default, none empty', () => {
  const base = dict(config.defaultLocale);
  const baseKeys = Object.keys(base).sort();
  for (const code of config.required) {
    const d = dict(code);
    const missing = baseKeys.filter((k) => d[k] === undefined);
    const empty = baseKeys.filter((k) => typeof d[k] === 'string' && d[k].trim() === '');
    const extra = Object.keys(d).filter((k) => base[k] === undefined);
    assert.deepEqual(missing, [], `${code}.json is missing keys: ${missing.join(', ')}`);
    assert.deepEqual(empty, [], `${code}.json has untranslated (empty) keys: ${empty.join(', ')}`);
    assert.deepEqual(extra, [], `${code}.json has keys the default locale lacks: ${extra.join(', ')}`);
  }
});

test('keys are sorted in every dictionary', () => {
  for (const code of config.locales) {
    const keys = Object.keys(dict(code));
    assert.deepEqual(keys, [...keys].sort(),
      `${code}.json is not sorted — run \`brotea i18n check\` for the fix`);
  }
});

test('placeholders survive translation', () => {
  const base = dict(config.defaultLocale);
  for (const code of config.required) {
    const d = dict(code);
    for (const [key, value] of Object.entries(base)) {
      if (d[key] === undefined) continue;
      assert.deepEqual(placeholders(d[key]), placeholders(value),
        `${code}.json '${key}': placeholders differ from ${config.defaultLocale}`);
    }
  }
});

test('plural keys keep the forms the language needs', () => {
  const base = dict(config.defaultLocale);
  const stems = [...new Set(Object.keys(base).filter((k) => PLURAL.test(k))
    .map((k) => k.replace(PLURAL, '')))];
  for (const code of config.required) {
    const d = dict(code);
    const cats = new Intl.PluralRules(config.intl[code]).resolvedOptions().pluralCategories;
    for (const stem of stems) {
      assert.ok(d[`${stem}.other`], `${code}.json '${stem}' needs the .other form`);
      if (cats.includes('one')) {
        assert.ok(d[`${stem}.one`], `${code}.json '${stem}' needs the .one form`);
      }
    }
  }
});
