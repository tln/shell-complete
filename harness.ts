// Real completion test harness: drive an actual interactive shell through a
// pseudo-terminal, type a command line, press TAB, and capture what the shell
// renders. This exercises the true path — `complete`/`compdef` registration,
// the shell's own filtering, directive effects, and rendering — not just our
// completion function in isolation.
//
//   import { getCompletions, shellAvailable } from './harness';
//   await getCompletions('bash', 'demo push --');  // -> { candidates, raw }

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import * as pty from 'node-pty';
import * as ac from './index';
import { Shell } from './index';

const DEMO = path.join(__dirname, 'examples', 'demo.js');
const MARKER = '@@RDY@@'; // unique prompt marker delimiting shell states
const NODE = process.execPath;

export interface Completions {
  candidates: string[];
  raw: string;
}

export interface CompletionOpts {
  timeout?: number;
  files?: string[];
  dirs?: string[]; // directories to seed in the cwd (created recursively)
}

// node-pty ships a prebuilt `spawn-helper` that must be executable; some
// sandboxed installs skip the postinstall chmod. Fix it best-effort on load.
(function ensureHelperExecutable(): void {
  const base = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(base);
  } catch {
    return;
  }
  for (const d of dirs) {
    const helper = path.join(base, d, 'spawn-helper');
    try {
      fs.chmodSync(helper, 0o755);
    } catch {
      /* not present for this platform */
    }
  }
})();

// Remove ANSI escapes, carriage returns, backspaces, and bells so the captured
// terminal output is plain text we can parse.
export function clean(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/\x1b[\[\]][0-9;?]*[ -/]*[@-~]/g, '') // CSI sequences
    .replace(/\x1b[=>PX^_].*?(\x1b\\|\x07)/g, '')
    .replace(/\x1b[=>()][A-Za-z0-9]?/g, '')
    .replace(/[\x00\x07\x08]/g, '')
    .replace(/\r/g, '');
}

