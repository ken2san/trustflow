import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { acquireFixtureLock } from '../../scripts/lib/fixtureLock.mjs'

// The lock shared by the cancellation fixture's writer and its spec. The
// earlier take-over of a dead holder's lock let two contenders both end up
// holding it (Codex Task 88); these pin the replacement: an existing lock is
// never removed, and release only removes the caller's own.

let dir
let lockFile
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'tf-lock-'))
  lockFile = path.join(dir, '.cancel-fixture.json.lock')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** A PID that is certainly not running: past the platform maximum. */
const DEAD_PID = 2 ** 22 + 12345

describe('acquireFixtureLock', () => {
  it('creates an owner-only lock and releases it', async () => {
    const release = await acquireFixtureLock(lockFile, 'test')
    expect((await stat(lockFile)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(lockFile, 'utf8')).pid).toBe(process.pid)
    expect(await release()).toBe(true)
    await expect(stat(lockFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lets exactly one of two simultaneous contenders through', async () => {
    const results = await Promise.allSettled([
      acquireFixtureLock(lockFile, 'a'),
      acquireFixtureLock(lockFile, 'b'),
    ])
    const won = results.filter(r => r.status === 'fulfilled')
    const lost = results.filter(r => r.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect(lost[0].reason.code).toBe('ELOCKED')
  })

  it('refuses while an active holder has it', async () => {
    const release = await acquireFixtureLock(lockFile, 'holder')
    await expect(acquireFixtureLock(lockFile, 'second')).rejects.toMatchObject({ code: 'ELOCKED' })
    expect(await release()).toBe(true)
  })

  it('never takes over a stale lock, even with two contenders at once', async () => {
    const stale = JSON.stringify({ pid: DEAD_PID, purpose: 'crashed run', token: 'old', created_at: 'then' })
    await writeFile(lockFile, stale)
    const results = await Promise.allSettled([
      acquireFixtureLock(lockFile, 'a'),
      acquireFixtureLock(lockFile, 'b'),
    ])
    expect(results.every(r => r.status === 'rejected' && r.reason.code === 'ELOCKED')).toBe(true)
    expect(results[0].reason.message).toMatch(/not running/)
    // Untouched: the stale lock is for a human to verify and remove.
    expect(await readFile(lockFile, 'utf8')).toBe(stale)
  })

  it('refuses an unreadable lock rather than guessing about it', async () => {
    await writeFile(lockFile, 'not json')
    await expect(acquireFixtureLock(lockFile, 'x')).rejects.toMatchObject({ code: 'ELOCKED' })
    expect(await readFile(lockFile, 'utf8')).toBe('not json')
  })

  // Best effort only: a replacement made between release's read and its
  // unlink is not caught, which is why manual cleanup waits for the holder
  // to exit (see fixtureLock.mjs).
  it('does not remove a lock replaced before it releases (best-effort check)', async () => {
    const release = await acquireFixtureLock(lockFile, 'first')
    // A manual cleanup, then someone else's lock at the same path.
    await rm(lockFile)
    const releaseSecond = await acquireFixtureLock(lockFile, 'second')
    expect(await release()).toBe(false)
    expect(JSON.parse(await readFile(lockFile, 'utf8')).purpose).toBe('second')
    expect(await releaseSecond()).toBe(true)
  })

  it('releases once', async () => {
    const release = await acquireFixtureLock(lockFile, 'once')
    expect(await release()).toBe(true)
    expect(await release()).toBe(false)
  })
})
