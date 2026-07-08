import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as stubs from './stubs';
import { Shell } from './stubs';

export { stubs };
export type { Shell };

// A completion candidate: a bare string, or a value with an optional
// description (single line; anything past the first newline is dropped).
// `noSpace` marks this candidate as one the user keeps typing
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
//   serialize(['a'])                      -> 'NODEFAULT\na\n'
//   serialize(undefined)                  -> 'DEFAULT\n'
//   serialize({ items, default: true })   -> 'DEFAULT\n<item lines>\n'
//   serialize({ ext: ['md'] })            -> 'EXT\nmd\n'
//   serialize({ dirs: true, in: 'x' })    -> 'DIRS\nx\n'
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
      } else {
        // The wire format is one candidate per line, so a multi-line
        // description would be read as extra candidates: keep its first line.
        const description = it.description && it.description.split(/\r?\n/, 1)[0];
        lines.push(description ? it.value + '\t' + description : it.value);
      }
    }
  }
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
  // The rc one-liner that regenerates the stub each shell startup — spawns
  // the program every startup; prefer install() where that's too slow.
  // `args` is how *your* CLI prints the stub (default: 'completion <shell>'):
  //   bash/zsh:  eval "$(myprog completion zsh)"
  //   fish:      myprog completion fish | source
  source(...args: string[]): string;
  // Where install() writes: the shell's per-user autoload dir (fish: always
  // loads; bash: loads under bash-completion 2.x; zsh: loads when the dir is
  // on fpath before compinit). When autoload doesn't work, the same file is
  // the target of the one-line rc fix, so the path is meaningful either way.
  installPath: string;
  // Why the shell may not autoload installPath, with the one rc line that
  // fixes it — or undefined when autoload will just work. Probed lazily on
  // first access (spawns the shell once, rc files included) and cached.
  // Reading it never touches the filesystem; install() prints it.
  readonly installWarning: string | undefined;
  // Write the stub to installPath (creating directories), probe whether the
  // shell will load it, and report to opts.out (default stdout): the path,
  // plus — when autoload won't kick in — the rc line that activates it.
  // Returns the written path (as in 0.1.1; note it now also prints).
  install(opts?: { out?: Writable }): string;
}

// Ask the user's actual shell whether installPath will be consulted, by
// running it as an interactive login shell (so rc files are read, matching a
// real terminal) and printing a sentinel. fish needs no probe: the filename
// is the registration. Anything inconclusive is 'unknown', not a hard no —
// install() then shows the fix line without claiming the install is broken.
const SENTINEL = '__shell_complete_probe_';

function probeActivation(
  shell: Shell,
  installPath: string
): { active: boolean | 'unknown'; reason?: string } {
  if (shell === 'fish') return { active: true };

  const dir = path.dirname(installPath);
  const cmd =
    shell === 'bash'
      ? // set by bash-completion >= 2.8 when its lazy loader is live
        `echo ${SENTINEL}\${BASH_COMPLETION_VERSINFO[0]:-no}`
      : // compdef exists (compinit ran) + our dir's position in fpath (0 = absent)
        `print -r -- ${SENTINEL}\${+functions[compdef]}_\${fpath[(Ie)\$SHELL_COMPLETE_PROBE_DIR]}`;
  const r = cp.spawnSync(shell, ['-lic', cmd], {
    encoding: 'utf8',
    timeout: 5000,
    env: Object.assign({}, process.env, { SHELL_COMPLETE_PROBE_DIR: dir }),
  });
  // rc files may print anything; only trust the sentinel.
  const m = (r.stdout || '').match(new RegExp(SENTINEL + '(\\S*)'));
  if (r.error || !m) return { active: 'unknown' };

  if (shell === 'bash') {
    if (m[1] === 'no') {
      return { active: false, reason: 'bash-completion 2.x is not loaded in your bash' };
    }
    return { active: true };
  }
  const parts = m[1].match(/^(\d+)_(\d+)$/);
  if (!parts) return { active: 'unknown' };
  if (parts[2] === '0') return { active: false, reason: `${dir} is not on your zsh fpath` };
  if (parts[1] === '0') {
    // compinit prompts on insecure dirs and aborts without a terminal, so a
    // piped probe can miss a compinit that works fine in a real terminal.
    return { active: 'unknown', reason: 'could not verify that compinit runs in your zsh' };
  }
  return { active: true };
}

// The one rc line that activates an installed stub when autoload doesn't.
// Static — sourcing the stub only defines functions, so unlike evalSource it
// costs no program spawn at shell startup. The zsh stub self-boots compinit,
// so plain `source` works there too.
function fixLine(shell: Shell, installPath: string): string {
  return shell === 'bash'
    ? `[ -f "${installPath}" ] && . "${installPath}"`
    : `source "${installPath}"`;
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
  // Lazy probe: run at most once, on first installWarning read (or install()).
  let probed = false;
  let warning: string | undefined;
  const installWarning = (): string | undefined => {
    if (!probed) {
      probed = true;
      const p = probeActivation(shell, installPath);
      if (p.active !== true) {
        const rc = shell === 'zsh' ? '~/.zshrc' : '~/.bashrc';
        const why = p.reason || `could not verify that ${shell} will load it`;
        warning =
          `${why}; completions may not load in new shells.\n` +
          `To activate, add this line to ${rc}:\n` +
          `  ${fixLine(shell, installPath)}`;
      }
    }
    return warning;
  };
  return {
    shell,
    name,
    script,
    installPath,
    get installWarning(): string | undefined {
      return installWarning();
    },
    source(...args: string[]): string {
      const cmd = [name, ...(args.length ? args : ['completion', shell])].join(' ');
      return shell === 'fish' ? `${cmd} | source` : `eval "$(${cmd})"`;
    },
    install(installOpts?: { out?: Writable }): string {
      const out = (installOpts && installOpts.out) || process.stdout;
      fs.mkdirSync(path.dirname(installPath), { recursive: true });
      fs.writeFileSync(installPath, script);
      out.write(`installed ${shell} completion: ${installPath}\n`);
      const w = installWarning();
      if (w) out.write(w + '\n');
      return installPath;
    },
  };
}
