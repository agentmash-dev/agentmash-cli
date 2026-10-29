// Antigravity's hooks (the Antigravity CLI, agy; https://antigravity.google/docs/hooks/),
// read and answered. agy sends its own camelCase JSON with no event name in
// it (the event is the argument login registers each hook with), and it
// reads exact answers back through strict protojson:
//
//   PostToolUse     {}, and nothing else: an unknown field there is an error
//                   that replaces the tool's own result
//   PreInvocation   {} or {"injectSteps":[{"ephemeralMessage":"<text>"}]}, a
//                   note the model reads before its next call, which blocks
//                   and approves nothing
//   PreToolUse      a decision, always: {}, a crash, a timeout or anything
//                   unreadable refuses the tool call
//
// Login registers PostToolUse (the report, as `post_edit`) and PreInvocation
// (the heads-up, as `prompt`), and no PreToolUse (see cli/agents/antigravity.mjs
// for why). So the advice reaches the agent at the start of each turn, as
// the heads-up Claude Code gets with a prompt, not before one edit. The
// pre_edit answer below is for someone who wires PreToolUse up by hand: it
// refuses the first try at a file a teammate is in, with the advice as the
// reason the model reads (deny-once.mjs), and otherwise says "ask", which
// leaves the call to the person's own permission rules. It never says
// "allow": the docs promise that it approves the call outright, and that
// only does not happen today because of a bug (antigravity-cli#1053).
//
// What agy sends, per its docs and what others have recorded of it
// (hooks/test/fixtures/antigravity/ has each shape, with its source):
//
//   every event   conversationId, workspacePaths (absolute; [] when `agy -p`
//                 runs without --add-dir), transcriptPath, artifactDirectoryPath,
//                 modelName. The hook runs in the folder of its hooks.json,
//                 never in the project.
//   PostToolUse   toolCall { name, args }, stepIdx, error ("" unless the tool
//                 failed). The file is args.TargetFile, which may start with ~.
//   PreInvocation invocationNum (0 for a turn's first model call) and
//                 initialNumSteps. No prompt: the person's words are read from
//                 the transcript, the last USER_INPUT line, between
//                 <USER_REQUEST> and </USER_REQUEST> (a format agy does not
//                 document; claude-mem and agy-auto read it the same way).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import denyOnce from './deny-once.mjs';

const NOTHING = '{}\n';
/** Leaves the call to the person's own rules: the docs' "prompts, but respects Always Allow". */
const ASK = '{"decision":"ask"}\n';

/** agy's tools, by what they do (https://antigravity.google/docs/hooks/, "Supported tools"). */
const TOOLS = {
  write: ['write_to_file'],
  edit: ['replace_file_content', 'multi_replace_file_content'],
  command: ['run_command'],
  read: ['view_file'],
};
const KIND = new Map(Object.entries(TOOLS).flatMap(([kind, names]) => names.map((name) => [name, kind])));

/** The transcript read back from its end, at most: the prompt of a turn just begun is its last lines. */
const TAIL_BYTES = 512 * 1024;
/** Turns remembered, at most, so a turn's prompt is reported once however often agy calls the model in it. */
const TURNS_KEPT = 100;

const str = (v) => (typeof v === 'string' ? v : undefined);
const yes = (v) => v === true || v === 'true';

/** A tool call's arguments: an object, or one sent as a JSON string. */
function argsOf(call) {
  const args = call?.args;
  if (args && typeof args === 'object' && !Array.isArray(args)) return args;
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // not arguments we can read
    }
  }
  return {};
}

const workspacesOf = (input) =>
  (Array.isArray(input.workspacePaths) ? input.workspacePaths : []).filter((p) => typeof p === 'string' && path.isAbsolute(p));

const inside = (dir, file) => {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** A TargetFile as an absolute path: ~ is the home folder, and a relative one is the first workspace's. */
function absoluteFile(target, workspaces) {
  if (typeof target !== 'string' || !target || /[\r\n\0]/.test(target)) return null;
  if (target === '~' || target.startsWith('~/') || target.startsWith('~\\')) return path.join(os.homedir(), target.slice(2));
  if (path.isAbsolute(target)) return path.normalize(target);
  return workspaces[0] ? path.resolve(workspaces[0], target) : null;
}

/** One chunk of a multi_replace_file_content (its fields are undocumented: these are replace_file_content's). */
const chunkOf = (c) => ({
  before: str(c?.TargetContent) ?? str(c?.targetContent),
  after: str(c?.ReplacementContent) ?? str(c?.replacementContent),
});

/** The normalized `files` entry for one edit tool's call, or null when it changes no file of anybody's. */
function fileOf(kind, name, args, file) {
  if (kind === 'write') return { path: file, action: 'write', ...(str(args.CodeContent) !== undefined ? { after: args.CodeContent } : {}) };
  if (name === 'multi_replace_file_content') {
    let chunks = args.ReplacementChunks;
    if (typeof chunks === 'string') {
      try {
        chunks = JSON.parse(chunks);
      } catch {
        chunks = null;
      }
    }
    const edits = (Array.isArray(chunks) ? chunks : []).map(chunkOf).filter((e) => e.before !== undefined || e.after !== undefined);
    return edits.length ? { path: file, edits } : { path: file };
  }
  const entry = { path: file };
  if (str(args.TargetContent) !== undefined) entry.before = args.TargetContent;
  if (str(args.ReplacementContent) !== undefined) entry.after = args.ReplacementContent;
  return entry;
}

/** The first model call of a turn: invocationNum 0, or none at all (protojson may leave a zero out). */
function firstInvocation(input) {
  const n = input.invocationNum;
  return n === undefined || n === null || n === 0 || n === '0';
}

/**
 * The person's last prompt in a transcript: { text, at }, `at` the byte its
 * line starts at (the transcript only grows, so the same line is the same
 * turn), or null. Read from the end, never more than TAIL_BYTES; never throws.
 */
export function lastUserInput(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !path.isAbsolute(transcriptPath) || !/\.jsonl$/i.test(transcriptPath)) return null;
  let fd = null;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let end = buf.length;
    while (end > 0) {
      const from = buf.lastIndexOf(0x0a, end - 1) + 1;
      // a line the tail cut into is not a line to read
      if (from === 0 && start > 0) break;
      const line = buf.subarray(from, end).toString('utf8');
      end = from - 1;
      if (!line.includes('USER_INPUT')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type !== 'USER_INPUT' || typeof entry.content !== 'string') continue;
      return { text: requestOf(entry.content), at: start + from };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // closed
      }
    }
  }
}

