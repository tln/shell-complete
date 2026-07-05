'use strict';

// Real shell-completion tests: drive bash / zsh / fish through a PTY and assert
// on what each shell actually completes. Shells that aren't installed are
// skipped (reported, not failed). Run: node test-completion.js
//
// This complements test.js (which unit-tests the wire protocol in isolation) by
// verifying the generated stubs work end to end in the real shells.

const assert = require('assert');
const { getCompletions, shellAvailable } = require('./harness');

const SHELLS = ['bash', 'zsh', 'fish'];

let passed = 0;
let skipped = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

const sorted = (a) => a.slice().sort();

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
    assert.deepStrictEqual(sorted(candidates), ['--remote=origin', '--remote=upstream']);
  });
}

// --- directive channel: Directive.Default falls back to shell file completion ---
for (const shell of ['bash', 'zsh', 'fish']) {
  test(`${shell}: Default directive falls back to file completion`, async () => {
    // `demo clone <TAB>` returns no items + Directive.Default -> the shell
    // should offer files. Seed a distinctive filename and expect to see it.
    const { candidates } = await getCompletions(shell, 'demo clone ', {
      files: ['ZZcompletionmarker'],
    });
    assert.ok(
      candidates.indexOf('ZZcompletionmarker') !== -1,
      'expected the seeded file to be offered; got ' + JSON.stringify(candidates)
    );
  });
}

async function run() {
  for (const { name, fn } of tests) {
    const shell = name.split(':')[0];
    if (SHELLS.indexOf(shell) !== -1 && !shellAvailable(shell)) {
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
      console.log('       ' + (err && err.message ? err.message.split('\n')[0] : err));
    }
  }
  console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

run();
