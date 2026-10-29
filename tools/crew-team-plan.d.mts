/**
 * Types for crew/team-plan.mjs, the agentmash crew's pure team planner, which
 * the server imports as it is instead of porting it: one planner is what keeps
 * a team installed by `npx agentmash team add`, by the site's pull request and
 * by the crew's own CLI the same bytes.
 *
 * The server compiles without allowJs, and under NodeNext a `.mjs` import takes
 * its types from the `.d.mts` beside it, so these declarations are all
 * TypeScript knows about the planner. They are written by hand from the
 * vendored source and copied into crew/team-plan.d.mts by tools/sync-crew.mjs;
 * edit this file, never the copy, and re-run the sync. The shapes follow
 * lib/team-plan.mjs and docs/bundle-format.md of the tag in crew/crew.lock.json;
 * when a new crew version changes an export, change it here in the same sync.
 *
 * Every function that validates throws a plain Error whose message is meant
 * for the person installing: there is no `code` property. A caller that has
 * to tell the cases apart (a web installer answering 400 or 409) can only go
 * by when it called and by the message; the one fixed wording worth matching
 * is noted on planChange.
 */

/** Always merged, never overwritten, so no bundle path may name it. */
export declare const SETTINGS_PATH: '.claude/settings.json';
export declare const MANIFEST_SCHEMA: 1;

// ── the bundle (crew/bundle.json, docs/bundle-format.md §2) ──────────────────
//
// Read-only all the way down: a server loads the bundle once and every request
// plans against that same object, so nothing may change it in place.

/** A file installed as it is. verifyBundle checks sha256 against content. */
export interface BundleFile {
  /** Relative to the repository root, starts with ".claude/", ASCII only (see pathProblem). */
  readonly path: string;
  /** Lowercase hex sha256 of the UTF-8 bytes of content. */
  readonly sha256: string;
  readonly content: string;
}

export interface BundleAgent extends BundleFile {
  /** Full name, e.g. "pipe-backend"; the file is .claude/agents/<name>.md. */
  readonly name: string;
  /** The part of name before the first "-", e.g. "pipe". Unique within the bundle. */
  readonly short: string;
  /** Display name, e.g. "Pipe". */
  readonly title: string;
  /** One line of at most 60 characters without "|", e.g. "Backend engineer". */
  readonly role: string;
  /** One of the catalog's group ids: lead, build, quality, ops, docs. */
  readonly group: string;
}

/** The PreToolUse group the install merges into .claude/settings.json (§8). */
export interface BundleHook {
  readonly event: string;
  readonly matcher: string;
  /** A shell string that contains marker. */
  readonly command: string;
  /** Seconds, a positive integer. */
  readonly timeout: number;
  /** The substring that identifies our group in settings.json. */
  readonly marker: string;
}

export interface BundleMeta {
  readonly name: string;
  readonly version: string;
  readonly url: string;
  /** Full name of the agent every team includes; always agents[0]. */
  readonly conductor: string;
  /** Contains "<team>", replaced by the quoted team name in the team skill. */
  readonly addCommand: string;
  readonly hook: BundleHook;
  /** ".claude/agentmash-crew/teams.json" */
  readonly manifestPath: string;
}

export interface TeamSkillTemplate {
  /** Contains {{team_slug}} and no other placeholder. */
  readonly pathPattern: string;
  readonly content: string;
}

export interface Bundle {
  readonly schema: 1;
  readonly meta: BundleMeta;
  /** Canonical order, conductor first. */
  readonly agents: readonly BundleAgent[];
  readonly shared: readonly BundleFile[];
  readonly templates: { readonly teamSkill: TeamSkillTemplate };
}

// ── teams and the manifest (.claude/agentmash-crew/teams.json, §7) ───────────

export interface Team {
  slug: string;
  /** Display name, trimmed, e.g. "Команда 123". */
  name: string;
  /** Full agent names. In a plan: conductor first, bundle order. */
  members: string[];
}

/** A plan's target after `remove` without --agents: the whole team goes. */
export interface RemovedTeam {
  slug: string;
  name: string;
  members: null;
}

/** What the manifest records about the bundle that wrote the files. */
export interface ManifestSource {
  name: string;
  version: string;
  url: string;
}

