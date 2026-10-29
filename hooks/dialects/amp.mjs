// Amp's dialect (ampcode.com). Amp runs no hook commands: AgentMash's plugin
// in Amp (clients/amp/plugin.mjs, which login writes to Amp's plugins folder)
// hands each moment to agent_hook.mjs with --client amp, in the envelope
// below, and gives Amp what this prints, once it has checked its shape. So
// the answers are Amp's own results:
//
//   pre_edit   {"action":"reject-and-continue","message":"<advice>…"} on the
//              first try of an edit of a file a teammate's agent is in, per
//              thread and file, and every try in the room's strict mode
//              (deny-once's rule, which this asks); else {"action":"allow"}
//   prompt     {"message":{"content":"<heads-up>","display":false}}: added to
//              the prompt, hidden, for the model; else {}
//   stop       {"notify":"<overlap>"}, which the plugin shows the person, as
//              Claude Code shows a Stop hook's systemMessage; else {}
//   else       {}
//
// Amp's tool.call has no way to let a call run with a note added to it: it
// lets it run, or refuses it with a message the model reads and goes on from.
// So the advice is a refusal of the first try, and the same edit again goes
// through; and allow, the neutral answer, grants nothing, since Amp asks the
// person about no tool unless its old permission rules are on, and the plugin
// answers no tool call at all then.
//
// The envelope the plugin writes on stdin:
//
//   {
//     "amp": 1,                        marks it
//     "hook": "tool.call",             the Amp event it came from: agent.start,
//                                      tool.call, tool.result, agent.end, unload
//     "thread": "T-…",                 event.thread.id: the session
//     "cwd": "/abs/repo",              the repository the call's files are in
//     "tool": "edit_file",             event.tool
//     "tool_use_id": "toolu_…",        event.toolUseID
//     "input": { … },                  event.input, as Amp sent it
//     "files": ["/abs/repo/src/a.ts"], what amp.helpers.filesModifiedByToolCall
//                                      says the call changes, as paths
//     "shell": "sed -i …",             a Bash or shell_command call's command,
//                                      by amp.helpers.shellCommandFromToolCall
//     "prompt": "…"                    agent.start's message
//   }
//
// Which files a call changes is Amp's own answer (`files`): the input fields
// of its edit tools are not documented, so they are read only for what an
// edit replaced, to count its lines, and for a file to name when Amp's helper
// names none. A shell command's changes are what the working tree says after
// it (post_tool_use, as for Claude Code's Bash). Anything that is not the
// envelope is read as Claude Code's shape, as the other dialects read it.

import path from 'node:path';
import { parseClaudeShaped } from './claude.mjs';
import denyOnce from './deny-once.mjs';

/**
 * Amp's tools, by what they do, registered for --client amp before anything
 * is read (lib.mjs, registerClientTools): the names in Amp's own tool list
 * (`amp tools list`, and the `init` message of `amp -x --stream-json`), and
 * apply_patch, which its helpers name. A read names no file it changes.
 */
export const AMP_TOOLS = {
  edit: ['edit_file', 'undo_edit'],
  write: ['create_file'],
  patch: ['apply_patch'],
  command: ['Bash', 'shell_command'],
  read: ['Read', 'read', 'Grep', 'glob', 'finder', 'oracle', 'Task', 'read_mcp_resource', 'read_web_page', 'web_search', 'todo_read', 'todo_write'],
};

const ALLOW = { action: 'allow' };
const said = (value) => ({ stdout: `${JSON.stringify(value)}\n` });
const text = (v) => (typeof v === 'string' && v ? v : undefined);
const usablePath = (p) => typeof p === 'string' && p.length > 0 && p.length <= 4096 && !/[\r\n\0]/.test(p);

/** The patch text of a patch tool's input, wherever it carries it: '' when it has none. */
function patchText(input) {
  for (const raw of [input.patch, input.command, input.input, input.patch_text]) {
    if (typeof raw === 'string' && raw.includes('*** ')) return raw;
    if (Array.isArray(raw)) {
      const found = raw.find((part) => typeof part === 'string' && part.includes('*** '));
      if (found) return found;
    }
  }
  return '';
}

