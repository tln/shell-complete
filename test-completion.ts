// Real shell-completion tests: drive bash / zsh / fish through a PTY and assert
// on what each shell actually completes. Shells that aren't installed are
// skipped (reported, not failed). Run: npm run test:completion
//
// This complements test.ts (which unit-tests the wire protocol in isolation) by
// verifying the generated stubs work end to end in the real shells.

import * as assert from 'assert';
import { getCompletions, shellAvailable } from './harness';
import { Shell } from './index';

const SHELLS: Shell[] = ['bash', 'zsh', 'fish'];

let passed = 0;
let skipped = 0;
let failed = 0;
const tests: { name: string; fn: () => Promise<void>; skip?: string }[] = [];

interface TestFn {
  (name: string, fn: () => Promise<void>): void;
  // Register a test that is known to fail (or that the harness can't observe
  // yet); `why` is printed alongside the skip so the gap stays visible.
  skip(why: string, name: string, fn: () => Promise<void>): void;
}

const test = ((name: string, fn: () => Promise<void>): void => {
  tests.push({ name, fn });
}) as TestFn;
test.skip = (why: string, name: string, fn: () => Promise<void>): void => {
  tests.push({ name, fn, skip: why });
};

const sorted = (a: string[]): string[] => a.slice().sort();
// Shells mark directory candidates with a trailing slash; normalize it away.
const bare = (a: string[]): string[] => a.map((c) => c.replace(/\/+$/, ''));

// --- subcommands: first word completes to the command names, no file noise ---
for (const shell of SHELLS) {
  test(`${shell}: first word completes subcommands`, async () => {
    const { candidates } = await getCompletions(shell, 'demo ');
    assert.deepStrictEqual(sorted(candidates), ['add', 'cd', 'clone', 'edit', 'push', 'theme']);
  });

  test(`${shell}: completes flags of a subcommand`, async () => {
    const { candidates } = await getCompletions(shell, 'demo push --');
    assert.deepStrictEqual(sorted(candidates), ['--force', '--remote=', '--tags']);
  });
}

// --- candidate order: program order survives (no alphabetical sort) ---
// `demo c` matches clone then cd in program order; sorted would flip them.
// A two-item listing keeps to one row, so column-major grids can't reorder it.
// bash is excluded: it needs >= 4.4 for nosort and older bash displays sorted.
for (const shell of ['zsh', 'fish'] as Shell[]) {
  test(`${shell}: preserves program candidate order`, async () => {
    const { candidates } = await getCompletions(shell, 'demo c');
    assert.deepStrictEqual(candidates, ['clone', 'cd']);
  });
}

// --- descriptions render where the shell supports them (zsh/fish) ---
test('zsh: renders per-candidate descriptions', async () => {
  const { raw } = await getCompletions('zsh', 'demo ');
  assert.ok(/Update remote refs/.test(raw), 'expected the push description in the listing');
});

test('fish: renders per-candidate descriptions', async () => {
  const { raw } = await getCompletions('fish', 'demo ');
  assert.ok(/Update remote refs/.test(raw), 'expected the push description in the listing');
});

// --- COMP_WORDBREAKS: `--flag=value` must survive bash's = word-splitting ---
for (const shell of SHELLS) {
  test(`${shell}: completes --flag=value across the = wordbreak`, async () => {
    const { candidates } = await getCompletions(shell, 'demo push --remote=');
    // bash: readline completes the sub-word after `=`, so the stub trims the
    // `--remote=` prefix from what it shows; zsh/fish never split the word.
    const expected =
      shell === 'bash'
        ? ['origin', 'upstream']
        : ['--remote=origin', '--remote=upstream'];
    assert.deepStrictEqual(sorted(candidates), expected);
  });
}

// --- directive channel: a no-opinion reply falls back to shell file completion ---
for (const shell of SHELLS) {
  test(`${shell}: Default directive falls back to file completion`, async () => {
    // `demo clone <TAB>`: the demo returns nothing (wire: Directive.Default)
    // -> the shell should offer files. Seed a distinctive filename and expect
    // to see it.
    const { candidates } = await getCompletions(shell, 'demo clone ', {
      files: ['ZZcompletionmarker'],
    });
    assert.ok(
      candidates.indexOf('ZZcompletionmarker') !== -1,
      'expected the seeded file to be offered; got ' + JSON.stringify(candidates)
    );
  });
}

