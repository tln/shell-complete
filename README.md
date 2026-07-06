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
    if (rest.includes('--install')) console.log(inst.install()); // write to the autoload dir
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
# 1. One-shot: write the stub into the shell's per-user autoload dir — no
#    dotfile editing (fish: always works; bash: needs the bash-completion 2.x
#    package; zsh: put `fpath+=~/.zfunc` before compinit).
myprog completion --install

# 2. Regenerate at shell startup, so the stub never drifts from the binary:
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
  | { items?: Item[]; default?: boolean }
                        // candidates; default: true also offers files as fallback
  | { ext: string[] }   // shell's file completion, these extensions only
  | { dirs: true; in?: string };  // directories only (optionally under ./in)
type CompleteFn = (words: string[], toComplete: string) => Reply | Promise<Reply>;
type Shell = 'bash' | 'zsh' | 'fish';
```

Every shape is a plain literal — no imports needed in completion code:

```ts
return ['add', 'clone'];                       // candidates only
return { items: names, default: true };        // name-or-path: files as fallback
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
    spells "print the stub" (default `completion <shell>`)
  - `.installPath` — the shell's per-user autoload dir for this program
  - `.install()` — write the stub there (creating dirs) and return the path
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

The reply is a tag line, payload lines, and a terminator:

```
$ node dist/examples/demo.js __complete bash/1 push --
NODEFAULT
--force	Force update
--tags	Push tags too
EOF
```

| Tag | Payload | Meaning | Reply spelling |
|-----|---------|---------|----------------|
| `DEFAULT` | candidates (may be none) | offer these; fall back to file completion | `null`/`undefined`, `{ items, default: true }` |
| `NODEFAULT` | candidates (may be none) | offer these and nothing else | `Item[]`, `{ items }`, `throw` (empty) |
| `EXT` | extensions | shell-native file completion, filtered | `{ ext: [...] }` |
| `DIRS` | optional start dir | directories only | `{ dirs: true, in? }` |

Candidate lines are `<value>\t<description>` (description optional). The tag
line may carry flags after the tag: `NOSPACE` (don't append a space after
insertion; space-wanting candidates in a mixed reply arrive pre-padded with a
trailing space). The final `EOF` line guards against a program that died
mid-reply — a stub that doesn't see it shows nothing. Unknown tags also render
nothing, so old stubs degrade safely against newer binaries.

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
