// A TOML reader, read only and with no dependencies, for one job: to know what
// a Codex config.toml says before login appends anything to it, and that the
// file still reads after. It never writes TOML, so it has no opinion on how a
// file is laid out; what it keeps is every value, and which tables were
// written inline, which a header may never add to.
//
// TOML 1.0, plus what 1.1 relaxed (newlines and a trailing comma in an inline
// table, an \e escape, a time without seconds), since Codex reads with a
// parser that takes both. Dates and times come back as their text. Anything a
// TOML parser has to refuse is refused here too, as a thrown Error that says
// where: a key or a table defined twice, a header over a table dotted keys or
// an inline table made, a value that is no value. Refusing more than Codex
// would only ever costs a skipped append; accepting less would cost a file.

const BARE = /[A-Za-z0-9_-]/;
const DEC = '(?:0|[1-9](?:_?[0-9])*)';
const DIGITS = '[0-9](?:_?[0-9])*';
const INTEGER = new RegExp(`^[+-]?${DEC}$`);
const FLOAT = new RegExp(`^[+-]?${DEC}(?:\\.${DIGITS})?(?:[eE][+-]?${DIGITS})?$`);
const DATE_TIME = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/;
const TIME = /^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };

const isTable = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Read `text` as TOML: `{ value, isInline }`, where `value` is the document as
 * plain objects and arrays and `isInline(table)` says whether a table was
 * written inline ({ ... }). Throws an Error naming the line for anything that
 * is not valid TOML.
 */
