#!/usr/bin/env node
'use strict';

// A tiny hand-wired CLI that demonstrates the completion engine directly.
// (An adapter deriving this from a function signature is the next step;
// this proves the engine + stubs end to end without it.)
//
//   node demo.js completion zsh        # print the stub to eval
//   node demo.js __complete ''         # inspect the raw wire protocol
//   node demo.js __complete push --    # complete flags of `push`
//
// Install for a session:  eval "$(node examples/demo.js completion zsh)"
// (uses the name `demo`, so alias/rename accordingly)

const ac = require('..');
const { Directive } = ac;

// The command model this demo completes against.
const COMMANDS = {
  clone: { desc: 'Clone a repository', flags: [] },
  push: {
    desc: 'Update remote refs',
    flags: [
      { name: '--force', desc: 'Force update' },
      { name: '--tags', desc: 'Push tags too' },
    ],
  },
  add: {
    desc: 'Add file contents',
    flags: [{ name: '--all', desc: 'Add all files' }],
  },
};

// complete(words, toComplete) -> { items, directive }
function complete(words, toComplete) {
  // First positional: a subcommand.
  if (words.length === 0) {
    const items = Object.keys(COMMANDS).map((name) => ({
      value: name,
      description: COMMANDS[name].desc,
    }));
    return { items, directive: Directive.NoFileComp };
  }

  const cmd = COMMANDS[words[0]];
  if (cmd) {
    // Value completion: `--remote=<partial>` — exercises bash's `=` wordbreak.
    const m = toComplete.match(/^--remote=(.*)$/);
    if (m) {
      const vals = ['origin', 'upstream'].filter((v) => v.indexOf(m[1]) === 0);
      return {
        items: vals.map((v) => ({ value: '--remote=' + v })),
        directive: Directive.NoFileComp,
      };
    }
    if (toComplete.startsWith('-')) {
      return { items: cmd.flags.map((f) => ({ value: f.name, description: f.desc })), directive: Directive.NoFileComp };
    }
  }

  // Otherwise let the shell complete filenames.
  return { items: [], directive: Directive.Default };
}

async function main() {
  // Completion request? Answer it and exit before doing anything else.
  if (await ac.handle(complete)) return;

  const [sub, ...rest] = process.argv.slice(2);

  // The `completion <shell>` command prints a stub to eval.
  if (sub === 'completion') {
    process.stdout.write(ac.script('demo', rest[0] || 'bash'));
    return;
  }

  console.log(`demo: would run "${sub || ''}" with`, rest);
}

main();
