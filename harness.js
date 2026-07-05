'use strict';

// Real completion test harness: drive an actual interactive shell through a
// pseudo-terminal, type a command line, press TAB, and capture what the shell
// renders. This exercises the true path — `complete`/`compdef` registration,
// the shell's own filtering, directive effects, and rendering — not just our
// completion function in isolation.
//
//   const { getCompletions, shellAvailable } = require('./harness');
//   await getCompletions('bash', 'demo push --');  // -> { candidates, raw }

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const pty = require('node-pty');

const DEMO = path.join(__dirname, 'examples', 'demo.js');
const MARKER = '@@RDY@@'; // unique prompt marker delimiting shell states
const NODE = process.execPath;

// node-pty ships a prebuilt `spawn-helper` that must be executable; some
// sandboxed installs skip the postinstall chmod. Fix it best-effort on load.
(function ensureHelperExecutable() {
  const base = path.join(__dirname, 'node_modules', 'node-pty', 'prebuilds');
  let dirs = [];
  try {
    dirs = fs.readdirSync(base);
  } catch (e) {
    return;
  }
  for (const d of dirs) {
    const helper = path.join(base, d, 'spawn-helper');
    try {
      fs.chmodSync(helper, 0o755);
    } catch (e) {
      /* not present for this platform */
    }
  }
})();

// Remove ANSI escapes, carriage returns, backspaces, and bells so the captured
// terminal output is plain text we can parse.
function clean(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/\x1b[\[\]][0-9;?]*[ -/]*[@-~]/g, '') // CSI sequences
    .replace(/\x1b[=>PX^_].*?(\x1b\\|\x07)/g, '')
    .replace(/\x1b[=>()][A-Za-z0-9]?/g, '')
    .replace(/[\x00\x07\x08]/g, '')
    .replace(/\r/g, '');
}

// Which shells are installed on this machine.
function shellAvailable(shell) {
  try {
    cp.execFileSync('command', ['-v', shell]); // won't work; fall through
  } catch (e) {
    /* ignore */
  }
  const bins = (process.env.PATH || '').split(path.delimiter);
  return bins.some((b) => {
    try {
      fs.accessSync(path.join(b, shell), fs.constants.X_OK);
      return true;
    } catch (e) {
      return false;
    }
  });
}

// Build the per-shell spawn config: an isolated init that shims `demo` to the
// node script, sources our generated stub, sets a marker prompt, and turns on
// immediate ambiguous listing so a single TAB shows all candidates.
function shellSetup(shell, tmpdir) {
  const ac = require('./index');
  const stub = ac.script('demo', shell);
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
    return {
      file: 'zsh',
      args: ['-i'],
      env: { ZDOTDIR: zdot },
    };
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
    return {
      file: 'fish',
      args: ['-N', '-i', '-C', `source ${setup}`],
      env: {},
    };
  }

  throw new Error('unsupported shell: ' + shell);
}

// Parse the captured listing region into candidate values, per shell.
function parseCandidates(shell, region) {
  const lines = clean(region).split('\n');
  // Drop the first line (the echoed command) and blank lines.
  const listing = lines.slice(1).filter((l) => l.trim() !== '' && l.indexOf(MARKER) === -1);
  const out = [];

  for (const line of listing) {
    let text = line;
    if (shell === 'zsh') {
      // "value  -- description"  -> value(s) before the separator
      const i = text.indexOf(' -- ');
      if (i !== -1) text = text.slice(0, i);
      for (const tok of text.trim().split(/\s+/)) if (tok) out.push(tok);
    } else if (shell === 'fish') {
      // "value  (description)" one per line -> first field
      const tok = text.trim().split(/\s{2,}|\t/)[0].trim();
      if (tok) out.push(tok);
    } else {
      // bash: no descriptions, candidates space/column separated
      for (const tok of text.trim().split(/\s+/)) if (tok) out.push(tok);
    }
  }
  return out;
}

// Drive one completion. Returns { candidates, raw }.
function getCompletions(shell, line, opts) {
  opts = opts || {};
  const timeout = opts.timeout || 10000;
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-complete-'));
  // Optionally seed files in the cwd so file-completion fallback is observable.
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
  const markerCount = () => buf.split(MARKER).length - 1;

  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        term.kill();
      } catch (e) {
        /* already gone */
      }
      try {
        fs.rmSync(tmpdir, { recursive: true, force: true });
      } catch (e) {
        /* ignore */
      }
      fn(arg);
    };

    const timer = setTimeout(
      () => finish(reject, new Error(`timed out waiting for completion (${shell})\n--- raw ---\n` + buf)),
      timeout
    );

    let phase = 'boot'; // boot -> typed -> listed
    let regionStart = 0;

    term.onData((data) => {
      buf += data;

      if (phase === 'boot' && markerCount() >= 1) {
        phase = 'typed';
        regionStart = buf.length; // region begins after the first prompt
        term.write(line);
        // Small delay so the echo lands before TAB, then request completion.
        setTimeout(() => term.write('\t'), 60);
        return;
      }

      if (phase === 'typed' && markerCount() >= 2) {
        phase = 'listed';
        const region = buf.slice(regionStart, buf.lastIndexOf(MARKER));
        const candidates = parseCandidates(shell, region);
        if (process.env.DEBUG_PTY) {
          process.stderr.write(`\n=== ${shell} raw region ===\n${JSON.stringify(region)}\n`);
        }
        finish(resolve, { candidates, raw: region });
      }
    });

    term.onExit(() => {
      if (!done) finish(reject, new Error(`shell exited early (${shell})\n--- raw ---\n` + buf));
    });
  });
}

module.exports = { getCompletions, shellAvailable, clean, MARKER };
