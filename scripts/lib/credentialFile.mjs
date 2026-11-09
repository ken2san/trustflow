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
//
// THE PRECONDITION, STATED BECAUSE IT BOUNDS EVERYTHING ABOVE
// The containing directory is assumed to be writable only by the owning user.
// O_EXCL protects CREATION, not a pathname's integrity afterwards: anyone who
// can write the directory can unlink or replace an entry between the open and
// the rename, and no flag here prevents that. These helpers are for a local
// harness keeping its own credentials tidy under the user's own directories.
// They are NOT an isolation boundary against another principal who can write
// those directories, and the same-OS-user limitation documented in
// ../two-agent-transaction.mjs applies here too.

import { randomBytes } from 'node:crypto';
import { constants as FS } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';

/** Owner read/write and nothing else. */
const OWNER_ONLY = 0o600;

/**
 * Write JSON to a file that holds a credential, atomically, owner-only.
 *
 * Returns the path, so a caller can log where it went — never what went there.
 */
export async function writeCredentialFile(file, value, { stagingName = null } = {}) {
  // Injectable only so a test can precreate this exact pathname and prove the
  // exclusive open refuses it. Codex's finding 2 on the third review: with a
  // randomized name no test could reach the staging path, so changing 'wx' to
  // 'w' passed all nine tests — the O_EXCL protection was unpinned.
  const staging = stagingName
    ?? `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;

  // 'wx' is O_WRONLY|O_CREAT|O_EXCL: it creates, or it fails. It never opens an
  // existing file and never follows a link, which is the whole point.
  const handle = await open(staging, 'wx', OWNER_ONLY);

  // Everything after the open is covered, not just the rename. A serialization
  // error, a failed write or a failed close used to exit before the cleanup and
  // leave a staging copy of the credential behind — restrictive and gitignored,
  // but a second copy. Codex's finding 3.
  try {
    try {
      await handle.writeFile(JSON.stringify(value, null, 2));
    } finally {
      await handle.close();
    }
    await rename(staging, file);
  } catch (err) {
    // The original error is what the caller needs; a failure to clean up must
    // not replace it.
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
  // O_NOFOLLOW, not lstat-then-open.
  //
  // The first version checked with `lstat` and then opened by path, and Codex
  // demonstrated the gap: replace the regular file with a symlink between those
  // two calls and the descriptor's own stat sees a perfectly good regular file
  // — the link's target — which then gets read and chmodded. The check and the
  // open disagreed about which object they meant, which is the very thing the
  // descriptor was introduced to prevent, moved one step earlier.
  //
  // Opening with O_NOFOLLOW removes the gap for the final component: if the
  // path is a symlink at the moment of opening, the open itself fails. It says
  // nothing about the ancestor directories — see the precondition above.
  let handle;
  try {
    handle = await open(file, FS.O_RDONLY | FS.O_NOFOLLOW);
  } catch (err) {
    if (err.code === 'ELOOP' || err.code === 'EMLINK') {
      throw new Error(
        `${file} is a symbolic link; a credential file must be a regular file`,
      );
    }
    throw err;
  }
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
