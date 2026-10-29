// For an agent whose hook before a tool can only let it run or refuse it,
// with a reason the model reads, and has no way to add context to a call it
// lets through (the Gemini CLI's BeforeTool; the agents whose dialects build
// on this one, such as Kiro's, Crush's and Amp's, say it their own way). The
// advice before an edit then goes as a refusal of the first try, with the
// advice as the reason, and the same edit tried again goes through: once per
// session and file in ONCE_FOR_MS, the advice's own cooldown in pre_tool_use.
// It answers in a top-level decision, and only ever to refuse:
//
//   pre_edit, advice, first try   {"decision":"deny","reason":"<advice>…"}
//   pre_edit, anything else       {}
//   every other event             {}
//
// A refusal is said only once it is written down: an agent run where the
// home folder cannot be written (a sandbox) would otherwise be refused on
// every try, and never get its edit through. In the room's strict mode the
// script refuses on every try until the agent acknowledges the collision, and
// that refusal goes as it is.
//
// {} is no opinion: the call goes on as it would have without the hook,
// asked about if the person would have been asked. It never says "allow",
// which some tools read as approving the call and skipping the person's
// prompt (Crush's top-level decision, Antigravity's PreToolUse): a tool
// wired to this dialect by hand (npx agentmash hook --print-command), whose
// hooks read a decision that way, is then never approved by it, on a
// pass-through or on any failure. Gemini CLI, which this was written for,
// acts only on ask, deny and block, and treats {} as it treated allow.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeShaped } from './claude.mjs';

/** No opinion, before an edit and after anything: never "allow" (see above). */
const NOTHING = '{}\n';
/** How long a refusal holds for its session and file: pre_tool_use's own cooldown. */
export const ONCE_FOR_MS = 10 * 60_000;
/** Refusals kept, at most: the newest. */
const KEPT = 300;

const stateFile = () => path.join(process.env.AGENTMASH_HOME || os.homedir(), '.agentmash', 'deny-once.json');
/** A refusal's key: which agent, session and file, as a hash, so the file names none of them. */
const keyOf = (client, session, file) => crypto.createHash('sha256').update(`${client}\0${session}\0${file}`).digest('hex').slice(0, 32);

/** The refusals still in their window, newest first: [key, at] each. Never throws. */
function readRefusals(now) {
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))?.denied;
    if (!saved || typeof saved !== 'object') return [];
    // one dated after now is a clock that went back since, and holds nothing off
    return Object.entries(saved)
      .filter(([, at]) => Number.isFinite(at) && at <= now && now - at < ONCE_FOR_MS)
      .sort((a, b) => b[1] - a[1]);
  } catch {
    return [];
  }
}

/** Write the refusals, whole: true only once they are on disk. Never throws. */
function writeRefusals(entries) {
  const file = stateFile();
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ denied: Object.fromEntries(entries) }), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // nothing was made
    }
    return false;
  }
}

/**
 * Whether these keys are refused now: when any of them was not refused in
 * the window, all of them are written down as refused now, and the answer is
 * yes only when that write took. Never throws.
 */
export function refuseOnce(keys, now = Date.now()) {
  const kept = readRefusals(now);
  const seen = new Set(kept.map(([key]) => key));
  if (keys.every((key) => seen.has(key))) return false;
  const fresh = new Set(keys);
  const entries = [...kept.filter(([key]) => !fresh.has(key)).slice(0, Math.max(0, KEPT - keys.length)), ...keys.map((key) => [key, now])];
  return writeRefusals(entries);
}

/** The keys for a result: one per file, or one for the call when it named none. */
const keysOf = (result) => {
  const files = Array.isArray(result?.files) && result.files.length ? result.files : [''];
  return files.map((file) => keyOf(result?.client ?? '', result?.session_id ?? 'unknown', file));
};

const deny = (reason) => ({ stdout: JSON.stringify({ decision: 'deny', reason }) + '\n' });

export default {
  name: 'deny-once',
  parse: parseClaudeShaped,
  answer(event, result) {
    if (event !== 'pre_edit') return { stdout: NOTHING };
    if (result?.action === 'deny' && result.text) {
      // strict mode: refused until acknowledged, and the acknowledged try, which comes back as advice, goes through
      refuseOnce(keysOf(result));
      return deny(result.text);
    }
    if (result?.action !== 'advise' || !result.text) return { stdout: NOTHING };
    if (!refuseOnce(keysOf(result))) return { stdout: NOTHING };
    return deny(
      `${result.text}\n\nAgentMash stopped this edit once so that you read the above first. It is advice, not a refusal:` +
        ' if the edit still has to happen, make the same edit again and it goes through.'
    );
  },
  neutral() {
    return { stdout: NOTHING };
  },
};
