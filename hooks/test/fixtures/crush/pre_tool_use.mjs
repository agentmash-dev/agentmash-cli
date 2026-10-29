// PreToolUse, Crush's one hook event, as Crush v0.97.1 writes it to a hook
// command's stdin and environment. Recorded from charmbracelet/crush at the
// v0.97.1 tag (the same at v0.63.0, where hooks began, but for the three
// CRUSH/AGENT/AI_AGENT markers):
//   - the payload: internal/hooks/input.go, BuildPayload, one json.Marshal'd
//     line of the Payload struct {event, session_id, cwd, tool_name,
//     tool_input}, with tool_input the model's arguments as it sent them
//     ({} when they are not JSON); cwd is Crush's working directory
//   - the environment: BuildEnv there, on top of all of Crush's own
//   - the tools' arguments: internal/agent/tools/{edit,multiedit,write,
//     lsp_replace_symbol,download,view,bash}.go, the *Params structs, whose
//     json tags are the names below; file_path is the model's own, absolute
//     or relative to cwd
//   - MCP tools: internal/agent/tools/mcp-tools.go, named mcp_<server>_<tool>
// The session id is a test's own (Crush's is a uuid.New() string), and the
// MCP call's arguments are an example of their form.

/** One PreToolUse payload for `tool_name` with `tool_input`, in Crush's field order. */
export function preToolUse(cwd, session, tool_name, tool_input) {
  return { event: 'PreToolUse', session_id: session, cwd, tool_name, tool_input };
}

/** What Crush puts in a hook's environment for the same call (BuildEnv). */
export function hookEnv(payload) {
  const env = {
    CRUSH: '1',
    AGENT: 'crush',
    AI_AGENT: 'crush',
    CRUSH_EVENT: payload.event,
    CRUSH_TOOL_NAME: payload.tool_name,
    CRUSH_SESSION_ID: payload.session_id,
    CRUSH_CWD: payload.cwd,
    CRUSH_PROJECT_DIR: payload.cwd,
  };
  if (typeof payload.tool_input?.command === 'string') env.CRUSH_TOOL_INPUT_COMMAND = payload.tool_input.command;
  if (typeof payload.tool_input?.file_path === 'string') env.CRUSH_TOOL_INPUT_FILE_PATH = payload.tool_input.file_path;
  return env;
}

/** edit (EditParams): old_string becomes new_string, once unless replace_all. */
export const edit = (cwd, session, file_path, old_string, new_string) => preToolUse(cwd, session, 'edit', { file_path, old_string, new_string });

/** multiedit (MultiEditParams): edits of one file, in order. */
export const multiedit = (cwd, session, file_path, edits) => preToolUse(cwd, session, 'multiedit', { file_path, edits });

/** write (WriteParams): the whole new text of a file. */
export const write = (cwd, session, file_path, content) => preToolUse(cwd, session, 'write', { file_path, content });

/** lsp_replace_symbol (ReplaceSymbolParams): a symbol replaced through the language server; its old text is not in the call. */
export const lspReplaceSymbol = (cwd, session, file_path, symbol, replacement) =>
  preToolUse(cwd, session, 'lsp_replace_symbol', { symbol, file_path, replacement, action: 'replace' });

/** download (DownloadParams): a URL saved to a file. */
export const download = (cwd, session, file_path, url) => preToolUse(cwd, session, 'download', { url, file_path });

/** view (ViewParams): a read, which names its file in file_path too. */
export const view = (cwd, session, file_path) => preToolUse(cwd, session, 'view', { file_path, limit: 200 });

/** bash (BashParams): a command, with the description the model gives it. */
export const bash = (cwd, session, command) => preToolUse(cwd, session, 'bash', { description: 'Rename a field', command });

/** An MCP server's tool: mcp_<server>_<tool>, its arguments as that server declares them. */
export const mcpTool = (cwd, session) =>
  preToolUse(cwd, session, 'mcp_github_create_pull_request', { owner: 'acme', repo: 'app', title: 'Add roles', head: 'feat/login', base: 'main' });
