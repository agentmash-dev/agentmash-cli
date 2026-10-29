// Claude Code's hook format, read and answered: the format Claude Code's own
// hooks use, and Codex's, Copilot's and Devin's, and that of any agent built
// to the same contract. Its answer is exactly what the hook script printed
// (hookSpecificOutput.additionalContext for advice, permissionDecision "deny"
// only in the room's strict mode, systemMessage for the person), and nothing
// at all when there is nothing to say: Claude Code reads an empty answer as
// "go on", and a hook never answers "allow", which would skip the person's
// own permission rules.
//
// Its parse reads Claude Code's shape, in snake_case or the Copilot CLI's
// camelCase (lib.mjs, normalizeHookInput), and is the one the other dialects
// use when they have none of their own. A tool call the hook scripts read
// themselves (Claude Code's, Codex's, Copilot's, Devin's) goes on to them as
// it came, so what they report is what they would have reported run directly;
// one the agent declared in its own words (lib.mjs, registerClientTools) goes
// as the Claude Code edit it is.

/** The edit fields of normalized input, from one tool call. */
function editOf(tool, toolInput, client, lib) {
  if (typeof tool !== 'string' || !tool) return { files: [] };
  const kind = lib?.clientToolKind?.(client, tool) ?? null;
  const files = lib?.editedFiles?.(tool, toolInput, client) ?? [];
  // the scripts read this one themselves
  if (kind === null) return { files, call: { tool_name: tool, tool_input: toolInput } };
  if (kind === 'read') return { files: [] };
  if (kind === 'command') return { files: [], command: typeof toolInput?.command === 'string' ? toolInput.command : '' };
  if (kind === 'patch') return { files, call: { tool_name: 'apply_patch', tool_input: toolInput } };
  // an edit or a write: of one file, the Claude Code edit it is; of several, their paths
  if (files.length !== 1 || !lib.asClaudeEdit) return { files };
  const edit = lib.asClaudeEdit(tool, toolInput, client);
  return { files, call: { tool_name: edit.tool, tool_input: { ...edit.input, file_path: files[0] } } };
}

/** Claude Code's hook input as normalized input (see agent_hook.mjs); null when it is not one. */
export function parseClaudeShaped(event, input, { client = null, lib = null } = {}) {
  const raw = lib?.normalizeHookInput?.(input) ?? input;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const n = {
    session_id: raw.session_id,
    cwd: raw.cwd,
    agent_id: raw.agent_id,
    agent_type: raw.agent_type,
    tool: raw.tool_name,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : raw.user_prompt,
    end_reason: raw.reason,
    source: raw.source,
    stop_hook_active: raw.stop_hook_active,
  };
  if (event === 'pre_edit' || event === 'post_edit') Object.assign(n, editOf(raw.tool_name, raw.tool_input, client, lib));
  return n;
}

export default {
  name: 'claude',
  parse: parseClaudeShaped,
  answer(event, result) {
    return { stdout: typeof result?.stdout === 'string' ? result.stdout : '' };
  },
  neutral() {
    return { stdout: '' };
  },
};
