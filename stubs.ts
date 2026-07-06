// Shell stubs for the tagged wire protocol. Each stub gathers the words up to
// the cursor, re-invokes the program as
//
//   <prog> <request> <shell>/<PROTOCOL> <word...> <toComplete>
//
// and renders the reply natively. The reply is line-oriented:
//
//   <TYPE>[ <flag>...]        DEFAULT | NODEFAULT | EXT | DIRS; flag: NOSPACE
//   <payload line>*           candidates (value\tdesc) / extensions / a dir
//   EOF                       terminator; if absent the reply is discarded
//
// Semantics per type:
//   DEFAULT     offer the payload candidates; fall back to file completion
//               when none match (no payload = plain file completion)
//   NODEFAULT   offer the payload candidates and nothing else
//   EXT         shell-native file completion filtered to the payload extensions
//   DIRS        directories only, inside payload[0] if present
//
// Candidate order is always preserved (bash needs >= 4.4; older bash shows
// sorted). Unknown types render nothing, so newer programs degrade safely
// under older stubs.

export type Shell = 'bash' | 'zsh' | 'fish';

// Bumped when the request or reply format changes; sent by every stub so the
// program can serve stale installed stubs after an upgrade.
export const PROTOCOL = 1;

// A safe shell identifier for function names, derived from the program name.
export function ident(name: string): string {
  return '_' + String(name).replace(/[^A-Za-z0-9]/g, '_');
}

export function bash(name: string, request: string): string {
  const fn = ident(name) + '_complete';
  return `# bash completion for ${name}   -*- shell-script -*-

# Rebuild words/cword, re-joining tokens readline split on = or :
# (COMP_WORDBREAKS), so --flag=value and host:path reach the program whole.
${fn}_reassemble() {
    words=() cword=0
    local i tok
    for ((i = 0; i < \${#COMP_WORDS[@]}; i++)); do
        tok=\${COMP_WORDS[i]}
        if ((\${#words[@]})) && [[ $tok == [=:]* || \${words[\${#words[@]}-1]} == *[=:] ]]; then
            words[\${#words[@]}-1]+=$tok
        else
            words+=("$tok")
        fi
        ((i == COMP_CWORD)) && cword=$((\${#words[@]} - 1))
    done
}

${fn}() {
    local words cword
    ${fn}_reassemble
    local cur=\${words[cword]}

    local out line
    out="$(${name} ${request} bash/${PROTOCOL} "\${words[@]:1:cword}" 2>/dev/null)"

    local -a lines=()
    while IFS= read -r line; do lines+=("$line"); done <<< "$out"

    COMPREPLY=()
    compopt -o nosort 2>/dev/null                     # keep program order (bash >= 4.4)

    # a complete reply ends with the EOF guard; otherwise show nothing
    local n=\${#lines[@]}
    if ((n < 2)) || [[ \${lines[n-1]} != EOF ]]; then
        return
    fi
    local head=\${lines[0]}
    local -a payload=("\${lines[@]:1:n-2}")

    case \${head%% *} in
    DEFAULT|NODEFAULT)
        local val
        for line in "\${payload[@]}"; do
            val=\${line%%$'\\t'*}                      # drop description (bash can't show it)
            [[ $val == "$cur"* ]] && COMPREPLY+=("$val")
        done
        # readline completes only the text after the last = or : it split on;
        # drop that prefix from each candidate so it is not doubled
        local char prefix i
        for char in = :; do
            if [[ $cur == *$char* && $COMP_WORDBREAKS == *$char* ]]; then
                prefix=\${cur%"\${cur##*$char}"}
                for ((i = 0; i < \${#COMPREPLY[@]}; i++)); do
                    COMPREPLY[i]=\${COMPREPLY[i]#"$prefix"}
                done
            fi
        done
        if [[ \${head%% *} == DEFAULT ]]; then         # files as fallback
            compopt -o default 2>/dev/null
        fi
        if [[ $head == *NOSPACE* ]]; then
            compopt -o nospace 2>/dev/null
        fi
        ;;
    EXT)
        local ext
        for ext in "\${payload[@]}"; do
            while IFS= read -r line; do COMPREPLY+=("$line"); done \\
                < <(compgen -f -X "!*.$ext" -- "$cur")
        done
        while IFS= read -r line; do COMPREPLY+=("$line"); done < <(compgen -d -- "$cur")
        compopt -o filenames 2>/dev/null
        ;;
    DIRS)
        while IFS= read -r line; do COMPREPLY+=("$line"); done \\
            < <(cd "\${payload[0]:-.}" 2>/dev/null && compgen -d -- "$cur")
        compopt -o filenames 2>/dev/null
        ;;
    esac
}
complete -F ${fn} ${name}
`;
}

