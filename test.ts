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
  assert.strictEqual(s(undefined), 'DEFAULT\n');
  assert.strictEqual(s(null), 'DEFAULT\n');
  // candidates, nothing else
  assert.strictEqual(s(['a', 'b']), 'NODEFAULT\na\nb\n');
  assert.strictEqual(s([]), 'NODEFAULT\n'); // no matches — show nothing
  assert.strictEqual(s({ items: ['a'] }), 'NODEFAULT\na\n');
  // descriptions ride behind a tab
  assert.strictEqual(
    s([{ value: 'push', description: 'Update remote refs' }, 'add']),
    'NODEFAULT\npush\tUpdate remote refs\nadd\n'
  );
  // delegated, filtered file completion (payload = filter args)
  assert.strictEqual(s({ ext: ['md', 'docx'] }), 'EXT\nmd\ndocx\n');
  assert.strictEqual(s({ dirs: true }), 'DIRS\n');
  assert.strictEqual(s({ dirs: true, in: 'themes' }), 'DIRS\nthemes\n');
  // nullish items are skipped
  assert.strictEqual(s(['a', null as unknown as string, 'b']), 'NODEFAULT\na\nb\n');
  // multi-line descriptions are clamped to their first line (the wire
  // format is line-based; extra lines would read as extra candidates)
  assert.strictEqual(
    s([{ value: 'push', description: 'Update remote refs\nalong with associated objects' }]),
    'NODEFAULT\npush\tUpdate remote refs\n'
  );
  assert.strictEqual(
    s([{ value: 'push', description: 'first\r\nsecond' }]),
    'NODEFAULT\npush\tfirst\n'
  );
  // a description that is only a newline collapses to no description
  assert.strictEqual(s([{ value: 'push', description: '\nrest' }]), 'NODEFAULT\npush\n');
});

test('serialize supports per-item noSpace via NOSPACE + trailing-space padding', () => {
  const s = ac.serialize;
  // mixed: NOSPACE flagged; space-wanting candidates get padded instead
  assert.strictEqual(
    s([{ value: '--flag=', noSpace: true }, '--all']),
    'NODEFAULT NOSPACE\n--flag=\n--all \n'
  );
  assert.strictEqual(
    s({ items: [{ value: 'host:', noSpace: true }, { value: 'up', description: 'd' }] }),
    'NODEFAULT NOSPACE\nhost:\nup \td\n'
  );
  // all-noSpace: just the flag, no padding
  assert.strictEqual(s([{ value: 'a/', noSpace: true }]), 'NODEFAULT NOSPACE\na/\n');
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
  assert.strictEqual(out.text(), 'NODEFAULT\n--force\n--tags\n');
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
  assert.strictEqual(out.text(), 'NODEFAULT\n');
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
  assert.strictEqual(out.text(), 'NODEFAULT\n');
});

test('handle awaits async callbacks', async () => {
  const out = sink();
  await ac.handle(async () => ({ items: ['async-ok'] }), ['fish/1', ''], { out });
  assert.strictEqual(out.text(), 'NODEFAULT\nasync-ok\n');
});

test('handle treats no return value as "let the shell do files"', async () => {
  const out = sink();
  await ac.handle(() => undefined, ['bash/1', ''], { out });
  assert.strictEqual(out.text(), 'DEFAULT\n');
});

