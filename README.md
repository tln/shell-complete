# shell-complete

Low-level abstraction over shell completions for **bash, zsh, and fish**.

```ts
import { handle, installation, CompleteFn, Shell } from 'shell-complete';

// Your hidden request subcommand — yours to choose; the stub gets the same token.
const REQUEST = '__complete';

// (words already typed, the word under the cursor) -> a Reply
const complete: CompleteFn = (words, toComplete) => {
  if (words.length === 0) {
    return [
      { value: 'clone', description: 'Clone a repository' },
      { value: 'push', description: 'Update remote refs' },
    ];
  }
  return; // no opinion — let the shell do files
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  // You route the hidden request subcommand — it's your CLI's namespace.
  if (cmd === REQUEST) return handle(complete, rest);

  if (cmd === 'completion') {
    const inst = installation({ request: REQUEST, shell: rest[0] as Shell | undefined ?? 'auto' });
    if (rest.includes('--install')) inst.install(); // write to the autoload dir; prints path + any activation hint
    else process.stdout.write(inst.script); // print for eval/source
    return;
  }
  // ... your real program ...
}
main();
```

CommonJS works too: `const { handle, installation } = require('shell-complete')`.

Two ways to install the completion:

```sh
# 1. One-shot: write the stub into the shell's per-user autoload dir.
#    install() probes whether the shell will actually load it there (fish:
#    always; bash: needs bash-completion 2.x loaded; zsh: the dir must be on
#    fpath before compinit) — and when it won't, prints the one rc line that
#    activates the written stub instead (a static `source`: no startup cost).
myprog completion --install

# 2. Regenerate at shell startup, so the stub never drifts from the binary.
#    Costs one program spawn per shell startup — prefer 1 if yours is slow:
eval "$(myprog completion bash)"   # ~/.bashrc
eval "$(myprog completion zsh)"    # ~/.zshrc
myprog completion fish | source    # ~/.config/fish/config.fish
```

## API

```ts
type Item = string | { value: string; description?: string; noSpace?: boolean };
type Reply =
  | Item[]              // candidates, nothing else (no file fallback)
  | null | undefined    // no opinion — shell does its default (files)
  | { items?: Item[] }  // candidates, nothing else (object form of Item[])
  | { ext: string[] }   // shell's file completion, these extensions only
  | { dirs: true; in?: string };  // directories only (optionally under ./in)
type CompleteFn = (words: string[], toComplete: string) => Reply | Promise<Reply>;
type Shell = 'bash' | 'zsh' | 'fish';
```

Every shape is a plain literal — no imports needed in completion code:

```ts
return ['add', 'clone'];                       // candidates only
return { ext: ['json', 'yaml'] };              // shell completes *.json / *.yaml
return { dirs: true, in: 'themes' };           // directories under ./themes
return [{ value: '--flag=', noSpace: true }];  // keep typing after insertion
throw err;                                     // fail dark (show nothing, no file noise)
```

Candidates are shown in the order you return them (pre-sort for alphabetical).
Per-item `noSpace` may be mixed freely with normal candidates.

- **`handle(complete, argv, opts?): Promise<void>`** — answer a completion
  request. You route the request token yourself and pass the arguments *after*
  it: `[proto, word..., toComplete]` — `proto` is the stub's
  `<shell>/<version>` stamp, and the last element is the possibly-empty word
  under the cursor. Throwing answers "show nothing". `opts`:
  `{ out?: { write(s): void } }`.
- **`installation({ request, name?, shell? }): Installation`** — everything a
  CLI needs to offer completion setup, derived from one place so the pieces
  can't disagree. `request` is the token the stub re-invokes you with — the
  same one you route to `handle()`. `name` defaults to the invoked script's
  basename; `shell` defaults to `'auto'` ($SHELL, falling back to bash — pass
  the user's answer through when you have one). The result:
  - `.script` — the stub text (print it for the eval/source flow)
  - `.source(...args)` — the rc one-liner (`eval "$(myprog completion zsh)"`,
    fish: `myprog completion fish | source`); `args` is however your CLI
    spells "print the stub" (default `completion <shell>`); spawns your
    program at every shell startup, so prefer `install()` when that's too slow
  - `.installPath` — the shell's per-user autoload dir for this program
  - `.installWarning` — why the shell may not autoload `installPath`, with
    the one rc line that fixes it (`[ -f <path> ] && . <path>` /
    `source <path>` — static, no startup spawn) — or `undefined` when
    autoload will just work. Probed lazily on first access (spawns the shell
    once) and cached; reading it never writes anything.
  - `.install(opts?)` — write the stub to `installPath` (creating dirs) and
    report to `opts.out` (default stdout): the path, then `installWarning`
    if set. Returns the written path.
- **`serialize(reply): string`** — lower a `Reply` to the wire format (used
  internally by `handle`; exposed for custom transports).
- **`stubs`** — the low-level per-shell generators
  (`stubs.script(name, shell, request)`), if you need a stub with none of the
  defaulting.

## Wire protocol

The stub re-invokes the program with the request token, a protocol stamp, and
the words up to the cursor:

```
myprog <request> <shell>/<version> <word...> <toComplete>
```

The stamp (e.g. `bash/1`) tells the program which stub generation is calling,
so a newer binary can keep answering stubs installed by an older one. The last
argument is the (possibly empty) word under the cursor.

The reply is a tag line followed by payload lines, read to end of output:

```
$ node dist/examples/demo.js __complete bash/1 push --
NODEFAULT
--force	Force update
--tags	Push tags too
```

| Tag | Payload | Meaning | Reply spelling |
|-----|---------|---------|----------------|
| `DEFAULT` | none | the shell's default (file) completion | `null`/`undefined` |
| `NODEFAULT` | candidates (may be none) | offer these and nothing else | `Item[]`, `{ items }`, `throw` (empty) |
| `EXT` | extensions | shell-native file completion, filtered | `{ ext: [...] }` |
| `DIRS` | optional start dir | directories only | `{ dirs: true, in? }` |

Candidate lines are `<value>\t<description>` (description optional). The tag
line may carry flags after the tag: `NOSPACE` (don't append a space after
insertion; space-wanting candidates in a mixed reply arrive pre-padded with a
trailing space). Unknown tags render nothing, so old stubs degrade safely
against newer binaries.

## Develop

- `npm run build` — compile `dist/` (JS + `.d.ts`).
- `npm test` — unit tests for the wire protocol.
- `npm run test:completion` — drive real bash/zsh/fish through a PTY and assert on
  what they render (uninstalled shells are skipped).

## Known gaps

- `--opt=value` and `host:path` work in bash without touching
  `COMP_WORDBREAKS`: the stub re-joins the split tokens for the request and
  trims the already-typed prefix from the reply. (bash therefore *displays*
  the part after `=`/`:`; zsh and fish display whole words.)
- `{ ext }` / `{ dirs }` delegate natively in bash (`compgen`) and zsh
  (`_files`); in fish they use `__fish_complete_suffix` /
  `__fish_complete_directories` when available (`in` is ignored), degrading
  to plain file completion otherwise.
- `noSpace` is honored in bash/zsh; fish ignores it (candidates still
  complete, with a space).
- Candidate order is preserved in zsh, fish, and bash ≥ 4.4; older bash —
  including macOS `/bin/bash` 3.2 — shows sorted.
