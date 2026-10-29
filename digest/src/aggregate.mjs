// Turning a week of raw hook events into the handful of facts a lead can act on.
//
// Everything here is pure: events in, one plain object out. The renderers and
// the CLI never re-derive anything, so what Slack shows and what `--to json`
// emits cannot drift apart.

const DAY_MS = 86_400_000;

export const DEFAULTS = {
  /** A zone needs this many distinct developers. Two is the smallest number that is a collision at all. */
  hotMinDevs: 2,
  /** ...and this many edits, so a pair of drive-by touches doesn't get promoted to a finding. */
  hotMinEdits: 4,
  /** ...and two of those edits, by different people, no further apart than this.
   *  Two people in a file a week apart is a handoff. Two people in it inside two
   *  days is the team stepping on itself. */
  hotWindowHours: 48,
  /** A pair of people earns a line only if they met in this many distinct files. */
  pairMinFiles: 2,
  /** A branch with at least this much work on it can stall... */
  stallMinEdits: 5,
  /** ...and counts as stalled once it has been untouched this long at period end. */
  stallDays: 3,
  /** At or below this many edits the digest drops its sections and just says what happened. */
  thinMaxEdits: 5,
};

export function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/** alice@acme.io -> alice, but only while every name stays distinct. */
export function shortNames(developers) {
  const out = new Map();
  const short = developers.map((d) => (d.includes('@') ? d.slice(0, d.indexOf('@')) : d));
  const collides = new Set(short.filter((s, i) => short.indexOf(s) !== i));
  developers.forEach((d, i) => out.set(d, collides.has(short[i]) ? d : short[i]));
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Everything is stamped in UTC. A digest that renders differently depending on
// which laptop the cron job runs on is a bug report waiting to happen.
export function formatDay(ts) {
  const d = new Date(ts);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function pct(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function isEdit(e) {
  return e.event_type === 'edit' && typeof e.file_path === 'string' && e.file_path.length > 0;
}

/** True when two edits by different people land within `windowMs` of each other. */
function hasCollision(edits, windowMs, sameFileOnly = true) {
  const sorted = [...edits].sort((a, b) => a.ts - b.ts);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && sorted[j].ts - sorted[i].ts <= windowMs; j++) {
      if (sorted[j].developer === sorted[i].developer) continue;
      if (!sameFileOnly && sorted[j].file_path === sorted[i].file_path) continue;
      return true;
    }
  }
  return false;
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const k = key(row);
    if (k === null || k === undefined) continue;
    const bucket = map.get(k);
    if (bucket) bucket.push(row);
    else map.set(k, [row]);
  }
  return map;
}

/**
 * Files and directories that repeatedly drew more than one person.
 *
 * A directory qualifies only when no single file inside it already did, and
 * only when the people involved were in *different* files -- that is the
 * interesting case, because nobody is fighting over a line of code and the
 * boundary is still wrong.
 */
export function hotZones(edits, options) {
  const { hotMinDevs, hotMinEdits, hotWindowHours } = options;
  const windowMs = hotWindowHours * 3_600_000;
  const zones = [];

  const byFile = groupBy(edits, (e) => e.file_path);
  const hotFiles = new Set();
  for (const [file, rows] of byFile) {
    const developers = [...new Set(rows.map((r) => r.developer))];
    if (developers.length < hotMinDevs || rows.length < hotMinEdits) continue;
    if (!hasCollision(rows, windowMs)) continue;
    hotFiles.add(file);
    zones.push({
      kind: 'file',
      path: file,
      developers: developers.sort(),
      edits: rows.length,
      files: 1,
      last_ts: Math.max(...rows.map((r) => r.ts)),
    });
  }

  const byDir = groupBy(edits, (e) => dirOf(e.file_path) || null);
  for (const [dir, rows] of byDir) {
    if (rows.some((r) => hotFiles.has(r.file_path))) continue;
    const developers = [...new Set(rows.map((r) => r.developer))];
    const files = new Set(rows.map((r) => r.file_path));
    if (developers.length < hotMinDevs || rows.length < hotMinEdits || files.size < 2) continue;
    if (!hasCollision(rows, windowMs, false)) continue;
    zones.push({
      kind: 'dir',
      path: dir,
      developers: developers.sort(),
      edits: rows.length,
      files: files.size,
      last_ts: Math.max(...rows.map((r) => r.ts)),
    });
  }

  return zones.sort(
    (a, b) => b.developers.length - a.developers.length || b.edits - a.edits || b.last_ts - a.last_ts
  );
}

