/**
 * PTY SMOKE-TEST GATE — the regression this whole refactor exists to kill.
 *
 * The `setup` wizard is INTERACTIVE and, before the single-Ink-app rewrite, mixed
 * an Ink runtime with a readline `Console`. Both bound `process.stdin` in raw
 * mode; when an Ink screen unmounted, its raw-mode teardown left readline dead, so
 * the NEXT prompt hit EOF and the process EXITED SILENTLY (code 0). Symptom on a
 * real terminal: pick an item in the main menu -> "Session name to manage" prints
 * -> the app vanishes. Unit tests NEVER caught it because ink-testing-library uses
 * a FAKE stdin and the readline prompts were never driven on a real TTY.
 *
 * So this test drives the BUILT binary through a REAL pseudo-terminal (node-pty)
 * and asserts the fix STRUCTURALLY: after selecting a menu item the next screen
 * renders AND the process is still alive a beat later (the exact assertion that
 * failed against the readline version — verified: a silent-exit stub makes it go
 * red). It is headless (no human, no real terminal needed) and part of the
 * permanent suite: `beforeAll` compiles `dist` so it always runs against fresh
 * output; the `test:pty` npm script builds first too.
 *
 * PTY DRIVER: node-pty (its native addon builds and loads in this sandbox). The
 * `/usr/bin/expect` fallback is available but NOT needed.
 */
import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawn, type IPty } from 'node-pty';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

// tests/e2e/setup-pty.test.ts -> repo root is two levels up.
const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const BIN = join(ROOT, 'dist', 'presentation', 'cli', 'main.js');
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

// ESC built at runtime so the ANSI regex/keystrokes carry no literal control
// character (keeps `no-control-regex` / source hygiene happy).
const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const ENTER = '\r';