export function zsh(name: string, request: string): string {
  const fn = ident(name) + '_complete';
  return `#compdef ${name}
${fn}() {
    local -a lines req
    # words[1] is the program; send words[2..CURRENT] incl. the (maybe empty) cursor word
    req=("\${(@)words[2,CURRENT]}")
    lines=("\${(@f)$(${name} ${request} zsh/${PROTOCOL} "\${(@)req}" 2>/dev/null)}")

    # a complete reply ends with the EOF guard; otherwise show nothing
    (( \${#lines} >= 2 )) && [[ \${lines[-1]} == EOF ]] || return
    local head=\${lines[1]}
    local -a payload
    payload=("\${(@)lines[2,-2]}")

    case \${head%% *} in
    DEFAULT|NODEFAULT)
        local -a cands
        local line val desc
        for line in $payload; do
            val=\${line%%$'\\t'*}
            desc=\${line#*$'\\t'}
            val=\${val//:/\\\\:}                       # _describe separator
            if [[ $val == $desc || $line != *$'\\t'* ]]; then
                cands+=("$val")
            else
                cands+=("$val:$desc")
            fi
        done
        local -a copts
        [[ $head == *NOSPACE* ]] && copts+=(-S '')
        local ret=1
        if (( \${#cands} )); then
            _describe -V -t ${ident(name)} '${name}' cands $copts && ret=0
        fi
        if (( ret )) && [[ \${head%% *} == DEFAULT ]]; then
            _files                                    # fallback when nothing matched
        fi
        ;;
    EXT)
        local -a globs
        local ext
        for ext in $payload; do globs+=(-g "*.$ext"); done
        _files $globs
        ;;
    DIRS)
        if [[ -n \${payload[1]:-} ]]; then
            pushd -q \${payload[1]} 2>/dev/null || return
            _files -/
            popd -q
        else
            _files -/
        fi
        ;;
    esac
}
compdef ${fn} ${name}
`;
}

export function fish(name: string, request: string): string {
  const fn = ident(name) + '_complete';
  return `# fish completion for ${name}
#
# ${fn} runs as the completion *condition* (-n): it stashes candidates in a
# global and succeeds, or fails to make the -f rule inert so fish falls back
# to its native file completion (DEFAULT with no matches, EXT/DIRS).
function ${fn}
    set -g ${fn}_results
    set -l tokens (commandline -opc)   # tokens up to cursor, program name first
    set -l current (commandline -ct)   # the word under the cursor
    set -l lines (${name} ${request} fish/${PROTOCOL} $tokens[2..-1] $current 2>/dev/null)

    # a complete reply ends with the EOF guard; otherwise show nothing
    test (count $lines) -ge 2; or return 0
    test "$lines[-1]" = EOF; or return 0

    set -l payload
    if test (count $lines) -gt 2
        set payload $lines[2..-2]
    end

    set -l type (string split -m1 ' ' -- $lines[1])[1]
    switch $type
        case DEFAULT NODEFAULT
            for line in $payload
                # fish reads value\\tdescription natively and adds its own
                # space, so drop any NOSPACE padding
                set -a ${fn}_results (string trim --right -- $line)
            end
            if test "$type" = DEFAULT; and test (count $${fn}_results) -eq 0
                return 1                       # no candidates: native files
            end
            return 0
        case EXT
            if type -q __fish_complete_suffix
                for ext in $payload
                    set -a ${fn}_results (__fish_complete_suffix .$ext)
                end
                return 0
            end
            return 1                           # helper missing: plain files
        case DIRS
            if type -q __fish_complete_directories
                set -a ${fn}_results (__fish_complete_directories $current)
                return 0
            end
            return 1
        case '*'
            return 0                           # unknown tag: show nothing
    end
end
# -k: keep the program's candidate order
complete -k -c ${name} -f -n '${fn}' -a '$${fn}_results'
`;
}

const GENERATORS: Record<Shell, (name: string, request: string) => string> = { bash, zsh, fish };

export const shells: Shell[] = Object.keys(GENERATORS) as Shell[];

// Return the stub for `shell`, or throw for an unknown shell.
export function script(name: string, shell: Shell, request: string): string {
  const gen = GENERATORS[shell];
  if (!gen) {
    throw new Error(`unknown shell "${shell}"; supported: ${shells.join(', ')}`);
  }
  return gen(name, request);
}