/** teams.json as parseManifest returns it, validated except for `source`. */
export interface Manifest {
  schema: 1;
  /**
   * Passed through from the committed file unchecked. The planner only reads
   * source.version, to warn when the files came from another crew version.
   */
  source: unknown;
  createdSettings: boolean;
  /** Members as the file lists them; planChange puts them in canonical order. */
  teams: Team[];
  /** Repository path -> lowercase hex sha256 of the bytes the installer wrote. */
  files: Record<string, string>;
}

/** teams.json as planChange writes it. */
export interface PlannedManifest extends Manifest {
  source: ManifestSource;
}

/**
 * A snapshot of the repository, taken before planning. lib/install.mjs
 * readState builds it from disk; any other installer has to build the same
 * thing from wherever it reads the repository.
 */
export interface RepoState {
  /** The parsed teams.json, or null when the file does not exist. */
  manifest: Manifest | null;
  /** .claude/settings.json as text, or null when it does not exist. */
  settingsText: string | null;
  /**
   * sha256 of the bytes at every path statePaths() returned, null where no
   * file exists. A path statePaths() named that is missing here makes
   * planChange throw an internal error.
   */
  onDisk: Readonly<Record<string, string | null>>;
}

// ── operations (§9) ──────────────────────────────────────────────────────────

/** Add a team, or extend the one with this exact name or slug. */
export interface AddOp {
  type: 'add';
  /** Display name, 1-60 code points; see validateTeamName. */
  name: string;
  /** Omit to derive it from name with slugify; never pass null. */
  slug?: string;
  /** Short or full names, any case, or "all". The conductor is added on its own. */
  members: readonly string[];
  /** Overwrite files the installer did not write, or that were changed locally. */
  force?: boolean;
}

/** Remove a whole team, or only some of its members. */
export interface RemoveOp {
  type: 'remove';
  /** Exact name, exact slug, or a name whose slug matches. */
  team: string;
  /** Omit to remove the team; the conductor can never be removed. */
  members?: readonly string[];
  force?: boolean;
}

/** Re-plan every installed team against this bundle. */
export interface UpdateOp {
  type: 'update';
  force?: boolean;
}

export type TeamOp = AddOp | RemoveOp | UpdateOp;

// ── plans ────────────────────────────────────────────────────────────────────

/**
 * created, updated (we wrote the old version), overwritten (--force),
 * unchanged, kept (changed locally, so not rewritten), deleted (no longer
 * needed), left (no longer needed but changed locally, so neither deleted nor
 * tracked any more).
 */
export type FileAction = 'created' | 'updated' | 'overwritten' | 'unchanged' | 'kept' | 'deleted' | 'left';

export interface PlannedWrite {
  path: string;
  content: string;
  /** sha256Hex(content). */
  sha256: string;
}

export interface PlannedChange {
  path: string;
  action: FileAction;
}

export interface SettingsPlan {
  path: typeof SETTINGS_PATH;
  /** The whole new file; null when it is deleted, or did not exist and still does not. */
  text: string | null;
  /** Whether the file has to be written (or deleted). */
  changed: boolean;
  action: 'created' | 'updated' | 'unchanged' | 'deleted';
}

export interface Plan<Target extends Team | RemovedTeam | null = Team | RemovedTeam | null> {
  /** Every team after the operation, sorted by slug. */
  teams: Team[];
  /** The team the operation was about; null for update. */
  target: Target;
  /** True when add created the team rather than extending one. */
  targetIsNew: boolean;
  /** Files to write, sorted by path. Settings and the manifest are not in here. */
  writes: PlannedWrite[];
  /** Files to delete, sorted by path. */
  deletes: string[];
  /** One entry per file considered, sorted by path, for the printed summary. */
  changes: PlannedChange[];
  settings: SettingsPlan;
  manifestPath: string;
  /** null when no team is left, and the manifest is deleted. */
  manifest: PlannedManifest | null;
  /** JSON.stringify(manifest, null, 2) + "\n", or null with manifest. */
  manifestText: string | null;
  manifestAction: 'created' | 'updated' | 'unchanged' | 'deleted';
  /** Whether applying the plan would change anything on disk. */
  changed: boolean;
  /** Things the person should know; the plan still applies. */
  warnings: string[];
}

/**
 * After add at least one team exists, so there is always a manifest and a
 * settings file to write. deletes can still be non-empty: an older manifest
 * may track a file this bundle no longer needs.
 */
export interface AddPlan extends Plan<Team> {
  settings: SettingsPlan & { text: string; action: 'created' | 'updated' | 'unchanged' };
  manifest: PlannedManifest;
  manifestText: string;
  manifestAction: 'created' | 'updated' | 'unchanged';
}

