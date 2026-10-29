// PreToolUse and PostToolUse, as Factory Droid (CLI 0.233.0) writes them to a
// command hook's stdin. Droid is closed source, so these are recorded from
// its documentation and from integrations tested against it, not captured:
//   - the common fields and the PreToolUse example (Create with file_path and
//     content, permission_mode "off", a transcript under ~/.factory/projects):
//     docs.factory.com/harness/hooks.md, "Hook input", as served 2026-10-05
//   - snake_case, as the docs show it: confirmed live on 0.233.0 by
//     kenryu42/cc-safety-net PR #198 and on 0.171.0 by FailproofAI/failproofai
//     (src/hooks/types.ts)
//   - tool_response after a Create, { filePath, success }: the archived hooks
//     reference (docs.factory.ai/reference/hooks-reference, 2026-07-08); the
//     current page shows only `"tool_response": {}`. success false is how
//     failproofai and numbat read a tool that failed.
//   - Edit: file_path, per Factory's code-validation guide (archived
//     2026-07-08), which reads `.tool_input.file_path` for Create|Edit|ApplyPatch.
//     The keys of its old and new text are documented nowhere: Checkmarx's
//     ast-cx-hooks assumes old_string/new_string, and old_str/new_str is the
//     other spelling in use. Both are here, as two fixtures.
//   - ApplyPatch: `patch`, a patch in the apply_patch format ("*** Begin
//     Patch"), as Droid's ACP adapter sends it (HernanJiang/CraftStation,
//     src/supervisor/agents/acp/canonicalMapping.test.ts); Checkmarx falls
//     back to `diff`, and the code-validation guide reads file_path.
//   - Execute's command in `command`, the tool names Read, LS, Grep and Glob,
//     and MCP tools as mcp__<server>__<tool>: the docs' matcher list.
// The session id is a test's own; the transcript path is an example of its form.

/** One tool event's payload for `tool_name` with `tool_input`. */
export function toolUse(event, cwd, session, tool_name, tool_input, extra = {}) {
  return {
    session_id: session,
    transcript_path: `/Users/me/.factory/projects/-Users-me-project/${session}.jsonl`,
    cwd,
    permission_mode: 'off',
    hook_event_name: event,
    tool_name,
    tool_input,
    ...extra,
  };
}

const pre = (cwd, session, tool_name, tool_input) => toolUse('PreToolUse', cwd, session, tool_name, tool_input);

// ── before ──────────────────────────────────────────────────────────────────

/** Create: the whole new file (the docs' own example). */
export const create = (cwd, session, file_path, content) => pre(cwd, session, 'Create', { file_path, content });

/** Edit, its text under old_str/new_str. */
export const editStr = (cwd, session, file_path, old_str, new_str) => pre(cwd, session, 'Edit', { file_path, old_str, new_str });

/** Edit, its text under old_string/new_string. */
export const editString = (cwd, session, file_path, old_string, new_string) => pre(cwd, session, 'Edit', { file_path, old_string, new_string });

/** ApplyPatch: an apply_patch patch, its paths relative to cwd. */
export const applyPatch = (cwd, session, patch) => pre(cwd, session, 'ApplyPatch', { patch });

/** An apply_patch patch updating one file. */
export const patchOf = (file, minus, plus) => ['*** Begin Patch', `*** Update File: ${file}`, '@@', `-${minus}`, `+${plus}`, '*** End Patch'].join('\n');

/** Read: what only a hook registered without a matcher would see. */
export const read = (cwd, session, file_path) => pre(cwd, session, 'Read', { file_path });

/** Execute, Droid's shell. */
export const execute = (cwd, session, command) => pre(cwd, session, 'Execute', { command });

// ── after ───────────────────────────────────────────────────────────────────

const post = (before, tool_response) => ({ ...before, hook_event_name: 'PostToolUse', tool_response });

/** Create, done: the response names the file it wrote, absolute. */
export const created = (cwd, session, file_path, content, filePath) => post(create(cwd, session, file_path, content), { filePath, success: true });

/** Edit, done. */
export const edited = (cwd, session, file_path, old_str, new_str) => post(editStr(cwd, session, file_path, old_str, new_str), { filePath: file_path, success: true });

/** Edit, failed: the old text was not in the file. */
export const editFailed = (cwd, session, file_path, old_str, new_str) =>
  post(editStr(cwd, session, file_path, old_str, new_str), { filePath: file_path, success: false, error: 'old_str not found in file' });

/** ApplyPatch, done (its response shape is undocumented: success alone). */
export const patched = (cwd, session, patch) => post(applyPatch(cwd, session, patch), { success: true });

/** Execute, done. */
export const executed = (cwd, session, command) => post(execute(cwd, session, command), { success: true });