// Which shells are installed on this machine.
export function shellAvailable(shell: string): boolean {
  const bins = (process.env.PATH || '').split(path.delimiter);
  return bins.some((b) => {
    try {
      fs.accessSync(path.join(b, shell), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

interface Setup {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

// Build the per-shell spawn config: an isolated init that shims `demo` to the
// node script, sources our generated stub, sets a marker prompt, and turns on
// immediate ambiguous listing so a single TAB shows all candidates.
function shellSetup(shell: Shell, tmpdir: string): Setup {
  // Generate at the low level; the token must match the demo's routing.
  const stub = ac.stubs.script('demo', shell, '__complete');
  const demoShim =
    shell === 'fish'
      ? `function demo; ${NODE} ${DEMO} $argv; end`
      : `demo() { ${NODE} ${DEMO} "$@"; }`;

  if (shell === 'bash') {
    const rc = path.join(tmpdir, 'bashrc');
    fs.writeFileSync(
      rc,
      [
        'set +o history',
        'unset PROMPT_COMMAND',
        `PS1='${MARKER}'`,
        "bind 'set show-all-if-ambiguous on' 2>/dev/null",
        "bind 'set bell-style none' 2>/dev/null",
        "bind 'set completion-query-items 999' 2>/dev/null",
        "bind 'set page-completions off' 2>/dev/null",
        demoShim,
        stub,
        '',
      ].join('\n')
    );
    return { file: 'bash', args: ['--noprofile', '--rcfile', rc, '-i'], env: {} };
  }

  if (shell === 'zsh') {
    const zdot = path.join(tmpdir, 'zdot');
    fs.mkdirSync(zdot, { recursive: true });
    fs.writeFileSync(
      path.join(zdot, '.zshrc'),
      [
        'HISTFILE=/dev/null',
        'autoload -U compinit && compinit -u',
        'unsetopt LIST_BEEP',
        'setopt NO_ALWAYS_LAST_PROMPT', // keep listing above the redrawn prompt
        `PROMPT='${MARKER}'`,
        'zstyle ":completion:*" menu no',
        demoShim,
        stub,
        '',
      ].join('\n')
    );
    return { file: 'zsh', args: ['-i'], env: { ZDOTDIR: zdot } };
  }

  if (shell === 'fish') {
    const setup = path.join(tmpdir, 'setup.fish');
    fs.writeFileSync(
      setup,
      [
        `function fish_prompt; echo -n '${MARKER}'; end`,
        'function fish_right_prompt; end',
        'function fish_greeting; end',
        demoShim,
        stub,
        '',
      ].join('\n')
    );
    return { file: 'fish', args: ['-N', '-i', '-C', `source ${setup}`], env: {} };
  }

  throw new Error('unsupported shell: ' + shell);
}

// Parse the captured listing region into candidate values, per shell.
function parseCandidates(shell: Shell, region: string): string[] {
  const lines = clean(region).split('\n');
  // Drop the first line (the echoed command) and blank lines.
  const listing = lines.slice(1).filter((l) => l.trim() !== '' && l.indexOf(MARKER) === -1);
  const out: string[] = [];

  for (const line of listing) {
    let text = line;
    if (shell === 'zsh') {
      // "value  -- description"  -> value(s) before the separator
      const i = text.indexOf(' -- ');
      if (i !== -1) text = text.slice(0, i);
      for (const tok of text.trim().split(/\s+/)) if (tok) out.push(tok);
    } else if (shell === 'fish') {
      // pager rows: "value  (description)  value  (description)" — values and
      // parenthesized descriptions separated by 2+ spaces
      for (const tok of text.trim().split(/\s{2,}|\t/)) {
        if (tok && !/^\(.*\)$/.test(tok)) out.push(tok);
      }
    } else {
      // bash: no descriptions, candidates space/column separated
      for (const tok of text.trim().split(/\s+/)) if (tok) out.push(tok);
    }
  }
  return out;
}

// Drive one completion. Returns { candidates, raw }.
export function getCompletions(
  shell: Shell,
  line: string,
  opts: CompletionOpts = {}
): Promise<Completions> {
  const timeout = opts.timeout || 10000;
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-complete-'));
  // Optionally seed dirs/files in the cwd so file-completion is observable.
  for (const dir of opts.dirs || []) {
    fs.mkdirSync(path.join(tmpdir, dir), { recursive: true });
  }
  for (const name of opts.files || []) {
    fs.writeFileSync(path.join(tmpdir, name), '');
  }
  const setup = shellSetup(shell, tmpdir);

  const term = pty.spawn(setup.file, setup.args, {
    name: 'xterm-256color',
    cols: 200,
    rows: 60,
    cwd: tmpdir,
    env: Object.assign({}, process.env, { TERM: 'xterm-256color' }, setup.env),
  });

  let buf = '';
  const markerCount = (): number => buf.split(MARKER).length - 1;

  // fish 4 probes the terminal (kitty keyboard protocol, XTGETTCAP,
  // background color, cursor position, primary DA) and waits for the answers
  // before drawing/redrawing. Answer every query, every time.
  const answerTerminalQueries = (data: string): void => {
    const reply = (trigger: RegExp, response: string): void => {
      const m = data.match(trigger);
      for (let i = 0; i < (m ? m.length : 0); i++) term.write(response);
    };
    reply(/\x1b\[\?u/g, '\x1b[?0u');
    reply(/\x1b\]11;\?/g, '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\');
    reply(/\x1bP\+q[0-9a-fA-F;]*(\x1b\\|\x07)/g, '\x1bP0+r\x1b\\');
    reply(/\x1b\[6n/g, '\x1b[1;1R');
    reply(/\x1b\[0?c/g, '\x1b[?62c');
  };

  return new Promise<Completions>((resolve, reject) => {
    let done = false;
    const finish = <T>(fn: (arg: T) => void, arg: T): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        term.kill();
      } catch {
        /* already gone */
      }
      try {
        fs.rmSync(tmpdir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      fn(arg);
    };

    const timer = setTimeout(
      () =>
        finish(
          reject,
          new Error(`timed out waiting for completion (${shell})\n--- raw ---\n` + buf)
        ),
      timeout
    );

    let phase = 'boot'; // boot -> typed -> listed
    let regionStart = 0;
    let tabbed = false;
    let quiesce: ReturnType<typeof setTimeout> | undefined;

    const finishListed = (region: string): void => {
      phase = 'listed';
      const candidates = parseCandidates(shell, region);
      if (process.env.DEBUG_PTY) {
        process.stderr.write(`\n=== ${shell} raw region ===\n${JSON.stringify(region)}\n`);
      }
      finish(resolve, { candidates, raw: region });
    };

    term.onData((data: string) => {
      buf += data;
      answerTerminalQueries(data);

      if (phase === 'boot' && markerCount() >= 1) {
        phase = 'typed';
        regionStart = buf.length; // region begins after the first prompt
        term.write(line);
        // Small delay so the echo lands before TAB, then request completion.
        setTimeout(() => {
          tabbed = true;
          term.write('\t');
        }, 60);
        return;
      }

      if (phase !== 'typed') return;

      // bash/zsh redraw the marker prompt above/below the listing.
      if (markerCount() >= 2) {
        finishListed(buf.slice(regionStart, buf.lastIndexOf(MARKER)));
        return;
      }

      // fish repaints the pager in place without re-printing the prompt:
      // treat post-TAB output quiescence as "listing rendered".
      if (shell === 'fish' && tabbed) {
        if (quiesce) clearTimeout(quiesce);
        quiesce = setTimeout(() => finishListed(buf.slice(regionStart)), 350);
      }
    });

    term.onExit(() => {
      if (!done) finish(reject, new Error(`shell exited early (${shell})\n--- raw ---\n` + buf));
    });
  });
}

export { MARKER };
