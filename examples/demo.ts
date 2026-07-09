#!/usr/bin/env node

// A tiny hand-wired CLI that demonstrates the completion engine directly.
// (An adapter deriving this from a function signature is the next step;
// this proves the engine + stubs end to end without it.)
//
//   node dist/examples/demo.js completion zsh          # print the stub to eval
//   node dist/examples/demo.js completion --install    # write to the autoload dir
//   node dist/examples/demo.js __complete bash/1 ''    # inspect the raw wire protocol
//   node dist/examples/demo.js __complete bash/1 push --   # complete flags of `push`
//
// Install for a session:  eval "$(node dist/examples/demo.js completion zsh)"
// (uses the name `demo`, so alias/rename accordingly)

import * as ac from '../index';
import { Reply } from '../index';

// Our hidden request subcommand — ours to choose; the stub gets the same token.
const REQUEST = '__complete';

interface Flag {
  name: string;
  desc: string;
  noSpace?: boolean;
}
interface Command {
  desc: string;
  flags: Flag[];
  // Completion for this command's positional argument (a bare, non-flag word).
  // Exercises the delegated directives (EXT / DIRS / DEFAULT-with-candidates).
  reply?: Reply;
}

// The command model this demo completes against.
const COMMANDS: Record<string, Command> = {
  clone: { desc: 'Clone a repository', flags: [] },
  push: {
    desc: 'Update remote refs',
    flags: [
      { name: '--force', desc: 'Force update' },
      { name: '--tags', desc: 'Push tags too' },
      { name: '--remote=', desc: 'Push destination', noSpace: true },
    ],
  },
  add: {
    desc: 'Add file contents',
    flags: [{ name: '--all', desc: 'Add all files' }],
  },
  // Positional-argument directives: files-by-extension, dirs, dirs-in-a-subdir,
  // and a name-or-path arg (candidates plus a file fallback).
  edit: { desc: 'Edit a file', flags: [], reply: { ext: ['txt', 'md'] } },
  cd: { desc: 'Change directory', flags: [], reply: { dirs: true } },
  theme: { desc: 'Pick a theme', flags: [], reply: { dirs: true, in: 'themes' } },
  switch: {
    desc: 'Switch branches',
    flags: [],
    reply: { items: ['HEAD', 'main'], default: true },
  },
};

// complete(words, toComplete) -> Reply. A returned array means "these
// candidates, nothing else"; returning nothing means "let the shell do files".
function complete(words: string[], toComplete: string): Reply {
  // First positional: a subcommand.
  if (words.length === 0) {
    return Object.keys(COMMANDS).map((name) => ({
      value: name,
      description: COMMANDS[name].desc,
    }));
  }

  const cmd = COMMANDS[words[0]];
  if (cmd) {
    // Value completion: `--remote=<partial>` — exercises bash's `=` wordbreak.
    const m = toComplete.match(/^--remote=(.*)$/);
    if (m) {
      const vals = ['origin', 'upstream'].filter((v) => v.indexOf(m[1]) === 0);
      return vals.map((v) => '--remote=' + v);
    }
    // Delegated directives glued behind a `--flag=`: exercises whether the
    // stub strips the wordbreak prefix before delegating to the shell.
    if (/^--dir=/.test(toComplete)) return { dirs: true };
    if (/^--file=/.test(toComplete)) return { ext: ['txt'] };
    // A `host:path`-style value — exercises the `:` wordbreak.
    if (/^host:/.test(toComplete)) {
      return ['host:one', 'host:two'].filter((v) => v.indexOf(toComplete) === 0);
    }
    if (toComplete.startsWith('-')) {
      return cmd.flags.map((f) => ({ value: f.name, description: f.desc, noSpace: f.noSpace }));
    }
    // A bare positional word: whatever directive the command declares.
    if (cmd.reply !== undefined) return cmd.reply;
  }

  // Otherwise let the shell complete filenames.
  return;
}

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);

  // Completion request? We route our own token and hand the already-stripped
  // argv to handle().
  if (sub === REQUEST) {
    // Forward-compat probe: emit a directive tag no stub knows, so tests can
    // assert older stubs degrade to "render nothing" rather than misbehave.
    if (rest[rest.length - 1] === '__future__') {
      process.stdout.write('FUTURE\nnope\n');
      return;
    }
    return ac.handle(complete, rest);
  }

  // `completion [shell]` prints a stub to eval; `completion [shell] --install`
  // writes it to the shell's autoload dir instead. The stub re-invokes us with
  // the same request token. (name defaults to `demo`, from this filename.)
  if (sub === 'completion') {
    const shellArg = rest.find((a) => !a.startsWith('--')) as ac.Shell | undefined;
    const inst = ac.installation({ request: REQUEST, shell: shellArg || 'auto' });
    if (rest.includes('--install')) {
      inst.install(); // writes the stub, prints the path + activation hint
    } else {
      process.stdout.write(inst.script);
    }
    return;
  }

  console.log(`demo: would run "${sub || ''}" with`, rest);
}

main();
