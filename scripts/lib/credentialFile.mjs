// Reading and writing a file that holds a credential.
//
// WHY THIS EXISTS, AND THE MISTAKE THAT PUT IT HERE
// Two harness files hold a Supabase refresh token, which carries an account's
// authority: the owner key (../agents/mint-owner-key.mjs) and the session cache
// (./tfClient.mjs). Both were created with a plain `writeFile`, so under the
// usual umask 022 they landed as 0644 — group- and world-readable. Codex found
// that (P1, .ada/codex-task15-review.md).
//
// The fix was `writeFile(file, data, { mode: 0o600 })`, and it does not work.
// **`mode` applies only when the file is CREATED.** Writing over an existing
// 0644 file leaves it 0644, so re-minting over a previous version's key kept it
// readable while the script printed "mode 600" — a cosmetic fix with a
// confident log line, which is worse than no fix. Measured:
//
//   writeFileSync(f, 'a'); chmodSync(f, 0o644);
//   writeFileSync(f, 'b', { mode: 0o600 });   // -> still 644
//
// Codex found that too, on the re-review, which is the second time one of my
// fixes to this file needed fixing.
//
// SO EVERY WRITE GOES THROUGH A FRESH FILE
// `writeCredentialFile` creates a uniquely named sibling with O_CREAT|O_EXCL
// and mode 0600, writes it, and renames it over the destination. That is one
// mechanism answering four separate problems:
//
//   - the destination's old mode is irrelevant, because rename replaces the
//     inode rather than the contents, and the new inode is 0600;
//   - O_EXCL refuses to open anything that already exists, so a stale staging
//     file from an earlier crash cannot be reused and renamed into place;
//   - O_CREAT|O_EXCL does not follow a symlink, so a planted staging link
//     cannot redirect the write at the live key — which it could, before,
//     corrupting the primary before the rename that was supposed to protect it;
//   - rename within a filesystem is atomic, so a reader sees the old file or
//     the new one, never a fragment.
//
// A unique name per call rather than a fixed `.next`: two callers then cannot
// collide on the staging file. They can still both rename, and the last one
// wins — this is not a lock, and ../lib/ownerKey.mjs says so.
//
// No fsync and no durability claim. Power loss is not the threat being
// addressed; a truncated credential after an ordinary crash was.

import { randomBytes } from 'node:crypto';
import { lstat, open, rename, unlink } from 'node:fs/promises';

/** Owner read/write and nothing else. */
const OWNER_ONLY = 0o600;

/**
 * Write JSON to a file that holds a credential, atomically, owner-only.
 *
 * Returns the path, so a caller can log where it went — never what went there.
 */
export async function writeCredentialFile(file, value) {
  const staging = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;

  // 'wx' is O_WRONLY|O_CREAT|O_EXCL: it creates, or it fails. It never opens an
  // existing file and never follows a link, which is the whole point.
  const handle = await open(staging, 'wx', OWNER_ONLY);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
  } finally {
    await handle.close();
  }

  try {
    await rename(staging, file);
  } catch (err) {
    await unlink(staging).catch(() => { /* nothing better to do */ });
    throw err;
  }
  return file;
}

/**
 * Read JSON from a file that holds a credential, refusing anything odd and
 * narrowing the permissions if they are loose.
 *
 * Descriptor-based on purpose: `stat` then `chmod` then `readFile` by path are
 * three chances to be pointed at three different objects. Here the file is
 * opened once and the checks, the chmod and the read all go through that one
 * handle, so they cannot disagree about which file they mean.
 *
 * Narrowing rather than refusing: 0600 is the only correct mode for this file,
 * and refusing would leave an over-permissive credential in place while the
 * operator reads an error. The exposure is reported, because a chmod does not
 * undo the time the file was readable — `onExposed` receives that message.
 */
export async function readCredentialFile(file, { onExposed = null } = {}) {
  // Before opening: a symlink where a credential should be is not a
  // permissions problem to repair, it is the wrong file.
  const link = await lstat(file);
  if (link.isSymbolicLink()) {
    throw new Error(`${file} is a symbolic link; a credential file must be a regular file`);
  }

  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error(`${file} is not a regular file`);
    }
    const mode = info.mode & 0o777;
    if (mode & 0o077) {
      await handle.chmod(OWNER_ONLY);
      onExposed?.(`${file} was mode ${mode.toString(8)} — narrowed to 600. `
        + 'It was readable beyond its owner until now.');
    }

    const text = await handle.readFile('utf8');
    try {
      return JSON.parse(text);
    } catch (err) {
      // The reason, never the content: a JSON parse error can quote its input,
      // and the input here is a credential.
      throw new Error(
        `${file} is not readable as JSON (${err.name ?? 'parse error'}). `
        + 'Not printing it: this file is a credential.',
      );
    }
  } finally {
    await handle.close();
  }
}
