// What the Cline CLI (cline 3.0.68) writes on a hook's stdin, read from
// cline/cline at tag cli-v3.0.68 (the hook code is the same at v4.1.22):
// sdk/packages/core/src/hooks/hook-file-hooks.ts, createPayloadBase (clineVersion
// from $CLINE_VERSION, else "", an ISO timestamp, taskId, sessionContext
// {rootSessionId}, workspaceRoots, workspaceInfo, userId from $CLINE_USER_ID or
// $USER, agent_id, parent_agent_id), then per hook: runToolCallStart
// ("tool_call", with the call's input as the model sent it, and preToolUse
// with every parameter JSON.stringify'd unless a string), runToolCallEnd
// ("tool_result", with the run's record {id, name, input, output, error?,
// durationMs, startedAt, endedAt} and postToolUse, whose result is the output
// JSON.stringify'd and whose success is !error), and runPromptSubmit
// ("prompt_submit"). The tools' outputs are the SDK's ToolOperationResult
// (sdk/packages/core/src/extensions/tools/definitions.ts: {query, result,
// success, error?}); what `result` says is the executor's, and not read by
// the hook. What differs from one test to the next is passed in: the session
// and the folder the CLI works in.

const base = ({ session, root }) => ({
  clineVersion: '',
  timestamp: '2026-10-05T09:14:03.512Z',
  taskId: session,
  sessionContext: { rootSessionId: session },
  workspaceRoots: [root],
  workspaceInfo: { rootPath: root, hint: 'app', associatedRemoteUrls: ['origin: git@github.com:acme/app.git'], latestGitCommitHash: '4f2a9c1', latestGitBranchName: 'feat/login' },
  userId: 'bob',
  agent_id: 'agent_01JC8N4V1R',
  parent_agent_id: null,
});

const stringified = (input) => Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));

/** PreToolUse ("tool_call") before `apply_patch` with {input}, its paths relative to the workspace. */
export const preApplyPatch = ({ session, root, patch }) => ({
  ...base({ session, root }),
  hookName: 'tool_call',
  iteration: 2,
  tool_call: { id: 'call_7Yv3cPatch', name: 'apply_patch', input: { input: patch } },
  preToolUse: { toolName: 'apply_patch', parameters: stringified({ input: patch }) },
});

/** PreToolUse before `editor` inserting lines, as a subagent of a team: its root session is the lead's. */
export const preEditorInsert = ({ session, root, lead, path = 'src/models/user.ts', new_text = '// roles\n', insert_line = 1 }) => {
  const input = { path, new_text, insert_line };
  return {
    ...base({ session, root }),
    sessionContext: { rootSessionId: lead },
    agent_id: 'agent_01JC8N9WORKER',
    parent_agent_id: 'agent_01JC8N4V1R',
    hookName: 'tool_call',
    iteration: 1,
    tool_call: { id: 'call_3Insert', name: 'editor', input },
    preToolUse: { toolName: 'editor', parameters: stringified(input) },
  };
};

/** PostToolUse ("tool_result") after `editor`, and what it gave back. */
export const postEditor = ({ session, root, input, output }) => ({
  ...base({ session, root }),
  hookName: 'tool_result',
  iteration: 3,
  tool_result: {
    id: 'call_9Editor',
    name: 'editor',
    input,
    output,
    durationMs: 17,
    startedAt: '2026-10-05T09:14:04.001Z',
    endedAt: '2026-10-05T09:14:04.018Z',
  },
  postToolUse: { toolName: 'editor', parameters: stringified(input), result: JSON.stringify(output), success: true, executionTimeMs: 17 },
});

/** An editor call that went through. */
export const editorDone = (path) => ({ query: `edit:${path}`, result: `Edited ${path}`, success: true });
/** One whose old_text was not in the file: the tool caught it, so the run saw no error, and success is still true. */
export const editorFailed = (path) => ({ query: `edit:${path}`, result: '', error: 'Editor operation failed: old_text not found in file', success: false });

/** PostToolUse after `run_commands`. */
export const postRunCommands = ({ session, root, commands = ['npm run build'] }) => {
  const output = [{ query: commands[0], result: 'built in 2.1s', success: true }];
  return {
    ...base({ session, root }),
    hookName: 'tool_result',
    iteration: 4,
    tool_result: {
      id: 'call_5Commands',
      name: 'run_commands',
      input: { commands },
      output,
      durationMs: 2140,
      startedAt: '2026-10-05T09:14:05.000Z',
      endedAt: '2026-10-05T09:14:07.140Z',
    },
    postToolUse: { toolName: 'run_commands', parameters: { commands: JSON.stringify(commands) }, result: JSON.stringify(output), success: true, executionTimeMs: 2140 },
  };
};

/**
 * UserPromptSubmit ("prompt_submit"): the CLI fires it only for user-role
 * messages added during a run, such as the runtime's own completion reminder
 * (sdk/packages/agents/src/agent-runtime.ts, addUserReminderMessage), and
 * reads nothing the hook prints.
 */
export const promptSubmit = ({ session, root, text }) => ({
  ...base({ session, root }),
  hookName: 'prompt_submit',
  userPromptSubmit: { prompt: text, attachments: [] },
});
