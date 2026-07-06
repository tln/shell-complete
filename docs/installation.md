# Installing completions: how far do other tools go?

The README currently tells users to add `eval "$(myprog completion bash)"` to
their rc file. That's the Cobra-era baseline. Survey of what shipping CLIs
actually do, roughly in ascending order of "how far they go":

## 1. Print instructions, user edits rc (kubectl, gh, helm, rustup)

`kubectl completion bash`, `gh completion -s zsh`, `rustup completions zsh`
print a script; docs tell you to `eval`/`source` it from your rc, or redirect
it into a file once. clap's dynamic mode is the same shape with an env-var
trigger instead of a subcommand: `source <(COMPLETE=bash myprog)`
([clap_complete::env](https://docs.rs/clap_complete/latest/clap_complete/env/index.html)),
and cargo nightly follows suit with `source <(CARGO_COMPLETE=bash cargo +nightly)`
([cargo unstable docs](https://doc.rust-lang.org/cargo/reference/unstable.html)).

clap's docs explicitly bless the eval-at-startup variant over the
write-to-file variant for the same reason our README does: the stub is
"self-correcting" — it can never drift from the installed binary.

*Cost:* every eval'd stub adds process spawns to shell startup (one `myprog
completion bash` each). Two or three of these are unnoticeable; shells with a
dozen become slow, which is why the ecosystem keeps moving toward №3.

## 2. Self-modifying installers (npm, fzf)

`npm completion >> ~/.bashrc` is the documented flow — the script detects it's
being run for install vs. being sourced. fzf ships an `install` script that
appends a line to your rc after asking. Convenient once, but rc-file mutation
is widely disliked (hard to uninstall, surprises dotfile managers). Nobody new
copies this pattern.

## 3. Drop a file in an autoload dir — no rc edit at all

This is the modern answer, and the key insight is **all three shells have a
directory where completions load on demand, with zero rc changes**:

| Shell | User dir | System/vendor dir | Loading |
|-------|----------|-------------------|---------|
| bash (bash-completion ≥ 2.x) | `~/.local/share/bash-completion/completions/<cmd>` (`$XDG_DATA_HOME`) | `$(prefix)/share/bash-completion/completions/<cmd>` | lazy — sourced on first TAB after `<cmd>` |
| zsh | any dir on `$fpath` before `compinit`; convention `~/.zfunc` or site `.../site-functions/_<cmd>` | `$(prefix)/share/zsh/site-functions/_<cmd>` | autoload — compinit maps `#compdef` at scan, body loads on first use |
| fish | `~/.config/fish/completions/<cmd>.fish` | `.../fish/vendor_completions.d/<cmd>.fish` | fully lazy — file found *by name* on first TAB |

Notes:
- bash requires the `bash-completion` 2.x package for the lazy dir (macOS
  ships without it; Homebrew's `bash-completion@2` provides it).
- zsh's dir is lazy-ish but `compinit` must run after `fpath` is set — the one
  rc prerequisite most zsh users already have.
- fish is the gold standard: nothing to configure, ever, and the filename *is*
  the registration.
- Even cargo's nightly instructions for bash say to put the `source <(...)`
  line **inside** `~/.local/share/bash-completion/completions/cargo` — using
  the lazy dir as a trampoline so the binary is only spawned on first `cargo <TAB>`,
  not at shell startup. That's the best of №1 and №3 combined.

## 4. Package manager does it (Homebrew, deb/rpm, cargo-dist)

On this machine, `gh`'s Homebrew formula installed all three at build time —
no user action whatsoever:

```
/opt/homebrew/share/zsh/site-functions/_gh
/opt/homebrew/etc/bash_completion.d/gh
/opt/homebrew/share/fish/vendor_completions.d/gh.fish
```

Formulas call `generate_completions_from_executable(bin/"gh", "completion", "-s")`.
Debian/Fedora packages do the same into `/usr/share/...`. This is safe *even
though the files are static snapshots* precisely because the dynamic protocol
makes the stub a thin adapter: everything interesting happens in
`gh __complete` at runtime, so the vendored stub only goes stale if the stub
format itself changes — rare — not when commands/flags change.

**This is the strongest practical argument for the dynamic-protocol design**:
it makes completions *distributable*. A static clap script (uv's is 215 KB of
generated bash) must be regenerated on every release; a Cobra-style stub
almost never changes.

## 5. Self-installing `completion install` subcommands

A few tools detect the right dir and write the file for you: `broot --install`,
`carapace`, various npm CLIs via [tabtab](https://github.com/mklabs/node-tabtab)
(writes a loader script + rc line). Python's argcomplete goes furthest with
`activate-global-python-argcomplete`, registering a bash *default* completer
(`complete -D`) that dynamically dispatches any python script — global, but
invasive.

### Case study: pnpm and the tabtab fork (verified locally + docs)

pnpm maintains [pnpm/tabtab](https://github.com/pnpm/tabtab), the live fork of
node-tabtab, and its history is a lesson in how far auto-install can go and
where it retreats to:

**tabtab's install mechanism** (the most refined rc-mutation design around):

- Writes each tool's stub under a central dir: `~/.config/tabtab/bash/<tool>.bash`.
- Maintains one loader, `~/.config/tabtab/__tabtab.bash`, that sources every
  stub in the dir.
- Appends exactly **one line, once, ever** to the rc:
  `[ -f ~/.config/tabtab/__tabtab.bash ] && . ~/.config/tabtab/__tabtab.bash || true`
  Subsequent tools install by dropping a file — no further rc edits. There's a
  programmatic `uninstall({ name })` too.

So it converges on the same shape as the shells' native autoload dirs (№3),
just tool-owned — an admission that "a directory of stubs + one hook" is the
correct architecture, built for the era before bash-completion's lazy dir was
widespread.

**What pnpm actually does today (v9+):** it *dropped* the interactive
`pnpm install-completion` and went back to print-and-redirect
([pnpm.io/completion](https://pnpm.io/completion)):

```sh
pnpm completion fish > ~/.config/fish/completions/pnpm.fish   # autoload dir, zero rc
pnpm completion bash > ~/completion-for-pnpm.bash             # + one source line in .bashrc
```

**Runtime protocol notes** (from `pnpm completion bash` on this machine): the
stub re-invokes `pnpm completion-server -- "${words[@]}"` with the request in
env vars (`COMP_CWORD`, `COMP_LINE`, `COMP_POINT`, `SHELL=bash`), and file
completion is signaled by the *magic candidate string*
`__tabtab_complete_files__` — an in-band sentinel where Cobra (and we) have
the out-of-band `:<directive>` line. It also leans on bash-completion helpers
when present (`_get_comp_words_by_ref -n = -n @ -n :` for wordbreaks —
cleaner than our global `COMP_WORDBREAKS` edit, degrading gracefully when
absent).

**Takeaways for best-in-class install:**

1. fish: autoload dir, always, even pnpm agrees. No rc line exists.
2. bash/zsh: prefer the native autoload dirs when present
   (bash-completion lazy dir / fpath); they made tabtab's custom loader
   obsolete.
3. If offering auto-install (`myprog completion install`), copy tabtab's
   discipline: stubs in an owned dir, at most one idempotent rc line, a
   working uninstall. Never append per-tool lines.
4. pnpm's retreat from auto-install to documented one-liners suggests the
   interactive installer wasn't worth its support burden — a `--install` flag
   should be additive, with print-to-stdout remaining the primary interface.

## Recommendation for shell-complete

Keep `script()` as the primitive, but document (and optionally provide) the
tiered story:

1. **fish**: `myprog completion fish > ~/.config/fish/completions/myprog.fish`
   — better default than `config.fish` sourcing; zero startup cost, standard
   location.
2. **zsh**: `myprog completion zsh > ~/.zfunc/_myprog` (stub already starts
   with `#compdef`, so it works as an autoloaded function file *and* as an
   eval — Cobra's does the same). Keep the eval one-liner for users who don't
   manage fpath.
3. **bash**: `myprog completion bash > ~/.local/share/bash-completion/completions/myprog`
   when bash-completion 2.x is present; eval line otherwise.
4. Consider a `completion --install` helper that does the above detection —
   that's the frontier of "how far others go" without touching rc files.
5. For packagers: document the Homebrew `generate_completions_from_executable`
   one-liner in the README; it's free adoption.

One caveat to fix first: our bash stub mutates `COMP_WORDBREAKS` globally at
source time (stubs.ts:50-51). Fine for an eval in one user's rc; rude for a
file installed system-wide (it changes word splitting for *every* completion
in the session). Cobra instead leaves `COMP_WORDBREAKS` alone and trims the
offending prefix from each `COMPREPLY` entry after the fact
(`__prog_handle_special_char` in bash_completionsV2.go) — worth adopting
before recommending file installation.

## Sources

- [clap_complete env docs](https://docs.rs/clap_complete/latest/clap_complete/env/index.html)
- [Cargo unstable features — native-completions](https://doc.rust-lang.org/cargo/reference/unstable.html), [tracking issue #14520](https://github.com/rust-lang/cargo/issues/14520)
- [bash-completion README](https://github.com/scop/bash-completion) (lazy-load dirs)
- Local: Homebrew vendor dirs listing (July 2026)
