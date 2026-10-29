// @i-know-the-amp-plugin-api-is-wip-and-very-experimental-right-now
// AgentMash's plugin for Amp (ampcode.com). `npx agentmash login` writes this
// file into Amp's own plugins folder, ~/.config/amp/plugins/agentmash.ts
// ($XDG_CONFIG_HOME/amp/plugins when that is set), with the one line that
// names the hooks folder filled in, and `npx agentmash logout` takes it out
// (cli/agents/amp.mjs). The line above has to stay the first: Amp builds from
// before the Plugin API was released would not load a plugin without it, and
// it costs nothing on the ones since.
//
// Amp runs no hook commands. The one way to see a tool call before it runs is
// a plugin: a module Amp's bundled Bun loads once and keeps running for every
// thread it hosts. So this is all of AgentMash's side of Amp, and it decides
// nothing itself: at each moment that matters it hands what Amp said to the
// generic hook (~/.agentmash/hooks/agent_hook.mjs, --client amp), which reads
// it with the amp dialect (hooks/dialects/amp.mjs) and answers in Amp's words.
//
//   agent.start   prompt, waited for: the prompt reported, and the heads-up
//                 (a teammate's agent at work here) added to it, hidden, for
//                 the model; nothing for a subagent's own thread
//   tool.call     pre_edit, waited for, only for a call Amp itself says changes
//                 files (amp.helpers.filesModifiedByToolCall): allow, or the
//                 first try refused with the advice as its reason (below)
//   tool.result   post_edit, in the background: the edit, or for a shell
//                 command what the working tree says it changed, reported
//   agent.end     stop, in the background: an overlap, said to the person
//   unloading     session_end for each thread seen, as far as there is time:
//                 Amp has no event for a session's end
//
// The advice before an edit. Amp's tool.call can let a call run, or refuse it
// with a reason the model reads and carries on from (reject-and-continue); it
// has no way to let a call run with a note added to it. So the first edit of a
// file a teammate's agent is in, per thread, is refused with the advice as the
// reason, and the same edit tried again goes through: the deny-once dialect's
// rule. Only the room's strict mode refuses more than once.
//
// Never in the person's way:
//   - an answer to a tool call is { action: 'allow' } unless the hook answers
//     in the one shape a refusal takes; never 'error' (which stops the
//     thread), 'modify' or 'synthesize'
//   - allow grants nothing: since Neo, Amp asks before no tool. Its old
//     permission rules still run, as a plugin of Amp's own, when the settings
//     ask for them (permissions, dangerouslyAllowAll: false,
//     guardedFiles.allowlist), and how two plugins' answers to one call
//     combine is not documented; with those settings on, or when they cannot
//     be read, this answers no tool call at all and only reports, so nothing
//     here can ever stand in for the person's own answer
//   - whatever fails, hangs past its time or says something unexpected is
//     allow, or nothing
//   - reports never hold Amp up: tool.result and agent.end return at once
//
// Plain JavaScript in a .ts file: Bun reads it as TypeScript, and node as a
// module, which is how the tests run it. Only node's own modules: a plugin in
// that folder has no node_modules.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The hooks folder `npx agentmash login` copied the scripts to: the one line login writes in. */
const HOOKS_DIR = null; // agentmash:hooks-dir

export const description = "AgentMash: before an edit, tells the agent when a teammate's agent is in that file, and reports this agent's prompts and edits to your team's room.";

/** The events this plugin listens to, as `amp plugins list` shows them. */
export const EVENTS = ['agent.start', 'tool.call', 'tool.result', 'agent.end'];

/**
 * How long each moment waits for the hook before it goes on without it: past
 * the hook's own guard (the room's 1.5 s budget, node starting twice, and
 * prompt_note's 2.5 s), so the hook's neutral answer normally comes first.
 */
const WAIT_MS = { pre_edit: 3000, prompt: 3500, stop: 3000 };
/** How long a report waits to be handed over, at most: only the write into the pipe. */
const HANDOFF_MS = 1500;
/** What is read of a hook's answer, at most. */
const MAX_ANSWER = 64 * 1024;
/** The longest text passed on to the model or the person. */
const MAX_TEXT = 8000;
/** Threads remembered: where each works, and which to end on unloading. */
const MAX_THREADS = 64;
/** Files read from one call, at most. */
const MAX_FILES = 100;
/** Amp's edit tools: asked about even when Amp's helper names no file, so the dialect can read the input's own. */
const EDIT_TOOLS = new Set(['edit_file', 'create_file', 'apply_patch']);
/** And one that changes a file after the fact, reported but never asked about. */
const REPORTED_TOOLS = new Set([...EDIT_TOOLS, 'undo_edit']);

const allow = () => ({ action: 'allow' });
/** `value`, `ms` from now, on a timer that keeps no process alive. */
const later = (ms, value = null) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(value), ms);
    timer.unref?.();
  });
const usable = (p) => typeof p === 'string' && p.length > 0 && p.length <= 4096 && path.isAbsolute(p) && !/[\r\n\0]/.test(p);

