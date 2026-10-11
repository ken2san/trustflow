#!/usr/bin/env node
// Does the proposed migration actually compile, and does it agree with the
// TypeScript rules?
//
//   npm run check:sql-draft
//
// WHY THIS EXISTS
// The first version of the draft could not have been applied at all. It used
//
//   not exists (select 1 from jsonb_array_elements(dod) ...)
//
// inside a CHECK constraint, which PostgreSQL rejects outright —
// "0A000: cannot use subquery in check constraint". Nothing in the repository
// would have caught that; it would have failed at `supabase db push`, against
// a real project, as the first feedback anyone got. Reviewing SQL by reading it
// is how that happened, so this runs it instead.
//
// The second defect it caught is the one reading could never have found. SQL/
// JSON path defaults to lax mode, which flattens nested arrays, so `$[*]` over
// [["nested"]] yields the string "nested" and a nested array passed a test for
// "every element is a string". It needed `strict`. That is not a thing you
// notice in review; it is a thing a case table notices.
//
// WHERE IT RUNS
// A throwaway PostgreSQL container, with NO published port — reachable only
// through `docker exec`, never from the host or the LAN — and removed when the
// run ends, including on failure. It never touches the E2E or production
// projects, and it holds no real data.

import { readFile } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { violationsOf } from '../supabase/functions/_shared/agreementRules.ts';

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRAFT = path.join(REPO, 'docs/proposals/20261012000000_agreement_wellformedness.sql.draft');
const FIXTURE = path.join(REPO, 'tests/fixtures/agreementCases.json');
const CONTAINER = 'tf-sql-draft-check';
const IMAGE = 'postgres:17';

// The columns the draft constrains, as production has them. Not the whole
// table: this checks the constraints, not the schema.
const TABLE = `
create table contracts (
  id                  uuid primary key default gen_random_uuid(),
  project_name        text not null,
  dod                 jsonb not null,
  amount_jpy          integer not null,
  currency            text not null,
  deadline            date,
  invited_hirer_email text,
  hirer_email         text,
  earner_display_name text,
  performed_by        text not null default 'creator'
);`;

// No `-i`: `docker exec -i` holds stdin open and blocks forever when the
// caller attaches none, which is not a timeout but a hang. Only the call that
// feeds the draft on stdin needs it.
const psql = (sql) => run('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres',
  '-v', 'ON_ERROR_STOP=1', '-tAc', sql]);

async function startPostgres() {
  await run('docker', ['rm', '-f', CONTAINER]).catch(() => {});
  // No -p. The container is reachable only via `docker exec`, so nothing is
  // published to the host or the network. The password is irrelevant for the
  // same reason, but is not a weak literal either.
  const password = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex');
  await run('docker', ['run', '-d', '--name', CONTAINER,
    '-e', `POSTGRES_PASSWORD=${password}`, IMAGE]);

  for (let i = 0; i < 60; i++) {
    try {
      await run('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'postgres']);
      await psql('select 1');
      return;
    } catch { await new Promise(r => setTimeout(r, 1000)); }
  }
  throw new Error('PostgreSQL did not become ready within 60s');
}

// Two different literal forms, kept apart because conflating them produced a
// false failure on the first run: JSON.stringify('JPY') is "JPY" WITH the
// quotes, so `currency` arrived as a 5-character string and the currency check
// refused every otherwise-valid row. The case table caught it, which is the
// argument for having one.
const sqlText = (v) => v === null || v === undefined
  ? 'null'
  : `'${String(v).replace(/'/g, "''")}'`;
const sqlJson = (v) => v === null || v === undefined
  ? 'null'
  : `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;

async function main() {
  // DRAFT is read only to fail early with a clear message if it is missing;
  // psql reads the copy inside the container.
  const [, fixture] = await Promise.all([
    readFile(DRAFT, 'utf8'),
    readFile(FIXTURE, 'utf8').then(JSON.parse),
  ]);
  const { cases, baseline, sqlCannotExpress } = fixture;

  console.log(`\nApplying the draft to a throwaway ${IMAGE} (no published port)\n`);
  await startPostgres();
  await psql(TABLE);

  // 1. Does it compile at all? This is the check that was missing.
  //
  // The draft is copied into the container and read with `-f <path>` rather
  // than piped to `-f -`. execFile has no `input` option — that belongs to
  // execFileSync — so the pipe form silently never wrote stdin and never
  // closed it, and psql waited on it forever. A hang, not an error.
  try {
    await run('docker', ['cp', DRAFT, `${CONTAINER}:/tmp/draft.sql`]);
    await run('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-f', '/tmp/draft.sql']);
    console.log(' ok  the draft applies');
  } catch (e) {
    console.error('FAIL the draft does not apply\n');
    console.error((e.stderr || e.message).trim());
    process.exit(1);
  }

  // 2. Does the database agree with agreementRules.ts, case by case?
  let failures = 0;
  for (const { label, patch, wellFormed, sqlEnforced } of cases) {
    if (!sqlEnforced) continue;
    const row = { ...baseline, ...patch };

    const tsAccepts = violationsOf(row, { now: new Date('2026-10-11T12:00:00Z') }).length === 0;

    let sqlAccepts = true;
    try {
      await psql(`insert into contracts
        (project_name, dod, amount_jpy, currency, deadline, invited_hirer_email,
         earner_display_name, performed_by)
        values (${sqlText(row.project_name)}, ${sqlJson(row.dod)}, ${row.amount_jpy},
                ${sqlText(row.currency)}, ${sqlText(row.deadline)}::date,
                ${sqlText(row.invited_hirer_email)}, ${sqlText(row.earner_display_name)},
                ${sqlText(row.performed_by)})`);
    } catch { sqlAccepts = false; }

    // The two must agree with the fixture AND with each other. Agreeing with
    // each other while both being wrong is the failure a shared case table is
    // supposed to make visible, so the expected value is asserted too.
    const good = tsAccepts === wellFormed && sqlAccepts === wellFormed;
    if (!good) failures++;
    console.log(`${good ? ' ok ' : 'FAIL'} ${label.padEnd(26)} `
      + `expected=${wellFormed ? 'accept' : 'reject'} ts=${tsAccepts ? 'accept' : 'reject'} sql=${sqlAccepts ? 'accept' : 'reject'}`);
  }

  console.log(`\n${cases.filter(c => c.sqlEnforced).length} cases, ${failures} disagreements`);
  if (sqlCannotExpress.length) {
    console.log('\nRules the database deliberately cannot express:');
    for (const { label, why } of sqlCannotExpress) console.log(`  ${label}\n    ${why}`);
  }
  process.exit(failures ? 1 : 0);
}

// Always clean up, including on failure: a leftover database container is
// exactly the kind of thing that sits running for a week.
const cleanup = async () => { await run('docker', ['rm', '-f', CONTAINER]).catch(() => {}); };
// execFileSync, imported statically: require() does not exist in an ES module,
// so the previous form threw inside the one handler that must not fail.
process.on('exit', () => { try { execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' }); } catch {} });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await cleanup(); process.exit(130); });

main()
  .then(cleanup, async (err) => { console.error(`\n${err.message}`); await cleanup(); process.exit(1); });
