// The patch format `apply_patch` takes, as Devin's tool of that name and
// OpenAI Codex's send it: a file's path is in the patch text, not in a field,
// so filesInPatch is the only way the hooks learn which files one changed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editedFiles, filesInPatch, summarizePatchedFile } from '../lib.mjs';

const PATCH = [
  '*** Begin Patch',
  '*** Add File: src/new.ts',
  '+export const a = 1;',
  '+export const b = 2;',
  '*** Update File: src/models/user.ts',
  '@@ export interface User {',
  '   id: string;',
  '-  name: string;',
  '+  name: string | null;',
  '+  deletedAt?: Date;',
  '*** Delete File: src/old.ts',
  '*** Update File: src/a.ts',
  '*** Move to: src/b.ts',
  '@@',
  '-const x = 1;',
  '+const x = 2;',
  '*** End of File',
  '*** End Patch',
].join('\n');

test('every file a patch adds, updates, deletes or moves, in its order, with its line counts', () => {
  assert.deepEqual(filesInPatch(PATCH), [
    { path: 'src/new.ts', action: 'add', added: 2, removed: 0 },
    { path: 'src/models/user.ts', action: 'update', added: 2, removed: 1 },
    { path: 'src/old.ts', action: 'delete', added: 0, removed: 0 },
    // a move takes the file from one path and leaves it at another: both are changed
    { path: 'src/a.ts', action: 'delete', added: 0, removed: 0, to: 'src/b.ts' },
    { path: 'src/b.ts', action: 'move', added: 1, removed: 1, from: 'src/a.ts' },
  ]);
});

test('a line inside a hunk that looks like a header is content, not a file', () => {
  const tricky = [
    '*** Begin Patch',
    '*** Update File: docs/patches.md',
    '@@',
    '-*** Add File: not/a/file.ts',
    '+*** Delete File: nor/this.ts',
    ' *** Update File: nor/this/one.ts',
    '*** End Patch',
  ].join('\n');
  assert.deepEqual(filesInPatch(tricky), [{ path: 'docs/patches.md', action: 'update', added: 1, removed: 1 }]);
});

test('CRLF, stray whitespace and a path named twice are read as one file', () => {
  const patch = '*** Begin Patch\r\n*** Update File:  src/x.ts  \r\n+a\r\n*** Update File: src/x.ts\r\n-b\r\n*** End Patch\r\n';
  assert.deepEqual(filesInPatch(patch), [{ path: 'src/x.ts', action: 'update', added: 1, removed: 1 }]);
});

test('anything that is not a patch has no files, and nothing throws', () => {
  for (const value of [undefined, null, 42, {}, [], '', 'just some text', '*** Begin Patch\n*** End Patch', '*** Add File: ']) {
    assert.deepEqual(filesInPatch(value), [], JSON.stringify(value));
  }
});

test('a huge patch is read to a bounded number of files', () => {
  const many = ['*** Begin Patch', ...Array.from({ length: 500 }, (_, i) => `*** Add File: gen/f${i}.ts\n+x`), '*** End Patch'].join('\n');
  const files = filesInPatch(many);
  assert.ok(files.length > 0 && files.length <= 100, `${files.length} files`);
  assert.equal(files[0].path, 'gen/f0.ts');
});

test('editedFiles: the files a tool call names, whichever agent made it', () => {
  // Claude Code
  assert.deepEqual(editedFiles('Edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' }), ['/r/a.ts']);
  assert.deepEqual(editedFiles('NotebookEdit', { notebook_path: '/r/n.ipynb' }), ['/r/n.ipynb']);
  // Devin: lowercase tools, a path under either name
  assert.deepEqual(editedFiles('edit', { path: 'src/a.ts' }), ['src/a.ts']);
  assert.deepEqual(editedFiles('write', { file_path: 'src/b.ts', content: 'x' }), ['src/b.ts']);
  assert.deepEqual(editedFiles('apply_patch', { command: PATCH }), ['src/new.ts', 'src/models/user.ts', 'src/old.ts', 'src/a.ts', 'src/b.ts']);
  // the shell form Codex sends a patch in
  assert.deepEqual(editedFiles('apply_patch', { command: ['apply_patch', PATCH] }).length, 5);
  // a `path` is only a file to an edit tool: a search's directory is not one
  assert.deepEqual(editedFiles('Grep', { path: 'src' }), []);
  assert.deepEqual(editedFiles('Bash', { command: 'sed -i s/a/b/ x' }), []);
  assert.deepEqual(editedFiles('Edit', null), []);
});

test("a move is said by where the file went in the repository, and never by a path outside it", () => {
  // what the room may know a path by: inside the repository, relative; outside, nothing
  const place = (p) => (p.startsWith('/') ? null : p);
  const out = { path: 'src/a.ts', action: 'delete', added: 0, removed: 0, to: '/Users/someone/private/notes/a.ts' };
  assert.equal(summarizePatchedFile(out, place), 'moved out of the repository, in a patch');
  assert.equal(summarizePatchedFile({ ...out, to: 'src/b.ts' }, place), 'moved to src/b.ts, in a patch');
  const into = { path: 'src/b.ts', action: 'move', added: 1, removed: 0, from: '/Users/someone/private/notes/a.ts' };
  assert.equal(summarizePatchedFile(into, place), 'moved into the repository, +1/-0 lines, in a patch');
  assert.equal(summarizePatchedFile({ ...into, from: 'src/a.ts' }, place), 'moved from src/a.ts, +1/-0 lines, in a patch');
  // asked with no way to tell, it names no path at all
  assert.equal(summarizePatchedFile(out), 'moved, in a patch');
  assert.equal(summarizePatchedFile(into), 'moved, +1/-0 lines, in a patch');
});
