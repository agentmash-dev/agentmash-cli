// `npx agentmash hook`: the generic hook (hooks/agent_hook.mjs) from the
// command line, for a coding agent agentmash has no connector for yet.
//
//   npx agentmash hook --print-command --client <id> --event <event>
//                      [--dialect <name>] [--input auto|native|normalized] [--json]
//
//       prints the line to put in the agent's hook configuration for that
//       event, word for word: node "<home>/.agentmash/hooks/agent_hook.mjs"
//       <event> --global --client <id> …, the string agent-kit.mjs's
//       agentHookCommand builds for every connector, so the same arguments
//       always print the same bytes (Codex keys a person's approval of a
//       hook to them). It is the only thing on stdout; a note on what is
//       missing goes to stderr.
//
//   npx agentmash hook <event> --client <id> [--dialect <name>] [--input …]
//
//       runs that same hook once, on the JSON piped in, and prints what the
//       agent would read back: for trying a configuration out by hand. It
//       runs the copy in ~/.agentmash/hooks, which is what the agent runs,
//       and this package's own copy only when login has not put one there.
//
// The node line is what goes in an agent's configuration, never npx: npx
// looks the package up on every call, seconds when it is cold, and a hook
// before an edit has 1.5 s to answer. Run by hand it is the same hook, and
// it fails the same way, open: arguments that do not read are said on
// stderr, and the hook still runs and gives its dialect's neutral answer.
//
// The CLI's shared argument parser reads a flag it does not know as taking
// the next word, so --print-command would swallow --client: this file reads
// its own arguments, raw.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AGENT_HOOK_SCRIPT, agentHookCommand } from './agent-kit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The events agent_hook.mjs answers, as its own EVENTS lists them (a test holds the two together). */
export const HOOK_EVENTS = ['pre_edit', 'post_edit', 'prompt', 'session_start', 'session_end', 'stop'];
/** A client id, as agent_hook.mjs and lib.mjs's hookClient take one. */
const CLIENT = /^[a-z][a-z0-9-]{0,20}$/;
const DIALECT = /^[a-z][a-z0-9-]{0,30}$/;
const INPUTS = ['auto', 'native', 'normalized'];

const machineHookDir = () => path.join(process.env.AGENTMASH_HOME || os.homedir(), '.agentmash', 'hooks');

/**
 * The hooks this package carries, which login copies: the checkout's first,
 * then the vendored copy, as agentmash.mjs's hookSourceDir looks.
 */
function sourceHookDir() {
  for (const dir of [path.join(HERE, '..', 'hooks'), path.join(HERE, 'hooks')]) {
    if (fs.existsSync(path.join(dir, AGENT_HOOK_SCRIPT))) return dir;
  }
  return null;
}

/** The dialects a hooks folder has, by name: one file each in its dialects/. */
function dialectsIn(dir) {
  if (!dir) return [];
  try {
    return fs
      .readdirSync(path.join(dir, 'dialects'))
      .filter((f) => f.endsWith('.mjs'))
      .map((f) => f.slice(0, -'.mjs'.length))
      .sort();
  } catch {
    return [];
  }
}