/** Pairs of people who kept meeting in the same files, close enough in time to matter. */
function collidingPairs(edits, options) {
  const windowMs = options.hotWindowHours * 3_600_000;
  const pairs = new Map();
  for (const [file, rows] of groupBy(edits, (e) => e.file_path)) {
    const sorted = [...rows].sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length && sorted[j].ts - sorted[i].ts <= windowMs; j++) {
        if (sorted[j].developer === sorted[i].developer) continue;
        // NUL separator: a developer identity can contain anything but this.
        const key = [sorted[i].developer, sorted[j].developer].sort().join('\u0000');
        let pair = pairs.get(key);
        if (!pair) {
          const [a, b] = key.split('\u0000');
          pair = { a, b, files: new Set(), last_ts: 0 };
          pairs.set(key, pair);
        }
        pair.files.add(file);
        pair.last_ts = Math.max(pair.last_ts, sorted[j].ts);
      }
    }
  }
  return [...pairs.values()]
    .filter((p) => p.files.size >= options.pairMinFiles)
    .map((p) => ({ a: p.a, b: p.b, shared_files: [...p.files].sort(), last_ts: p.last_ts }))
    .sort((x, y) => y.shared_files.length - x.shared_files.length || y.last_ts - x.last_ts);
}

function peopleOf(events, edits, periodEnd) {
  const people = [];
  for (const [developer, rows] of groupBy(events, (e) => e.developer)) {
    const own = edits.filter((e) => e.developer === developer);
    const dirs = new Map();
    for (const e of own) {
      const d = dirOf(e.file_path) || '(repo root)';
      dirs.set(d, (dirs.get(d) ?? 0) + 1);
    }
    const withHint = rows.filter((r) => r.task_hint).sort((a, b) => b.ts - a.ts);
    const lastTs = Math.max(...rows.map((r) => r.ts));
    people.push({
      developer,
      edits: own.length,
      files: new Set(own.map((e) => e.file_path)).size,
      days_active: new Set(own.map((e) => dayKey(e.ts))).size,
      sessions: new Set(rows.map((r) => r.session_id)).size,
      branches: [...new Set(rows.map((r) => r.git_branch).filter(Boolean))].sort(),
      areas: [...dirs.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([dir, count]) => ({ dir, edits: count, share: pct(count, own.length) })),
      latest_hint: withHint[0]?.task_hint ?? null,
      sample_files: [...new Set(own.sort((a, b) => b.ts - a.ts).map((e) => e.file_path))].slice(0, 5),
      last_ts: lastTs,
      idle_days: Math.floor((periodEnd - lastTs) / DAY_MS),
    });
  }
  return people.sort((a, b) => b.edits - a.edits || a.developer.localeCompare(b.developer));
}

function stalledWork(events, edits, periodEnd, options) {
  const branches = [];
  for (const [branch, rows] of groupBy(edits, (e) => e.git_branch || null)) {
    const lastTs = Math.max(...rows.map((r) => r.ts));
    const idleDays = Math.floor((periodEnd - lastTs) / DAY_MS);
    if (rows.length < options.stallMinEdits || idleDays < options.stallDays) continue;
    branches.push({
      branch,
      developers: [...new Set(rows.map((r) => r.developer))].sort(),
      edits: rows.length,
      last_ts: lastTs,
      idle_days: idleDays,
    });
  }
  branches.sort((a, b) => b.edits - a.edits);

  // A session that took a prompt and never produced an edit is somebody asking
  // for something they didn't get -- invisible on the live board, worth a line here.
  const dropped = [];
  for (const [, rows] of groupBy(events, (e) => `${e.developer} ${e.session_id}`)) {
    if (rows.some(isEdit)) continue;
    if (!rows.some((r) => r.event_type === 'prompt')) continue;
    dropped.push({ developer: rows[0].developer, ts: Math.max(...rows.map((r) => r.ts)) });
  }
  dropped.sort((a, b) => b.ts - a.ts);
  return { branches: branches.slice(0, 3), dropped_sessions: dropped };
}

