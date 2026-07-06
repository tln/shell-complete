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
const tests: { name: string; fn: () => Promise<void> }[] = [];

function test(name: string, fn: () => Promise<void>): void {
  tests.push({ name, fn });
}

const sorted = (a: string[]): string[] => a.slice().sort();

// --- subcommands: first word completes to the command names, no file noise ---
for (const shell of SHELLS) {
  test(`${shell}: first word completes subcommands`, async () => {
    const { candidates } = await getCompletions(shell, 'demo ');
    assert.deepStrictEqual(sorted(candidates), ['add', 'clone', 'push']);
  });

  test(`${shell}: completes flags of a subcommand`, async () => {
    const { candidates } = await getCompletions(shell, 'demo push --');
    assert.deepStrictEqual(sorted(candidates), ['--force', '--tags']);
  });
}

// --- candidate order: program order survives (no alphabetical sort) ---
// The demo returns clone, push, add — sorted would put `add` first. bash is
// excluded: it needs >= 4.4 for nosort and older bash displays sorted.
for (const shell of ['zsh', 'fish'] as Shell[]) {
  test(`${shell}: preserves program candidate order`, async () => {
    const { candidates } = await getCompletions(shell, 'demo ');
    assert.deepStrictEqual(candidates, ['clone', 'push', 'add']);
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

async function run(): Promise<void> {
  for (const { name, fn } of tests) {
    const shell = name.split(':')[0];
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
