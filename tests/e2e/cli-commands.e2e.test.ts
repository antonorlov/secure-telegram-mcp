/**
 * The published CLI as a shell sees it: flags that must answer without a daemon, and the
 * version check that tells an operator the running daemon predates an upgrade.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { TelegramClient } from 'telegram';

import {
  hashEndpointToken,
  mintEndpointToken,
} from '../../src/infrastructure/endpoint-token.js';
import {
  daemonAddress,
  operatorAddress,
} from '../../src/infrastructure/index.js';
import { PACKAGE_VERSION } from '../../src/infrastructure/package-info.js';
import { E2EWorld } from '../_support/e2e-world.js';
import { FakeTelegramClient } from '../_support/fake-telegram-client.js';
import { readDaemonOwner, stopDetachedDaemon } from '../_support/detached-daemon.js';

const execFileAsync = promisify(execFile);
const CLI = join(process.cwd(), 'dist', 'presentation', 'cli', 'main.js');
const SCOPED_ID = 100;

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

describe.skipIf(process.platform === 'win32')('cli commands', () => {
  let world: E2EWorld;
  let stub: Server | undefined;

  beforeEach(async () => {
    world = await E2EWorld.create('tmcp-cli-');
  });

  afterEach(async () => {
    const running = stub;
    stub = undefined;
    if (running !== undefined) {
      await new Promise<void>((resolve) => {
        running.close(() => { resolve(); });
      });
    }
    await world.dispose();
  });

  // A non-zero exit is an outcome to assert here, not a failure of the helper.
  const cli = async (...args: string[]): Promise<CliRun> => {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
        env: world.childEnv({}),
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code?: unknown; stdout?: string; stderr?: string };
      if (typeof failed.code !== 'number') throw error;
      return { code: failed.code, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
    }
  };

  const nothingStarted = (): void => {
    expect(readDaemonOwner(world.sessionDir)).toBeUndefined();
    expect(existsSync(daemonAddress(world.sessionDir))).toBe(false);
  };

  describe('answers without a daemon', () => {
    // Inner hooks run before the outer dispose: a regression's detached daemon must not
    // outlive the case.
    afterEach(async () => {
      await stopDetachedDaemon(world.sessionDir).catch(() => undefined);
    });

    it.each(['--version', '-v'])('%s prints the package version alone', async (flag) => {
      const run = await cli(flag);

      expect(run).toEqual({ code: 0, stdout: `${PACKAGE_VERSION}\n`, stderr: '' });
      nothingStarted();
    }, 30_000);

    it.each(['--help', '-h'])('%s prints the usage to stdout and succeeds', async (flag) => {
      const run = await cli(flag);

      expect(run.code).toBe(0);
      expect(run.stderr).toBe('');
      expect(run.stdout).toContain('Commands:');
      expect(run.stdout).toContain('stop ');
      expect(run.stdout).toContain('-v, --version');
      nothingStarted();
    }, 30_000);

    it('prints the usage to stderr and fails when no command is given', async () => {
      const run = await cli();

      expect(run.code).toBe(1);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain('Commands:');
      nothingStarted();
    }, 30_000);

    it('names an unknown command and points at --help instead of guessing', async () => {
      const run = await cli('strat');

      expect(run.code).toBe(1);
      expect(run.stdout).toBe('');
      expect(run.stderr).toBe(
        "Unknown command 'strat'. Run 'npx secure-telegram-mcp --help' for usage.\n",
      );
      nothingStarted();
    }, 30_000);
  });

  describe('start reports the daemon version', () => {
    it('names the version it found running and raises no warning when it matches', async () => {
      const token = mintEndpointToken();
      await world.seal({
        config: {
          version: 1,
          endpoints: [
            {
              name: 'worker',
              session: 'acct',
              scope: { chats: [String(SCOPED_ID)], folders: [] },
              verbs: ['read'],
              tokenHash: hashEndpointToken(token),
            },
          ],
        },
        sessionRefs: ['acct'],
      });
      const fake = new FakeTelegramClient(SCOPED_ID);
      await world.startDaemon({
        clientFactory: () => fake as unknown as TelegramClient,
      });

      const run = await cli('start');

      expect(run.code).toBe(0);
      expect(run.stderr).toBe(`Telegram MCP ${PACKAGE_VERSION} is running.\n`);
    }, 30_000);

    /**
     * An older daemon is a different build, so a stub stands in for it on the operator socket.
     * It is exactly what a detached daemon left over from the previous release looks like.
     */
    it('warns, with the way out, when the running daemon is another version', async () => {
      await mkdir(world.sessionDir, { recursive: true, mode: 0o700 });
      const server = createServer((socket) => {
        socket.on('data', (chunk: Buffer) => {
          for (const line of chunk.toString('utf8').split('\n')) {
            if (line === '') continue;
            const { id } = JSON.parse(line) as { readonly id: string };
            socket.write(
              `${JSON.stringify({
                v: 1,
                id,
                ok: true,
                result: { posture: 'smooth', locked: false, hasAccounts: true, version: '0.0.1' },
              })}\n`,
            );
          }
        });
      });
      stub = server;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(operatorAddress(world.sessionDir), resolve);
      });

      const run = await cli('start');

      expect(run.code).toBe(0);
      expect(run.stderr).toBe(
        `Warning: Telegram MCP 0.0.1 is running, but this CLI is ${PACKAGE_VERSION}. ` +
          "To switch, run 'npx secure-telegram-mcp stop', then 'start' again.\n" +
          'Telegram MCP 0.0.1 is running.\n',
      );
    }, 30_000);
  });
});