/**
 * @param events raw rows from GET /events, any order, possibly spanning two periods
 * @param opts   { periodStart, periodEnd, previousStart, truncated, ...DEFAULTS }
 */
export function aggregate(events, opts) {
  const options = { ...DEFAULTS, ...opts };
  const { periodStart, periodEnd, previousStart } = options;

  const current = events.filter((e) => e.ts >= periodStart && e.ts < periodEnd);
  const previous = events.filter((e) => e.ts >= previousStart && e.ts < periodStart);
  const edits = current.filter(isEdit);
  const previousEdits = previous.filter(isEdit);

  const zones = hotZones(edits, options);
  const previousZones = previousStart < periodStart ? hotZones(previousEdits, options) : [];
  const previousPaths = new Set(previousZones.map((z) => z.path));
  for (const zone of zones) zone.status = previousPaths.has(zone.path) ? 'repeat' : 'new';
  const currentPaths = new Set(zones.map((z) => z.path));

  const totalEdits = edits.length;
  const areas = [...groupBy(edits, (e) => dirOf(e.file_path) || '(repo root)').entries()]
    .map(([dir, rows]) => ({
      dir,
      edits: rows.length,
      share: pct(rows.length, totalEdits),
      developers: [...new Set(rows.map((r) => r.developer))].sort(),
    }))
    .sort((a, b) => b.edits - a.edits)
    .filter((a) => a.share >= 5)
    .slice(0, 5);

  const developers = [...new Set(current.map((e) => e.developer))].sort();
  const previousDevelopers = [...new Set(previous.map((e) => e.developer))];

  return {
    room: opts.room ?? null,
    label: opts.label ?? null,
    generated_at: new Date(opts.now ?? Date.now()).toISOString(),
    period: {
      start: new Date(periodStart).toISOString(),
      end: new Date(periodEnd).toISOString(),
      days: Math.max(1, Math.round((periodEnd - periodStart) / DAY_MS)),
      label: `${formatDay(periodStart)} to ${formatDay(periodEnd - 1)} UTC`,
    },
    thresholds: {
      hot_min_devs: options.hotMinDevs,
      hot_min_edits: options.hotMinEdits,
      hot_window_hours: options.hotWindowHours,
      pair_min_files: options.pairMinFiles,
      stall_days: options.stallDays,
    },
    quiet: current.length === 0,
    /** Whether there was any prompt text at all -- so the digest only mentions withholding it when there was. */
    has_hints: current.some((e) => Boolean(e.task_hint)),
    thin: current.length > 0 && totalEdits <= options.thinMaxEdits,
    totals: {
      events: current.length,
      edits: totalEdits,
      files: new Set(edits.map((e) => e.file_path)).size,
      developers: developers.length,
      sessions: new Set(current.map((e) => `${e.developer} ${e.session_id}`)).size,
    },
    people: peopleOf(current, edits, periodEnd),
    areas,
    hot_zones: zones,
    pairs: collidingPairs(edits, options).slice(0, 4),
    stalled: stalledWork(current, edits, periodEnd, options),
    comparison: {
      available: previous.length > 0,
      edits: previousEdits.length,
      developers: previousDevelopers.length,
      hot_zones: previousZones.length,
      edits_delta_pct:
        previousEdits.length > 0
          ? Math.round(((totalEdits - previousEdits.length) / previousEdits.length) * 100)
          : null,
      cooled: previousZones.filter((z) => !currentPaths.has(z.path)).map((z) => z.path).slice(0, 3),
    },
    /** True when the server had more rows in the window than we were willing to page. */
    truncated: Boolean(options.truncated),
  };
}
