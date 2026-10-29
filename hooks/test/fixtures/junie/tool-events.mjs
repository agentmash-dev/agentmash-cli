// What Junie CLI sends its PreToolUse hook. Junie is closed source, so each
// shape is from its docs or from a payload someone captured and published,
// named on each; and where nobody has published one, the candidates are
// said as candidates.
//
// The envelope changed between builds:
//   26.8.3, 26.8.24 and 26.8.31  hook_event_name, tool_name and tool_input,
//                                and nothing else: no session_id, no cwd, no
//                                project_path (pragma-sh/pragma
//                                packages/junie-plugin/AGENTS.md on 26.8.3;
//                                stablyai/orca PR #16472, live on 26.8.24)
//   3419.7 (26.9.22) and later   session_id too (maj0rpain/orchestrator
//                                #260); project_path may still be missing
//                                (#266), and cwd, where present, is Junie's
//                                own home, never the project
//
// Edit and Write inputs: no captured PreToolUse for either has been
// published. ggshield's Write fixture ({file_path, content}) was written by
// ggshield itself, and its PR says PreToolUse was not verified live. What is
// known is that the guard which refused every edit on 3419.7 read
// `.tool_input.file_path // .tool_input.path` (orchestrator #260), so the
// path is under one of those two, and that Junie's Edit is "search/replace,
// apply patch" (junie-cli-subagents.html). So both path keys, both pairs of
// text keys, and a patch body are fixtures here.

/** The envelope of a build: '3419.7' with session_id (and project_path when given), '26.8' with none. */
const envelope = ({ build = '3419.7', session_id, junieHome, project_path }) =>
  build === '26.8'
    ? { hook_event_name: 'PreToolUse' }
    : {
        hook_event_name: 'PreToolUse',
        session_id,
        ...(junieHome ? { cwd: junieHome } : {}),
        ...(project_path ? { project_path } : {}),
      };

/**
 * The one PreToolUse junie-cli-hooks.html shows, word for word: a Bash call,
 * which names no file.
 */
export const docsBash = () => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'sleep 60', run_in_background: false, timeout: 30 },
});

/** Write, the candidate with Claude Code's names: {file_path, content}. */
export const write = ({ path, content = 'export const b = 2;\n', ...at }) => ({
  ...envelope(at),
  tool_name: 'Write',
  tool_input: { file_path: path, content },
});

/** Edit, the candidate with Claude Code's names: {file_path, old_string, new_string}. */
export const editClaudeNames = ({ path, before = 'id: string', after = 'id: string;\n  role: string', ...at }) => ({
  ...envelope(at),
  tool_name: 'Edit',
  tool_input: { file_path: path, old_string: before, new_string: after },
});

/** Edit, the search/replace candidate, with its path under `path`, as orchestrator's guard also reads it. */
export const editSearchReplace = ({ path, before = 'id: string', after = 'id: string;\n  role: string', ...at }) => ({
  ...envelope(at),
  tool_name: 'Edit',
  tool_input: { path, search: before, replace: after },
});

/** Edit, the apply-patch candidate: no path field, the files named only inside the patch. */
export const editPatch = ({ patch, ...at }) => ({
  ...envelope(at),
  tool_name: 'Edit',
  tool_input: { patch },
});

/**
 * Read, as Junie's `open` reaches a hook ({file_path, offset}, per ggshield's
 * Junie tests; unverified live). login's matcher keeps it from the hook; were
 * it to come, it is a read.
 */
export const read = ({ path, ...at }) => ({
  ...envelope(at),
  tool_name: 'Read',
  tool_input: { file_path: path, offset: 0 },
});
