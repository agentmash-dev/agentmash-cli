// preToolUse and postToolUse in the Copilot CLI's own camelCase format, the
// one its hooks reference gives (docs.github.com/en/copilot/reference/
// hooks-reference): timestamp, cwd, toolName, toolArgs as a JSON string, and
// after the tool toolResult; with sessionId, which normalizeHookInput reads.
// This is the shape the Copilot CLI would send Claude Code's hooks if it runs
// them from ~/.claude/settings.json beside its own. It is written from the
// reference and has not been captured from a live session: one is still to
// be checked. Its edit tool, `edit`, takes path, old_str and new_str (the
// field names seen live on 1.0.91, docs/ADAPTERS.md).

const base = (cwd, session) => ({
  sessionId: session,
  timestamp: 1791000000000,
  cwd,
});

/** preToolUse for its edit tool on `file` (absolute, or relative to cwd). */
export const preEdit = (cwd, session, file, old_str, new_str) => ({
  ...base(cwd, session),
  toolName: 'edit',
  toolArgs: JSON.stringify({ path: file, old_str, new_str }),
});

/** postToolUse for the same edit, done. */
export const postEdit = (cwd, session, file, old_str, new_str) => ({
  ...preEdit(cwd, session, file, old_str, new_str),
  toolResult: { resultType: 'success', textResultForLlm: 'File edited.' },
});

/** userPromptSubmitted. */
export const prompt = (cwd, session, text) => ({ ...base(cwd, session), prompt: text });