// --- DEFAULT on a `--flag=` word: files complete after the `=`, not against
// the whole word (bash splits on wordbreaks; fish handles `=` natively; zsh
// needs the stub's compset). `demo xyz …` is an unknown subcommand, so the
// demo replies bare DEFAULT.
for (const shell of SHELLS) {
  test(`${shell}: Default completes the value after --flag=`, async () => {
    const { candidates } = await getCompletions(shell, 'demo xyz --expire=', {
      files: ['ZZcompletionmarker'],
    });
    assert.ok(
      candidates.some((c) => c.indexOf('ZZcompletionmarker') !== -1),
      'expected the seeded file to be offered; got ' + JSON.stringify(candidates)
    );
  });
}

// --- EXT directive: files filtered to the given extensions (dirs still shown) ---
for (const shell of ['bash', 'zsh'] as Shell[]) {
  test(`${shell}: EXT completes files by extension, hiding others`, async () => {
    const { candidates } = await getCompletions(shell, 'demo edit ', {
      files: ['keep.txt', 'notes.md', 'ignore.log'],
    });
    const got = JSON.stringify(candidates);
    assert.ok(candidates.indexOf('keep.txt') !== -1, 'want keep.txt; got ' + got);
    assert.ok(candidates.indexOf('notes.md') !== -1, 'want notes.md; got ' + got);
    assert.ok(candidates.indexOf('ignore.log') === -1, 'ignore.log should be filtered; got ' + got);
  });
}
// The fish EXT branch does not filter by extension — it lists every file
// (native file completion), so ignore.log leaks through. Skipped until fixed.
test.skip(
  'fish EXT branch does not filter by extension (lists all files)',
  'fish: EXT completes files by extension, hiding others',
  async () => {
    const { candidates } = await getCompletions('fish', 'demo edit ', {
      files: ['keep.txt', 'notes.md', 'ignore.log'],
    });
    const got = JSON.stringify(candidates);
    assert.ok(candidates.indexOf('keep.txt') !== -1, 'want keep.txt; got ' + got);
    assert.ok(candidates.indexOf('notes.md') !== -1, 'want notes.md; got ' + got);
    assert.ok(candidates.indexOf('ignore.log') === -1, 'ignore.log should be filtered; got ' + got);
  }
);

// --- DIRS directive: directories only, files excluded ---
for (const shell of SHELLS) {
  test(`${shell}: DIRS completes directories only`, async () => {
    const { candidates } = await getCompletions(shell, 'demo cd ', {
      dirs: ['alpha', 'beta'],
      files: ['plainfile'],
    });
    const got = bare(candidates);
    assert.ok(got.indexOf('alpha') !== -1, 'want alpha; got ' + JSON.stringify(candidates));
    assert.ok(got.indexOf('beta') !== -1, 'want beta; got ' + JSON.stringify(candidates));
    assert.ok(got.indexOf('plainfile') === -1, 'files should be excluded; got ' + JSON.stringify(candidates));
  });
}

// --- DIRS `in`: scope directory completion to a subdirectory ---
for (const shell of ['bash', 'zsh'] as Shell[]) {
  test(`${shell}: DIRS scopes to the "in" subdirectory`, async () => {
    const { candidates } = await getCompletions(shell, 'demo theme ', {
      dirs: ['themes/dark', 'themes/light', 'decoy'],
    });
    const got = bare(candidates);
    assert.ok(got.indexOf('dark') !== -1, 'want dark; got ' + JSON.stringify(candidates));
    assert.ok(got.indexOf('light') !== -1, 'want light; got ' + JSON.stringify(candidates));
    assert.ok(got.indexOf('decoy') === -1, 'decoy is outside themes/; got ' + JSON.stringify(candidates));
  });
}
// The fish stub ignores the DIRS payload — it always completes cwd dirs.
test.skip(
  'fish DIRS branch drops the "in" payload (completes cwd dirs instead)',
  'fish: DIRS scopes to the "in" subdirectory',
  async () => {
    const { candidates } = await getCompletions('fish', 'demo theme ', {
      dirs: ['themes/dark', 'themes/light', 'decoy'],
    });
    const got = bare(candidates);
    assert.ok(got.indexOf('dark') !== -1 && got.indexOf('light') !== -1, JSON.stringify(candidates));
    assert.ok(got.indexOf('decoy') === -1, JSON.stringify(candidates));
  }
);

