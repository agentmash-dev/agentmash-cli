// Two edits the check before an edit used to miss, both found by the benchmark in
// agentmash-dev/agentmash-bench:
//
// - a Bash command that writes files (`sed -i`, a heredoc into a file, a python3
//   script that opens one for writing). Claude Code allowed to run any command
//   edits that way, no edit tool names the file, and the check never ran.
// - a new file. It has no imports on disk to read, so a teammate's change to a
//   name it is about to import never reached it; its imports are in the text
//   the Write (or a patch's Add File) is about to give it.
//
// Against a real throwaway repository and a room that records what it was asked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HOLDER, KEY, baseEnv, runHook, session, startServer, timed } from './fixtures.mjs';
import { filesACommandWrites, newFileSource } from '../lib.mjs';

const EMPTY_GITCONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-command-git-')), 'gitconfig');
fs.writeFileSync(EMPTY_GITCONFIG, '');
const gitEnv = { GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG, GIT_CONFIG_NOSYSTEM: '1' };

function writeFile(dir, rel, content) {
  const target = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

/** A committed repository: src/models/user.ts exports createUser, src/api/handlers.ts imports it. */
function repository() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-command-')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: { ...baseEnv, ...gitEnv }, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'bob@example.com');
  git('config', 'user.name', 'bob');
  writeFile(dir, 'src/models/user.ts', 'export function createUser(email: string) {\n  return { email };\n}\n');
  writeFile(dir, 'src/api/handlers.ts', "import { createUser } from '../models/user';\n\nexport const post = () => createUser('a@b.c');\n");
  writeFile(dir, 'README.md', '# app\n');
  writeFile(dir, 'node_modules/dep/index.js', 'module.exports = 1;\n');
  writeFile(dir, '.gitignore', 'node_modules/\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

function env(repo, port) {
  return {
    AGENTMASH_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-command-home-')),
    AGENTMASH_URL: `http://127.0.0.1:${port}`,
    AGENTMASH_ROOM: KEY,
    AGENTMASH_DEV: 'bob',
    CLAUDE_PROJECT_DIR: repo,
    ...gitEnv,
  };
}

const bash = (repo, sessionId, command) => ({
  session_id: sessionId,
  cwd: repo,
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command, description: 'edit a file' },
});

const checked = (room) => room.requests.filter((r) => r.path === '/check').map((r) => r.query.file_path);

const PYTHON_EDIT = [
  "python3 - <<'E'",
  "p='src/models/user.ts'",
  's=open(p).read()',
  "open(p,'w').write(s.replace('email: string', 'email: string, name: string'))",
  'E',
].join('\n');

// A whole change in one command, as Claude Code allowed every command writes it (the
// benchmark's p09-async): new files from cat heredocs, their TypeScript full of `=>`,
// then a python3 heredoc that edits a file a teammate changed.
const HEREDOC_CHANGE = [
  "cat > src/services/search.ts <<'EOF'",
  "import type { Task } from '../domain/task.ts';",
  '',
  'export function searchTasks(store: Store, query: string): Task[] {',
  '  const wanted = query.trim().toLowerCase();',
  '  if (!wanted) return [];',
  '  const archived = new Set(store.listProjects().filter((project) => project.archived).map((project) => project.id));',
  '  return store',
  '    .listTasks()',
  '    .filter(',
  '      (task) =>',
  '        !archived.has(task.projectId) &&',
  '        (task.title.toLowerCase().includes(wanted) || task.tags.some((tag) => tag.toLowerCase() === wanted)),',
  '    );',
  '}',
  'EOF',
  "cat > src/api/search.ts <<'EOF'",
  "import { searchTasks } from '../services/search.ts';",
  '',
  "export const getSearch: Handler = (store, req) => ok(searchTasks(store, req.query.q ?? '').map(taskJson));",
  'EOF',
  "python3 - <<'EOF'",
  "p='src/models/user.ts'",
  's=open(p).read()',
  "s=s.replace('email: string', 'email: string, name: string')",
  "open(p,'w').write(s)",
  'EOF',
  "cat > test/search.test.ts <<'EOF'",
  "test('search', () => {",
  "  assert.deepEqual(searchTasks(store, 'e').map((t) => t.id), [copy.id]);",
  '  assert.ok(results.length >= 0);',
  '});',
  'EOF',
  'npm run check 2>&1 | tail -15',
].join('\n');

test('filesACommandWrites: the files a command writes, by what its text says', () => {
  const repo = repository();
  // each file relative to the repository, with / between its folders as on POSIX (path.relative says \ on Windows)
  const files = (command, cwd = repo) => filesACommandWrites(command, { cwd, projectDir: repo }).map((f) => path.relative(repo, f).split(path.sep).join('/'));
  // a script that opens a file to write, in Python or Node
  assert.deepEqual(files(PYTHON_EDIT), ['src/models/user.ts']);
  assert.deepEqual(files(`node -e "require('fs').writeFileSync('src/api/handlers.ts', 'x')"`), ['src/api/handlers.ts']);
  // in-place editors, every file they name that is there
  assert.deepEqual(files("sed -i '' 's/a/b/' src/models/user.ts src/api/handlers.ts"), ['src/models/user.ts', 'src/api/handlers.ts']);
  assert.deepEqual(files("perl -pi -e 's/a/b/' README.md"), ['README.md']);
  // a redirect or tee writes its target, there yet or not
  assert.deepEqual(files("cat > src/api/new.ts <<'EOF'\nexport const a = 1;\nEOF"), ['src/api/new.ts']);
  assert.deepEqual(files('echo "# hi" >> README.md'), ['README.md']);
  assert.deepEqual(files('printf x | tee -a docs/notes.md'), ['docs/notes.md']);
  // a move names the file it takes away
  assert.deepEqual(files('git mv src/models/user.ts src/models/person.ts'), ['src/models/user.ts']);
  // relative to the command's folder
  assert.deepEqual(files("sed -i '' 's/a/b/' user.ts", path.join(repo, 'src/models')), ['src/models/user.ts']);
});

test('filesACommandWrites reads a long command in time linear in its length', () => {
  const repo = repository();
  // a long here-string piped into Set-Content, or a long word after cp: a run with no slash or dot
  // in it once took seconds of the hook's 5 s, every start of the run tried again
  const long = 'a'.repeat(60_000);
  for (const [command, shell] of [
    [`Set-Content x ${long}`, 'powershell'],
    [`cp x ${long}`, 'bash'],
    // and 20,000 `<<` that no line ends, each looked for once
    [Array.from({ length: 20_000 }, (_, i) => `x <<w${i}`).join('\n'), 'bash'],
  ]) {
    const { ms, limit, value } = timed(1000, () => filesACommandWrites(command, { cwd: repo, projectDir: repo, shell }));
    assert.deepEqual(value, []);
    assert.ok(ms < limit, `${shell}: ${Math.round(ms)} ms`);
  }
  // and what it finds in one is what it found before
  assert.deepEqual(
    filesACommandWrites(`cp ${'b'.repeat(60_000)} src/models/user.ts`, { cwd: repo, projectDir: repo }).map((f) => path.relative(repo, f).split(path.sep).join('/')),
    ['src/models/user.ts']
  );
});

test('filesACommandWrites: git checkout writes the files it names, from Bash and PowerShell alike', () => {
  const repo = repository();
  const files = (command, shell = 'bash') =>
    filesACommandWrites(command, { cwd: repo, projectDir: repo, shell }).map((f) => path.relative(repo, f).split(path.sep).join('/'));
  for (const shell of ['bash', 'powershell']) {
    assert.deepEqual(files('git checkout -- src/models/user.ts', shell), ['src/models/user.ts'], shell);
    assert.deepEqual(files('git checkout HEAD~1 -- src/models/user.ts README.md', shell), ['src/models/user.ts', 'README.md'], shell);
    assert.deepEqual(files('git checkout src/api/handlers.ts', shell), ['src/api/handlers.ts'], shell);
    // a branch is no file here
    assert.deepEqual(files('git checkout -b feature/soft-deletes', shell), [], shell);
    assert.deepEqual(files('git checkout main', shell), [], shell);
  }
  assert.deepEqual(files('git checkout -- src\\models\\user.ts', 'powershell'), ['src/models/user.ts']);
});

test('filesACommandWrites: a command that only reads writes nothing, and nothing outside the repository counts', () => {
  const repo = repository();
  const files = (command) => filesACommandWrites(command, { cwd: repo, projectDir: repo });
  for (const command of [
    'cat src/models/user.ts',
    'grep -n createUser src/api/handlers.ts | head',
    'npm test 2>&1 | tail -3',
    'git diff HEAD -- src/models/user.ts > /dev/null',
    'node --test test/a.test.ts 2>&1',
    'ls -la src; wc -l src/models/user.ts',
  ]) {
    assert.deepEqual(files(command), [], command);
  }
  // writes outside the repository, or into what git never merges here
  assert.deepEqual(files('grep -rn x src > /tmp/out.txt'), []);
  assert.deepEqual(files("sed -i '' 's/a/b/' node_modules/dep/index.js"), []);
  assert.deepEqual(files("sed -i '' 's/a/b/' ../elsewhere/file.ts"), []);
  // and nothing throws on what is not a command
  for (const value of [undefined, null, 42, {}, '']) assert.deepEqual(filesACommandWrites(value, { cwd: repo }), []);
});

test('filesACommandWrites: a PowerShell command, in its own words and with backslashes', () => {
  const repo = repository();
  const files = (command, cwd = repo) =>
    filesACommandWrites(command, { cwd, projectDir: repo, shell: 'powershell' }).map((f) => path.relative(repo, f).split(path.sep).join('/'));
  assert.deepEqual(files("(Get-Content src\\models\\user.ts) -replace 'email', 'mail' | Set-Content src\\models\\user.ts"), ['src/models/user.ts']);
  assert.deepEqual(files("Set-Content -Path .\\src\\api\\handlers.ts -Value 'x'"), ['src/api/handlers.ts']);
  assert.deepEqual(files('"# hi" | Out-File -FilePath README.md -Encoding utf8'), ['README.md']);
  assert.deepEqual(files('add-content README.md "more"'), ['README.md'], 'any case');
  assert.deepEqual(files('Copy-Item src/models/user.ts src/models/person.ts'), ['src/models/user.ts']);
  assert.deepEqual(files("[IO.File]::WriteAllText('src/models/user.ts', $text)"), ['src/models/user.ts']);
  assert.deepEqual(files('ri .\\README.md'), ['README.md'], 'an alias');
  // a redirect writes its target, there yet or not; $null is nowhere
  assert.deepEqual(files("'export const a = 1;' > src\\api\\new.ts"), ['src/api/new.ts']);
  assert.deepEqual(files('npm test *> $null'), []);
  // and a variable's is wherever the variable says, which the text does not: no file of the repository
  assert.deepEqual(files('git log --oneline > $env:TEMP\\log.txt'), []);
  assert.deepEqual(files('npm test | Tee-Object -FilePath x.log > "$OUT"'), []);
  assert.deepEqual(filesACommandWrites('git log > $TMPDIR/log.txt', { cwd: repo, projectDir: repo }), [], 'from Bash too');
  // a script it starts, read as from Bash
  assert.deepEqual(files(`python -c "open('src/models/user.ts','w').write('x')"`), ['src/models/user.ts']);
  // relative to the command's folder
  assert.deepEqual(files('Set-Content user.ts x', path.join(repo, 'src', 'models')), ['src/models/user.ts']);
  // and what only reads, or writes outside the repository, is nothing
  for (const command of [
    'Get-Content src\\models\\user.ts',
    'Select-String -Path src\\api\\handlers.ts -Pattern createUser',
    'npm test 2>&1 | Select-Object -Last 5',
    'Get-ChildItem src -Recurse | Measure-Object',
    'Write-Host "copy done"; git status',
    "Set-Content -Path ..\\elsewhere\\file.ts -Value 'x'",
    "Set-Content node_modules\\dep\\index.js 'x'",
  ]) {
    assert.deepEqual(files(command), [], command);
  }
  // Bash's words stay Bash's: Set-Content is no Bash command
  assert.deepEqual(filesACommandWrites('Set-Content src/models/user.ts x', { cwd: repo, projectDir: repo }), []);
});

test('filesACommandWrites reads a bounded number of files from one command', () => {
  const repo = repository();
  for (let i = 0; i < 20; i++) writeFile(repo, `gen/f${i}.ts`, 'export const x = 1;\n');
  const many = `sed -i '' 's/1/2/' ${Array.from({ length: 20 }, (_, i) => `gen/f${i}.ts`).join(' ')}`;
  assert.equal(filesACommandWrites(many, { cwd: repo, projectDir: repo }).length, 8);
});

test('filesACommandWrites: a heredoc is what a file or a script gets, not more of the command', () => {
  const repo = repository();
  const files = (command) => filesACommandWrites(command, { cwd: repo, projectDir: repo }).map((f) => path.relative(repo, f).split(path.sep).join('/'));
  // the file the python3 script edits, though the TypeScript before it holds more `>` than the list holds names;
  // a file there now first, then the ones the command makes, in its order
  assert.deepEqual(files(HEREDOC_CHANGE), ['src/models/user.ts', 'src/services/search.ts', 'src/api/search.ts', 'test/search.test.ts']);
  // `=>`, `->` and `>=` in a script on the command line are no redirects either
  assert.deepEqual(files(`node -e "const ok = [1].filter((n) => n >= 0); console.log(ok)"`), []);
  // a heredoc fed to a shell is more commands
  assert.deepEqual(files("bash <<'SH'\necho '# hi' >> README.md\nSH"), ['README.md']);
  // and a << that no line ends is no heredoc: what follows it is still the command
  assert.deepEqual(files(`python3 -c "print(1 << shift)"\necho x > src/api/new.ts`), ['src/api/new.ts']);
  // nor is a here-string
  assert.deepEqual(files(`python3 <<< "open('src/models/user.ts','w').write('x')"`), ['src/models/user.ts']);
});

test('filesACommandWrites: a file there now is read before the files a command makes, past the bound', () => {
  const repo = repository();
  const many = Array.from({ length: 10 }, (_, i) => `echo ${i} > gen/f${i}.ts`).join('\n');
  const files = filesACommandWrites(`mkdir -p gen\n${many}\n${PYTHON_EDIT}`, { cwd: repo, projectDir: repo });
  assert.equal(files.length, 8);
  assert.equal(path.relative(repo, files[0]).split(path.sep).join('/'), 'src/models/user.ts');
});

test('newFileSource: the text a new file is about to have, from a Write or a patch', () => {
  const repo = repository();
  const fresh = path.join(repo, 'src/api/new.ts');
  const content = "import { createUser } from '../models/user';\n";
  assert.equal(newFileSource(fresh, 'Write', { file_path: fresh, content }), content);
  const patch = ['*** Begin Patch', '*** Add File: src/api/new.ts', `+${content.trim()}`, '+export const x = 1;', '*** End Patch'].join('\n');
  assert.equal(newFileSource(fresh, 'apply_patch', { command: patch }, { cwd: repo }), `${content.trim()}\nexport const x = 1;\n`);
  // a file on disk is read where it is, and an update or another file's add says nothing about this one
  assert.equal(newFileSource(path.join(repo, 'src/models/user.ts'), 'Write', { content }), null);
  const other = patch.replace('src/api/new.ts', 'src/api/other.ts');
  assert.equal(newFileSource(fresh, 'apply_patch', { command: other }, { cwd: repo }), null);
  assert.equal(newFileSource(path.join(repo, 'notes.md'), 'Write', { content: 'x' }), null, 'no symbols outside JS and TS');
  assert.equal(newFileSource(fresh, 'Write', null), null);
});

test('newFileSource: the text a Bash heredoc writes into a new file', () => {
  const repo = repository();
  const fresh = path.join(repo, 'src/api/new.ts');
  const content = "import { createUser } from '../models/user';\nexport const make = (email) => createUser(email);";
  const source = (command) => newFileSource(fresh, 'Bash', { command }, { cwd: repo, shell: 'bash' });
  assert.equal(source(`cat > src/api/new.ts <<'EOF'\n${content}\nEOF`), `${content}\n`);
  assert.equal(source(`mkdir -p src/api && cat <<EOF > src/api/new.ts\n${content}\nEOF\nnpm test`), `${content}\n`);
  assert.equal(source(`tee src/api/new.ts > /dev/null <<-'EOF'\n${content}\n\tEOF`), `${content}\n`);
  // among other heredocs, the one this file gets
  assert.equal(source(`${HEREDOC_CHANGE}\ncat > src/api/new.ts <<'TS'\n${content}\nTS`), `${content}\n`);
  // a heredoc another file gets, a script's, or one in a commit message says nothing about this one
  assert.equal(source(`cat > src/api/other.ts <<'EOF'\n${content}\nEOF`), null);
  assert.equal(source(`python3 - <<'EOF'\nopen('src/api/new.ts', 'w').write('x')\nEOF`), null);
  assert.equal(source(`git commit -F - <<'EOF'\n${content}\nEOF`), null);
  // nor does a command read as anything but Bash, or a file there already
  assert.equal(newFileSource(fresh, 'Bash', { command: `cat > src/api/new.ts <<'EOF'\n${content}\nEOF` }, { cwd: repo }), null);
  assert.equal(newFileSource(path.join(repo, 'src/models/user.ts'), 'Bash', { command: `cat > src/models/user.ts <<'EOF'\n${content}\nEOF` }, { cwd: repo, shell: 'bash' }), null);
});

test('before a Bash command writes a file a teammate changed, the room is asked and the agent told', async () => {
  const room = await startServer({ holders: [HOLDER] });
  const repo = repository();
  try {
    const pre = await runHook('pre_tool_use.mjs', bash(repo, session(), PYTHON_EDIT), env(repo, room.port));
    assert.equal(pre.code, 0);
    assert.equal(pre.stderr, '');
    assert.deepEqual(checked(room), ['src/models/user.ts']);
    const out = JSON.parse(pre.stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, 'PreToolUse');
    assert.equal(out.permissionDecision, undefined, 'advice, not a refusal');
    assert.match(out.additionalContext, /alice's agent/);
    assert.match(out.additionalContext, /src\/models\/user\.ts/);
  } finally {
    await room.close();
  }
});

test('before one long heredoc command writes a file a teammate changed, the room is asked about it', async () => {
  const room = await startServer({ holders: [HOLDER] });
  const repo = repository();
  try {
    const pre = await runHook('pre_tool_use.mjs', bash(repo, session(), HEREDOC_CHANGE), env(repo, room.port));
    assert.equal(pre.code, 0);
    assert.equal(pre.stderr, '');
    assert.ok(checked(room).includes('src/models/user.ts'), checked(room).join(', '));
    assert.match(JSON.parse(pre.stdout).hookSpecificOutput.additionalContext, /alice's agent/);
  } finally {
    await room.close();
  }
});

test('before a PowerShell command writes a file a teammate changed, the room is asked and the agent told', async () => {
  const room = await startServer({ holders: [HOLDER] });
  const repo = repository();
  try {
    // Claude Code's PowerShell tool: Bash's input, the command in `command`
    const command = "(Get-Content src\\models\\user.ts) -replace 'email: string', 'email: string, name: string' | Set-Content src\\models\\user.ts";
    const pre = await runHook('pre_tool_use.mjs', { ...bash(repo, session(), command), tool_name: 'PowerShell' }, env(repo, room.port));
    assert.equal(pre.code, 0);
    assert.equal(pre.stderr, '');
    assert.deepEqual(checked(room), ['src/models/user.ts']);
    const out = JSON.parse(pre.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, undefined, 'advice, not a refusal');
    assert.match(out.additionalContext, /alice's agent/);
    assert.match(out.additionalContext, /src\/models\/user\.ts/);
    // and one that only reads asks nothing
    const read = await runHook('pre_tool_use.mjs', { ...bash(repo, session(), 'Get-Content src\\models\\user.ts'), tool_name: 'PowerShell' }, env(repo, room.port));
    assert.deepEqual([read.code, read.stdout, read.stderr], [0, '', '']);
    assert.equal(checked(room).length, 1);
    // the Copilot CLI's powershell tool, in its own format: checked the same, before it runs
    const copilot = { sessionId: session(), cwd: repo, hookEventName: 'PreToolUse', toolName: 'powershell', toolArgs: JSON.stringify({ command }) };
    const viaCopilot = await runHook('pre_tool_use.mjs', copilot, env(repo, room.port), ['--client', 'copilot']);
    assert.equal(viaCopilot.code, 0, viaCopilot.stderr);
    assert.deepEqual(checked(room), ['src/models/user.ts', 'src/models/user.ts']);
  } finally {
    await room.close();
  }
});

test('a Bash command that only reads asks the room nothing and says nothing', async () => {
  const room = await startServer({ holders: [HOLDER] });
  const repo = repository();
  try {
    for (const command of ['cat src/models/user.ts', 'npm test 2>&1 | tail -5', 'git log --oneline -3']) {
      const pre = await runHook('pre_tool_use.mjs', bash(repo, session(), command), env(repo, room.port));
      assert.deepEqual([pre.code, pre.stdout, pre.stderr], [0, '', ''], command);
    }
    assert.deepEqual(checked(room), []);
  } finally {
    await room.close();
  }
});

test('a new file is checked by the imports it is about to have', async () => {
  const room = await startServer({ holders: [] });
  const repo = repository();
  try {
    const file = path.join(repo, 'src/api/duplicate.ts');
    const write = {
      session_id: session(),
      cwd: repo,
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: file, content: "import { createUser } from '../models/user';\n\nexport const dup = () => createUser('x@y.z');\n" },
    };
    const pre = await runHook('pre_tool_use.mjs', write, env(repo, room.port));
    assert.equal(pre.code, 0);
    const ask = room.requests.find((r) => r.path === '/check');
    assert.equal(ask.query.file_path, 'src/api/duplicate.ts');
    assert.deepEqual(ask.query.imports.split(','), ['createUser'], 'what it takes from src/models/user.ts goes with the check');
  } finally {
    await room.close();
  }
});

test('a new file a Bash heredoc writes is checked by the imports it is about to have, as a Write is', async () => {
  const room = await startServer({ holders: [] });
  const repo = repository();
  try {
    const command = "cat > src/api/duplicate.ts <<'EOF'\nimport { createUser } from '../models/user';\n\nexport const dup = () => createUser('x@y.z');\nEOF";
    const pre = await runHook('pre_tool_use.mjs', bash(repo, session(), command), env(repo, room.port));
    assert.equal(pre.code, 0);
    const ask = room.requests.find((r) => r.path === '/check');
    assert.equal(ask.query.file_path, 'src/api/duplicate.ts');
    assert.deepEqual(ask.query.imports.split(','), ['createUser']);
  } finally {
    await room.close();
  }
});
