# Canonical implementations to test against

Goal: real CLIs whose completions you can poke by hand, both at the wire level
and interactively, to compare behavior with shell-complete.

## Cobra (dynamic `__complete` — same protocol as this library)

### gh — the convenient one (installed via Homebrew)

Wire level, no shell involved:

```
$ gh __complete pr ""            # all subcommands + :4 (NoFileComp)
checkout	Check out a pull request in git
checks	Show CI status for a single pull request
...
:4
Completion ended with directive: ShellCompDirectiveNoFileComp   # ← stderr, debug only

$ gh __complete pr "ch"          # Cobra's built-in prefix filter at work
checkout	Check out a pull request in git
checks	Show CI status for a single pull request
:4

$ gh __complete pr view --"      # flag completion
$ gh __complete repo clone ""    # dynamic: hits the GitHub API for your repos
```

Interactive, in a scratch shell:

```
$ bash --norc
$ eval "$(gh completion -s bash)"; gh pr <TAB><TAB>
$ zsh -f
$ autoload -U compinit && compinit -u; eval "$(gh completion -s zsh)"; gh pr <TAB>
```

Also instructive: read Cobra's actual generated stubs next to ours —
`gh completion -s bash` (~400 lines) vs stubs.ts (~30). The delta is the
feature list: descriptions in bash, `compgen` re-filtering, `_filedir`
delegation, debug tracing (`BASH_COMP_DEBUG_FILE=/tmp/x gh <TAB>` logs every
step — a trick worth stealing for our PTY tests).

### kubectl — the maximal one (installed)

The reference for *hard* dynamic completion:
[k8s.io/kubectl/pkg/util/completion](https://github.com/kubernetes/kubectl/blob/master/pkg/util/completion/completion.go)
completes resource types, then live object names from the API server, then
falls through flags.

```
$ kubectl __complete apply -f ""   # FilterFileExt in the wild
json
yaml
yml
:8

$ kubectl __complete get ""        # needs a cluster; without one (this machine)
panic: runtime error: index out of range ...   # ← why Directive.Error exists
```

That panic is a live lesson: dynamic completion code runs on every TAB in
hostile conditions (no network, no config). The stub's `2>/dev/null` is what
keeps it from splattering onto the command line.

### Other Cobra hosts on this machine: `docker` (and any `hugo`, `helm` if
installed later). Nearly every CNCF CLI speaks `__complete`.

## clap

clap has two generations, and the difference *is* the research finding:

### Static (`clap_complete::generate`) — uv, ripgrep, fd, bat

```
$ uv generate-shell-completion bash | wc -c    # ~215 KB of generated case-statements
$ rg --generate complete-zsh | head            # rg ≥ 14 self-generates; older ships files
```

Everything is decided at generation time: a giant `case` over subcommand
paths, `opts="..."` word lists, `COMPREPLY=($(compgen -W "$opts" -- "$cur"))`.
No process is spawned on TAB (fast!), but: no dynamic values (can't complete
your venv names or installed packages), and the script goes stale the moment
the binary updates — hence the regenerate-on-release burden for packagers.

### Dynamic (`clap_complete::env::CompleteEnv`, feature `unstable-dynamic`)

Trigger is an env var instead of a subcommand — the binary checks
`COMPLETE=<shell>` *before* arg parsing:

```
source <(COMPLETE=bash myprog)     # rc one-liner: prints the stub
# on TAB the stub re-invokes: COMPLETE=bash myprog -- <argv-so-far>
```

The canonical shipping user is **cargo nightly** (var renamed to
`CARGO_COMPLETE`). This machine's nightly (2022) predates it, so to test:

```
$ rustup toolchain install nightly
$ source <(CARGO_COMPLETE=bash cargo +nightly)   # in a scratch bash
$ cargo +nightly b<TAB>                           # bench/build/...
$ CARGO_COMPLETE=bash cargo +nightly -- cargo b   # wire level, roughly
```

Design deltas vs Cobra worth observing when you test:

- **No directive bitfield.** clap's engine returns structured candidates
  (value, help, ValueHint) and the *engine* decides file behavior, emitting
  path candidates itself rather than delegating to the shell
  (see [file-filtering.md](file-filtering.md)).
- **Engine-side filtering.** clap filters candidates against the current token
  in Rust; Cobra leaves user-function output unfiltered and lets stubs/shell
  filter (see [filtering.md](filtering.md)).
- **Trigger ergonomics.** Env-var trigger works even for CLIs that can't
  spare a subcommand name, and can't collide with user args; Cobra's hidden
  `__complete` subcommand keeps stderr/stdout discipline simpler. Our
  `REQUEST = '__complete'` follows Cobra; supporting an env trigger too would
  be a ~5-line addition to `isRequest()`.

## Suggested comparison matrix to run (bash + zsh, PTY or by hand)

| Scenario | gh | cargo nightly | shell-complete demo |
|----------|----|---------------|---------------------|
| subcommand w/ descriptions, zsh | ✓ shows desc | ✓ | ✓ |
| descriptions in bash | ✓ (V2 script renders `(desc)`) | ? | ✗ today (we drop them, stubs.ts:32) |
| unfiltered callback + `ch<TAB>` in bash | filtered by compgen | filtered by engine | **inserts wrong prefix** (bug, see filtering.md) |
| `--flag=<TAB>` | ✓ | ✓ | ✓ (COMP_WORDBREAKS hack) |
| `-f <TAB>` file ext filter | `kubectl apply -f` → *.yaml only | ValueHint paths | falls to all files |
| no candidates + NoFileComp | shows nothing | shows nothing | ✓ |
| completion source errors | silent (Error directive) | silent | falls back to files (gap, see directives.md) |

## Sources

- [Cobra completions guide](https://github.com/spf13/cobra/blob/main/site/content/completions/_index.md)
- [kubectl completion package](https://github.com/kubernetes/kubectl/blob/master/pkg/util/completion/completion.go)
- [clap_complete::env](https://docs.rs/clap_complete/latest/clap_complete/env/index.html), [clap dynamic discussion #5677](https://github.com/clap-rs/clap/discussions/5677)
- [cargo native-completions tracking issue #14520](https://github.com/rust-lang/cargo/issues/14520), [cargo unstable docs](https://doc.rust-lang.org/cargo/reference/unstable.html)
- Local captures: gh/kubectl/uv (July 2026)
