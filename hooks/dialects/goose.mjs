// goose's hooks (aaif-goose/goose, once block/goose: the goose CLI, goose
// Desktop and `goose acp` share one hook runner), read and answered. Checked
// against crates/goose/src/hooks/mod.rs and agents/agent.rs at v1.53.0.
//
// What goose sends: one JSON object on stdin, its event in `event`, the
// session in `session_id` (20261005_3), the folder it works in in
// `working_dir` (left out on some events of the CLI's own loop: this
// process's cwd is goose's then, which is where it was started), and for a
// tool its `tool_name` and `tool_input`. Its developer extension's tools are
// unprefixed: `write` {path, content} and `edit` {path, before, after}, where
// `path` may be relative to working_dir. Any other extension's are
// `<extension>__<tool>`.
//
// What goose reads back: before a tool (PreToolUse), only a decision. Empty
// stdout lets the call go on, `{"decision":"block","reason":"…"}` refuses it
// with the reason as the tool's error, which the model reads and the turn goes
// on from (exit status 2 refuses too, and nothing here ever exits with it);
// nothing else is read, so there is no way to hand the model a word and let
// the edit through. Anything goose cannot read as a decision (a stray
// line, `{}`, Claude Code's hookSpecificOutput) is a hook that failed, which
// goose logs and lets the call through. And it never asks the person anything
// on a hook's say: its own approval comes before the hook runs, so letting a
// call go on grants nothing. On SessionStart, the goose CLI shows a `banner`
// to the person, never to the model. Everything else it sends is for us to
// report, and what we print then is not read at all.
//
// So the advice before an edit goes the way it goes to Cursor: the first try
// at a file a teammate is in is refused, with the advice as the reason, once
// per session and file in ten minutes (deny-once.mjs keeps the refusals, and
// refuses only once one is written down), and the same edit again goes
// through. goose ends every refusal by a hook with "Do not retry; this is a
// policy denial, not a transient failure", so the reason says that for this
// one it is not. The room's strict mode refuses every try until the agent
// acknowledges the collision, as it does everywhere. Every other answer is
// nothing at all, and so is every failure.

import crypto from 'node:crypto';
import { refuseOnce } from './deny-once.mjs';

/** goose's event for each of ours: a payload naming any other is not goose's, and is let be. */
const GOOSE_EVENTS = {
  pre_edit: ['PreToolUse'],
  post_edit: ['AfterFileEdit', 'PostToolUse'],
  prompt: ['UserPromptSubmit'],
  session_start: ['SessionStart'],
  session_end: ['SessionEnd'],
  stop: ['Stop'],
};

/**
 * Tools that write a file, by their name after any `<extension>__`: goose's
 * own categorize_tool, which is also when it sends AfterFileEdit.
 */
const FILE_TOOLS = new Set(['write', 'edit', 'patch', 'write_file', 'edit_file']);
/** The developer extension's shell: it names no file, and the working tree says what it changed. */
const SHELL_TOOLS = new Set(['shell']);

const NOTHING = { stdout: '' };

/** A tool's own name, without the `<extension>__` goose puts before another extension's. */
const localName = (tool) => {
  const at = tool.lastIndexOf('__');
  return at === -1 ? tool : tool.slice(at + 2);
};
const nonEmpty = (value) => typeof value === 'string' && value.length > 0;

/** A tool's input as an object, whether it came as one or as JSON text. */
function inputOf(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The edit fields of normalized input (see agent_hook.mjs) from one of goose's tool calls. */
function editOf(tool, toolInput) {
  if (!nonEmpty(tool)) return { files: [] };
  const name = localName(tool);
  const input = inputOf(toolInput);
  if (SHELL_TOOLS.has(name)) return { files: [], tool, command: typeof input.command === 'string' ? input.command : '' };
  // a read, a search, a tool of another extension's: nothing to ask about, nothing to report
  if (!FILE_TOOLS.has(name)) return { files: [], tool };
  // the same fields goose takes a file from, in the same order
  const file = [input.path, input.file, input.file_path].find(nonEmpty);
  if (!file) return { files: [], tool };
  if (typeof input.before === 'string' && typeof input.after === 'string') {
    return { files: [{ path: file, before: input.before, after: input.after, action: 'edit' }], tool };
  }
  if (typeof input.content === 'string') return { files: [{ path: file, after: input.content, action: 'write' }], tool };
  // another extension's edit, of a shape not known here: the file it names, and no count of lines
  return { files: [{ path: file }], tool };
}

/** A refusal's keys: one per file, as deny-once.mjs keeps them, so the two never disagree. */
const keysOf = (result) => {
  const files = Array.isArray(result?.files) && result.files.length ? result.files : [''];
  return files.map((file) =>
    crypto
      .createHash('sha256')
      .update(`${result?.client ?? ''}\0${result?.session_id ?? 'unknown'}\0${file}`)
      .digest('hex')
      .slice(0, 32)
  );
};

/**
 * goose's refusal. It adds ". Do not retry; …" after the reason, so the
 * reason ends on a word, never on a full stop of its own.
 */
const block = (reason) => ({ stdout: JSON.stringify({ decision: 'block', reason: reason.replace(/[\s.]+$/, '') }) + '\n' });

const HELD =
  'AgentMash held back this first try so that you read the above before the edit lands. It is advice, not a policy:' +
  ' goose calls every refusal by a hook a policy denial and says not to retry, and for this one neither is so.' +
  ' If the edit still has to happen, make the same edit again and it goes through';

export default {
  name: 'goose',
  // goose's developer extension's own tools, for the vocabulary (lib.mjs, registerClientTools);
  // another extension's `<extension>__write_file` and the like are read by their last part, here
  tools: { write: ['write', 'write_file'], edit: ['edit', 'edit_file'], command: ['shell'] },
  parse(event, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    // OpenHands' Agent Canvas loads every folder in ~/.agents/plugins, this one
    // included, and its executor sets OPENHANDS_EVENT_TYPE on every hook: there
    // its own plugin reports (cli/agents/openhands.mjs), so ours says nothing
    if (process.env.OPENHANDS_EVENT_TYPE) return null;
    if (!GOOSE_EVENTS[event]?.includes(input.event)) return null;
    const n = {
      session_id: nonEmpty(input.session_id) ? input.session_id : undefined,
      cwd: nonEmpty(input.working_dir) ? input.working_dir : undefined,
    };
    // the prompt is `message`, and goose copies it to matcher_context too
    if (event === 'prompt') n.prompt = [input.message, input.matcher_context].find((v) => typeof v === 'string') ?? '';
    if (event === 'pre_edit' || event === 'post_edit') Object.assign(n, editOf(input.tool_name, input.tool_input));
    return n;
  },
  answer(event, result) {
    const text = typeof result?.text === 'string' && result.text ? result.text : null;
    if (event === 'session_start') {
      // the heads-up, for the person: the goose CLI shows a banner as a session opens, and the model never sees it
      return text ? { stdout: JSON.stringify({ banner: text }) + '\n' } : NOTHING;
    }
    if (event !== 'pre_edit' || !text) return NOTHING;
    if (result.action === 'deny') {
      // strict mode: refused until acknowledged, and the acknowledged try, which comes back as advice, goes through
      refuseOnce(keysOf(result));
      return block(text);
    }
    if (result.action !== 'advise' || !refuseOnce(keysOf(result))) return NOTHING;
    return block(`${text}\n\n${HELD}`);
  },
  neutral() {
    return NOTHING;
  },
};