/** What the person typed, out of the blocks agy wraps it in. */
export function requestOf(content) {
  const asked = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content);
  if (asked) return asked[1].trim();
  return content.replace(/<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/\1>/g, '').trim();
}

const turnsFile = () => path.join(process.env.AGENTMASH_HOME || os.homedir(), '.agentmash', 'antigravity-turns.json');

/**
 * Whether this turn is one not seen before, and noted as seen. A turn that
 * cannot be noted (a home that cannot be written) counts as new: its prompt
 * is reported again rather than never. Never throws.
 */
export function firstSight(conversation, at, now = Date.now()) {
  const key = crypto.createHash('sha256').update(`${conversation}\0${at}`).digest('hex').slice(0, 32);
  const file = turnsFile();
  let seen = {};
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))?.seen;
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) seen = saved;
  } catch {
    // none yet
  }
  if (Object.hasOwn(seen, key)) return false;
  const kept = Object.entries(seen)
    .filter(([, t]) => Number.isFinite(t))
    .sort((a, b) => b[1] - a[1])
    .slice(0, TURNS_KEPT - 1);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ seen: Object.fromEntries([...kept, [key, now]]) }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // nothing was made
    }
  }
  return true;
}

/**
 * agy's payload as normalized input (see agent_hook.mjs), or null when there
 * is nothing to do: a later model call of a turn, a turn already reported,
 * or a call with no workspace to say which repository it is in.
 */
export function parseAntigravity(event, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const session = str(input.conversationId) || str(process.env.ANTIGRAVITY_CONVERSATION_ID);
  const workspaces = workspacesOf(input);

  if (event === 'prompt') {
    if (!firstInvocation(input) || !workspaces[0]) return null;
    const said = lastUserInput(input.transcriptPath);
    if (said && session && !firstSight(session, said.at)) return null;
    return { session_id: session, cwd: workspaces[0], prompt: said?.text ?? '' };
  }

  if (event === 'pre_edit' || event === 'post_edit') {
    const call = input.toolCall && typeof input.toolCall === 'object' ? input.toolCall : {};
    const name = str(call.name);
    const kind = KIND.get(name);
    const base = { session_id: session, cwd: workspaces[0], tool: name, files: [] };
    // a tool that failed changed nothing
    if (event === 'post_edit' && typeof input.error === 'string' && input.error) return base;
    const args = argsOf(call);
    // a command names no file: the working tree of the workspace says what it changed, and with no workspace there is none to look at
    if (kind === 'command') {
      return event === 'post_edit' && workspaces[0] ? { ...base, command: str(args.CommandLine) ?? str(args.command) ?? '' } : base;
    }
    if (kind !== 'edit' && kind !== 'write') return base;
    if (kind === 'write' && yes(args.IsArtifact)) return base;
    const file = absoluteFile(args.TargetFile, workspaces);
    if (!file) return base;
    // agy's own notes on the task (its artifacts) are nobody's code
    const artifacts = str(input.artifactDirectoryPath);
    if (artifacts && path.isAbsolute(artifacts) && inside(artifacts, file)) return base;
    // the repository is the workspace the file is in; with no workspace, the file's own folder
    const home = workspaces.filter((w) => inside(w, file)).sort((a, b) => b.length - a.length)[0];
    return { ...base, cwd: home ?? workspaces[0] ?? path.dirname(file), files: [fileOf(kind, name, args, file)] };
  }

  // the other events, which login does not register: never the folder the hook runs in, which is agy's own
  return workspaces[0] ? { session_id: session, cwd: workspaces[0] } : null;
}

export default {
  name: 'antigravity',
  tools: TOOLS,
  parse: parseAntigravity,
  answer(event, result) {
    if (event === 'pre_edit') {
      const said = denyOnce.answer(event, result);
      let decision = null;
      try {
        decision = JSON.parse(said.stdout).decision;
      } catch {
        // not a decision: ask
      }
      return decision === 'deny' ? { stdout: said.stdout } : { stdout: ASK };
    }
    if (event === 'prompt' && typeof result?.text === 'string' && result.text) {
      return { stdout: JSON.stringify({ injectSteps: [{ ephemeralMessage: result.text }] }) + '\n' };
    }
    return { stdout: NOTHING };
  },
  neutral(event) {
    return { stdout: event === 'pre_edit' ? ASK : NOTHING };
  },
};