// ── functions ────────────────────────────────────────────────────────────────

/** Lowercase hex sha256 of a string's UTF-8 bytes, or of raw bytes. */
export declare function sha256Hex(data: string | Uint8Array): string;

/** Why path cannot be an install target, or null when it can. */
export declare function pathProblem(path: unknown): string | null;

/** Returns path when pathProblem finds nothing; throws otherwise. `what` names it in the message. */
export declare function assertSafePath(path: string, what?: string): string;

/**
 * Checks the shape, every sha256 and every path, and returns the same object.
 * Throws "invalid bundle: …" on the first problem.
 */
export declare function verifyBundle(bundle: unknown): Bundle;

/**
 * Returns the name trimmed. Throws when it is empty, longer than 60 code
 * points, or holds a control character, a line break, `"`, `\`, `$`, a
 * backtick or `!` (it goes into YAML and shell commands).
 */
export declare function validateTeamName(name: unknown): string;

/** Returns slug when it matches /^[a-z0-9][a-z0-9-]{0,39}$/; throws otherwise. */
export declare function validateSlug(slug: unknown): string;

/**
 * "Команда 123" -> "komanda-123": Russian and Kazakh transliterated, anything
 * else outside a-z0-9 collapsed to "-", at most 40 characters. Throws when
 * nothing usable is left, e.g. a name written only in CJK.
 */
export declare function slugify(name: string): string;

/**
 * Short or full names, any case, or "all", to full names in bundle order with
 * the conductor first. Throws on an unknown name, listing the valid ones.
 */
export declare function resolveMembers(bundle: Bundle, tokens: readonly string[]): string[];

/** Where a team's skill goes: pathPattern with the slug filled in. Throws on a bad slug. */
export declare function teamSkillPath(bundle: Bundle, slug: string): string;

/**
 * The team skill for one team. Members must be full names from the bundle; the
 * conductor is added if missing. Same bundle and team, same bytes.
 */
export declare function renderTeamSkill(
  bundle: Bundle,
  team: { readonly name: string; readonly slug: string; readonly members: readonly string[] }
): { path: string; content: string };

/**
 * Adds the crew's hook group to settings.json once. text is the current file,
 * or null when there is none. When nothing changes the original text comes
 * back untouched. Throws when the file is not a JSON object, or has "hooks" or
 * "hooks.<event>" of the wrong type.
 */
export declare function mergeSettings(
  text: string | null | undefined,
  hook: BundleHook
): { text: string; changed: boolean; created: boolean };

/**
 * Removes the crew's hook entry (every entry whose JSON contains marker).
 * With deleteIfEmpty an empty result comes back as text null: delete the file.
 * keptGroups counts groups that stay because they hold something else.
 */
export declare function unmergeSettings(
  text: string | null | undefined,
  marker: string,
  options?: { event?: string; deleteIfEmpty?: boolean }
): { text: string | null; changed: boolean; keptGroups: number };

/**
 * Parses and validates teams.json, which is committed and so untrusted. where
 * names the file in messages. Throws "<where>: <problem>; fix the file and
 * rerun".
 */
export declare function parseManifest(text: string, where: string, bundle: Bundle): Manifest;

/**
 * Every path planChange may need a hash for, sorted: the manifest, every
 * shared and agent file, every file the manifest tracks and every installed
 * team's skill, plus, for add, the target team's skill. settings.json is read
 * separately (RepoState.settingsText). Throws what add would throw for a bad
 * name or slug.
 */
export declare function statePaths(bundle: Bundle, manifest: Manifest | null | undefined, op: TeamOp): string[];

/**
 * Plans one operation against a snapshot; writes nothing. Throws, before any
 * write could happen, on a bad name, slug or agent, a settings.json it cannot
 * merge into, or files in the way. That last message starts with "refusing to
 * overwrite files that agentmash-crew did not write:" followed by one
 * indented path per line.
 */
export declare function planChange(bundle: Bundle, state: RepoState, op: AddOp): AddPlan;
export declare function planChange(bundle: Bundle, state: RepoState, op: RemoveOp): Plan<Team | RemovedTeam>;
export declare function planChange(bundle: Bundle, state: RepoState, op: UpdateOp): Plan<null>;
export declare function planChange(bundle: Bundle, state: RepoState, op: TeamOp): Plan;