export function parseToml(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  let i = 0;
  const root = {};
  /** How each table came to be: root, implicit (a header's parent), explicit (its own header), dotted, inline. */
  const kinds = new Map([[root, 'root']]);
  const inline = new WeakSet();
  const arraysOfTables = new WeakSet();
  let current = root;

  const fail = (why) => {
    throw new Error(`line ${src.slice(0, i).split('\n').length}: ${why}`);
  };
  const skipWs = () => {
    while (src[i] === ' ' || src[i] === '\t') i++;
  };
  const skipComment = () => {
    if (src[i] === '#') while (i < src.length && src[i] !== '\n') i++;
  };
  const atEol = () => i >= src.length || src[i] === '\n' || (src[i] === '\r' && src[i + 1] === '\n');
  /** Whitespace, comments and newlines: between the lines of a document, or of an array. */
  const skipWsNl = () => {
    for (;;) {
      skipWs();
      skipComment();
      if (src[i] === '\n') i += 1;
      else if (src[i] === '\r' && src[i + 1] === '\n') i += 2;
      else return;
    }
  };
  const endLine = () => {
    skipWs();
    skipComment();
    if (!atEol()) fail('expected the end of the line');
    if (src[i] === '\r') i += 2;
    else if (src[i] === '\n') i += 1;
  };

  function escape() {
    const c = src[i + 1];
    if (c !== undefined && Object.hasOwn(ESCAPES, c)) {
      i += 2;
      return ESCAPES[c];
    }
    if (c === 'u' || c === 'U') {
      const n = c === 'u' ? 4 : 8;
      const hex = src.slice(i + 2, i + 2 + n);
      if (hex.length !== n || !/^[0-9A-Fa-f]+$/.test(hex)) fail(`\\${c} needs ${n} hex digits`);
      const code = parseInt(hex, 16);
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail(`\\${c}${hex} is not a Unicode scalar value`);
      i += 2 + n;
      return String.fromCodePoint(code);
    }
    return fail(`\\${c ?? ''} is not an escape`);
  }

  function basicString() {
    i += 1;
    let out = '';
    for (;;) {
      const c = src[i];
      if (c === undefined || c === '\n' || c === '\r') fail('a string is not closed on its line');
      if (c === '"') {
        i += 1;
        return out;
      }
      if (c === '\\') out += escape();
      else {
        out += c;
        i += 1;
      }
    }
  }

  function literalString() {
    i += 1;
    const end = src.indexOf("'", i);
    const newline = src.indexOf('\n', i);
    if (end === -1 || (newline !== -1 && newline < end)) fail('a string is not closed on its line');
    const out = src.slice(i, end);
    i = end + 1;
    return out;
  }

  /** The newline straight after an opening """ or ''' is not part of the string. */
  const skipFirstNewline = () => {
    if (src[i] === '\n') i += 1;
    else if (src[i] === '\r' && src[i + 1] === '\n') i += 2;
  };

  function multiBasic() {
    i += 3;
    skipFirstNewline();
    let out = '';
    for (;;) {
      if (i >= src.length) fail('a multi-line string is not closed');
      if (src.startsWith('"""', i)) {
        // up to two more quotes are the string's own: """a"""" is a"
        let quotes = 3;
        while (src[i + quotes] === '"' && quotes < 5) quotes += 1;
        i += quotes;
        return out + '"'.repeat(quotes - 3);
      }
      if (src[i] === '\\') {
        // a backslash ending a line trims the newlines and spaces after it
        let j = i + 1;
        while (src[j] === ' ' || src[j] === '\t') j += 1;
        if (src[j] === '\n' || (src[j] === '\r' && src[j + 1] === '\n')) {
          i = j;
          while (i < src.length && /[ \t\r\n]/.test(src[i])) i += 1;
          continue;
        }
        out += escape();
        continue;
      }
      out += src[i];
      i += 1;
    }
  }

  function multiLiteral() {
    i += 3;
    skipFirstNewline();
    const end = src.indexOf("'''", i);
    if (end === -1) fail('a multi-line string is not closed');
    let quotes = 3;
    while (src[end + quotes] === "'" && quotes < 5) quotes += 1;
    const out = src.slice(i, end) + "'".repeat(quotes - 3);
    i = end + quotes;
    return out;
  }

  function key() {
    const parts = [];
    for (;;) {
      skipWs();
      if (src.startsWith('"""', i) || src.startsWith("'''", i)) fail('a key cannot be a multi-line string');
      if (src[i] === '"') parts.push(basicString());
      else if (src[i] === "'") parts.push(literalString());
      else {
        const start = i;
        while (i < src.length && BARE.test(src[i])) i += 1;
        if (i === start) fail('expected a key');
        parts.push(src.slice(start, i));
      }
      skipWs();
      if (src[i] !== '.') return parts;
      i += 1;
    }
  }

  function array() {
    i += 1;
    const out = [];
    for (;;) {
      skipWsNl();
      if (src[i] === ']') {
        i += 1;
        return out;
      }
      out.push(value());
      skipWsNl();
      if (src[i] === ',') i += 1;
      else if (src[i] === ']') {
        i += 1;
        return out;
      } else fail('expected , or ] in an array');
    }
  }

  function freeze(table) {
    inline.add(table);
    for (const v of Object.values(table)) {
      if (isTable(v)) freeze(v);
    }
  }

  function inlineTable() {
    i += 1;
    const table = {};
    kinds.set(table, 'inline');
    skipWsNl();
    if (src[i] === '}') {
      i += 1;
      freeze(table);
      return table;
    }
    for (;;) {
      skipWsNl();
      const parts = key();
      if (src[i] !== '=') fail('expected = in an inline table');
      i += 1;
      skipWs();
      assign(table, parts, value());
      skipWsNl();
      if (src[i] === ',') {
        i += 1;
        skipWsNl();
        if (src[i] !== '}') continue;
      }
      if (src[i] === '}') {
        i += 1;
        freeze(table);
        return table;
      }
      fail('expected , or } in an inline table');
    }
  }

  function value() {
    if (src.startsWith('"""', i)) return multiBasic();
    if (src[i] === '"') return basicString();
    if (src.startsWith("'''", i)) return multiLiteral();
    if (src[i] === "'") return literalString();
    if (src[i] === '[') return array();
    if (src[i] === '{') return inlineTable();
    let token = /^[^\s,\]}#]+/.exec(src.slice(i))?.[0];
    if (!token) return fail('expected a value');
    // a date and a time may be written with a space between them
    if (/^\d{4}-\d{2}-\d{2}$/.test(token) && src[i + token.length] === ' ' && /^\d{2}:/.test(src.slice(i + token.length + 1))) {
      token += ` ${/^[^\s,\]}#]+/.exec(src.slice(i + token.length + 1))[0]}`;
    }
    i += token.length;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (/^[+-]?inf$/.test(token)) return token.startsWith('-') ? -Infinity : Infinity;
    if (/^[+-]?nan$/.test(token)) return NaN;
    if (/^0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*$/.test(token)) return parseInt(token.slice(2).replace(/_/g, ''), 16);
    if (/^0o[0-7](?:_?[0-7])*$/.test(token)) return parseInt(token.slice(2).replace(/_/g, ''), 8);
    if (/^0b[01](?:_?[01])*$/.test(token)) return parseInt(token.slice(2).replace(/_/g, ''), 2);
    if (INTEGER.test(token)) return Number(token.replace(/_/g, ''));
    if (FLOAT.test(token) && /[.eE]/.test(token)) return Number(token.replace(/_/g, ''));
    if (DATE_TIME.test(token) || TIME.test(token)) return token;
    return fail(`${token} is not a value`);
  }

  /** `parts = value` into `table`: dotted keys make tables of their own, which only more dotted keys may add to. */
  function assign(table, parts, v) {
    let t = table;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(t, part)) {
        const sub = {};
        kinds.set(sub, 'dotted');
        t[part] = sub;
        t = sub;
        continue;
      }
      const next = t[part];
      if (!isTable(next) || inline.has(next) || kinds.get(next) !== 'dotted') fail(`${parts.join('.')}: ${part} is already defined`);
      t = next;
    }
    const last = parts[parts.length - 1];
    if (Object.hasOwn(t, last)) fail(`${parts.join('.')} is defined twice`);
    t[last] = v;
  }

  function header(ofArray) {
    i += ofArray ? 2 : 1;
    const parts = key();
    if (ofArray ? !src.startsWith(']]', i) : src[i] !== ']') fail(`expected ${ofArray ? ']]' : ']'}`);
    i += ofArray ? 2 : 1;
    endLine();
    const name = parts.join('.');
    let t = root;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(t, part)) {
        const sub = {};
        kinds.set(sub, 'implicit');
        t[part] = sub;
        t = sub;
        continue;
      }
      let next = t[part];
      if (Array.isArray(next) && arraysOfTables.has(next)) next = next[next.length - 1];
      if (!isTable(next) || inline.has(next)) fail(`[${name}]: ${part} is not a table that can be added to`);
      t = next;
    }
    const last = parts[parts.length - 1];
    if (ofArray) {
      if (!Object.hasOwn(t, last)) {
        const list = [];
        arraysOfTables.add(list);
        t[last] = list;
      }
      const list = t[last];
      if (!Array.isArray(list) || !arraysOfTables.has(list)) fail(`[[${name}]] is already defined, and not as an array of tables`);
      const entry = {};
      kinds.set(entry, 'explicit');
      list.push(entry);
      current = entry;
      return;
    }
    if (!Object.hasOwn(t, last)) {
      const sub = {};
      kinds.set(sub, 'explicit');
      t[last] = sub;
      current = sub;
      return;
    }
    const existing = t[last];
    if (isTable(existing) && kinds.get(existing) === 'implicit') {
      kinds.set(existing, 'explicit');
      current = existing;
      return;
    }
    fail(`[${name}] is defined twice`);
  }

  for (;;) {
    skipWsNl();
    if (i >= src.length) break;
    if (src[i] === '[') {
      header(src[i + 1] === '[');
      continue;
    }
    const parts = key();
    if (src[i] !== '=') fail('expected =');
    i += 1;
    skipWs();
    if (atEol()) fail(`${parts.join('.')} has no value`);
    assign(current, parts, value());
    endLine();
  }
  return { value: root, isInline: (table) => inline.has(table) };
}
