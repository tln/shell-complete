# shell-complete research notes

Deep-dives written July 2026, verified against Cobra `main`, clap_complete
docs, and live experiments with gh / kubectl / uv on this machine.

- **[api-design.md](api-design.md)** — per-directive audit (can `Default`/
  `NoFileComp`/`FilterDirs` carry values? why?) and a proposed zero-import
  `Reply` API: bare array ⇒ `NoFileComp`, `files:` mode object replaces the
  filter directives, `noSpace`/`keepOrder` booleans, `Error` exists only as
  thrown exceptions. Wire format unchanged.
- **[directives.md](directives.md)** — what each `Directive` bit means, its Go
  lineage, and what `Error` is *for* (fail dark; don't fall back to files).
  Found gap: our stubs treat `Error` like an empty `Default`.
- **[file-filtering.md](file-filtering.md)** — why `FilterFileExt`/`FilterDirs`
  exist (native file-completion UX is unfakeable from the program), exactly how
  Cobra delegates them per shell, how clap does it instead, and an
  implementation order for us.
- **[installation.md](installation.md)** — the five tiers of completion
  installation in the wild, the per-shell zero-rc-edit autoload dirs, why the
  dynamic protocol makes vendored stubs safe (Homebrew), the pnpm/tabtab case
  study (central stub dir + single idempotent rc line; pnpm v9 retreated from
  auto-install back to print-and-redirect), and what to recommend
  before/instead of rc editing. Found gap: our bash stub's global
  `COMP_WORDBREAKS` mutation blocks file-based installation.
- **[filtering.md](filtering.md)** — should we filter on `toComplete` when
  user code doesn't? Answer: the *bash stub* must (real insertion bug today);
  the *engine* must not (defeats zsh/bash case-insensitive & fuzzy matchers;
  Cobra parity); ship a `filterPrefix` helper.
- **[testing-in-the-wild.md](testing-in-the-wild.md)** — canonical testbeds:
  gh + kubectl for Cobra (wire commands you can run right now), cargo nightly
  for clap dynamic, uv/rg for clap static; comparison matrix to exercise.

## Actionable findings (extracted)

1. **bash stub: filter `COMPREPLY` against `$cur`** — unfiltered callbacks
   currently insert wrong text in bash. (filtering.md)
2. **bash+zsh stubs: honor `Error` (bit 1)** — return early, no file fallback.
   (directives.md)
3. **bash stub: replace global `COMP_WORDBREAKS` edit** with Cobra-style
   per-reply prefix trimming. (installation.md)
4. **Implement `FilterDirs` then `FilterFileExt`** for zsh (`_files -/`,
   `_files -g`) and bash (`compgen -d`, extglob `compgen -X`); fish degrades
   to plain files like Cobra. (file-filtering.md)
5. **Document autoload-dir installation** (fish completions dir, zsh fpath,
   bash-completion lazy dir) ahead of rc-eval; consider `completion --install`.
   (installation.md)
6. **Export `filterPrefix(items, toComplete)`** and document the
   callback-filters contract, Cobra-style. (filtering.md)
