# Should the engine filter on `toComplete`?

Question: if user code returns candidates without filtering against
`toComplete`, should shell-complete filter for them?

## What each layer does today

**Cobra, program side** (verified in completions.go): Cobra prefix-filters the
candidates *it* generates — subcommand names, flag names, `ValidArgs` — with
`strings.HasPrefix(..., toComplete)`. But results from a user's
`ValidArgsFunction` are appended **as-is**; filtering them is documented as
the function's job. So Cobra's contract matches ours: the callback should
filter. (Observable: `gh __complete pr "ch"` returns only `checkout`/`checks` —
that's Cobra's built-in subcommand filter, not gh code.)

**Cobra, shell side** — this is the part that makes unfiltered functions
mostly harmless there:

| Shell | Client-side filtering |
|-------|----------------------|
| bash (Cobra V2 script) | **yes** — `compgen -W "${completions[*]}" -- "$cur"` re-filters everything |
| zsh | via zsh itself — `_describe`→`compadd` applies the user's matcher rules |
| fish (Cobra script) | **yes** — `string match -r "^$prefix.*"` in the script; fish also pager-filters natively |

**Our stubs today**: zsh and fish inherit shell-native filtering (`_describe`;
fish matches `-a` output against the current token). **bash does not**
(stubs.ts:32 fills `COMPREPLY` verbatim). This is a real bug, not a style
choice: readline *replaces the typed word* with the sole candidate or with the
longest common prefix of `COMPREPLY`. Type `myprog che<TAB>` against a
callback that returns all subcommands unfiltered and bash will happily rewrite
`che` to the common prefix of *all* of them (or cycle through wrong words with
menu-complete). Unfiltered candidates in bash aren't just noisy — they insert
wrong text.

## So there are really two questions

### 1. Must the bash stub filter? Yes.

Non-negotiable, independent of engine policy — Cobra's V2 script does exactly
this. Dependency-free version for stubs.ts:

```bash
# instead of: COMPREPLY+=("${line%%$'\t'*}")
local val=${line%%$'\t'*}
[[ $val == "$cur"* ]] && COMPREPLY+=("$val")
```

(or one `compgen -W` pass after the loop; either way `cur` is
`${COMP_WORDS[COMP_CWORD]}` — the word the stub already sends as
`toComplete`).

### 2. Should the *engine* (`handle()`/`respond()`) also filter? No — default off.

Arguments for engine-side filtering:

- Bulletproofs naive callbacks on all shells at once.
- Cheap: one `startsWith` pass.

Arguments against (why Cobra doesn't):

- **It defeats smarter shell matching.** zsh users with
  `matcher-list 'm:{a-z}={A-Za-z}'` get case-insensitive completion — but only
  if the case-mismatched candidates *reach* zsh. An engine that pre-filters
  with case-sensitive `startsWith` silently breaks that (and any
  substring/fuzzy matcher config). Same for bash `completion-ignore-case`.
  The shell is the only layer that knows the user's matching rules; the
  program should over-supply, shell disposes. Filter as late as possible.
- **Prefix isn't always the semantics.** Callbacks legitimately match on
  other axes: `git switch f<TAB>` might offer `feature/foo` for `foo`,
  version pickers match `1.2` inside `v1.2.3`, kubectl matches resource
  short-names. A forced engine prefix-filter would strip those before the
  shell sees them. (They render oddly in bash regardless — but that's the
  callback author's informed tradeoff, not the transport's.)
- **Cobra parity.** The wire contract stays "program sends what it wants,
  stubs/shell dispose". Every Cobra user's mental model transfers.

### Recommendation

1. Fix the bash stub to prefix-filter against `$cur` (Cobra V2 parity). This
   alone makes unfiltered callbacks safe everywhere, because zsh/fish already
   filter.
2. Keep `handle()` pass-through. Document the contract in the README the way
   Cobra does: *"your callback should filter using `toComplete` (usually
   `value.startsWith(toComplete)`); shells filter too, but don't rely on it."*
3. Optionally export a tiny helper so the lazy path is the correct path:
   `filterPrefix(items, toComplete)` — mirrors the `strings.HasPrefix` loop
   that appears in virtually every Cobra `ValidArgsFunction` in the wild.
4. If engine filtering is ever added, make it opt-in
   (`handle(fn, { filter: true })`), never default.

## One subtlety worth a test

Filtering interacts with `--flag=value` splitting: after the stub un-splits
`=` (or Cobra's `-P` flagPrefix handling in zsh), what the *shell* considers
the current word may be `--flag=val` while the program's `toComplete` is
`val`. Whichever layer filters must compare against the same string it will
ultimately insert — this is why Cobra's zsh script passes `-P "${BASH_REMATCH}"`
to compadd rather than prepending `--flag=` to candidates. Our PTY test
(test-completion.ts) should cover `--opt=v<TAB>` under the new bash filter.

## Sources

- [Cobra completions.go](https://github.com/spf13/cobra/blob/main/completions.go) — `HasPrefix` on built-ins; `ValidArgsFunction` results appended unfiltered
- [Cobra bash_completionsV2.go](https://github.com/spf13/cobra/blob/main/bash_completionsV2.go) — `compgen -W ... -- "$cur"`
- [Cobra fish_completions.go](https://github.com/spf13/cobra/blob/main/fish_completions.go) — `string match -r "^$prefix.*"`
- Local: `gh __complete pr "ch"` (captured, July 2026)
