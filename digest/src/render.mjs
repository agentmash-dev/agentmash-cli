// One composition, four targets.
//
// `compose` is the only place that decides what earns a line. Each target
// supplies a formatter (escaping, emphasis, column padding) and gets the same
// digest back, so Slack and the terminal can never disagree about the facts.

import { formatDay, shortNames } from './aggregate.mjs';

const MAX_COL = 44;

function periodWord(days) {
  if (days === 1) return 'daily';
  if (days === 7) return 'weekly';
  if (days === 14) return 'fortnightly';
  return `${days}-day`;
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function truncate(s, n) {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function widthOf(values) {
  return Math.min(MAX_COL, values.reduce((w, v) => Math.max(w, v.length), 0));
}

function areaPhrase(areas) {
  if (areas.length === 0) return null;
  const [first, second] = areas;
  if (!second || second.share < 15) return `mostly ${first.dir} (${first.share}%)`;
  return `${first.dir} (${first.share}%), ${second.dir} (${second.share}%)`;
}

function branchPhrase(branches) {
  if (branches.length === 0) return null;
  if (branches.length <= 2) return branches.join(', ');
  return `${branches.slice(0, 2).join(', ')} +${branches.length - 2} more`;
}

/**
 * @returns {{heading: string|null, lines: string[]}[]}
 */
export function compose(model, f, opts = {}) {
  const { includeHints = false, includeLink = false, link = null } = opts;
  const name = shortNames(model.people.map((p) => p.developer));
  const who = (dev) => name.get(dev) ?? dev;
  const title = `AgentMash ${periodWord(model.period.days)} digest${model.label ? ` · ${model.label}` : ''}`;
  const sections = [];

  if (model.quiet) {
    sections.push({
      heading: null,
      lines: [
        f.b(title),
        f.plain(`${model.period.label} — nothing recorded. No agent touched this repo.`),
      ],
    });
    return sections;
  }

  const t = model.totals;
  const headline =
    `${model.period.label} · ${plural(t.developers, 'person', 'people')} · ` +
    `${plural(t.edits, 'edit')} across ${plural(t.files, 'file')}`;
  sections.push({ heading: null, lines: [f.b(title), f.plain(headline)] });

  // A room with a handful of events gets the truth in three lines rather than a
  // set of empty section headings pretending to be a report.
  if (model.thin) {
    const lines = [
      f.plain(
        `A quiet ${model.period.days === 1 ? 'day' : 'period'}: too little activity to say anything about ` +
          `concentration or collisions. Everything that happened:`
      ),
    ];
    for (const person of model.people) {
      const detail = person.edits === 0
        ? `${plural(person.sessions, 'session')}, no edits`
        : `${plural(person.edits, 'edit')} · ${person.sample_files.join(', ')}`;
      lines.push(`${f.indent}${f.b(who(person.developer))}  ${f.plain(detail)}`);
    }
    sections.push({ heading: null, lines });
    return withFooter(sections, model, f, { includeLink, link, includeHints });
  }

  // --- who worked on what -------------------------------------------------
  {
    const width = widthOf(model.people.map((p) => who(p.developer)));
    const lines = model.people.map((person) => {
      const parts = [];
      if (person.edits === 0) {
        parts.push(`${plural(person.sessions, 'session')}, no edits landed`);
      } else {
        parts.push(`${plural(person.edits, 'edit')} in ${plural(person.files, 'file')}`);
        parts.push(`${person.days_active}d active`);
        const area = areaPhrase(person.areas);
        if (area) parts.push(area);
        const branch = branchPhrase(person.branches);
        if (branch) parts.push(branch);
      }
      let line = `${f.indent}${f.col(who(person.developer), width)}  ${f.plain(parts.join(' · '))}`;
      if (includeHints && person.latest_hint) {
        line += `\n${f.indent}${f.pad('', width)}  ${f.dim(`"${truncate(person.latest_hint, 110)}"`)}`;
      }
      return line;
    });
    sections.push({ heading: 'Who worked on what', lines });
  }

  // --- where work concentrated -------------------------------------------
  if (model.areas.length >= 2) {
    const width = widthOf(model.areas.map((a) => a.dir));
    sections.push({
      heading: 'Where work concentrated',
      lines: model.areas.map(
        (a) =>
          `${f.indent}${f.c(a.dir, width)}  ${f.plain(
            `${f.padStart(String(a.share), 2)}% · ${plural(a.edits, 'edit')} · ` +
              a.developers.map(who).join(', ')
          )}`
      ),
    });
  }

  // --- hot zones ----------------------------------------------------------
  {
    const th = model.thresholds;
    const rule =
      `${th.hot_min_devs}+ people, ${th.hot_min_edits}+ edits, ` +
      `two of them ${th.hot_window_hours}h apart or less`;
    const lines = [`${f.indent}${f.dim(rule)}`];
    if (model.hot_zones.length === 0) {
      lines.push(`${f.indent}${f.plain('Nothing qualified. Nobody was working on top of anybody else.')}`);
    } else {
      const label = (z) => (z.kind === 'dir' ? `${z.path}/` : z.path);
      const width = widthOf(model.hot_zones.map(label));
      for (const zone of model.hot_zones) {
        const status = zone.status === 'repeat' ? 'still hot from last period' : 'new this period';
        const scale =
          zone.kind === 'dir'
            ? `${plural(zone.edits, 'edit')} across ${plural(zone.files, 'file')}`
            : plural(zone.edits, 'edit');
        lines.push(
          `${f.indent}${f.c(label(zone), width)}  ${f.plain(
            `${zone.developers.map(who).join(', ')} · ${scale} · ${status}`
          )}`
        );
      }
      const dirZone = model.hot_zones.find((z) => z.kind === 'dir');
      if (dirZone) {
        lines.push(
          `${f.indent}${f.dim(`${dirZone.path}/ is a directory: no one file collided, but the boundary keeps drawing a crowd.`)}`
        );
      }
    }
    if (model.pairs.length > 0) {
      lines.push('');
      lines.push(`${f.indent}${f.b('Who keeps meeting whom')}`);
      for (const pair of model.pairs) {
        lines.push(
          `${f.indent}${f.plain(
            `${who(pair.a)} + ${who(pair.b)} — ${plural(pair.shared_files.length, 'shared file')}, ` +
              `last ${formatDay(pair.last_ts)}`
          )}`
        );
      }
    }
    sections.push({ heading: 'Hot zones', lines });
  }

  // --- stalled ------------------------------------------------------------
  {
    const lines = [];
    const branchWidth = widthOf(model.stalled.branches.map((b) => b.branch));
    for (const branch of model.stalled.branches) {
      lines.push(
        `${f.indent}${f.c(branch.branch, branchWidth)}  ${f.plain(
          `${branch.developers.map(who).join(', ')} · ${plural(branch.edits, 'edit')} · ` +
            `nothing since ${formatDay(branch.last_ts)} (${plural(branch.idle_days, 'day')})`
        )}`
      );
    }
    const dropped = model.stalled.dropped_sessions;
    if (dropped.length > 0) {
      const examples = dropped
        .slice(0, 3)
        .map((d) => `${who(d.developer)} ${formatDay(d.ts)}`)
        .join(', ');
      lines.push(
        `${f.indent}${f.plain(
          `${plural(dropped.length, 'session')} took a prompt and produced no edits: ${examples}` +
            (dropped.length > 3 ? ', ...' : '')
        )}`
      );
    }
    if (lines.length > 0) sections.push({ heading: 'Stalled', lines });
  }

  // --- comparison ---------------------------------------------------------
  {
    const c = model.comparison;
    const previous = `previous ${plural(model.period.days, 'day')}`;
    if (!c.available) {
      sections.push({
        heading: `Against the ${previous}`,
        lines: [`${f.indent}${f.plain('No activity recorded then, so there is nothing to compare against.')}`],
      });
    } else {
      const delta =
        c.edits_delta_pct === null
          ? 'was nothing'
          : `${c.edits_delta_pct >= 0 ? '+' : ''}${c.edits_delta_pct}%, was ${c.edits}`;
      const lines = [
        `${f.indent}${f.plain(
          `edits ${t.edits} (${delta}) · people ${t.developers} (was ${c.developers}) · ` +
            `hot zones ${model.hot_zones.length} (was ${c.hot_zones})`
        )}`,
      ];
      if (c.cooled.length > 0) {
        lines.push(`${f.indent}${f.plain(`cooled off: ${c.cooled.join(', ')}`)}`);
      }
      sections.push({ heading: `Against the ${previous}`, lines });
    }
  }

  return withFooter(sections, model, f, { includeLink, link, includeHints });
}

function withFooter(sections, model, f, { includeLink, link, includeHints }) {
  const lines = [];
  if (model.truncated) {
    lines.push(
      f.dim(
        'The window hit the read cap, so the oldest events in it were never fetched. ' +
          'Every count below is a floor, not a total.'
      )
    );
  }
  if (f.local && model.has_hints && !includeHints) {
    lines.push(f.dim('Prompt text withheld. Re-run with --include-hints to put it in the digest.'));
  }
  // the dashboard as the CLI worked it out (fetchDashboardLink): by the room's ref wherever a sign-in opens it
  if (includeLink && link) {
    lines.push(f.dim(link));
  }
  if (lines.length > 0) sections.push({ heading: null, lines });
  return sections;
}

// --- formatters -----------------------------------------------------------

const pad = (s, width) => (width ? s + ' '.repeat(Math.max(0, width - s.length)) : s);

/** Terminal / pipe. ANSI only when we are actually attached to a terminal. */
export function textFormatter({ color = false } = {}) {
  const bold = (s) => (color ? `[1m${s}[0m` : s);
  const dim = (s) => (color ? `[2m${s}[0m` : s);
  return {
    local: true,
    indent: '  ',
    plain: (s) => s,
    dim,
    b: (s) => bold(s),
    c: (s, width) => pad(s, width),
    col: (s, width) => bold(pad(s, width)),
    pad: (s, width) => pad(s, width),
    padStart: (s, width) => s.padStart(width),
  };
}

/** Slack mrkdwn: only &, < and > are special, and a backtick would end a code span. */
export function slackFormatter() {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return {
    local: false,
    indent: '',
    plain: esc,
    dim: (s) => `_${esc(s)}_`,
    b: (s) => `*${esc(s)}*`,
    c: (s) => `\`${esc(String(s).replace(/`/g, "'"))}\``,
    col: (s) => `*${esc(s)}*`,
    pad: (s) => s,
    padStart: (s) => s,
  };
}

