'use strict';

// Engine unit tests. Run: node autocomplete/test.js
// (Shell stubs are exercised separately by test-stub.sh against a real shell.)

const assert = require('assert');
const ac = require('./index');
const { Directive } = ac;

// Collect what respond()/handle() write instead of hitting stdout.
function sink() {
  const chunks = [];
  return { write: (s) => chunks.push(s), text: () => chunks.join('') };
}

let passed = 0;
const pending = [];
function test(name, fn) {
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

test('isRequest detects the __complete request', () => {
  assert.strictEqual(ac.isRequest(['__complete', 'a']), true);
  assert.strictEqual(ac.isRequest(['push', '--force']), false);
  assert.strictEqual(ac.isRequest([]), false);
});

test('parseRequest splits words and the cursor word', () => {
  assert.deepStrictEqual(ac.parseRequest(['__complete', 'push', '--f']), {
    words: ['push'],
    toComplete: '--f',
  });
  // trailing empty cursor word (line ended in a space)
  assert.deepStrictEqual(ac.parseRequest(['__complete', 'push', '']), {
    words: ['push'],
    toComplete: '',
  });
  // just the request: completing the first word
  assert.deepStrictEqual(ac.parseRequest(['__complete']), { words: [], toComplete: '' });
});

test('respond emits value\\tdesc lines and a trailing directive', () => {
  const out = sink();
  ac.respond(
    [{ value: 'push', description: 'Update remote refs' }, 'add'],
    Directive.NoFileComp,
    out
  );
  assert.strictEqual(out.text(), 'push\tUpdate remote refs\nadd\n:4\n');
});

test('respond defaults to Directive.Default and skips nullish items', () => {
  const out = sink();
  ac.respond(['a', null, 'b'], undefined, out);
  assert.strictEqual(out.text(), 'a\nb\n:0\n');
});

test('handle returns false for a normal (non-completion) invocation', async () => {
  const called = { n: 0 };
  const handled = await ac.handle(() => { called.n++; }, { argv: ['push'] });
  assert.strictEqual(handled, false);
  assert.strictEqual(called.n, 0);
});

test('handle runs the callback and writes its reply', async () => {
  const out = sink();
  const handled = await ac.handle(
    (words, toComplete) => {
      assert.deepStrictEqual(words, ['push']);
      assert.strictEqual(toComplete, '--f');
      return { items: ['--force', '--tags'], directive: Directive.NoSpace };
    },
    { argv: ['__complete', 'push', '--f'], out }
  );
  assert.strictEqual(handled, true);
  assert.strictEqual(out.text(), '--force\n--tags\n:2\n');
});

test('handle accepts a bare array (directive defaults to Default)', async () => {
  const out = sink();
  await ac.handle(() => ['a', 'b'], { argv: ['__complete', ''], out });
  assert.strictEqual(out.text(), 'a\nb\n:0\n');
});

test('handle reports Directive.Error when the callback throws', async () => {
  const out = sink();
  await ac.handle(() => { throw new Error('boom'); }, { argv: ['__complete', 'x'], out });
  assert.strictEqual(out.text(), ':1\n');
});

test('handle awaits async callbacks', async () => {
  const out = sink();
  await ac.handle(
    async () => { return { items: ['async-ok'] }; },
    { argv: ['__complete', ''], out }
  );
  assert.strictEqual(out.text(), 'async-ok\n:0\n');
});

test('script emits a stub per shell and rejects unknown shells', () => {
  for (const shell of ['bash', 'zsh', 'fish']) {
    const s = ac.script('demo', shell);
    assert.ok(s.includes('demo'), shell + ' stub names the program');
    assert.ok(s.includes(ac.REQUEST), shell + ' stub invokes the request');
  }
  assert.throws(() => ac.script('demo', 'powershell'), /unknown shell/);
});

Promise.all(pending).then(() => {
  console.log(`\n${passed}/${pending.length} passed`);
  if (passed !== pending.length) process.exitCode = 1;
});
