# Rethinking `CompleteFn`: from bitfield to shapes

The current return type is Cobra's Go idiom transliterated to TS:

```ts
{ items?: Item[]; directive?: number }   // directive = imported bit constants OR'd together
```

Three smells:

1. **Imports.** The common case (`NoFileComp`) needs `import { Directive }`.
   A completion callback should be writable inline with zero imports.
2. **Illegal states are expressible.** `FilterFileExt | FilterDirs`?
   `items` + `FilterDirs` (items silently reinterpreted)? `Error | NoSpace`?
   The bitfield type-checks all of them.
3. **One field, three meanings.** The payload lines are candidates *or*
   extension filters *or* a start directory, depending on bits — the classic
   untagged union.

The directives aren't six independent booleans. Analyzed one by one (verified
against Cobra's generated scripts — see below), they collapse into **one enum
plus two flags**.

## The per-directive audit

### `Default` (0) — "can you return values too? why?"

**Yes**, and it's meaningful: *"here are my candidates, and file completion
stays available as a fallback."* Cobra's bash V2 script filters your
candidates with `compgen`, then runs `_filedir` only if the directive lacks
`NoFileComp` and nothing matched. Use case: arguments that accept a
name-**or**-path (`helm install <repo/chart | ./local-dir>`, `myprog run
<task-name | script.js>`). So values+files is a real combination — it just
shouldn't be the *default* for value-returning callbacks (see below).

### `Error` (1) — "seems like a hack"

