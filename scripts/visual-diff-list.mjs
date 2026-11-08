#!/usr/bin/env node
// Which captured screens changed since the last run.
//
// WHY THIS EXISTS
// The capture specs now produce around thirty images per run across two
// widths, and a reviewer who has to open all of them to find the two that
// moved will stop reviewing. A byte hash is enough to answer "which ones
// changed", which is the only question that decides where attention goes.
//
// Deliberately NOT a pixel diff. No new dependency and no baseline images in
// the repo; "changed" here means "different bytes", so an unrelated font or
// renderer change reports every screen as changed — that is a limitation, not
// a bug, and it is still cheaper than opening thirty images. When it happens,
// promote once and the next run is clean again.
//
// USAGE
//   node scripts/visual-diff-list.mjs             compare every capture set
//   node scripts/visual-diff-list.mjs owner-screens
//   node scripts/visual-diff-list.mjs --promote   make the current run the
//                                                 baseline for the next one
//
// Layout: test-results/<set>/ is the run that just happened, and
// test-results/<set>-prev/ is the baseline. Both are gitignored, so the
// baseline is per-machine and the first run on a machine reports everything as
// new, which is correct — nothing has been reviewed there yet.
//
// Exits 0 whether or not anything changed: this reports, it does not gate.
// It exits non-zero only when it was asked for a set that does not exist.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'test-results';
const PREV_SUFFIX = '-prev';

const args = process.argv.slice(2);
const promote = args.includes('--promote');
const named = args.filter(a => !a.startsWith('--'));

const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

const pngsIn = (dir) => {
  if (!existsSync(dir)) return new Map();
  const out = new Map();
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (!entry.endsWith('.png') || !statSync(path).isFile()) continue;
    out.set(entry, hash(path));
  }
  return out;
};

/** Capture sets are the directories a capture spec writes, minus the baselines. */
function captureSets() {
  if (!existsSync(ROOT)) return [];
  return readdirSync(ROOT)
    .filter(name => !name.endsWith(PREV_SUFFIX))
    .filter(name => statSync(join(ROOT, name)).isDirectory())
    .filter(name => pngsIn(join(ROOT, name)).size > 0)
    .sort();
}

const sets = named.length ? named : captureSets();

if (!sets.length) {
  console.log(`No capture sets under ${ROOT}/. Run \`npm run capture:guest\` or `
    + '`npm run capture:owner` first.');
  process.exit(0);
}

let missing = false;

for (const set of sets) {
  const current = join(ROOT, set);
  const baseline = `${current}${PREV_SUFFIX}`;

  if (!existsSync(current)) {
    console.error(`✗  ${set}: no such capture set at ${current}`);
    missing = true;
    continue;
  }

  const now = pngsIn(current);
  const before = pngsIn(baseline);

  const added = [...now.keys()].filter(n => !before.has(n)).sort();
  const removed = [...before.keys()].filter(n => !now.has(n)).sort();
  const changed = [...now.keys()].filter(n => before.has(n) && before.get(n) !== now.get(n)).sort();
  const same = now.size - added.length - changed.length;

  console.log(`\n${set} — ${now.size} image${now.size === 1 ? '' : 's'}`
    + (before.size ? '' : '  (no baseline yet: everything is new)'));

  for (const name of added) console.log(`  new      ${join(current, name)}`);
  for (const name of changed) console.log(`  changed  ${join(current, name)}`);
  for (const name of removed) console.log(`  gone     ${name}`);
  if (same) console.log(`  ${same} unchanged`);

  if (promote) {
    // Copied, not moved: the images a reviewer was just told to open have to
    // still be there after promoting, and the next capture run overwrites the
    // current directory anyway.
    if (existsSync(baseline)) rmSync(baseline, { recursive: true, force: true });
    cpSync(current, baseline, { recursive: true });
    console.log(`  promoted → ${baseline}`);
  }
}

if (!promote) {
  console.log('\nReview the screens listed above against docs/visual-checklist.md,'
    + '\nthen `npm run visual:diff -- --promote` to make this run the baseline.');
}

process.exit(missing ? 1 : 0);