/** The edit fields of normalized input (agent_hook.mjs) for one call in the envelope. */
function editOf(event, envelope, client, lib) {
  const tool = text(envelope.tool);
  const input = envelope.input && typeof envelope.input === 'object' && !Array.isArray(envelope.input) ? envelope.input : {};
  const kind = tool ? (lib?.clientToolKind?.(client, tool) ?? null) : null;
  const shell = typeof envelope.shell === 'string' ? envelope.shell : null;
  const cwd = typeof envelope.cwd === 'string' && path.isAbsolute(envelope.cwd) ? envelope.cwd : null;
  let files = (Array.isArray(envelope.files) ? envelope.files : []).filter(usablePath);

  if (kind === 'read') return { files: [] };
  if (kind === 'command' || shell !== null) {
    // after a command, the working tree says what it changed; before it, what Amp names (an in-place sed) is asked about
    if (event === 'post_edit') return { files: [], command: shell ?? text(input.cmd) ?? text(input.command) ?? '' };
    return { files: files.map((p) => ({ path: p })) };
  }
  // Amp named none: the input's own file field, for a tool it calls an edit
  if (files.length === 0 && (kind === 'edit' || kind === 'write')) files = (lib?.editedFiles?.(tool, input, client) ?? []).filter(usablePath);
  if (kind === 'patch') {
    const patch = patchText(input);
    const named = patch && lib?.filesInPatch ? lib.filesInPatch(patch).map((f) => (cwd ? path.resolve(cwd, f.path) : f.path)) : [];
    // the patch, for its line counts, only when it names exactly the files Amp says it changes
    const same = named.length > 0 && named.length === files.length && named.every((p) => files.includes(p));
    if (same) return { files: [], patch };
    return { files: files.map((p) => ({ path: p })) };
  }
  if (files.length === 1 && (kind === 'edit' || kind === 'write') && lib?.asClaudeEdit) {
    const edit = lib.asClaudeEdit(tool, input, client);
    if (edit?.tool === 'Write' && typeof edit.input?.content === 'string') return { files: [{ path: files[0], after: edit.input.content, action: 'write' }] };
    if (edit?.tool === 'Edit' && typeof edit.input?.old_string === 'string' && typeof edit.input?.new_string === 'string') {
      return { files: [{ path: files[0], before: edit.input.old_string, after: edit.input.new_string }] };
    }
  }
  // what changed in them is not known: named, and counted as nothing
  return { files: files.map((p) => ({ path: p })) };
}

/** The envelope as normalized input (see agent_hook.mjs); anything else as Claude Code's shape. */
export function parseAmp(event, input, { client = 'amp', lib = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.amp !== 1) return parseClaudeShaped(event, input, { client, lib });
  const n = { session_id: text(input.thread), cwd: text(input.cwd), tool: text(input.tool) };
  if (event === 'prompt') n.prompt = typeof input.prompt === 'string' ? input.prompt : '';
  // Amp has no event for a session's end: the plugin ends its threads as Amp unloads it
  if (event === 'session_end') n.end_reason = 'exit';
  if (event === 'stop') n.stop_hook_active = false;
  if (event === 'pre_edit' || event === 'post_edit') Object.assign(n, editOf(event, input, client, lib));
  return n;
}

export default {
  name: 'amp',
  tools: AMP_TOOLS,
  parse: parseAmp,
  answer(event, result) {
    if (event === 'pre_edit') {
      // deny-once decides, and keeps what it refused: refused once per thread and file, strict mode every time
      let decision = null;
      try {
        decision = JSON.parse(denyOnce.answer(event, result).stdout);
      } catch {
        decision = null;
      }
      if (decision?.decision === 'deny' && typeof decision.reason === 'string' && decision.reason) {
        return said({ action: 'reject-and-continue', message: decision.reason });
      }
      return said(ALLOW);
    }
    const words = typeof result?.text === 'string' && result.text ? result.text : null;
    if (event === 'prompt' && words) return said({ message: { content: words, display: false } });
    if (event === 'stop' && words) return said({ notify: words });
    return said({});
  },
  neutral(event) {
    return said(event === 'pre_edit' ? ALLOW : {});
  },
};
