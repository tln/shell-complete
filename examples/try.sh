#!/bin/sh
# Interactive helper: drop into a real shell with the `demo` CLI and its
# completion loaded, so you can tab around by hand.
#
#   sh examples/try.sh <bash|zsh|fish>              # source the stub (quick poke)
#   sh examples/try.sh <bash|zsh|fish> --install    # exercise install + autoload
#
# Runs against dist/, so build first if you edited sources:  npm run build
set -eu

shell=${1:-}
mode=${2:-}
case "$shell" in
  bash | zsh | fish) ;;
  *)
    echo "usage: sh examples/try.sh <bash|zsh|fish> [--install]" >&2
    exit 2
    ;;
esac

command -v "$shell" >/dev/null 2>&1 || {
  echo "$shell is not installed" >&2
  exit 1
}

# Locate the repo (this script lives in examples/) and the compiled demo.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$here/.." && pwd)
demo="$root/dist/examples/demo.js"
[ -f "$demo" ] || {
  echo "missing $demo — run: npm run build" >&2
  exit 1
}

tmp=$(mktemp -d "${TMPDIR:-/tmp}/shell-complete-try.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

hint="try: demo <TAB> | demo push --<TAB> | demo edit <TAB> | demo cd <TAB> | demo push --dir=<TAB>"
echo "demo -> node $demo"
echo "shell: $shell   mode: ${mode:-source}   scratch: $tmp"
echo

if [ "$mode" = "--install" ]; then
  # Isolated home so install writes into a throwaway autoload dir, and a real
  # `demo` on PATH so the installed completion can re-invoke it by name.
  export HOME="$tmp"
  export XDG_CONFIG_HOME="$tmp/.config"
  export XDG_DATA_HOME="$tmp/.local/share"
  mkdir -p "$tmp/bin"
  printf '#!/bin/sh\nexec node "%s" "$@"\n' "$demo" >"$tmp/bin/demo"
  chmod +x "$tmp/bin/demo"
  export PATH="$tmp/bin:$PATH"

  echo "=== demo completion $shell --install ==="
  demo completion "$shell" --install
  echo
  echo "Fresh $shell below (interactive, isolated \$HOME). $hint"
  echo "If it doesn't autoload, the hint above is the one line to add."
  echo
  "$shell" -i
  exit 0
fi

# --- source mode: shim demo + source the stub in a throwaway rc ---
node "$demo" completion "$shell" >"$tmp/stub.$shell"

case "$shell" in
  bash)
    rc="$tmp/bashrc"
    {
      echo "demo() { node \"$demo\" \"\$@\"; }"
      echo "source \"$tmp/stub.bash\""
      echo "echo '$hint'"
    } >"$rc"
    bash --noprofile --rcfile "$rc" -i
    ;;
  zsh)
    zdot="$tmp/zdot"
    mkdir -p "$zdot"
    {
      echo "demo() { node \"$demo\" \"\$@\"; }"
      echo "autoload -U compinit && compinit -u"
      echo "source \"$tmp/stub.zsh\""
      echo "echo '$hint'"
    } >"$zdot/.zshrc"
    env ZDOTDIR="$zdot" zsh -i
    ;;
  fish)
    setup="$tmp/setup.fish"
    {
      echo "function demo; node \"$demo\" \$argv; end"
      echo "source \"$tmp/stub.fish\""
      echo "echo '$hint'"
    } >"$setup"
    fish -i -C "source $setup"
    ;;
esac
