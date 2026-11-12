// A test's temp folders: tempDir makes one under the system's temp folder, and
// the folder goes, with whatever the test or a process it started wrote in it,
// when the test file's process exits. Node runs each test file in a process of
// its own, so a file's folders go as the file ends: a test that threw, or a
// cleanup a test never reached, leaves none behind.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const made = [];

process.once('exit', removeTempDirs);

/** A new empty folder under os.tmpdir() whose name starts with prefix, gone when this process exits. */
export function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** A file or folder a test makes beside a temp folder rather than in it (an archive, a linked worktree), gone with the folders. */
export function removeOnExit(target) {
  made.push(target);
  return target;
}

/** Remove every folder tempDir made in this process, and what removeOnExit was given; it runs on exit, so it never throws. */
export function removeTempDirs() {
  for (const target of made.splice(0)) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // windows may still hold a file a child had open; it's in the temp folder
    }
  }
}