// Strip CSI sequences + charset/other single-char escapes so text assertions
// match the glyphs Ink actually painted, not the cursor choreography around them.
const ANSI = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}[()][0-9A-Za-z]|${ESC}[=>]`,
  'g',
);
const strip = (raw: string): string => raw.replace(ANSI, '');

const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * A PTY-scoped environment: a throwaway session/config dir, colour disabled.
 * CI-detection variables are STRIPPED: Ink (via is-in-ci) suppresses interactive
 * frame painting when it sees them, and this suite exists to test the app as an
 * interactive terminal — the PTY, not the CI host, is the environment under test.
 */
const ptyEnv = (sessionDir: string): Record<string, string | undefined> => {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        key !== 'CI' &&
        key !== 'CONTINUOUS_INTEGRATION' &&
        !key.startsWith('CI_') &&
        !key.startsWith('GITHUB_'),
    ),
  );
  return {
    ...inherited,
    TERM: 'xterm-256color',
    NO_COLOR: '1',
    TELEGRAM_MCP_SESSION_DIR: sessionDir,
    TELEGRAM_MCP_CONFIG: join(sessionDir, 'telegram-mcp.config.json'),
  };
};

/** A live PTY-driven `setup` run: accumulates output, tracks exit, drives keys. */
interface PtyRun {
  readonly term: IPty;
  output(): string;
  exited(): boolean;
  exitCode(): number | undefined;
  write(data: string): void;
  waitForText(needle: string, timeoutMs?: number): Promise<boolean>;
  waitForExit(timeoutMs?: number): Promise<number | undefined>;
  kill(): void;
}

// Live handles cleaned up after every test (kill strays, delete temp dirs).
const openRuns: PtyRun[] = [];
const tempDirs: string[] = [];

const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-pty-'));
  tempDirs.push(dir);
  return dir;
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'EPERM'
    );
  }
};

/** Stop the detached daemon that setup auto-started for this throwaway store. */
const stopTestDaemon = async (sessionDir: string): Promise<void> => {
  const ownerPath = join(sessionDir, '.daemon-running', 'owner');
  if (!existsSync(ownerPath)) return;
  const raw = readFileSync(ownerPath, 'utf8').trim();
  const match = /^([1-9]\d*):[a-f0-9]{32}$/.exec(raw);
  if (match === null) {
    throw new Error(`invalid test daemon owner in ${ownerPath}`);
  }
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid)) {
    throw new Error(`invalid test daemon PID in ${ownerPath}`);
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'ESRCH'
    ) {
      return;
    }
    throw error;
  }
  const deadline = Date.now() + 5_000;
  while (processIsAlive(pid) && Date.now() < deadline) await delay(25);
  if (processIsAlive(pid)) {
    process.kill(pid, 'SIGKILL');
    throw new Error(`test daemon ${String(pid)} did not stop after SIGTERM`);
  }
};

/** Spawn `node dist/.../main.js <args...>` inside an 80x30 xterm PTY. */
const spawnSetup = (args: readonly string[], sessionDir: string): PtyRun => {
  const term = spawn(process.execPath, [BIN, ...args], {
    name: 'xterm-256color',
    cols: 80,
    rows: 30,
    cwd: sessionDir,
    env: ptyEnv(sessionDir),
  });

  let buffer = '';
  let hasExited = false;
  let code: number | undefined;

  term.onData((chunk) => {
    buffer += chunk;
  });
  term.onExit((event) => {
    hasExited = true;
    code = event.exitCode;
  });

  const run: PtyRun = {
    term,
    output: () => strip(buffer),
    exited: () => hasExited,
    exitCode: () => code,
    write: (data) => {
      term.write(data);
    },
    waitForText: async (needle, timeoutMs = 8000) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (strip(buffer).includes(needle)) return true;
        if (hasExited) return strip(buffer).includes(needle);
        await delay(50);
      }
      return strip(buffer).includes(needle);
    },
    waitForExit: async (timeoutMs = 8000) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (hasExited) return code;
        await delay(50);
      }
      return hasExited ? code : undefined;
    },
    kill: () => {
      if (!hasExited) term.kill();
    },
  };
  openRuns.push(run);
  return run;
};

beforeAll(() => {
  // Compile `dist` so the PTY always drives fresh output (the gate must reflect
  // the current source). Runs the local tsc directly — no reliance on npm/PATH.
  execFileSync(
    process.execPath,
    [TSC, '-p', join(ROOT, 'tsconfig.build.json')],
    { cwd: ROOT, stdio: 'pipe' },
  );
  expect(existsSync(BIN)).toBe(true);
}, 180000);

afterEach(async () => {
  const runs = openRuns.splice(0);
  for (const run of runs) run.kill();
  await Promise.all(runs.map((run) => run.waitForExit(2_000)));

  const dirs = tempDirs.splice(0);
  for (const dir of dirs) {
    await stopTestDaemon(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('setup wizard over a real PTY (raw-mode-handoff regression)', () => {
  it(
    'main menu -> select opens the next screen AND stays alive; typing advances it',
    async () => {
      const run = spawnSetup(['setup'], freshDir());

      // The single Ink app mounts and paints the main menu.
      expect(await run.waitForText('Secure Telegram MCP — setup')).toBe(true);

      // A fresh dir = logged-out home menu ([Log in, Quit]); Enter selects the
      // first item, "Log in".
      run.write(ENTER);

      // ASSERTION 1 (the exact regression): the NEXT screen — the api_id text
      // prompt — renders...
      expect(await run.waitForText('api_id')).toBe(true);
      // ...and the process is STILL ALIVE a beat later. Against the old readline
      // version the prompt printed and the process then exited 0 — this is the
      // line that catches the silent-exit bug.
      await delay(800);
      expect(run.exited()).toBe(false);

      // ASSERTION 2: type an api_id + Enter and the flow ADVANCES to the next
      // prompt (api_hash), still without exiting — proving the menu->text->text
      // stdin handoff works.
      run.write('123456');
      await delay(200);
      run.write(ENTER);
      expect(await run.waitForText('api_hash')).toBe(true);
      await delay(300);
      expect(run.exited()).toBe(false);

      run.kill();
    },
    30000,
  );

  it(
    'main menu -> Quit exits cleanly with code 0',
    async () => {
      const run = spawnSetup(['setup'], freshDir());
      expect(await run.waitForText('Secure Telegram MCP — setup')).toBe(true);

      // Logged-out home menu is [Log in, Quit] — Down once to "Quit", Enter.
      run.write(DOWN);
      await delay(150);
      run.write(ENTER);

      // ASSERTION 3: the app unmounts and the process exits promptly, code 0.
      expect(await run.waitForExit(10000)).toBe(0);
    },
    30000,
  );

  it('non-TTY setup prints the plan and exits non-zero without hanging', () => {
    const dir = freshDir();
    // No PTY: stdin/stderr are pipes, so `isInteractiveTty()` is false. Setup
    // must print the plan and exit non-zero rather than block on stdin.
    const result = spawnSync(process.execPath, [BIN, 'setup'], {
      cwd: dir,
      env: ptyEnv(dir),
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // ASSERTION 4: it terminated on its own (no timeout-kill) with a non-zero
    // code, and wrote the plan to STDERR (STDOUT stays protocol-clean).
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
