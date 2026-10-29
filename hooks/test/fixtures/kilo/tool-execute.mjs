// What Kilo Code hands a plugin's tool.execute.before and tool.execute.after
// hooks, recorded from Kilo Code 7.8.3's source (Kilo-Org/kilocode, tag
// v7.8.3), not from a live run:
//
//   packages/opencode/src/session/tools.ts L197-221      before: (input { tool, sessionID, callID }, output { args }),
//                                                        args as the model sent them, not yet checked against the
//                                                        tool's schema; after: (input { tool, sessionID, callID,
//                                                        args }, output = the tool's result, with attachments)
//   packages/opencode/src/tool/edit.ts L74-83            edit { filePath, oldString, newString, replaceAll? }
//   packages/opencode/src/tool/write.ts L24-29           write { content, filePath }
//   packages/opencode/src/tool/apply_patch.ts L22-24     apply_patch { patchText }, offered in place of edit to GPT
//                                                        models (tool/registry.ts L398-400, kilocode/tool/registry.ts
//                                                        L56-65, usePatch)
//   packages/opencode/src/kilocode/tool/notebook-host.ts L81-98   notebook_edit { path, action, index?,
//                                                        expected_revision?, kind?, language?, source? }, VS Code
//                                                        with experimental.native_notebook_tools only
//   packages/opencode/src/tool/shell/prompt.ts L24-31    bash { command, timeout?, workdir?, description? }
//   edit.ts L231-239, write.ts L104-113, apply_patch.ts L333-340   each one's result
//
// ids as Kilo makes them: ses_ and msg_ and prt_; a callID is the provider's
// own tool call id.

export const SESSION = 'ses_1f2c3d4e5ffeA7kq9XyR2bW4tN';
export const CALL = 'toolu_01KqT5n9WcVd3sKfXr2bY7aE';

/** tool.execute.before's two arguments, for `tool` called with `args`. */
export const before = (tool, args, { sessionID = SESSION, callID = CALL } = {}) => [{ tool, sessionID, callID }, { args }];

/** tool.execute.after's two arguments, for `tool` called with `args`, which returned `result`. */
export const after = (tool, args, result, { sessionID = SESSION, callID = CALL } = {}) => [
  { tool, sessionID, callID, args },
  { ...result, attachments: undefined },
];

// ── each tool's arguments, as a model sends them ───────────────────────────

/** edit: filePath is described to the model as absolute; a relative one is joined to the instance directory (edit.ts L107-109). */
export const editArgs = (filePath) => ({ filePath, oldString: 'id: string', newString: 'id: string;\n  role: string' });
export const writeArgs = (filePath) => ({ content: 'export const b = 2;\n', filePath });
/** apply_patch: the files are named only inside the patch, relative to the instance directory (apply_patch.ts L78). */
export const patchArgs = (relPath) => ({
  patchText: [
    '*** Begin Patch',
    `*** Update File: ${relPath}`,
    '@@',
    '-export interface User { id: string }',
    '+export interface User { id: string; role: string }',
    '*** End Patch',
  ].join('\n'),
});
/** notebook_edit: one cell of a notebook, by a path relative to the request directory or absolute. */
export const notebookArgs = (notebookPath) => ({
  path: notebookPath,
  action: 'replace',
  index: 2,
  expected_revision: 'rev_7f3a',
  kind: 'code',
  language: 'python',
  source: 'df = load_users()\n',
});
export const readArgs = (filePath) => ({ filePath, offset: 1, limit: 2000 });
export const bashArgs = (workdir) => ({ command: "sed -i '' 's/id: string/id: number/' src/models/user.ts", timeout: 120000, workdir, description: 'Change the id type' });

// ── what each returned (the after hook's output) ───────────────────────────

export const editResult = (filePath, worktree) => ({
  title: filePath.slice(worktree.length + 1),
  output: 'Edit applied successfully.',
  metadata: {
    diagnostics: {},
    diff: `Index: ${filePath}\n===================================================================\n--- ${filePath}\n+++ ${filePath}\n@@ -1,1 +1,2 @@\n-export interface User { id: string }\n+export interface User { id: string;\n+  role: string }\n`,
    filediff: { file: filePath, patch: '', additions: 2, deletions: 1 },
  },
});
export const writeResult = (filePath, worktree) => ({
  title: filePath.slice(worktree.length + 1),
  output: 'Wrote file successfully.',
  metadata: { diagnostics: {}, filepath: filePath, exists: false, diff: '', filediff: { file: filePath, patch: '', additions: 1, deletions: 0 } },
});
export const patchResult = (filePath, relPath) => ({
  title: `Success. Updated the following files:\nM ${relPath}`,
  output: `Success. Updated the following files:\nM ${relPath}`,
  metadata: {
    diff: '',
    files: [{ filePath, relativePath: relPath, type: 'update', patch: '', additions: 1, deletions: 1 }],
    diagnostics: {},
  },
});
export const notebookResult = (notebookPath) => ({
  title: 'replace notebook cell 2',
  output: '{\n  "action": "replace",\n  "index": 2\n}',
  metadata: { path: notebookPath, revision: 'rev_7f3b', index: 2 },
});
export const bashResult = () => ({ title: "sed -i '' 's/id: string/id: number/' src/models/user.ts", output: '', metadata: { output: '', exit: 0, description: 'Change the id type' } });
