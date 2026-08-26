// GENERATED FILE by `brotea quality sync` (quality/schema-gate.mjs in the
// factory). Do not edit it here: change the catalog and re-sync, or the next
// fleet migration will stomp on your changes.
//
// schema-gate.mjs — what this app's data model must say before it is allowed to
// merge. Pure, dependency-free, and it never talks to an instance: it reads the
// DECLARATION, which is the half a repository owns.
//
// Every rule here is one incident.
//
// On 2026-08-14 every PocketBase in the fleet had `users.createRule = ""` —
// anyone on the internet could register — and because business collections were
// gated with `@request.auth.id != ""`, a stranger who signed up could read a
// client's leads. It had been that way for weeks, and it was found by attacking
// the CRM by hand.
//
// The nightly audit now compares what an instance SERVES against what its app
// DECLARES. That comparison was silently vacuous for the collection that
// mattered: until 2026-08-26 no brick declared `users` at all, so the audit had
// nothing to hold the instance to. This is the half that makes the declaration
// exist in the first place.

/** -1, 0 or 1, with missing parts counting as 0. */
function cmp(a, b) {
  const pa = String(a ?? '0').split('.').map(Number);
  const pb = String(b ?? '0').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** The version of `db` that started shipping the `users` declaration. */
export const DB_DECLARES_USERS = '1.3.0';

/**
 * @param {object|null} lock    the app's brotea.json
 * @param {object|null} schema  the app's pb/schema.json, or null if absent
 * @returns {string[]} findings, empty when the model is sound
 */
export function findings(lock, schema) {
  const out = [];
  const db = lock?.features?.db?.version ?? null;
  const collections = schema?.collections ?? null;

  // 1. An app with a database has a users table whether it declares one or not.
  //    Undeclared means PocketBase's defaults stand and nothing re-applies
  //    anything — the exact state three instances were in for weeks.
  if (db && cmp(db, DB_DECLARES_USERS) >= 0) {
    if (!collections) {
      out.push(`this app has db@${db} and no pb/schema.json — its users collection is whatever PocketBase created`);
      return out;
    }
    if (!collections.some((c) => c?.name === 'users')) {
      out.push(`db@${db} declares the users collection and this app's pb/schema.json does not carry it`
        + ' — run `brotea add db --upgrade`');
    }
  }
  if (!collections) return out;

  const users = collections.find((c) => c?.name === 'users');
  if (users) {
    if (users.type !== 'auth') out.push(`users must declare "type": "auth" — pb-schema.mjs defaults to "base" and PocketBase rejects the PATCH`);
    const rule = (action) => {
      // `access` is the readable spelling and wins where both exist, exactly as
      // pb-schema.mjs resolves them.
      if (users.access && action in users.access) return users.access[action];
      return users.rules?.[action] ?? null;
    };
    // 2. Self-registration. `null`/`nobody` is superuser-only: operators are
    //    created by the factory, never by signup.
    const create = rule('create');
    if (!(create === null || create === undefined || create === 'nobody')) {
      out.push(`users.create is ${JSON.stringify(create)} — anything but null lets accounts be created without a superuser`);
    }
    // 3. PocketBase rules are per RECORD, not per FIELD. Its default
    //    `id = @request.auth.id` ("you may edit yourself") lets an operator
    //    PATCH any field of their own row, including their role. A member
    //    promoted themselves to admin with one request on a canary.
    for (const action of ['update', 'delete']) {
      const v = rule(action);
      if (!(v === null || v === undefined || v === 'nobody')) {
        out.push(`users.${action} is ${JSON.stringify(v)} — rules are per record, so this grants the row's role field too`);
      }
    }
  }

  // 4. A raw empty string grants everyone, and it looks like an oversight
  //    because usually it is one. If it is a decision, it has a name:
  //    `"access": { "create": "public" }`, which the nightly audit reads as a
  //    decision instead of reporting it as drift.
  for (const col of collections) {
    for (const [action, value] of Object.entries(col?.rules ?? {})) {
      if (value === '') {
        out.push(`${col.name}.rules.${action} is "" — say it with "access": { "${action}": "public" } so the audit can tell a decision from a default`);
      }
    }
  }

  return out;
}
