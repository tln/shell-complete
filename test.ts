// Engine unit tests. Run: npm test
// (Shell stubs are exercised separately by test-completion.ts against real shells.)

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ac from './index';
import { Writable } from './index';

// Collect what handle() writes instead of hitting stdout.
function sink(): Writable & { text(): string } {
  const chunks: string[] = [];
  return { write: (s: string) => chunks.push(s), text: () => chunks.join('') };
}

let passed = 0;
const pending: Promise<void>[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  pending.push(
    Promise.resolve()
      .then(fn)
      .then(() => {
        passed++;
        console.log('ok - ' + name);
      })
      .catch((err) => {
        console.error('not ok - ' + name);
        console.error(err && err.stack ? err.stack : err);
        process.exitCode = 1;
      })
  );
}

test('serialize lowers each Reply shape to the wire format', () => {
  const s = ac.serialize;
  // no opinion -> shell default (files)
  assert.strictEqual(s(undefined), 'DEFAULT\nEOF\n');
  assert.strictEqual(s(null), 'DEFAULT\nEOF\n');
  // candidates, nothing else
  assert.strictEqual(s(['a', 'b']), 'NODEFAULT\na\nb\nEOF\n');
  assert.strictEqual(s([]), 'NODEFAULT\nEOF\n'); // no matches — show nothing
  assert.strictEqual(s({ items: ['a'] }), 'NODEFAULT\na\nEOF\n');
  // descriptions ride behind a tab
  assert.strictEqual(
    s([{ value: 'push', description: 'Update remote refs' }, 'add']),
    'NODEFAULT\npush\tUpdate remote refs\nadd\nEOF\n'
  );
  // name-or-path: candidates plus file fallback
  assert.strictEqual(s({ items: ['a'], default: true }), 'DEFAULT\na\nEOF\n');
  // delegated, filtered file completion (payload = filter args)
  assert.strictEqual(s({ ext: ['md', 'docx'] }), 'EXT\nmd\ndocx\nEOF\n');
  assert.strictEqual(s({ dirs: true }), 'DIRS\nEOF\n');
  assert.strictEqual(s({ dirs: true, in: 'themes' }), 'DIRS\nthemes\nEOF\n');
  // nullish items are skipped
  assert.strictEqual(s(['a', null as unknown as string, 'b']), 'NODEFAULT\na\nb\nEOF\n');
});

test('serialize supports per-item noSpace via NOSPACE + trailing-space padding', () => {
  const s = ac.serialize;
  // mixed: NOSPACE flagged; space-wanting candidates get padded instead
  assert.strictEqual(
    s([{ value: '--flag=', noSpace: true }, '--all']),
    'NODEFAULT NOSPACE\n--flag=\n--all \nEOF\n'
  );
  assert.strictEqual(
    s({ items: [{ value: 'host:', noSpace: true }, { value: 'up', description: 'd' }] }),
    'NODEFAULT NOSPACE\nhost:\nup \td\nEOF\n'
  );
  // all-noSpace: just the flag, no padding
  assert.strictEqual(s([{ value: 'a/', noSpace: true }]), 'NODEFAULT NOSPACE\na/\nEOF\n');
  // the flag rides the tag line for DEFAULT too
  assert.strictEqual(
    s({ items: [{ value: 'x=', noSpace: true }], default: true }),
    'DEFAULT NOSPACE\nx=\nEOF\n'
  );
});

test('handle strips the proto stamp and splits words / cursor word', async () => {
  const out = sink();
  await ac.handle(
    (words, toComplete) => {
      assert.deepStrictEqual(words, ['push']);
      assert.strictEqual(toComplete, '--f');
      return ['--force', '--tags'];
    },
    ['bash/1', 'push', '--f'],
    { out }
  );
  assert.strictEqual(out.text(), 'NODEFAULT\n--force\n--tags\nEOF\n');
});

test('handle treats a proto-only request as completing the first word', async () => {
  const out = sink();
  await ac.handle(
    (words, toComplete) => {
      assert.deepStrictEqual(words, []);
      assert.strictEqual(toComplete, '');
      return [];
    },
    ['zsh/1'],
    { out }
  );
  assert.strictEqual(out.text(), 'NODEFAULT\nEOF\n');
});

test('handle answers NODEFAULT with no candidates when the callback throws', async () => {
  const out = sink();
  await ac.handle(
    () => {
      throw new Error('boom');
    },
    ['bash/1', 'x'],
    { out }
  );
  assert.strictEqual(out.text(), 'NODEFAULT\nEOF\n');
});

test('handle awaits async callbacks', async () => {
  const out = sink();
  await ac.handle(async () => ({ items: ['async-ok'] }), ['fish/1', ''], { out });
  assert.strictEqual(out.text(), 'NODEFAULT\nasync-ok\nEOF\n');
});

test('handle treats no return value as "let the shell do files"', async () => {
  const out = sink();
  await ac.handle(() => undefined, ['bash/1', ''], { out });
  assert.strictEqual(out.text(), 'DEFAULT\nEOF\n');
});