const colour = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
const paint = (code) => (s) => (colour ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const e = { bold: paint(1), dim: paint(2), yellow: paint(33), red: paint(31) };
const note = (s) => console.error(`  ${e.dim('·')} ${s}`);
const caution = (s) => console.error(`  ${e.yellow('!')} ${s}`);

function usage(dialects) {
  return `
  npx agentmash hook --print-command --client <id> --event <event>
                     [--dialect <name>] [--input <how>] [--json]
      the line to put in an agent's hook configuration for one event, word for word:
      node "${path.join(machineHookDir(), AGENT_HOOK_SCRIPT)}" <event> --global --client <id> …
  npx agentmash hook <event> --client <id> [--dialect <name>] [--input <how>]
      run that hook once on the JSON piped in, and print what the agent would read back

  <event>     ${HOOK_EVENTS.join(', ')}
  --client    the agent, as the room names its edits (<id>:Edit): a-z, 0-9 and -, up to 21
  --dialect   the answer the agent reads${dialects.length ? `: ${dialects.join(', ')}` : ''}
              (default: the one named like the client, else claude)
  --input     auto (default), native (the agent's own JSON) or normalized (agentmash's schema)
  --json      with --print-command: the line, quoted as a JSON config needs it, and what it
              answers in

  register the node line, never npx: npx looks the package up on every call, seconds
  when it is cold, and a hook before an edit has 1.5 s to answer
`;
}

// ── arguments ───────────────────────────────────────────────────────────────

const VALUES = { '--client': 'client', '--event': 'event', '--dialect': 'dialect', '--input': 'input' };
// --global is what every line says already: taken, so a line copied from a
// connector runs as it is, and changes nothing
const SWITCHES = { '--print-command': 'print', '--json': 'json', '--global': 'global', '--help': 'help', '-h': 'help' };

/**
 * `hook`'s arguments, as typed after it. Nothing throws: what does not read
 * is in `problems`, for --print-command to refuse and a run to say and go
 * past, as a hook does.
 */
export function parseHookArgs(argv) {
  const out = { _: [], problems: [] };
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    const eq = word.startsWith('--') ? word.indexOf('=') : -1;
    const flag = eq > 2 ? word.slice(0, eq) : word;
    if (Object.hasOwn(SWITCHES, flag)) {
      // still taken, so --print-command=yes is refused as a print, not run as a hook
      if (eq > 2) out.problems.push(`${flag} takes no value`);
      out[SWITCHES[flag]] = true;
    } else if (Object.hasOwn(VALUES, flag)) {
      const value = eq > 2 ? word.slice(eq + 1) : argv[++i];
      if (value === undefined || (eq <= 2 && value.startsWith('--'))) {
        out.problems.push(`${flag} needs a value`);
        if (value !== undefined) i--;
      } else if (Object.hasOwn(out, VALUES[flag])) out.problems.push(`${flag} is given twice`);
      else out[VALUES[flag]] = value;
    } else if (word.startsWith('-') && word !== '-') {
      out.problems.push(`unknown option ${word}`);
    } else {
      out._.push(word);
    }
  }
  const [named, ...extra] = out._;
  if (extra.length) out.problems.push(`unexpected ${JSON.stringify(extra[0])}`);
  if (named !== undefined && out.event !== undefined && named !== out.event) {
    out.problems.push(`two events named: ${named} and --event ${out.event}`);
  }
  out.event ??= named;
  return out;
}

/** What is wrong with the hook the arguments describe, a sentence each; `dialects` is what there is to answer in. */
function problemsOf(args, dialects) {
  const out = [...args.problems];
  if (args.event === undefined) out.push(`say which event: ${HOOK_EVENTS.join(', ')}`);
  else if (!HOOK_EVENTS.includes(args.event)) out.push(`unknown event ${JSON.stringify(args.event)}: one of ${HOOK_EVENTS.join(', ')}`);
  if (args.client === undefined) out.push('--client names the agent, as the room will name its edits (<id>:Edit)');
  else if (!CLIENT.test(args.client)) out.push(`--client ${JSON.stringify(args.client)}: a-z, 0-9 and -, starting with a letter, up to 21`);
  if (args.dialect !== undefined && (!DIALECT.test(args.dialect) || (dialects.length && !dialects.includes(args.dialect)))) {
    out.push(`no dialect ${JSON.stringify(args.dialect)}${dialects.length ? `: there are ${dialects.join(', ')}` : ''}`);
  }
  if (args.input !== undefined && !INPUTS.includes(args.input)) out.push(`--input is ${INPUTS.join(', ')}`);
  return out;
}

/** agent_hook.mjs's arguments, in the order agentHookCommand writes them. */
function hookArgs({ event, client, dialect, input }) {
  return [
    event ?? '',
    '--global',
    ...(client === undefined ? [] : ['--client', client]),
    ...(dialect === undefined ? [] : ['--dialect', dialect]),
    ...(input === undefined ? [] : ['--input', input]),
  ];
}

