import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, stat, chmod, writeFile, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  readCredentialFile, writeCredentialFile,
} from '../../scripts/lib/credentialFile.mjs'

// WHY THESE EXIST
// Two harness files hold a Supabase refresh token, which carries an account's
// authority. Both were created world-readable, and the first fix — passing
// `{ mode: 0o600 }` to writeFile — does nothing to a file that already exists,
// so re-minting over an old key left it readable while the script logged
// "mode 600". Both rounds of that were found by review rather than by a test,
// which is the reason for this file: the behaviour is pure filesystem, so there
// is no excuse for not asserting it.

let dir
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'tf-cred-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const modeOf = async (f) => (await stat(f)).mode & 0o777

describe('writing a file that holds a credential', () => {
  it('creates it readable only by its owner', async () => {
    const f = path.join(dir, 'key.json')
    await writeCredentialFile(f, { refresh_token: 'abc' })
    expect(await modeOf(f)).toBe(0o600)
  })

  it('narrows a file that already exists with loose permissions', async () => {
    // THE DEFECT THIS PINS. `writeFile(f, data, { mode })` applies the mode
    // only on creation, so this case silently kept 0644 — measured, and the
    // reason every write now goes through a fresh file and a rename.
    const f = path.join(dir, 'key.json')
    await writeFile(f, '{"refresh_token":"old"}')
    await chmod(f, 0o644)
    await writeCredentialFile(f, { refresh_token: 'new' })
    expect(await modeOf(f)).toBe(0o600)
    expect((await readCredentialFile(f)).refresh_token).toBe('new')
  })

  it('leaves no staging file behind', async () => {
    const f = path.join(dir, 'key.json')
    await writeCredentialFile(f, { refresh_token: 'abc' })
    await writeCredentialFile(f, { refresh_token: 'def' })
    expect(await readdir(dir)).toEqual(['key.json'])
  })

  it('cannot be redirected by a planted staging file', async () => {
    // A fixed `.next` name could be pre-created, or pointed at the live key by
    // a symlink, so that the write corrupted the primary BEFORE the rename
    // that was supposed to make the replacement atomic. The staging name is
    // now unique per call and opened O_EXCL, so neither works.
    const f = path.join(dir, 'key.json')
    await writeCredentialFile(f, { refresh_token: 'live' })
    await writeFile(path.join(dir, 'key.json.next'), 'planted')
    await symlink(f, path.join(dir, 'key.json.decoy'))
    await writeCredentialFile(f, { refresh_token: 'replacement' })
    expect((await readCredentialFile(f)).refresh_token).toBe('replacement')
    expect(await modeOf(f)).toBe(0o600)
  })
})

describe('reading a file that holds a credential', () => {
  it('narrows loose permissions and reports the exposure', async () => {
    const f = path.join(dir, 'key.json')
    await writeFile(f, '{"refresh_token":"abc"}')
    await chmod(f, 0o644)
    const said = []
    const parsed = await readCredentialFile(f, { onExposed: m => said.push(m) })
    expect(parsed.refresh_token).toBe('abc')
    expect(await modeOf(f)).toBe(0o600)
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('644')
    // The exposure is stated as past tense, because a chmod does not undo it.
    expect(said[0]).toContain('readable beyond its owner')
  })

  it('says nothing when the permissions were already right', async () => {
    const f = path.join(dir, 'key.json')
    await writeCredentialFile(f, { refresh_token: 'abc' })
    const said = []
    await readCredentialFile(f, { onExposed: m => said.push(m) })
    expect(said).toEqual([])
  })

  it('refuses a symbolic link rather than chmodding whatever it points at', async () => {
    const real = path.join(dir, 'elsewhere.json')
    await writeCredentialFile(real, { refresh_token: 'abc' })
    const link = path.join(dir, 'key.json')
    await symlink(real, link)
    await expect(readCredentialFile(link)).rejects.toThrow(/symbolic link/)
  })

  it('names the reason for malformed content, never the content', async () => {
    const f = path.join(dir, 'key.json')
    await writeFile(f, 'not-json-ABCSECRETVALUE', { mode: 0o600 })
    await expect(readCredentialFile(f)).rejects.toThrow(/not readable as JSON/)
    await expect(readCredentialFile(f)).rejects.not.toThrow(/ABCSECRETVALUE/)
  })

  it('reports a missing file as ENOENT, so a caller can tell it apart', async () => {
    await expect(readCredentialFile(path.join(dir, 'absent.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })
})
