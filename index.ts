import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as stubs from './stubs';
import { Shell } from './stubs';

export { stubs };
export type { Shell };

// A completion candidate: a bare string, or a value with an optional
// description. `noSpace` marks this candidate as one the user keeps typing
// into (e.g. `--flag=`, `host:`): no space is appended after inserting it,
// even when other candidates in the same reply do get one.
export type Item = string | { value: string; description?: string; noSpace?: boolean };

// Candidates to offer, in this order (the shell's sort is suppressed;
// pre-sort the array if you want alphabetical):
//   items      the candidates
//   default    true = also let the shell do its default (file) completion,
//              e.g. for name-or-path arguments
export interface ItemsReply {
  items?: Item[];
  default?: boolean;
}

// Delegate to the shell's own file completion, constrained. Not combinable
// with items — the payload lines *are* the filter arguments.
export interface ExtReply {
  ext: string[]; // only files with these extensions (shells still offer dirs to descend)
}
export interface DirsReply {
  dirs: true; // directories only ...
  in?: string; // ... inside this directory
}

export type ReplyObject = ItemsReply | ExtReply | DirsReply;

// What a `complete` callback may return:
//   ['a', 'b']            candidates, nothing else (wire: NODEFAULT)
//   []                    no matches — show nothing
//   nothing / null        no opinion — shell does its default (files)
//   { ... }               one of the ReplyObject shapes above
export type Reply = Item[] | ReplyObject | null | undefined | void;

// The user-supplied completion logic. May be sync or async.
export type CompleteFn = (words: string[], toComplete: string) => Reply | Promise<Reply>;

// Anything with a `write` — process.stdout, or a test sink.
export interface Writable {
  write(chunk: string): unknown;
}

export interface HandleOptions {
  out?: Writable;
}

// Serialize a Reply into the wire format.
//
//   serialize(['a'])                      -> 'NODEFAULT\na\nEOF\n'
//   serialize(undefined)                  -> 'DEFAULT\nEOF\n'
//   serialize({ items, default: true })   -> 'DEFAULT\n<item lines>\nEOF\n'
//   serialize({ ext: ['md'] })            -> 'EXT\nmd\nEOF\n'
//   serialize({ dirs: true, in: 'x' })    -> 'DIRS\nx\nEOF\n'
//
// Per-item noSpace uses git-completion's idiom: the NOSPACE flag can only say
// "no space for everyone", so when a reply mixes both kinds the space-wanting
// candidates get a literal trailing space — the inserted text then ends in a
// space anyway. (The fish stub strips the padding; fish adds its own space.)
export function serialize(reply: Reply): string {
  const lines: string[] = [];
  if (reply == null) {
    lines.push('DEFAULT');
  } else if ('ext' in reply && !Array.isArray(reply) && reply.ext && reply.ext.length) {
    lines.push('EXT');
    for (const ext of reply.ext) lines.push(ext);
  } else if ('dirs' in reply && !Array.isArray(reply) && reply.dirs) {
    lines.push('DIRS');
    if (reply.in) lines.push(reply.in);
  } else {
    const r: ItemsReply = Array.isArray(reply) ? { items: reply } : (reply as ItemsReply);
    let items = (r.items || []).filter((it) => it != null);
    const noSpace = (it: Item): boolean => typeof it === 'object' && !!it.noSpace;
    const anyNoSpace = items.some(noSpace);
    if (anyNoSpace && !items.every(noSpace)) {
      items = items.map((it) =>
        noSpace(it) ? it : typeof it === 'string' ? it + ' ' : { ...it, value: it.value + ' ' }
      );
    }
    lines.push((r.default ? 'DEFAULT' : 'NODEFAULT') + (anyNoSpace ? ' NOSPACE' : ''));
    for (const it of items) {
      if (typeof it === 'string') {
        lines.push(it);
      } else if (it.description) {
        lines.push(it.value + '\t' + it.description);
      } else {
        lines.push(it.value);
      }
    }
  }
  lines.push('EOF');
  return lines.join('\n') + '\n';
}

