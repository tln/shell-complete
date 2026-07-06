# FilterFileExt & FilterDirs: why delegate file completion to the shell?

## The question

`FilterFileExt` (8) and `FilterDirs` (16) look redundant at first: the program
runs in the user's cwd, so why not just `readdir()` and emit matching paths as
ordinary candidates?

## Why you can't fake file completion from the program

Shell-native file completion carries UX you cannot reproduce by emitting
strings:

1. **Incremental directory descent.** Type `src/co<TAB>` — the shell completes
   `src/completions/` *without a trailing space* and lets you keep typing into
   the directory. To fake that you'd have to reimplement partial-path parsing,
   emit `NoSpace` conditionally for dirs, and get the trailing-`/` convention
   right per shell.
2. **Quoting and escaping.** Paths with spaces, `$`, brackets: the shell's
   file completer escapes them per its own quoting rules (which differ across
   bash/zsh/fish and depend on whether the user is inside quotes). Program
   strings are inserted more literally; kubectl-style values are shell-safe,
   arbitrary filenames are not.
3. **User configuration is honored.** Case-insensitive matching
   (`completion-ignore-case`, zsh `matcher-list`), hidden-file preferences,
   zsh's colored/columned file listings, fish's file previews — all apply to
   *shell* file completion and none to program-emitted strings.
4. **Expansion context.** `~/`, `$HOME/`, `..` — the shell completes inside
   these correctly; the program sees a raw `toComplete` string and would have
   to expand them itself (and must *not* insert the expanded form).

So the directive inverts control: instead of "here are candidates", the
program says "do your native file completion, *constrained like this*". The
payload lines become filter arguments — extensions for `FilterFileExt`, an
optional starting subdirectory for `FilterDirs`.

Cobra's convenience wrappers show the intended usage:
`cmd.MarkFlagFilename("file", "json", "yaml")` → the flag completes with
`:8` + those extensions; `MarkFlagDirname` → `:16`. Live:

```
$ kubectl __complete apply -f ""
json
yaml
yml
:8
```

## How Cobra implements each, per shell

From Cobra's generated scripts (verified against `main`, July 2026):

| Shell | FilterFileExt | FilterDirs |
|-------|---------------|------------|
| bash (V2 script) | `_filedir 'json|yaml|yml'` — joins extensions with `|` | `_filedir -d`; if a subdir payload is present, `pushd "$subdir" && _filedir -d && popd` |
| zsh | `_files -g "*.json" -g "*.yaml" ...` (prefixes `*.` unless the payload already looks like a glob), wrapped in `_arguments '*:filename:...'` | `_files -/`, with the same optional `pushd` into `${completions[1]}` |
| fish | **Not supported** — the function `return`s 1 so fish falls back to *unfiltered* file completion | Same fallback |
| PowerShell | Not supported (falls back) | Not supported |

Two implementation notes that matter for us:

- **Cobra's bash path requires the `bash-completion` package** — `_filedir` is
  not a bash builtin. Our stub deliberately has no such dependency. The
  dependency-free equivalents are:
  `compgen -f -X '!*.@(json|yaml|yml)' -- "$cur"` plus `compgen -d -- "$cur"`
  (extglob `@(...)` alternation; add `-o filenames` behavior via
  `compopt -o filenames` so bash appends `/` to dirs and escapes spaces), and
  `compgen -d -- "$cur"` alone for FilterDirs.
- **The zsh side is nearly free**: our stub already calls `_files` as its
  fallback (stubs.ts:87); FilterFileExt is the same call with `-g` globs, and
  FilterDirs is `_files -/`.
- **fish precedent lowers the bar**: Cobra ships fish support that simply
  degrades to plain file completion for both directives. Matching that is a
  legitimate v1 (`complete -c prog -f -a ...` already suppresses files; the
  stub would need to *stop* suppressing when these bits are set — fish's
  `complete --keep-files`/`-F` on the wrapper or `__fish_complete_suffix` can
  do better later).

## How clap does it

clap has no directive protocol in its static scripts — file behavior is baked
in at generation time from `ValueHint` on each arg (`ValueHint::FilePath`,
`DirPath`, `ExecutablePath`, ...). E.g. zsh generation emits `_files` /
`_files -/` for those hints directly into the script. The dynamic engine
(`clap_complete::CompleteEnv`, `unstable-dynamic` feature) evaluates the same
`ValueHint`s at completion time inside the Rust process — including doing its
own path candidate generation — rather than delegating via a directive. So:

- **Cobra**: runtime *directive* → shell does the filtering natively.
- **clap static**: compile-time *hint* → shell function baked into the script.
- **clap dynamic**: runtime hint → **engine emits path strings itself** (this
  is the "fake it from the program" approach, and tracking issues about
  quoting/UX parity, e.g. [clap #5730](https://github.com/clap-rs/clap/issues/5730),
  illustrate why it's hard).

Cobra's design is the strongest argument for keeping `FilterFileExt`/
`FilterDirs` in our protocol: it's the only approach that gets native file UX
*and* runtime decisions ("this flag takes YAML") without shipping shell-side
knowledge of the CLI's structure.

## Recommended implementation order for shell-complete

1. `FilterDirs`, zsh (`_files -/`) and bash (`compgen -d`): tiny, high value.
2. `FilterFileExt`, zsh (`_files -g`) and bash (extglob `compgen -X`).
3. fish: degrade to unfiltered files (Cobra parity), improve later.
4. Wire payload convention: extensions without `*.` (Cobra sends bare `json`),
   optional single subdir line for `FilterDirs`.

## Sources

- [Cobra bash_completionsV2.go](https://github.com/spf13/cobra/blob/main/bash_completionsV2.go)
- [Cobra zsh_completions.go](https://github.com/spf13/cobra/blob/main/zsh_completions.go)
- [Cobra fish_completions.go](https://github.com/spf13/cobra/blob/main/fish_completions.go)
- [clap_complete docs](https://docs.rs/clap_complete/latest/clap_complete/) / [CompleteEnv](https://docs.rs/clap_complete/latest/clap_complete/env/struct.CompleteEnv.html)
- Local: `kubectl __complete apply -f ""` → `:8` (captured above)
