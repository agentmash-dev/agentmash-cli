// What OpenCode hands a plugin's tool.execute.before and tool.execute.after
// hooks, recorded from OpenCode 1.18.34's source (anomalyco/opencode, tag
// v1.18.34), not from a live run:
//
//   packages/opencode/src/session/tools.ts L104-129   before: (input { tool, sessionID, callID }, output { args }),
//                                                     args as the model sent them; after: (input { tool, sessionID,
//                                                     callID, args }, output = the tool's result, with attachments)
//   packages/opencode/src/tool/edit.ts L48-55         edit { filePath, oldString, newString, replaceAll? }
//   packages/opencode/src/tool/write.ts L20-25        write { content, filePath }
//   packages/opencode/src/tool/apply_patch.ts L19     apply_patch { patchText }, offered in place of edit and write
//                                                     to GPT models (tool/registry.ts L296-300)
//   packages/opencode/src/tool/read.ts L28-36         read { filePath, offset?, limit? }
//   packages/opencode/src/tool/shell/prompt.ts L16-22 bash { command, timeout?, workdir? }
//   edit.ts L203-210, write.ts L93-99, apply_patch.ts L296-301   each one's result
//
// ids as OpenCode makes them (packages/opencode/src/id/id.ts): ses_ and msg_
// and prt_; a callID is the provider's own tool call id.

export const SESSION = 'ses_2f6a1c0e8ffeZ3kq7XyR1bW4tN';
export const CALL = 'toolu_01HqT5n9WcVd3sKfXr2bY7aE';

/** tool.execute.before's two arguments, for `tool` called with `args`. */
export const before = (tool, args, { sessionID = SESSION, callID = CALL } = {}) => [{ tool, sessionID, callID }, { args }];

/** tool.execute.after's two arguments, for `tool` called with `args`, which returned `result`. */
export const after = (tool, args, result, { sessionID = SESSION, callID = CALL } = {}) => [
  { tool, sessionID, callID, args },
  { ...result, attachments: undefined },
];

// ── each tool's arguments, as a model sends them ───────────────────────────

/** edit: filePath is described to the model as absolute; a relative one is joined to the instance directory (edit.ts L80-82). */
export const editArgs = (filePath) => ({ filePath, oldString: 'id: string', newString: 'id: string;\n  role: string' });
export const writeArgs = (filePath) => ({ content: 'export const b = 2;\n', filePath });
/** apply_patch: the files are named only inside the patch, relative to the instance directory (apply_patch.ts L73). */
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
export const readArgs = (filePath) => ({ filePath, offset: 1, limit: 2000 });
export const bashArgs = (workdir) => ({ command: "sed -i '' 's/id: string/id: number/' src/models/user.ts", timeout: 120000, workdir });

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
  metadata: { diagnostics: {}, filepath: filePath, exists: false },
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
export const bashResult = () => ({ title: "sed -i '' 's/id: string/id: number/' src/models/user.ts", output: '', metadata: { output: '', exit: 0, description: 'Change the id type' } });