// --- EXT / DIRS glued behind a `--flag=`: the = wordbreak must be stripped ---
// bash & zsh strip the `--flag=` prefix before delegating (like the DEFAULT
// branch does); two candidates are seeded so the completion is ambiguous and
// renders a listing. fish's stub does not strip the prefix yet, so it's skipped.
const extAfterFlag = async (shell: Shell): Promise<void> => {
  const { candidates } = await getCompletions(shell, 'demo push --file=', {
    files: ['keep.txt', 'more.txt', 'ignore.log'],
  });
  const got = JSON.stringify(candidates);
  assert.ok(candidates.some((c) => c.indexOf('keep.txt') !== -1), 'want keep.txt; got ' + got);
  assert.ok(candidates.some((c) => c.indexOf('more.txt') !== -1), 'want more.txt; got ' + got);
  assert.ok(!candidates.some((c) => c.indexOf('ignore.log') !== -1), 'ignore.log filtered; got ' + got);
};
const dirsAfterFlag = async (shell: Shell): Promise<void> => {
  const { candidates } = await getCompletions(shell, 'demo push --dir=', {
    dirs: ['themes', 'docs'],
  });
  const got = JSON.stringify(candidates);
  const b = bare(candidates);
  assert.ok(b.some((c) => c.indexOf('themes') !== -1), 'want themes; got ' + got);
  assert.ok(b.some((c) => c.indexOf('docs') !== -1), 'want docs; got ' + got);
};
for (const shell of ['bash', 'zsh'] as Shell[]) {
  test(`${shell}: EXT completes values after --file=`, () => extAfterFlag(shell));
  test(`${shell}: DIRS completes values after --dir=`, () => dirsAfterFlag(shell));
}
test.skip(
  'fish EXT branch does not strip the --flag= wordbreak prefix (nor filter by ext)',
  'fish: EXT completes values after --file=',
  () => extAfterFlag('fish')
);
test.skip(
  'fish DIRS branch does not strip the --flag= wordbreak prefix',
  'fish: DIRS completes values after --dir=',
  () => dirsAfterFlag('fish')
);

// --- `:` wordbreak: host:path values reach the program whole, undoubled ---
for (const shell of SHELLS) {
  test(`${shell}: completes host:path values across the : wordbreak`, async () => {
    const { candidates } = await getCompletions(shell, 'demo push host:');
    // bash: readline completes only the sub-word after `:`, so the stub trims
    // the `host:` prefix. zsh/fish keep the word whole.
    const expected = shell === 'bash' ? ['one', 'two'] : ['host:one', 'host:two'];
    assert.deepStrictEqual(sorted(candidates), expected);
  });
}

// --- bash cannot render descriptions: the stub must drop them, not leak them ---
test('bash: drops descriptions it cannot render', async () => {
  const { raw, candidates } = await getCompletions('bash', 'demo ');
  assert.ok(!/Update remote refs/.test(raw), 'bash listing must not leak descriptions');
  assert.ok(candidates.indexOf('push') !== -1, 'but the value still completes');
});

// --- forward-compat: an unknown directive tag renders nothing (safe degrade) ---
test('fish: unknown directive tag renders nothing', async () => {
  const { candidates } = await getCompletions('fish', 'demo push __future__');
  assert.deepStrictEqual(candidates, []);
});
for (const shell of ['bash', 'zsh'] as Shell[]) {
  test.skip(
    'an empty listing is indistinguishable from a timeout in this harness',
    `${shell}: unknown directive tag renders nothing`,
    async () => {
      const { candidates } = await getCompletions(shell, 'demo push __future__');
      assert.deepStrictEqual(candidates, []);
    }
  );
}

// --- NOSPACE: a noSpace candidate is completed without a trailing space ---
// Observing this needs the edited command line after a *unique* completion;
// this harness only parses the ambiguous-completion listing, so it's skipped.
test.skip(
  'needs inline-completion capture (edited command line), not the ambiguous listing',
  'noSpace: candidate completes without a trailing space',
  async () => {
    // `demo push --rem<TAB>` should complete to `--remote=` with the cursor
    // right after `=` (no space), so a further TAB offers origin/upstream.
    const { candidates } = await getCompletions('bash', 'demo push --remote=');
    assert.deepStrictEqual(sorted(candidates), ['origin', 'upstream']);
  }
);

async function run(): Promise<void> {
  for (const { name, fn, skip } of tests) {
    const shell = name.split(':')[0];
    if (skip) {
      skipped++;
      console.log(`skip - ${name} (${skip})`);
      continue;
    }
    if (SHELLS.indexOf(shell as Shell) !== -1 && !shellAvailable(shell)) {
      skipped++;
      console.log(`skip - ${name} (${shell} not installed)`);
      continue;
    }
    try {
      await fn();
      passed++;
      console.log(`ok   - ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL - ${name}`);
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      console.log('       ' + msg);
    }
  }
  console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

run();
