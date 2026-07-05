'use strict';

// shell-complete — the thin completion engine.
//
// A framework-neutral implementation of Cobra's dynamic-completion contract:
// a shell stub re-invokes the program with a hidden `__complete` request, the
// program prints candidates plus a directive, and the stub renders them. All
// the "what completes here" logic lives in one place (a `complete` callback);
// each shell needs only a ~20-line stub (see stubs.js).
//
// Wire format the stubs read on stdout:
//   <value>\t<description>     one per line; the \t<description> is optional
//   :<directive>               final line, the directive bitfield as a number

const stubs = require('./stubs');

// The hidden subcommand a shell stub invokes: `prog __complete <words...>`.
const REQUEST = '__complete';

// Cobra-compatible ShellCompDirective bitfield. Combine with `|`.
const Directive = {
  Default: 0, // let the shell do its default (usually file completion)
  Error: 1, // an error occurred; the stub ignores all candidates
  NoSpace: 2, // don't append a space after a lone candidate (e.g. `--flag=`)
  NoFileComp: 4, // don't fall back to file completion when there are no candidates
  FilterFileExt: 8, // treat candidates as file-extension filters (delegated to shell)
  FilterDirs: 16, // complete directories only (delegated to shell)
  KeepOrder: 32, // preserve the program's order instead of letting the shell sort
};

// Is this process invocation a completion request from a shell stub?
function isRequest(argv) {
  argv = argv || process.argv.slice(2);
  return argv[0] === REQUEST;
}

// Parse a completion request into { words, toComplete }.
//
// The stub invokes `prog __complete <w1> <w2> ... <toComplete>`, where the
// final argument is the (possibly empty) word under the cursor. `words` are the
// already-completed words before it.
function parseRequest(argv) {
  argv = argv || process.argv.slice(2);
  const rest = argv.slice(1); // drop the leading '__complete'
  if (rest.length === 0) return { words: [], toComplete: '' };
  return { words: rest.slice(0, -1), toComplete: rest[rest.length - 1] };
}

// Serialize candidates + directive into the wire format, then write it.
//
// Each item is either a string, or { value, description }. Directive defaults
// to Directive.Default.
function respond(items, directive, out) {
  out = out || process.stdout;
  directive = directive == null ? Directive.Default : directive;
  const lines = [];
  for (const item of items || []) {
    if (item == null) continue;
    if (typeof item === 'string') {
      lines.push(item);
    } else if (item.description) {
      lines.push(item.value + '\t' + item.description);
    } else {
      lines.push(item.value);
    }
  }
  lines.push(':' + directive);
  out.write(lines.join('\n') + '\n');
}

// Runtime entry point. If argv is a completion request, run `complete` and
// print the reply; returns true (the caller should then exit before running
// its real logic). Otherwise returns false and does nothing.
//
//   complete(words, toComplete) -> { items, directive }
//
// `complete` may be sync or async, and may return a plain array of items (the
// directive then defaults to Default).
async function handle(complete, opts) {
  opts = opts || {};
  const argv = opts.argv || process.argv.slice(2);
  if (!isRequest(argv)) return false;

  const { words, toComplete } = parseRequest(argv);
  let result;
  try {
    result = await complete(words, toComplete);
  } catch (err) {
    respond([], Directive.Error, opts.out);
    return true;
  }
  if (Array.isArray(result)) result = { items: result };
  result = result || {};
  respond(result.items, result.directive, opts.out);
  return true;
}

// Produce the shell stub to be eval'd, e.g. `eval "$(prog completion zsh)"`.
function script(name, shell) {
  return stubs.script(name, shell, REQUEST);
}

module.exports = {
  Directive,
  REQUEST,
  isRequest,
  parseRequest,
  respond,
  handle,
  script,
  stubs,
};