/**
 * Telegram HTML. MarkdownV2 would need every one of _*[]()~`>#+-=|{}.! escaped
 * everywhere, including inside code spans, and a single stray dot in a filename
 * rejects the whole message. HTML has exactly three special characters.
 */
export function telegramFormatter() {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return {
    local: false,
    indent: '',
    plain: esc,
    dim: (s) => `<i>${esc(s)}</i>`,
    b: (s) => `<b>${esc(s)}</b>`,
    c: (s) => `<code>${esc(s)}</code>`,
    col: (s) => `<b>${esc(s)}</b>`,
    pad: (s) => s,
    padStart: (s) => s,
  };
}

// --- targets --------------------------------------------------------------

export function renderText(model, opts = {}) {
  const f = textFormatter(opts);
  const out = [];
  for (const section of compose(model, f, opts)) {
    if (section.heading) out.push(f.b(section.heading.toUpperCase()));
    out.push(...section.lines);
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function sectionTexts(model, f, opts) {
  return compose(model, f, opts).map((section) =>
    (section.heading ? [f.b(section.heading), ...section.lines] : section.lines).join('\n')
  );
}

const SLACK_BLOCK_CHARS = 2900;
const SLACK_MAX_BLOCKS = 48;

/** Block Kit payload. Long sections are split rather than silently dropped by Slack. */
export function renderSlack(model, opts = {}) {
  const f = slackFormatter();
  const [first, ...rest] = sectionTexts(model, f, opts);
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: truncate(headerText(model), 148), emoji: false },
    },
  ];
  for (const text of [first, ...rest]) {
    for (const chunk of splitToLength(text, SLACK_BLOCK_CHARS)) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
    }
  }
  if (blocks.length > SLACK_MAX_BLOCKS) {
    blocks.length = SLACK_MAX_BLOCKS;
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_digest truncated_' }] });
  }
  return { text: headerText(model), blocks };
}

