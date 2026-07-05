'use strict';

// Directive-aware shell stubs. Each stub gathers the words up to the cursor,
// re-invokes the program with the hidden `__complete` request, then reads the
// `<value>\t<desc>` lines and the trailing `:<directive>` line and renders them
// natively. This is the per-shell adapter over the one wire protocol.
//
// Directive bits honored here: NoSpace(2), NoFileComp(4). FilterFileExt(8) and
// FilterDirs(16) are reserved (delegating typed file completion per shell is
// TODO); KeepOrder(32) is honored where the shell allows.

// A safe shell identifier for function names, derived from the program name.
function ident(name) {
  return '_' + String(name).replace(/[^A-Za-z0-9]/g, '_');
}

function bash(name, request) {
  const fn = ident(name) + '_complete';
  return `# bash completion for ${name}   -*- shell-script -*-
${fn}() {
    COMPREPLY=()
    # words after the program name, up to and including the (maybe empty) cursor word
    local words=("\${COMP_WORDS[@]:1:COMP_CWORD}")

    local out directive=0 line
    out="$(${name} ${request} "\${words[@]}" 2>/dev/null)"

    while IFS= read -r line; do
        case "$line" in
            '') ;;
            :*) directive="\${line#:}" ;;
            *)  COMPREPLY+=("\${line%%$'\\t'*}") ;;   # keep value, drop description (bash can't show it)
        esac
    done <<< "$out"

    if [ $(( directive & 2 )) -ne 0 ]; then          # NoSpace
        compopt -o nospace 2>/dev/null
    fi
    if [ $(( directive & 4 )) -ne 0 ]; then          # NoFileComp: suppress file fallback
        compopt +o default 2>/dev/null
    elif [ \${#COMPREPLY[@]} -eq 0 ]; then            # no candidates: allow file completion
        compopt -o default 2>/dev/null
    fi
}

# Treat --flag=value and host:path as single words. bash's default
# COMP_WORDBREAKS splits on '=' and ':', which breaks value completion; readline
# reads COMP_WORDBREAKS before calling the function, so this must run now, at
# source time. Note: it affects this shell session globally.
COMP_WORDBREAKS=\${COMP_WORDBREAKS//=}
COMP_WORDBREAKS=\${COMP_WORDBREAKS//:}
complete -o default -F ${fn} ${name}
`;
}

function zsh(name, request) {
  const fn = ident(name) + '_complete';
  return `#compdef ${name}
${fn}() {
    local -a response cands
    local directive=0 line val desc
    # words[1] is the program; send words[2..CURRENT] incl. the (maybe empty) cursor word
    local -a req
    req=("\${(@)words[2,CURRENT]}")

    response=("\${(@f)$(${name} ${request} "\${(@)req}" 2>/dev/null)}")

    for line in $response; do
        if [[ $line == :* ]]; then
            directive=\${line#:}
        elif [[ -n $line ]]; then
            val=\${line%%$'\\t'*}
            desc=\${line#*$'\\t'}
            if [[ $val == $desc ]]; then
                cands+=("$val")
            else
                cands+=("$val:$desc")
            fi
        fi
    done

    local -a flags
    (( (directive & 2) != 0 )) && flags+=(-S '')     # NoSpace
    if (( \${#cands} )); then
        _describe -t ${ident(name)} '${name}' cands $flags
    elif (( (directive & 4) == 0 )); then            # not NoFileComp: fall back to files
        _files
    fi
}
compdef ${fn} ${name}
`;
}

function fish(name, request) {
  const fn = ident(name) + '_complete';
  return `# fish completion for ${name}
function ${fn}
    set -l tokens (commandline -opc)   # tokens up to cursor, program name first
    set -l current (commandline -ct)   # the word under the cursor
    ${name} ${request} $tokens[2..-1] $current 2>/dev/null | while read -l line
        # fish reads value\\tdescription natively; just drop the directive marker
        string match -q -- ':*' $line; and continue
        test -n "$line"; and echo $line
    end
end
complete -c ${name} -f -a '(${fn})'
`;
}

const GENERATORS = { bash, zsh, fish };

// Return the stub for `shell`, or throw for an unknown shell.
function script(name, shell, request) {
  const gen = GENERATORS[shell];
  if (!gen) {
    throw new Error(
      `unknown shell "${shell}"; supported: ${Object.keys(GENERATORS).join(', ')}`
    );
  }
  return gen(name, request);
}

module.exports = { script, bash, zsh, fish, ident, shells: Object.keys(GENERATORS) };
