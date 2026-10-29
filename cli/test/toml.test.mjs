// The read-only TOML parser login uses before it touches Codex's config.toml:
// it has to accept every config a person can write, and refuse every one
// Codex itself would refuse, since "it still parses" is what decides whether
// login may append to the file at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToml } from '../toml.mjs';

const ok = (text) => parseToml(text).value;
const bad = (text, why) => assert.throws(() => parseToml(text), undefined, why ?? text);

test('the shapes a config.toml is written in', () => {
  assert.deepEqual(
    ok(`# a comment
model = "gpt-5.5-codex"   # trailing comment
approval_policy = 'on-request'
"quoted key" = 1
bare-key_2 = +1_000
`),
    { model: 'gpt-5.5-codex', approval_policy: 'on-request', 'quoted key': 1, 'bare-key_2': 1000 }
  );
  const v = ok(`
[features]
hooks = true
web = false

[mcp_servers.node_repl]
command = "/usr/bin/node"
args = []
startup_timeout_sec = 120
tool_timeout = 1.5e2

[mcp_servers.node_repl.env]
PATH = "/bin:/usr/bin"
"quoted.name" = "x"

[projects."/Users/someone/app"]
trust_level = "trusted"

[[hooks.PreToolUse]]
matcher = "^Bash$"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "python3 hook.py"
timeout = 30

[hooks.state."/Users/someone/.codex/hooks.json:pre_tool_use:0:0"]
trusted_hash = "sha256:abc"
`);
  assert.equal(v.features.hooks, true);
  assert.deepEqual(v.mcp_servers.node_repl.args, []);
  assert.equal(v.mcp_servers.node_repl.tool_timeout, 150);
  assert.equal(v.mcp_servers.node_repl.env['quoted.name'], 'x');
  assert.equal(v.projects['/Users/someone/app'].trust_level, 'trusted');
  assert.equal(v.hooks.PreToolUse[0].hooks[0].command, 'python3 hook.py');
  assert.equal(v.hooks.state['/Users/someone/.codex/hooks.json:pre_tool_use:0:0'].trusted_hash, 'sha256:abc');
});

test('values of every kind', () => {
  const v = ok(`
s1 = "tab\\tquote\\" unicode \\u00e9 \\U0001F600"
s2 = 'C:\\path\\no\\escapes'
s3 = """
first
second \\
   joined"""
s4 = '''
raw \\n stays'''
ints = [1, +2, -3, 1_000, 0xdead_beef, 0o755, 0b1010]
floats = [3.14, -0.5, 5e+22, 1e6, 6.626e-34, inf, -inf, nan]
dates = [1979-05-27T07:32:00Z, 1979-05-27T00:32:00.999999-07:00, 1979-05-27 07:32:00, 1979-05-27, 07:32:00]
nested = [ [1, 2], ["a", 'b'], [ {x = 1}, {y = 2} ], ]
multi = [
  "one",   # a comment in an array
  "two",
]
inline = { name = "x", deep.key = 1, list = [1, 2] }
`);
  assert.equal(v.s1, 'tab\tquote" unicode é 😀');
  assert.equal(v.s2, 'C:\\path\\no\\escapes');
  assert.equal(v.s3, 'first\nsecond joined');
  assert.equal(v.s4, 'raw \\n stays');
  assert.deepEqual(v.ints, [1, 2, -3, 1000, 0xdeadbeef, 0o755, 10]);
  assert.equal(v.floats[0], 3.14);
  assert.equal(v.floats[5], Infinity);
  assert.ok(Number.isNaN(v.floats[7]));
  assert.equal(v.dates.length, 5);
  assert.deepEqual(v.nested[2], [{ x: 1 }, { y: 2 }]);
  assert.deepEqual(v.multi, ['one', 'two']);
  assert.deepEqual(v.inline, { name: 'x', deep: { key: 1 }, list: [1, 2] });
});

test('dotted keys and inline tables are the forms login has to see before it appends a table', () => {
  const dotted = parseToml('mcp_servers.agentmash.command = "node"\n');
  assert.equal(dotted.value.mcp_servers.agentmash.command, 'node');
  const inline = parseToml('mcp_servers = { github = { command = "gh" } }\n');
  assert.ok(inline.isInline(inline.value.mcp_servers), 'an inline table is told apart');
  const within = parseToml('[mcp_servers]\nagentmash = { command = "node" }\n');
  assert.ok(within.isInline(within.value.mcp_servers.agentmash));
  assert.ok(!within.isInline(within.value.mcp_servers));
});

test('everything Codex would refuse is refused', () => {
  bad('a = 1\na = 2\n', 'a key defined twice');
  bad('[a]\nx = 1\n[a]\ny = 2\n', 'a table defined twice');
  bad('mcp_servers.agentmash.command = "node"\n[mcp_servers.agentmash]\nargs = []\n', 'a table its dotted keys defined, then a header');
  bad('mcp_servers = { github = {} }\n[mcp_servers.agentmash]\ncommand = "node"\n', 'a table added to an inline one');
  bad('[mcp_servers]\nagentmash = { command = "node" }\n[mcp_servers.agentmash]\nargs = []\n', 'an inline table, then a header for it');
  bad('a = [1, 2]\n[[a]]\n', 'an array of tables over a plain array');
  bad('a = "unterminated\n');
  bad('a = """never closed\n');
  bad('a = \n');
  bad('= 1\n');
  bad('a = 1 b = 2\n', 'two key-values on one line');
  bad('[a\n');
  bad('a = 01\n', 'a leading zero');
  bad('a = 1__0\n');
  bad('a = "\\x"\n', 'an escape TOML has not got');
  bad('a = { b = 1, b = 2 }\n');
  bad('[a.b]\nc = 1\n[a]\nb.d = 2\n', 'dotted keys into a table a header defined');
});

test('a header may name a table its children made first, once', () => {
  const v = ok('[a.b.c]\nx = 1\n[a]\ny = 2\n[a.b]\nz = 3\n');
  assert.deepEqual(v, { a: { b: { c: { x: 1 }, z: 3 }, y: 2 } });
  bad('[a.b.c]\n[a.b]\n[a.b]\n');
});
