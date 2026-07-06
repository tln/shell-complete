# Directives: semantics and lineage

The `Directive` bitfield is a direct port of Cobra's `ShellCompDirective`
([completions.go](https://github.com/spf13/cobra/blob/main/completions.go)).
It *is* very Go-like: Go has no exceptions and no sum types, so Cobra models
"extra instructions to the shell" as an `int` built with `1 << iota` that rides
alongside the candidate list in every return value. We inherit the numbering
verbatim so the wire format stays Cobra-compatible (`:<n>` trailer), even
though in JS some of it is redundant — e.g. a thrown exception already maps to
`Error` in `handle()` (index.ts:109-114), so user code here rarely needs to
return `Directive.Error` by hand.

## The bits, per Cobra's source (doc comments verbatim)

| Bit | Cobra name | Cobra's definition |
|----:|------------|--------------------|
| 1 | `ShellCompDirectiveError` | "an error occurred and completions should be ignored" |
| 2 | `ShellCompDirectiveNoSpace` | "the shell should not add a space after the completion even if there is a single completion provided" |
| 4 | `ShellCompDirectiveNoFileComp` | "the shell should not provide file completion even when no completion is provided" |
| 8 | `ShellCompDirectiveFilterFileExt` | "the provided completions should be used as file extension filters" (see [file-filtering.md](file-filtering.md)) |
| 16 | `ShellCompDirectiveFilterDirs` | "only directory names should be provided in file completion" |
| 32 | `ShellCompDirectiveKeepOrder` | "the shell should preserve the order in which the completions are provided" |
| 0 | `ShellCompDirectiveDefault` | "let the shell perform its default behavior after completions have been provided" |

Note the two *shapes* of directive hiding in one bitfield:

- **Modifiers** (`NoSpace`, `NoFileComp`, `KeepOrder`): tweak how the shell
  presents the candidates you sent.
- **Delegations** (`FilterFileExt`, `FilterDirs`): the "candidates" are not
  candidates at all — they're *arguments to the shell's own file completion*.
  `kubectl __complete apply -f ""` returns `json`/`yaml`/`yml` + `:8`; those
  three lines are extension filters, not things to insert.

`Error` is a third shape: a signal that everything else should be discarded.

## What `Error` actually means, and why you'd use it

**Semantics:** "my completion machinery failed — show *nothing*, and don't
paper over it with file completion." It is not merely "empty result". Cobra's
zsh script returns immediately on the error bit, *before* the file-completion
fallback; an empty result with `Default` would instead fall through to
completing filenames.

**Why it exists:** dynamic completion callbacks do real work — hit APIs, read
config, spawn processes — and that work fails in the field. A live example
from this machine (no cluster running):

```
$ kubectl __complete get ""
E0705 ... dial tcp [::1]:6443: connect: connection refused
panic: runtime error: index out of range [0] with length 0
```

kubectl's completion func crashed outright here (a kubectl bug — it should
have returned `Error`), but the design intent is visible: when the API server
is unreachable, offering the user *filenames* as pod names would be actively
misleading. `Error` says "fail dark". The stubs also redirect the program's
stderr (`2>/dev/null` in ours, stubs.ts:26,66,100), so a crash or error trace
never corrupts the command line — the user just gets no completions.

**When Cobra returns it internally:** unknown subcommand path, flag-parse
failure mid-line, unsupported flag — i.e. "I can't even tell what we're
completing". In shell-complete you get it in two ways: your callback throws
(automatic), or you return `{ directive: Directive.Error }` deliberately
(e.g. a caught network timeout).

**Rule of thumb:** return `Error` when the *question was valid but you failed
to answer it*. Return `[] + NoFileComp` when the answer is genuinely "nothing
matches". Return `[] + Default` when "I have no opinion — let the shell do
files".

## Gap in our stubs (found while writing this)

Our bash/zsh stubs never test bit 1. Today that's masked because `handle()`
sends zero candidates alongside `:1`, but the *fallback* behavior is wrong:

- bash (stubs.ts:41-43): zero candidates + directive 1 → `directive & 4` is 0
  → `compopt -o default` → **file completion runs on error**.
- zsh (stubs.ts:86-88): same — `_files` runs on error.

Cobra treats `Error` as terminal (no candidates, *no file fallback*). Fix:
check bit 1 first and `return` in both stubs. Fish drops directives entirely
today, so `Error` (and everything else) is invisible there — see
[testing-in-the-wild.md](testing-in-the-wild.md) for how Cobra's fish script
handles it.

## Sources

- [Cobra completions.go](https://github.com/spf13/cobra/blob/main/completions.go) — directive definitions and doc comments
- [Cobra shell completions guide](https://github.com/spf13/cobra/blob/main/site/content/completions/_index.md)
- Local experiments: `gh __complete`, `kubectl __complete` (July 2026, gh via Homebrew, kubectl 1.9.1-era Cobra vendored)
