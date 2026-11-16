import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIXTURE_USAGE, parseFixtureArgs } from '../../scripts/lib/fixtureArgs.mjs'
import { CANCEL_FIXTURE_FILE, CANCEL_FIXTURE_LOCK } from '../../scripts/lib/fixtureLock.mjs'

// The fixture writer's arguments. `--chek` used to fall through to a
// recording run and `--check --resume` ran resume (Codex Task 90). Offline:
// the script is only ever started here with arguments it must refuse.

const SCRIPT = fileURLToPath(new URL('../../scripts/record-cancel-fixture.mjs', import.meta.url))

const INVALID = [
  ['--chek'],
  ['--check', '--resume'],
  ['--resume', '--check'],
  ['--check', '--check'],
  ['--resume', '--resume'],
  ['--retry-unsettled'],
  ['--resume', '--retry-unsettled'],
  ['check'],
  ['--check=1'],
  [''],
]

describe('parseFixtureArgs', () => {
  it('accepts exactly no arguments, --check, or --resume', () => {
    expect(parseFixtureArgs([])).toBe('record')
    expect(parseFixtureArgs(['--check'])).toBe('check')
    expect(parseFixtureArgs(['--resume'])).toBe('resume')
  })

  it('refuses unknown, duplicate and conflicting arguments', () => {
    for (const argv of INVALID) expect(parseFixtureArgs(argv), JSON.stringify(argv)).toBeNull()
  })
})

describe('record-cancel-fixture.mjs with invalid arguments', () => {
  // A stripped environment and a configuration file that does not exist: if
  // the refusal ever regressed, loading the E2E configuration would fail too,
  // so this test can never reach a project.
  const run = (argv) => {
    const home = mkdtempSync(path.join(tmpdir(), 'tf-args-'))
    try {
      return spawnSync(process.execPath, [SCRIPT, ...argv], {
        encoding: 'utf8',
        timeout: 15_000,
        env: { PATH: '', HOME: home, TF_E2E_ENV_FILE: path.join(home, 'absent.env') },
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  it('exits 2 with only the fixed message, before any lock or record file exists', () => {
    const before = [existsSync(CANCEL_FIXTURE_FILE), existsSync(CANCEL_FIXTURE_LOCK)]
    for (const argv of INVALID) {
      const r = run(argv)
      expect(r.status, JSON.stringify(argv)).toBe(2)
      expect(r.stdout).toBe('')
      expect(r.stderr).toBe(`STOP: unrecognised arguments; nothing was done. ${FIXTURE_USAGE}\n`)
    }
    expect([existsSync(CANCEL_FIXTURE_FILE), existsSync(CANCEL_FIXTURE_LOCK)]).toEqual(before)
  // Ten Node start-ups in a row: ~2s alone, ~9s under the full suite's load.
  }, 60_000)
})
