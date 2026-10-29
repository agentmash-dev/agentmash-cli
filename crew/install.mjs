// File-system side of the team installer: find the repository, snapshot what is on disk, apply a plan.
// All decisions are made by the pure functions in team-plan.mjs; this module only reads and writes.
//
// Safety rules: every path is relative to the repository root and starts with ".claude/"; we never follow a symlink
// inside the repository (not for the file, not for any parent directory); a plan is validated completely before the
// first byte is written.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SETTINGS_PATH, assertSafePath, parseManifest, planChange, sha256Hex, statePaths, verifyBundle } from './team-plan.mjs';

/**
 * Walks up from `start` to the first directory that contains a .git directory or file (worktrees, submodules).
 * Refuses the home directory: when it is a git repository (a dotfiles checkout), its .claude/ is Claude Code's
 * user-level configuration, which applies to every project.
 */
export function findRepoRoot(start = process.cwd()) {
  const from = path.resolve(start);
  if (!isDirectory(from)) throw new Error(`${from} is not a directory`);
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (exists(path.join(dir, '.git'))) {
      if (realpath(dir) === realpath(os.homedir())) {
        throw new Error(
          `the nearest git repository above ${from} is your home directory ${dir}; installing there would write into ~/.claude, Claude Code's configuration for every project. Run this inside a project repository or pass --repo <path>`,
        );
      }
      return dir;
    }
    if (path.dirname(dir) === dir) {
      throw new Error(`${from} is not inside a git repository (no .git found in it or above it); pass --repo <path>`);
    }
  }
}

function realpath(abs) {
  try {
    return fs.realpathSync(abs);
  } catch {
    return path.resolve(abs);
  }
}

function isDirectory(abs) {
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function exists(abs) {
  try {
    fs.statSync(abs);
    return true;
  } catch {
    return false;
  }
}

const toAbsolute = (root, rel) => path.join(root, ...rel.split('/'));

/**
 * lstat every component of `rel` below the repository root. Returns false when the path does not exist and true when
 * it is a regular file. Throws on a symlink anywhere on the way, a parent that is not a directory, or a target that is
 * not a regular file.
 */
function inspectPath(root, rel) {
  const parts = rel.split('/');
  let current = root;
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    const shown = parts.slice(0, i + 1).join('/');
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`refusing to touch ${rel}: ${shown} is a symlink`);
    const last = i === parts.length - 1;
    if (!last && !stat.isDirectory()) throw new Error(`refusing to touch ${rel}: ${shown} is not a directory`);
    if (last && !stat.isFile()) throw new Error(`refusing to touch ${rel}: it is not a regular file`);
  }
  return true;
}

function readBytes(root, rel) {
  return inspectPath(root, rel) ? fs.readFileSync(toAbsolute(root, rel)) : null;
}

function readText(root, rel) {
  const bytes = readBytes(root, rel);
  return bytes === null ? null : bytes.toString('utf8');
}

export function readManifest(root, bundle) {
  const { manifestPath } = bundle.meta;
  const text = readText(root, manifestPath);
  return text === null ? null : parseManifest(text, manifestPath, bundle);
}

/** Snapshot for planChange: the manifest, settings.json and the sha256 of every path the plan may touch. */
export function readState(root, bundle, op) {
  const manifest = readManifest(root, bundle);
  const onDisk = {};
  for (const rel of statePaths(bundle, manifest, op)) {
    const bytes = readBytes(root, assertSafePath(rel));
    onDisk[rel] = bytes === null ? null : sha256Hex(bytes);
  }
  return { manifest, settingsText: readText(root, SETTINGS_PATH), onDisk };
}

/** Removes the directories above `rel` that are now empty, up to but never including .claude itself. */
function pruneEmptyDirectories(root, rel) {
  const parts = rel.split('/').slice(0, -1);
  while (parts.length > 1) {
    try {
      fs.rmdirSync(toAbsolute(root, parts.join('/')));
    } catch (error) {
      if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') return;
      if (error.code !== 'ENOENT') throw error;
    }
    parts.pop();
  }
}

/**
 * Writes a sibling temporary file, flushes it and renames it over the target. A write that fails (disk full) or is
 * interrupted leaves the old file whole, never a truncated one that the next run would take for a local edit.
 */
function writeFile(root, rel, content) {
  const abs = toAbsolute(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const temp = `${abs}.agentmash-tmp-${process.pid}`;
  let fd = null;
  let created = false;
  try {
    fd = fs.openSync(temp, 'wx');
    created = true;
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, abs);
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    if (created) fs.rmSync(temp, { force: true });
    throw error;
  }
}

function deleteFile(root, rel) {
  fs.rmSync(toAbsolute(root, rel), { force: true });
  pruneEmptyDirectories(root, rel);
}

/** Applies a plan from planChange: files, then settings.json, then the manifest (so a crash leaves it conservative). */
export function apply(root, plan) {
  for (const write of plan.writes) {
    if (sha256Hex(write.content) !== write.sha256) throw new Error(`internal error: content of ${write.path} does not match its sha256`);
  }
  for (const rel of [...plan.writes.map((w) => w.path), ...plan.deletes, plan.manifestPath]) inspectPath(root, assertSafePath(rel));
  inspectPath(root, SETTINGS_PATH);

  for (const { path: rel, content } of plan.writes) writeFile(root, rel, content);
  for (const rel of plan.deletes) deleteFile(root, rel);

  if (plan.settings.changed) {
    if (plan.settings.text === null) fs.rmSync(toAbsolute(root, SETTINGS_PATH), { force: true });
    else writeFile(root, SETTINGS_PATH, plan.settings.text);
  }

  if (plan.manifestAction === 'deleted') deleteFile(root, plan.manifestPath);
  else if (plan.manifestAction !== 'unchanged') writeFile(root, plan.manifestPath, plan.manifestText);
}

// ---------------------------------------------------------------------------------------------------------------
// High-level entry points for the CLI

export function loadBundle(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read the crew bundle at ${file} (${error.code ?? error.message}); run: node scripts/build-bundle.mjs`);
  }
  let bundle;
  try {
    bundle = JSON.parse(text);
  } catch (error) {
    throw new Error(`the crew bundle at ${file} is not valid JSON (${error.message})`);
  }
  return verifyBundle(bundle);
}

/** Plans `op` for the repository containing `repo` and, unless dryRun, applies it. */
export function runTeamOp({ repo, bundle, op, dryRun = false }) {
  const root = findRepoRoot(repo);
  const plan = planChange(bundle, readState(root, bundle, op), op);
  if (!dryRun) apply(root, plan);
  return { root, plan };
}

export function listTeams({ repo, bundle }) {
  const root = findRepoRoot(repo);
  return { root, teams: readManifest(root, bundle)?.teams ?? [] };
}