Agreed, for us. Cobra needs it because Go signals errors by return value, and
the directive line is the only back-channel. But note it *does* carry one bit
of shell-visible semantics: error suppresses the file-completion fallback
(Cobra's zsh script `return`s before `_files`), whereas empty+`Default` falls
through to files. Our `handle()` already buffers output and maps exceptions
to `:1` (index.ts:109-114) — the "printed some completions then died"
scenario can't even occur here. **Conclusion: drop `Error` from the user API
entirely; it stays a wire-level artifact produced only by `throw`.** User
code that *catches* a failure and wants to fail dark just re-throws or
returns `[]` (see mapping below — bare `[]` no longer falls back to files).

### `NoFileComp` (4) — "can you return values too? why? combine?"

Values + `NoFileComp` isn't just legal, it's **the** case: every list
completion in gh ends `:4`. The reason it must be combinable: without it,
a typo after `gh pr ` would fall back to completing *filenames* — noise
masquerading as a suggestion. Which raises the real design question: why does
the wire's zero-value (`Default`) mean "files on"? That's a bash-ism (Cobra
registers with `-o default`) inherited as a default. Survey says the
common intent when you return candidates is "these, and nothing else".
**Conclusion: `NoFileComp` disappears as a concept; it becomes the implicit
behavior of returning items, and `files: true` opts back into the fallback.**

### `FilterFileExt` (8) — "feels like it should be a different shape. Often static."

Exactly right, and Cobra's own scripts prove it: the payload lines are not
candidates, they're **arguments to the shell's file completer** (bash:
`_filedir 'json|yaml'`; zsh: `_files -g '*.json'`). You cannot mix real
candidates with them on the wire. And it's static in practice — Cobra users
don't write functions for this, they annotate:
`cmd.MarkFlagFilename("config", "json", "yaml")`. It's data, not code.
**Conclusion: model as a distinct object shape (`{ files: { ext: [...] } }`),
mutually exclusive with `items` by construction.**

### `FilterDirs` (16) — "can you return values too?"

No — same repurposing trick, sneakier: `payload[0]`, if present, is the
directory *within which* to complete (Cobra's scripts literally `pushd
"${completions[0]}" && _filedir -d && popd`). One optional parameter
masquerading as a candidate list. **Conclusion: same shape family:
`{ files: { dirs: true, in?: 'some/dir' } }`.**

### `KeepOrder` (32) — "why? what uses it in practice?"

Every shell **sorts candidates alphabetically** by default (readline sorts
`COMPREPLY`, zsh sorts within `_describe`, fish sorts its pager).
`KeepOrder` (bash ≥4.4 `compopt -o nosort`, zsh `_describe -V`, fish
`complete -k`) preserves program order instead. Real returners found via
GitHub code search (it's rare — most hits are just generated stubs):

- **vmware-tanzu/tanzu-cli** — yes/no prompt completion, keeps the
  recommended `true` first (with a comment: "may not work for all shells").
- **telemetryOS/Graviton** — DB migration names in chronological order.
- The general pattern: *ranked* lists — recency (branches by last commit),
  semver (newest first), severity, recommended-first.

Worth keeping, as a boolean — it's a genuine presentation flag, cheap on all
three shells. (Our zsh stub can add `-V`; bash needs a 4.4 gate like Cobra's;
fish needs the `-k` registration trick.)

### `NoSpace` (2)

The one honest flag in the set. Needed whenever the completion is a prefix
the user keeps typing into: `--flag=`, `host:`, hierarchical values
(`region/zone`). Keep as boolean.

## The distilled model

Candidates, one *file-behavior* mode, two presentation flags:

```
files mode:  off (default w/ items) | fallback | ext-filtered | dirs[-in-subdir]
flags:       noSpace, keepOrder
```

## Proposed API — no imports required

```ts
type Item = string | { value: string; description?: string };

type Reply =
  | void | null       // "no opinion" → shell's default (file completion)
  | Item[]            // candidates, nothing else — the 95% case
  | {
      items?: Item[];
      files?: boolean | { ext?: string[]; dirs?: boolean; in?: string };
      noSpace?: boolean;
      keepOrder?: boolean;
    };

type CompleteFn = (words: string[], current: string) => Reply | Promise<Reply>;
```

Every shape is a plain literal — nothing to import, structurally typed, and
illegal states are now unrepresentable (`ext` filters can't carry candidates;
there's no `Error|NoSpace` to write).

### Wire mapping (unchanged wire — full Cobra compat)

| You return | Wire | Old spelling |
|---|---|---|
| `['a', 'b']` | `a`,`b`, `:4` | items + `NoFileComp` |
| `[]` | `:4` | "no matches, show nothing" |
| *(nothing)* / `null` | `:0` | `Default` |
| `{ items, files: true }` | items, `:0` | items + `Default` |
| `{ files: { ext: ['json','yaml'] } }` | `json`,`yaml`, `:8` | `FilterFileExt` |
| `{ files: { dirs: true } }` | `:16` | `FilterDirs` |
| `{ files: { dirs: true, in: 'themes' } }` | `themes`, `:16` | `FilterDirs` + payload |
| `{ items, noSpace: true }` | items, `:6` | `NoSpace\|NoFileComp` |
| `{ items, keepOrder: true }` | items, `:36` | `KeepOrder\|NoFileComp` |
| `throw` | `:1` | `Error` |

**The one breaking semantic change:** a bare array now means `:4`, not `:0`.
Defensible on survey evidence (gh/kubectl attach `NoFileComp` to essentially
every candidate list; falling back to filenames on a subcommand typo is a
misfeature) and it makes the lazy path the correct path.

### Examples, before/after

```ts
// before
import { Directive } from 'shell-complete';
return { items: subcommands, directive: Directive.NoFileComp };
// after
return subcommands;

// before
return { items: ['yaml', 'json'], directive: Directive.FilterFileExt };  // "items"?!
// after
return { files: { ext: ['yaml', 'json'] } };

// before
return { items: [flag + '='], directive: Directive.NoSpace | Directive.NoFileComp };
// after
return { items: [flag + '='], noSpace: true };
```

### What stays

- `respond()`/`Directive`/the wire protocol — unchanged, still exported for
  custom transports and for anyone porting Cobra completion functions 1:1.
  `Reply` normalization is a pure function on top (`toDirective(reply)`),
  easily unit-tested against the table above.
- `handle()` signature; it just accepts the new shapes too. Old
  `{ items, directive }` can be detected (`typeof directive === 'number'`)
  and honored forever — it's four lines of back-compat.

## Final shape (as implemented, after review)

Review flattened the proposal further — three discriminated shapes instead of
one object with a `files` union field:

```ts
type Reply =
  | Item[] | null | undefined
  | { items?: Item[]; default?: boolean; directive?: number }
  | { ext: string[] }
  | { dirs: true; in?: string };
```

Deltas from the proposal above:

- **`files:` wrapper dropped.** `{ ext }` / `{ dirs, in? }` are top-level
  shapes; `files: true` became `default: true` (named for the wire's
  `Default`: "also let the shell do its default completion"). Object literals
  mixing shapes (`{ items, ext }`) now fail TS excess-property checks.
- **Reply-level `noSpace` deleted** — subsumed by per-item
  `{ value, noSpace: true }`. Mixed lists work on the Cobra wire via
  git-completion's idiom: set the global NoSpace bit and pad the
  space-wanting candidates with a literal trailing space.
- **`keepOrder` deleted — it's the default.** Every candidate reply carries
  bit 32; the transport never reorders. Alphabetical is the program's job
  (`.sort()`), since the inverse (un-sorting shell-side) is impossible.
  Stubs honor it: zsh `_describe -V`, bash `compopt -o nosort` (≥4.4, older
  degrades to sorted), fish `complete -k`.

## Protocol v1 (second revision): the wire follows the shapes

Once the API became a tagged union, keeping Cobra's `:bitfield` wire was
carrying someone else's Go constraint. Wire v1 mirrors the Reply union — a
tag line, payload, and terminator:

```
NODEFAULT NOSPACE          DEFAULT | NODEFAULT | EXT | DIRS; flag: NOSPACE
--flag=
--all ␣                    (padded: mixed noSpace)
EOF                        positional terminator (last line only)
```

Consequences:

- Stubs dispatch on `read type` + `case` instead of bit arithmetic.
- `ERROR` needs no tag: throw ⇒ `NODEFAULT` with no payload — literally
  "show nothing, no file fallback".
- `KeepOrder` needs no wire presence: stubs preserve order unconditionally.
- `EOF` is checked positionally (last line must equal it, strip one), so a
  candidate legitimately named `EOF` can't truncate a reply; a missing
  terminator (program died mid-write) discards the reply. Unknown tags render
  nothing — old stubs degrade safely against newer binaries.
- The request carries a `<shell>/<version>` stamp
  (`prog __complete bash/1 ...`) so a newer binary can serve stubs installed
  by an older one — the drift scenario vendored/installed stubs create (see
  installation.md). Positional, not env: env prefixes can't invoke shell
  *functions* in fish, and sniffing argv shapes collides with real words.
- Dropping the bitfield killed the `directive` escape hatch and `Directive`
  export; `respond`/`normalizeReply` merged into `serialize(reply)`.
- The bash stub now does Cobra-style `=`/`:` handling (reassemble the request
  word, trim the readline-owned prefix from replies) instead of mutating
  `COMP_WORDBREAKS` globally — unblocking file-based installation. It also
  prefix-filters against the current word, fixing the wrong-insertion bug
  (see filtering.md). EXT/DIRS are delegated per shell (bash `compgen`,
  zsh `_files -g` / `-/`, fish best-effort helpers).

## Neighbors, for calibration

- **clap dynamic** models candidates as structs
  (`CompletionCandidate{ value, help, hidden }`) and file behavior as
  arg-level `ValueHint`s — i.e. it also landed on "file completion is a mode,
  not a candidate list". No user-facing bitfield.
- **tabtab/pnpm** has no protocol at all: the *magic candidate string*
  `__tabtab_complete_files__` in-band signals "do file completion"
  (observed live in `pnpm completion bash`). That's the ditch on the other
  side of the road — directives exist so the payload channel stays clean.
- **Fig/Amazon Q specs** are the maximal shape-based design (declarative
  JSON with `template: "filepaths"`, generators) — evidence that "shapes not
  flags" is where completion APIs converge when unconstrained by Go.

## Sources

- [Cobra completions.go](https://github.com/spf13/cobra/blob/main/completions.go), [bash_completionsV2.go](https://github.com/spf13/cobra/blob/main/bash_completionsV2.go), [zsh_completions.go](https://github.com/spf13/cobra/blob/main/zsh_completions.go)
- KeepOrder users: [tanzu-cli ceip_participation.go](https://github.com/vmware-tanzu/tanzu-cli/blob/main/pkg/command/ceip_participation.go), telemetryOS/Graviton `cmd/commands/down.go` (GitHub code search, July 2026)
- [clap_complete CompletionCandidate](https://docs.rs/clap_complete/latest/clap_complete/engine/struct.CompletionCandidate.html)
- Local: `pnpm completion bash` sentinel capture