test('installation emits a stub per shell and rejects unknown shells', () => {
  for (const shell of ['bash', 'zsh', 'fish'] as const) {
    const s = ac.installation({ request: '__complete', name: 'demo', shell }).script;
    assert.ok(s.includes('demo'), shell + ' stub names the program');
    assert.ok(s.includes('__complete'), shell + ' stub invokes the request');
    assert.ok(s.includes(`${shell}/${ac.stubs.PROTOCOL}`), shell + ' stub sends its proto stamp');
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
  assert.ok(inst.script.includes('complete -o nospace -F _test_complete test'), 'derived name "test"');
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

// Probe fixtures: the probe reads footprints from an interactive login shell,
// which reads rc files from $HOME — so a throwaway home fakes any machine.
function withFixtureHome<T>(files: Record<string, string>, fn: () => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-complete-home-'));
  for (const name of Object.keys(files)) {
    fs.writeFileSync(path.join(home, name), files[name]);
  }
  const saved: Record<string, string | undefined> = {};
  // HOME steers both the spawned shell's rc files and installPath (os.homedir);
  // the rest would leak the real machine's completion setup into the fixture.
  for (const v of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'BASH_COMPLETION_USER_DIR', 'ZDOTDIR']) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    for (const v of Object.keys(saved)) {
      if (saved[v] == null) delete process.env[v];
      else process.env[v] = saved[v];
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('installWarning probes bash without side effects (bare home: not loaded)', () => {
  withFixtureHome({}, () => {
    const inst = ac.installation({ request: '__complete', name: 'demo', shell: 'bash' });
    const w = inst.installWarning;
    assert.ok(w && w.includes('bash-completion 2.x is not loaded'), String(w));
    assert.ok(w!.includes(`. "${inst.installPath}"`), 'includes the activating rc line');
    assert.ok(!fs.existsSync(inst.installPath), 'probing writes nothing');
  });
});

test('installWarning is undefined when the bash loader footprint is present', () => {
  // The probe checks the variable bash-completion sets, so a fixture rc can
  // fake the loader without installing the package. Noise checks the sentinel
  // parse: rc output must not confuse the probe.
  withFixtureHome(
    { '.bash_profile': 'echo starting up!\nBASH_COMPLETION_VERSINFO=(2 14)\n' },
    () => {
      const inst = ac.installation({ request: '__complete', name: 'demo', shell: 'bash' });
      assert.strictEqual(inst.installWarning, undefined);
    }
  );
});

test('installWarning explains zsh fpath / compinit states', () => {
  // bare home: ~/.zfunc is not on fpath
  withFixtureHome({}, () => {
    const inst = ac.installation({ request: '__complete', name: 'demo', shell: 'zsh' });
    const w = inst.installWarning;
    assert.ok(w && w.includes('is not on your zsh fpath'), String(w));
    assert.ok(w!.includes(`source "${inst.installPath}"`), 'fix line sources the stub');
  });
  // fpath is right but compinit never runs: soft warning, not a hard no
  withFixtureHome({ '.zshrc': 'fpath+=$HOME/.zfunc\n' }, () => {
    const inst = ac.installation({ request: '__complete', name: 'demo', shell: 'zsh' });
    const w = inst.installWarning;
    assert.ok(w && w.includes('could not verify that compinit runs'), String(w));
  });
  // fpath + compinit (-u: skip the tty-bound security prompt): autoload works
  withFixtureHome(
    { '.zshrc': 'fpath+=$HOME/.zfunc\nautoload -Uz compinit && compinit -u\n' },
    () => {
      const inst = ac.installation({ request: '__complete', name: 'demo', shell: 'zsh' });
      assert.strictEqual(inst.installWarning, undefined);
    }
  );
});

test('installation.install writes the stub and reports the path', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-complete-install-'));
  const saved = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = tmp;
    const inst = ac.installation({ request: '__complete', name: 'demo', shell: 'fish' });
    const out = sink();
    const written = inst.install({ out });
    assert.strictEqual(written, inst.installPath, 'returns the written path (0.1.1 compat)');
    assert.ok(inst.installPath.startsWith(tmp), 'honors $XDG_CONFIG_HOME');
    assert.strictEqual(fs.readFileSync(inst.installPath, 'utf8'), inst.script);
    // fish autoloads by filename: no probe, no activation hint
    assert.strictEqual(out.text(), `installed fish completion: ${inst.installPath}\n`);
  } finally {
    if (saved == null) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('installation.install probes bash and prints the fix line unless autoload is live', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-complete-install-'));
  const saved = process.env.BASH_COMPLETION_USER_DIR;
  try {
    process.env.BASH_COMPLETION_USER_DIR = tmp;
    const inst = ac.installation({ request: '__complete', name: 'demo', shell: 'bash' });
    const out = sink();
    inst.install({ out });
    assert.strictEqual(fs.readFileSync(inst.installPath, 'utf8'), inst.script, 'stub written');
    const text = out.text();
    assert.ok(text.startsWith(`installed bash completion: ${inst.installPath}\n`), text);
    // the probe's verdict is machine-dependent; the invariant is the shape:
    // either the single installed line, or an activation hint sourcing the stub
    const rest = text.slice(text.indexOf('\n') + 1);
    if (rest !== '') {
      assert.ok(rest.includes('To activate, add this line to ~/.bashrc:'), text);
      assert.ok(rest.includes(`. "${inst.installPath}"`), 'hint sources the written stub');
    }
  } finally {
    if (saved == null) delete process.env.BASH_COMPLETION_USER_DIR;
    else process.env.BASH_COMPLETION_USER_DIR = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

Promise.all(pending).then(() => {
  console.log(`\n${passed}/${pending.length} passed`);
  if (passed !== pending.length) process.exitCode = 1;
});