test('installation emits a stub per shell and rejects unknown shells', () => {
  for (const shell of ['bash', 'zsh', 'fish'] as const) {
    const s = ac.installation({ request: '__complete', name: 'demo', shell }).script;
    assert.ok(s.includes('demo'), shell + ' stub names the program');
    assert.ok(s.includes('__complete'), shell + ' stub invokes the request');
    assert.ok(s.includes(`${shell}/${ac.stubs.PROTOCOL}`), shell + ' stub sends its proto stamp');
    assert.ok(s.includes('EOF'), shell + ' stub checks the terminator');
  }
  assert.throws(
    () => ac.installation({ request: '__complete', name: 'demo', shell: 'powershell' as ac.Shell }),
    /unknown shell/
  );
});

test('installation uses a caller-chosen request token verbatim', () => {
  const s = ac.installation({ request: 'completion-server', name: 'demo', shell: 'bash' }).script;
  assert.ok(s.includes('demo completion-server'), 'stub invokes the custom token');
  assert.ok(!s.includes('__complete'), 'the conventional token is not assumed');
});

test('installation defaults the name from the invoked script, and requires a request', () => {
  // Under `node dist/test.js`, process.argv[1] ends in test.js -> name "test".
  const inst = ac.installation({ request: '__complete', shell: 'bash' });
  assert.strictEqual(inst.name, 'test');
  assert.ok(inst.script.includes('complete -F _test_complete test'), 'derived name "test"');
  assert.throws(() => ac.installation({ request: '' }), /request token/);
});

test('installation resolves shell "auto" from $SHELL, falling back to bash', () => {
  const saved = process.env.SHELL;
  try {
    process.env.SHELL = '/usr/local/bin/fish';
    assert.strictEqual(ac.installation({ request: 'x', name: 'demo' }).shell, 'fish');
    process.env.SHELL = '/bin/zsh';
    assert.strictEqual(ac.installation({ request: 'x', name: 'demo', shell: 'auto' }).shell, 'zsh');
    process.env.SHELL = '/usr/bin/nushell';
    assert.strictEqual(ac.installation({ request: 'x', name: 'demo' }).shell, 'bash');
    delete process.env.SHELL;
    assert.strictEqual(ac.installation({ request: 'x', name: 'demo' }).shell, 'bash');
  } finally {
    if (saved == null) delete process.env.SHELL;
    else process.env.SHELL = saved;
  }
});

test('installation.source builds the rc one-liner per shell', () => {
  const opts = { request: '__complete', name: 'demo' } as const;
  assert.strictEqual(
    ac.installation({ ...opts, shell: 'bash' }).source(),
    'eval "$(demo completion bash)"'
  );
  assert.strictEqual(
    ac.installation({ ...opts, shell: 'zsh' }).source(),
    'eval "$(demo completion zsh)"'
  );
  assert.strictEqual(
    ac.installation({ ...opts, shell: 'fish' }).source(),
    'demo completion fish | source'
  );
  // custom args: however your CLI spells "print the stub"
  assert.strictEqual(
    ac.installation({ ...opts, shell: 'zsh' }).source('completions', '--shell=zsh'),
    'eval "$(demo completions --shell=zsh)"'
  );
});

test('installation.installPath targets each shell\'s autoload dir', () => {
  const opts = { request: '__complete', name: 'demo' } as const;
  const sep = path.sep;
  const saved = process.env.BASH_COMPLETION_USER_DIR;
  try {
    delete process.env.BASH_COMPLETION_USER_DIR;
    const fishPath = ac.installation({ ...opts, shell: 'fish' }).installPath;
    assert.ok(fishPath.endsWith(`fish${sep}completions${sep}demo.fish`), fishPath);
    const bashPath = ac.installation({ ...opts, shell: 'bash' }).installPath;
    assert.ok(bashPath.endsWith(`bash-completion${sep}completions${sep}demo`), bashPath);
    const zshPath = ac.installation({ ...opts, shell: 'zsh' }).installPath;
    assert.ok(zshPath.endsWith(`.zfunc${sep}_demo`), zshPath);
  } finally {
    if (saved != null) process.env.BASH_COMPLETION_USER_DIR = saved;
  }
});

test('installation.install writes the stub and returns the path', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-complete-install-'));
  const saved = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = tmp;
    const inst = ac.installation({ request: '__complete', name: 'demo', shell: 'fish' });
    const written = inst.install();
    assert.strictEqual(written, inst.installPath);
    assert.ok(written.startsWith(tmp), 'honors $XDG_CONFIG_HOME');
    assert.strictEqual(fs.readFileSync(written, 'utf8'), inst.script);
  } finally {
    if (saved == null) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

Promise.all(pending).then(() => {
  console.log(`\n${passed}/${pending.length} passed`);
  if (passed !== pending.length) process.exitCode = 1;
});