// ── the two ways to use it ──────────────────────────────────────────────────

function printCommand(args) {
  const hookDir = machineHookDir();
  const installedDialects = dialectsIn(hookDir);
  const dialects = [...new Set([...dialectsIn(sourceHookDir()), ...installedDialects])].sort();
  const problems = problemsOf(args, dialects);
  if (problems.length) {
    for (const problem of problems) console.error(`\n${e.red('error')} ${problem}`);
    console.error(usage(dialects));
    // exitCode, never process.exit() (see die in agentmash.mjs)
    process.exitCode = 1;
    return;
  }
  const command = agentHookCommand(hookDir, args.event, args.client, { dialect: args.dialect ?? null, input: args.input ?? null });
  // the one agent_hook.mjs picks when none is named
  const answersIn = args.dialect ?? (dialects.includes(args.client) ? args.client : 'claude');
  const script = path.join(hookDir, AGENT_HOOK_SCRIPT);
  const installed = fs.existsSync(script);

  if (args.json) console.log(JSON.stringify({ command, event: args.event, client: args.client, dialect: answersIn, installed }, null, 2));
  else console.log(command);

  if (!installed) caution(`${script} is not on this machine yet: ${e.bold('npx agentmash login')} copies it there, and its dialects`);
  else if (!installedDialects.includes(answersIn)) {
    caution(`the ${answersIn} dialect is not in ${path.join(hookDir, 'dialects')} yet: ${e.bold('npx agentmash login')} copies it`);
  }
  // an agent with a connector of its own gets every event, and anything its
  // hooks need beyond this line, from `tools add` (agents/<id>.mjs)
  if (args.client !== 'index' && fs.existsSync(path.join(HERE, 'agents', `${args.client}.mjs`))) {
    note(`agentmash connects ${args.client} itself: ${e.bold(`npx agentmash tools add ${args.client}`)} registers every event`);
  }
  if (args.dialect === undefined) {
    const others = dialects.filter((d) => d !== answersIn);
    note(
      `answers in the ${answersIn} dialect${answersIn === 'claude' ? " (Claude Code's hook JSON)" : ''}` +
        (others.length ? `; --dialect picks another: ${others.join(', ')}` : '')
    );
  }
}

function runHook(args) {
  const installed = path.join(machineHookDir(), AGENT_HOOK_SCRIPT);
  const source = sourceHookDir();
  const script = fs.existsSync(installed) ? installed : source && path.join(source, AGENT_HOOK_SCRIPT);
  const problems = problemsOf(args, dialectsIn(script && path.dirname(script)));
  if (args.json) problems.push('--json is for --print-command');
  // said, and then run anyway: the hook's own neutral answer is what a hook gives for arguments it cannot use
  for (const problem of problems) caution(problem);
  if (!script) {
    caution(`there is no ${AGENT_HOOK_SCRIPT} in ${path.dirname(installed)} or in this package: run npx agentmash login`);
    return Promise.resolve();
  }
  if (script !== installed) note(`${installed} is not there yet (npx agentmash login copies it): running this package's copy`);
  if (process.stdin.isTTY) note(`reading the agent's JSON from stdin: pipe it in, or type it and end with Ctrl-D`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...hookArgs(args)], { stdio: 'inherit', windowsHide: true });
    child.on('error', (err) => {
      caution(`could not run ${script}: ${err.message}`);
      resolve();
    });
    // the hook's own exit code, which is 0 unless its dialect says otherwise
    child.on('close', (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}

/** `npx agentmash hook …`, given the words after `hook`. */
export async function cmdHook(argv) {
  const args = parseHookArgs(argv);
  if (args.help || argv.length === 0) {
    console.log(usage([...new Set([...dialectsIn(sourceHookDir()), ...dialectsIn(machineHookDir())])].sort()));
    return;
  }
  if (args.print) return printCommand(args);
  return runHook(args);
}
