// What Cline's VS Code extension (saoudrizwan.claude-dev 4.1.22) writes on a
// hook's stdin, read from cline/cline at tag v4.1.22:
// apps/vscode/src/sdk/hooks-adapter.ts builds the data (every tool parameter
// through toStringRecord: a string as it is, anything else JSON.stringify'd,
// so a null is "null"; PostToolUse's result is String(output), and a tool's
// output is an object, so "[object Object]"), apps/vscode/src/core/hooks/
// hook-factory.ts adds clineVersion, hookName, timestamp (Date.now() as a
// string), workspaceRoots, userId and model {provider: "unknown", slug:
// "unknown"}, and serializes it with the generated HookInput.toJSON
// (apps/vscode/proto/cline/hooks.proto): camelCase, fields in the proto's
// order, and every proto3 default left out (no `parameters` when there are
// none, no `success` when it is false). The tools are the SDK's
// (sdk/packages/core/src/extensions/tools/schemas.ts): editor {path,
// old_text?, new_text, insert_line?}, apply_patch {input}, read_files
// {files: [{path}]}. What differs from one test to the next is passed in:
// the task (Cline's conversation id) and the workspace root.

const base = (hookName, { taskId, root }) => ({
  clineVersion: '4.1.22',
  hookName,
  timestamp: '1791158400123',
  taskId,
  workspaceRoots: [root],
  userId: 'c6f0a8e2-2b5e-4d8a-9a51-0f3e7d2b9c11',
  model: { provider: 'unknown', slug: 'unknown' },
});

/**
 * PreToolUse before `editor` replacing text. The model sent insert_line as
 * null (a strict JSON schema makes it send every field), which arrives as
 * the string "null".
 */
export const preEditorReplace = ({ taskId, root, path = `${root}/src/models/user.ts`, old_text = 'id: string', new_text = 'id: string;\n  role: string' }) => ({
  ...base('PreToolUse', { taskId, root }),
  preToolUse: { toolName: 'editor', parameters: { path, old_text, new_text, insert_line: 'null' } },
});

/** PreToolUse before `read_files`: its files are a JSON-stringified list. */
export const preReadFiles = ({ taskId, root }) => ({
  ...base('PreToolUse', { taskId, root }),
  preToolUse: { toolName: 'read_files', parameters: { files: JSON.stringify([{ path: `${root}/src/models/user.ts` }]) } },
});

/** PreToolUse before `apply_patch` sent as the bare patch string: toStringRecord gives {}, which proto3 leaves out. */
export const preApplyPatchBare = ({ taskId, root }) => ({
  ...base('PreToolUse', { taskId, root }),
  preToolUse: { toolName: 'apply_patch' },
});

/** PostToolUse after `editor` made a file (no old_text): the call went through, so success is there and true. */
export const postEditorCreate = ({ taskId, root, path = 'src/new.ts', new_text = 'export const a = 1;\n' }) => ({
  ...base('PostToolUse', { taskId, root }),
  postToolUse: { toolName: 'editor', parameters: { path, new_text }, result: '[object Object]', success: true, executionTimeMs: 41 },
});

/** PostToolUse after `editor` replaced text. */
export const postEditorReplace = ({ taskId, root, path = `${root}/src/models/user.ts`, old_text = 'id: string', new_text = 'id: string;\n  role: string' }) => ({
  ...base('PostToolUse', { taskId, root }),
  postToolUse: { toolName: 'editor', parameters: { path, old_text, new_text }, result: '[object Object]', success: true, executionTimeMs: 38 },
});

/**
 * PostToolUse after an `editor` call the person rejected at Cline's approval
 * prompt: the result is an error, success false, and so left out. (The
 * result's wording is the runtime's, not read by the hook.)
 */
export const postEditorRejected = ({ taskId, root }) => ({
  ...base('PostToolUse', { taskId, root }),
  postToolUse: {
    toolName: 'editor',
    parameters: { path: `${root}/src/models/user.ts`, old_text: 'id: string', new_text: 'id: number' },
    result: 'The user denied this operation.',
    executionTimeMs: 2210,
  },
});

/** UserPromptSubmit, before a turn: the latest prompt that is not a hook's own context. No attachments, so none sent. */
export const prompt = ({ taskId, root, text = 'give the user a role' }) => ({
  ...base('UserPromptSubmit', { taskId, root }),
  userPromptSubmit: { prompt: text },
});