const TELEGRAM_CHARS = 3800;

/** One or more sendMessage bodies; Telegram hard-rejects anything over 4096 characters. */
export function renderTelegram(model, opts = {}) {
  const f = telegramFormatter();
  const sections = sectionTexts(model, f, opts);
  const messages = [];
  let current = '';
  for (const section of sections) {
    for (const chunk of splitToLength(section, TELEGRAM_CHARS)) {
      if (current && current.length + chunk.length + 2 > TELEGRAM_CHARS) {
        messages.push(current);
        current = chunk;
      } else {
        current = current ? `${current}\n\n${chunk}` : chunk;
      }
    }
  }
  if (current) messages.push(current);
  return messages;
}

function headerText(model) {
  const label = model.label ? ` · ${model.label}` : '';
  return `AgentMash ${periodWord(model.period.days)} digest${label} — ${model.period.label}`;
}

/** Split on line boundaries where possible, and mid-line only when a line is itself too long. */
export function splitToLength(text, limit) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    let rest = line;
    while (rest.length > limit) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    if (current && current.length + 1 + rest.length > limit) {
      chunks.push(current);
      current = rest;
    } else {
      current = current ? `${current}\n${rest}` : rest;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * JSON is a pipe, and a pipe ends somewhere we can't see. It obeys the same
 * prompt-text rule as the chat targets: no hint unless one was asked for.
 */
function forJson(model, includeHints) {
  return {
    ...model,
    hints_included: includeHints,
    people: model.people.map(({ latest_hint, ...person }) =>
      includeHints ? { ...person, latest_hint } : person
    ),
  };
}

export function render(model, target, opts = {}) {
  switch (target) {
    case 'text':
      return renderText(model, opts);
    case 'json':
      return `${JSON.stringify(forJson(model, Boolean(opts.includeHints)), null, 2)}\n`;
    case 'slack':
      return renderSlack(model, opts);
    case 'telegram':
      return renderTelegram(model, opts);
    default:
      throw new Error(`unknown target: ${target}`);
  }
}
