# shell-complete

The thin, framework-neutral completion engine: a JavaScript implementation of
Cobra's dynamic-completion contract. A shell stub re-invokes your program with a
hidden `__complete` request; the program prints candidates plus a directive; the
stub renders them. All "what completes here" logic lives in one `complete`
callback — each shell needs only a ~20-line stub.

This is the reusable core. An adapter that derives the callback from a
function signature is the next layer; see [Next](#next).

## Why this design

Copied from Cobra/clap (the design two ecosystems converged on independently)
because the alternative — tabtab's `COMP_*` + `log()` model — has no back-channel
from program to shell. The **directive bitfield** is that channel: it's what lets
you say "no trailing space after `--flag=`", "don't fall back to files here", or
"keep my order". See the [directives](#directives) table.

## Usage

```js
const ac = require('shell-complete');
const { Directive } = ac;

// (words already typed, the word under the cursor) -> { items, directive }
function complete(words, toComplete) {
  if (words.length === 0) {
    return {
      items: [
        { value: 'clone', description: 'Clone a repository' },
        { value: 'push', description: 'Update remote refs' },
      ],
      directive: Directive.NoFileComp,
    };
  }
  return { items: [], directive: Directive.Default }; // let the shell do files
}

async function main() {
  // Answer a completion request and exit before running anything else.
  if (await ac.handle(complete)) return;

  const [sub, ...rest] = process.argv.slice(2);
  if (sub === 'completion') {
    process.stdout.write(ac.script('myprog', rest[0] || 'bash'));
    return;
  }
  // ... real program ...
}
main();
```

Install completion for a shell (no dotfile editing — regenerate on each startup
so the stub never drifts from the program):

```sh
# bash  (~/.bashrc)
eval "$(myprog completion bash)"
# zsh   (~/.zshrc)
eval "$(myprog completion zsh)"
# fish  (~/.config/fish/config.fish)
myprog completion fish | source
```

## API

- `handle(complete, opts?) -> Promise<boolean>` — if `argv` is a `__complete`
  request, run `complete` and print the reply; resolves `true` (caller should
  return). Otherwise `false`. `complete` may be sync/async and may return a bare
  array of items (directive defaults to `Default`). `opts`: `{ argv, out }`.
- `respond(items, directive?, out?)` — serialize items + directive to the wire
  format. Items are strings or `{ value, description }`.
- `script(name, shell) -> string` — the stub to eval; `shell` ∈ `bash|zsh|fish`.
- `Directive` — the bitfield below. `REQUEST` — the hidden subcommand
  (`__complete`). `isRequest(argv)`, `parseRequest(argv)` — request helpers.

## Wire protocol

The stub runs `myprog __complete <word...> <toComplete>`; the last arg is the
(possibly empty) word under the cursor. The program prints:

```
<value>\t<description>     one per line; \t<description> optional
:<directive>               final line, the directive bitfield as a number
```

Inspect it by hand:

```
$ node examples/demo.js __complete push --
--force	Force update
--tags	Push tags too
:4
```

## Directives

| Bit | Name | Effect | Honored |
|----:|------|--------|---------|
| 0 | `Default` | shell does its default (usually file completion) | ✅ |
| 1 | `Error` | ignore all candidates | ✅ |
| 2 | `NoSpace` | no space after a lone candidate (e.g. `--flag=`) | ✅ bash/zsh |
| 4 | `NoFileComp` | don't fall back to file completion | ✅ bash/zsh |
| 8 | `FilterFileExt` | treat candidates as file-extension filters | reserved |
| 16 | `FilterDirs` | complete directories only | reserved |
| 32 | `KeepOrder` | preserve program order instead of sorting | partial |

## Testing

Two layers:

- `npm test` — `test.js`, unit tests for the wire protocol (no shells needed).
- `npm run test:completion` — `test-completion.js`, **real** tests that drive
  bash / zsh / fish through a PTY (via `node-pty`), type a line, press TAB, and
  assert on what the shell actually renders. Shells that aren't installed are
  skipped, not failed.

The PTY harness (`harness.js`) exports `getCompletions(shell, line, opts)` for
reuse. `DEBUG_PTY=1` dumps the raw captured terminal region.

## Status / known gaps

- **fish** support is implemented but untested on this machine (fish not
  installed); bash + zsh are verified by the PTY suite.
- **`--flag=value`**: bash splits on `COMP_WORDBREAKS` (`=`, `:`), so the
  `--opt=val` form is not yet reconstructed. The `--opt val` (space) form works.
- `FilterFileExt` / `FilterDirs` are defined but not yet delegated per shell.
- Install is by `eval`ing the stub (Cobra/clap-recommended, drift-free); no
  dotfile mutation, so no uninstall step is needed.

## Next

An adapter — `completionFor(commands)` — that walks a parsed
signature model (subcommands from nested objects, `--long`/`-short` from option
params, boolean-vs-value from default types, descriptions from comments) into a
`complete` callback. Everything above is the substrate it plugs into.