// Answer a completion request. The caller routes the request token itself and
// passes the arguments *after* it: `[proto, word..., toComplete]` — proto is
// the stub's `<shell>/<version>` stamp, and the final element is the
// (possibly empty) word under the cursor.
//
//   const [cmd, ...rest] = process.argv.slice(2);
//   if (cmd === REQUEST) return handle(complete, rest);
//
// A thrown exception answers NODEFAULT with no candidates (fail dark).
export async function handle(
  complete: CompleteFn,
  argv: string[],
  opts?: HandleOptions
): Promise<void> {
  const out = (opts && opts.out) || process.stdout;
  const rest = argv.slice(1); // drop the <shell>/<version> stamp
  const words = rest.slice(0, -1);
  const toComplete = rest.length ? rest[rest.length - 1] : '';
  let result: Reply;
  try {
    result = await complete(words, toComplete);
  } catch {
    out.write(serialize([]));
    return;
  }
  out.write(serialize(result));
}

export interface InstallationOptions {
  // The request token the stub re-invokes you with — the same one you route
  // to handle().
  request: string;
  // The command being completed; defaults to the invoked script's basename.
  name?: string;
  // Target shell; 'auto' (the default) guesses from $SHELL, falling back to
  // bash. $SHELL is the *login* shell, so pass the user's answer through when
  // you have one (e.g. `myprog completion zsh`).
  shell?: Shell | 'auto';
}

// Everything a CLI (or framework) needs to offer completion installation.
export interface Installation {
  shell: Shell; // resolved target shell
  name: string; // resolved program name
  script: string; // the stub itself — print it for the eval/source flow
  // The rc one-liner that regenerates the stub each shell startup. `args` is
  // how *your* CLI prints the stub (default: 'completion <shell>'):
  //   bash/zsh:  eval "$(myprog completion zsh)"
  //   fish:      myprog completion fish | source
  source(...args: string[]): string;
  // Where install() writes: the shell's per-user autoload dir, so completion
  // works with no rc edit (fish: always; bash: needs the bash-completion 2.x
  // package; zsh: ~/.zfunc must be on fpath before compinit).
  installPath: string;
  // Write the stub to installPath (creating directories) and return the path.
  install(): string;
}

function detectShell(): Shell {
  const sh = path.basename(process.env.SHELL || '');
  return sh === 'zsh' || sh === 'fish' ? sh : 'bash';
}

function defaultInstallPath(shell: Shell, name: string): string {
  const home = os.homedir();
  const xdgData = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  switch (shell) {
    case 'fish': // autoloaded by name, zero config
      return path.join(xdgConfig, 'fish', 'completions', name + '.fish');
    case 'bash': // bash-completion 2.x lazy-load dir
      return path.join(
        process.env.BASH_COMPLETION_USER_DIR || path.join(xdgData, 'bash-completion'),
        'completions',
        name
      );
    case 'zsh': // conventional user fpath dir; needs fpath+=~/.zfunc
      return path.join(home, '.zfunc', '_' + name);
  }
}

// Describe how completion for this program installs into a shell. The stub
// text, the rc one-liner, and the autoload-dir path/write are all derived
// from one place so they can't disagree.
//
//   installation({ request: '__complete' }).script          // print to eval
//   installation({ request: '__complete' }).install()       // write; -> path
export function installation(opts: InstallationOptions): Installation {
  const request = opts.request;
  if (!request) throw new Error('installation() needs the request token you route to handle()');
  let name = opts.name;
  if (name == null) {
    const argv1 = process.argv[1] || '';
    name = path.basename(argv1, path.extname(argv1));
  }
  if (!name) throw new Error('installation() could not derive a program name; pass one');
  const shell = !opts.shell || opts.shell === 'auto' ? detectShell() : opts.shell;

  const script = stubs.script(name, shell, request); // throws on unknown shell
  const installPath = defaultInstallPath(shell, name);
  return {
    shell,
    name,
    script,
    installPath,
    source(...args: string[]): string {
      const cmd = [name, ...(args.length ? args : ['completion', shell])].join(' ');
      return shell === 'fish' ? `${cmd} | source` : `eval "$(${cmd})"`;
    },
    install(): string {
      fs.mkdirSync(path.dirname(installPath), { recursive: true });
      fs.writeFileSync(installPath, script);
      return installPath;
    },
  };
}
