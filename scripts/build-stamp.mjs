#!/usr/bin/env node
// build-stamp.mjs — writes public/version.json with the commit the build came
// from. File GENERATED in every app by `brotea quality sync`: fix it in the
// factory (quality/build-stamp.mjs), not in the project's repo.
//
// Why does it exist? Because until today there was no way to answer "is the
// site serving the code we reviewed?". Coolify stores `git_commit_sha: "HEAD"`
// (not a SHA) and does not pass the commit as a build-arg, so the control
// plane does not know it. And the case that really matters is caught by no
// database: a failed deploy leaves the PREVIOUS container serving, with green
// CI and the deployment row saying everything went fine (it happened to us on
// 2026-08-01 with maría-limpieza: `/` answered 200 with the old version and
// `/en/` gave a 404). Only a stamp the site itself serves tells those apart.
//
// The commit arrives in PUBLIC_BUILD_COMMIT, which the factory sets as a build
// variable before deploying. If it is missing —local build, or someone fired
// the deploy by hand from Coolify— it falls back to the context's git and, if
// that fails too, to "unknown": an honest stamp saying "I don't know" is worth
// more than an invented one.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const fromEnv = (process.env.PUBLIC_BUILD_COMMIT ?? '').trim();
const fromGit = () => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
};

const commit = fromEnv || fromGit() || 'unknown';
const stamp = {
  commit,
  short: commit.slice(0, 12),
  source: fromEnv ? 'factory' : (commit === 'unknown' ? 'none' : 'git'),
  branch: (process.env.COOLIFY_BRANCH ?? '').trim() || null,
  built_at: new Date().toISOString(),
};

mkdirSync('public', { recursive: true });
writeFileSync('public/version.json', `${JSON.stringify(stamp, null, 2)}\n`);
console.log(`build-stamp: ${stamp.short} (${stamp.source})`);