/**
 * The plugin, for the hooks in `hooksDir`. `options` are for the tests: the
 * node to run (`node` on PATH, as every agent's hook runs it), the
 * environment the hook gets, and how long each moment waits.
 */
export function agentmash(hooksDir = HOOKS_DIR, { node = 'node', env = process.env, waitMs = WAIT_MS } = {}) {
  return async function plugin(amp) {
    if (typeof hooksDir !== 'string' || !path.isAbsolute(hooksDir)) return;
    const hook = path.join(hooksDir, 'agent_hook.mjs');

    // ── handing a moment to the hook ──────────────────────────────────────

    /**
     * Run the generic hook for `event` with `envelope` on its stdin. Waited
     * for: what it printed, as JSON, or null. In the background: null once
     * the envelope is in the pipe. Never throws, never outlasts `ms`.
     */
    function run(event, envelope, { wait, ms }) {
      return new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const settle = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        let child;
        try {
          child = spawn(node, [hook, event, '--global', '--client', 'amp'], {
            env,
            stdio: ['pipe', wait ? 'pipe' : 'ignore', 'ignore'],
            detached: !wait,
            windowsHide: true,
          });
        } catch {
          return settle(null);
        }
        timer = setTimeout(() => {
          if (wait) {
            try {
              child.kill();
            } catch {
              // gone already
            }
          }
          settle(null);
        }, ms);
        child.on('error', () => settle(null));
        // a hook that answers without reading all of it (switched off, say) still answers: 'close' says what
        child.stdin.on('error', () => {
          if (!wait) settle(null);
        });
        if (wait) {
          let out = '';
          child.stdout.setEncoding('utf8');
          child.stdout.on('data', (d) => {
            if (out.length < MAX_ANSWER) out += d;
          });
          child.on('close', () => {
            try {
              settle(out.trim() ? JSON.parse(out) : null);
            } catch {
              settle(null);
            }
          });
        }
        try {
          child.stdin.end(JSON.stringify(envelope), () => {
            if (wait) return;
            try {
              child.unref();
            } catch {
              // nothing to let go of
            }
            settle(null);
          });
        } catch {
          settle(null);
        }
      });
    }

    // ── what Amp says about a call ────────────────────────────────────────

    /** A URI from Amp's helpers as a local path, or null. */
    function pathOf(uri) {
      try {
        const p = amp.helpers?.filePathFromURI?.(uri);
        if (usable(p)) return p;
      } catch {
        // below
      }
      try {
        const url = new URL(String(uri));
        if (url.protocol === 'file:') return fileURLToPath(url);
      } catch {
        // not a file
      }
      return null;
    }

    /** The files Amp says a call or its result changes: its own reading, never a guess from the input. */
    function changedFiles(event) {
      let uris = null;
      try {
        uris = amp.helpers?.filesModifiedByToolCall?.(event) ?? null;
      } catch {
        uris = null;
      }
      if (!Array.isArray(uris)) return [];
      const files = [];
      for (const uri of uris.slice(0, MAX_FILES)) {
        const p = pathOf(uri);
        if (usable(p) && !files.includes(p)) files.push(p);
      }
      return files;
    }

    /** The shell command of a Bash or shell_command call, by Amp's own helper: { command, dir } or null. */
    function shellOf(event) {
      try {
        const shell = amp.helpers?.shellCommandFromToolCall?.(event);
        if (typeof shell?.command !== 'string') return null;
        return { command: shell.command, dir: typeof shell.dir === 'string' ? shell.dir : null };
      } catch {
        return null;
      }
    }

    /**
     * The repository a path is in: the nearest folder up from it with a .git
     * (a checkout, a worktree, a submodule), or null. Amp's workspaceRoot is
     * one folder for the whole process, and a runner serves many, so each
     * call's own files say where it works.
     */
    function repoOf(p) {
      if (!usable(p)) return null;
      let dir = p;
      try {
        if (!fs.statSync(p).isDirectory()) dir = path.dirname(p);
      } catch {
        dir = path.dirname(p); // a file not made yet
      }
      for (let at = dir; ; at = path.dirname(at)) {
        try {
          if (fs.existsSync(path.join(at, '.git'))) return at;
        } catch {
          return null;
        }
        if (path.dirname(at) === at) return null;
      }
    }

    /** The repository Amp has open: its workspace root's, else the folder Amp was started in. */
    function workspaceRepo() {
      try {
        const root = amp.system?.workspaceRoot;
        const found = root ? repoOf(pathOf(root)) : null;
        return found ?? repoOf(process.cwd());
      } catch {
        return null;
      }
    }

    // where each thread last worked, newest last: a prompt or a turn's end has no files of its own
    const threads = new Map();
    const threadOf = (event) => (typeof event?.thread?.id === 'string' ? event.thread.id : null);
    function remember(thread, cwd) {
      if (!thread || !cwd) return;
      threads.delete(thread);
      threads.set(thread, cwd);
      while (threads.size > MAX_THREADS) threads.delete(threads.keys().next().value);
    }

    /** The envelope the amp dialect reads (hooks/dialects/amp.mjs documents it). */
    const envelope = (hook, thread, cwd, fields = {}) => ({ amp: 1, hook, thread, cwd, ...fields });
    const callFields = (event, files, shell) => ({
      tool: typeof event?.tool === 'string' ? event.tool : null,
      tool_use_id: typeof event?.toolUseID === 'string' ? event.toolUseID : null,
      input: event?.input && typeof event.input === 'object' && !Array.isArray(event.input) ? event.input : {},
      files,
      ...(shell ? { shell: shell.command } : {}),
    });

    // ── whether this may answer a tool call at all ────────────────────────

    /**
     * False when Amp's old permission rules may be asking the person about
     * calls (see the top), or when that cannot be told: then no tool.call
     * handler is registered, and every call goes on as it would without one.
     */
    async function mayAnswerToolCalls() {
      try {
        if (typeof amp.configuration?.get !== 'function') return false;
        const config = await Promise.race([amp.configuration.get(), later(2000)]);
        if (!config || typeof config !== 'object') return false;
        const setting = (name) => (config[name] !== undefined ? config[name] : config[`amp.${name}`]);
        return setting('permissions') === undefined && setting('dangerouslyAllowAll') !== false && setting('guardedFiles.allowlist') === undefined;
      } catch {
        return false;
      }
    }

    // ── the events ────────────────────────────────────────────────────────

    if (await mayAnswerToolCalls()) {
      amp.on('tool.call', async (event) => {
        try {
          const files = changedFiles(event);
          // a read, a search, a command that changes no file Amp can name: nothing to ask
          if (files.length === 0 && !EDIT_TOOLS.has(event?.tool)) return allow();
          const thread = threadOf(event);
          const cwd = repoOf(files[0]) ?? threads.get(thread) ?? workspaceRepo();
          // a file in no repository is no room's
          if (!cwd) return allow();
          remember(thread, cwd);
          const said = await run('pre_edit', envelope('tool.call', thread, cwd, callFields(event, files, shellOf(event))), {
            wait: true,
            ms: waitMs.pre_edit,
          });
          if (said?.action === 'reject-and-continue' && typeof said.message === 'string' && said.message.trim()) {
            return { action: 'reject-and-continue', message: said.message.slice(0, MAX_TEXT) };
          }
        } catch {
          // below
        }
        return allow();
      });
    }

    amp.on('tool.result', (event) => {
      try {
        // a call that failed, or was cancelled, is not reported as an edit
        if (event?.status !== 'done') return undefined;
        const files = changedFiles(event);
        const shell = shellOf(event);
        if (files.length === 0 && !shell && !REPORTED_TOOLS.has(event?.tool)) return undefined;
        const thread = threadOf(event);
        const cwd = repoOf(files[0]) ?? repoOf(shell?.dir) ?? threads.get(thread) ?? workspaceRepo();
        if (!cwd) return undefined;
        remember(thread, cwd);
        run('post_edit', envelope('tool.result', thread, cwd, callFields(event, files, shell)), { wait: false, ms: HANDOFF_MS });
      } catch {
        // nothing reported
      }
      // nothing returned: Amp sends the tool's result to the model as it was
      return undefined;
    });

    amp.on('agent.start', async (event, ctx) => {
      try {
        if (typeof event?.message !== 'string') return {};
        const thread = threadOf(event);
        // a subagent's or a side thread's prompt is the model's, not the person's
        const parent = await Promise.race([(async () => ctx?.thread?.parentThreadID?.())().catch(() => null), later(300)]);
        if (typeof parent === 'string' && parent) return {};
        const cwd = threads.get(thread) ?? workspaceRepo();
        if (!cwd) return {};
        remember(thread, cwd);
        const said = await run('prompt', envelope('agent.start', thread, cwd, { prompt: event.message }), { wait: true, ms: waitMs.prompt });
        const content = said?.message?.content;
        if (typeof content === 'string' && content.trim()) return { message: { content: content.slice(0, MAX_TEXT), display: false } };
      } catch {
        // below
      }
      return {};
    });

    amp.on('agent.end', (event) => {
      try {
        if (event?.status !== 'done') return undefined;
        const thread = threadOf(event);
        // a thread that never worked in a repository here has nothing to overlap
        const cwd = threads.get(thread);
        if (!cwd) return undefined;
        run('stop', envelope('agent.end', thread, cwd), { wait: true, ms: waitMs.stop }).then((said) => {
          const words = said?.notify;
          if (typeof words !== 'string' || !words.trim()) return;
          try {
            Promise.resolve(amp.ui?.notify?.(words.slice(0, MAX_TEXT))).catch(() => {});
          } catch {
            // no UI here (amp -x): nobody to tell
          }
        });
      } catch {
        // nothing said
      }
      // nothing returned: a turn's end is never continued from here
      return undefined;
    });

    try {
      amp.onDispose?.(() =>
        Promise.race([
          Promise.all(
            [...threads].map(([thread, cwd]) => run('session_end', envelope('unload', thread, cwd), { wait: false, ms: HANDOFF_MS }))
          ),
          later(2000),
        ])
      );
    } catch {
      // no unloading to hear of
    }
  };
}

export default agentmash();
