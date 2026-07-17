/**
 * Lane routing tests — the SSOT "which intent → which sink" contract, and the
 * promised fix that a developer DIAGNOSTIC never reaches a rendered frame.
 *
 *   Lane 1 (diagnostics) → the debug FILE only, ZERO re-renders, never a frame.
 *   Lane 2 (ephemeral status) → the bounded ring via the status setter.
 *   Lane 3 (must-read) → a BLOCKING 'notice' router request (its own screen).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';

import {
  SetupApp,
  SetupUiController,
} from '../../../src/presentation/cli/ink/run-setup-app.js';
import {
  debugLog,
  debugLogError,
} from '../../../src/infrastructure/setup-debug-log.js';
import type { StatusItem } from '../../../src/presentation/cli/ink/notification-model.js';
import type { SetupUi } from '../../../src/presentation/cli/ink/setup-ui-port.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 25));
const DIAGNOSTIC = 'PASSWORD_HASH_INVALID';

afterEach(() => {
  delete process.env['TELEGRAM_MCP_DEBUG_LOG'];
});

// ---------------------------------------------------------------------------
// Lane 1 — a diagnostic NEVER appears in ANY rendered frame, and lands in the FILE.
// ---------------------------------------------------------------------------

describe('lane 1 — developer diagnostics never reach a frame', () => {
  it('routes a wrong-password diagnostic to the debug FILE, never to any frame', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-diag-'));
    const logPath = join(dir, 'debug.log');
    process.env['TELEGRAM_MCP_DEBUG_LOG'] = logPath;

    try {
      const controller = new SetupUiController();
      // The flow mimics the account-login logger callback (lane 1) that used to
      // be `ui.note('[telegram] …')` — now a direct file-sink call — followed by a
      // real ephemeral status line the operator SHOULD see (lane 2).
      const flow = (ui: SetupUi): Promise<void> => {
        debugLog('[telegram]', DIAGNOSTIC);
        ui.notify('Logged in as Ada.');
        return Promise.resolve();
      };
      const r = render(
        <SetupApp
          controller={controller}
          run={flow}
          onComplete={vi.fn()}
          onInterrupt={vi.fn()}
        />,
      );
      await tick();

      // NEVER in ANY frame (frames.every is required — a scroll-off could pass a
      // lastFrame check alone).
      expect(r.frames.every((f) => !f.includes(DIAGNOSTIC))).toBe(true);
      expect(r.lastFrame() ?? '').not.toContain(DIAGNOSTIC);
      // But the operator-facing status DID reach the screen.
      expect(r.lastFrame() ?? '').toContain('Logged in as Ada.');
      // And the diagnostic went to the FILE.
      expect(readFileSync(logPath, 'utf8')).toContain(DIAGNOSTIC);
      if (process.platform !== 'win32') {
        expect(statSync(logPath).mode & 0o777).toBe(0o600);
      }
      r.unmount();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits arbitrary exception messages while retaining stack locations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-diag-error-'));
    const logPath = join(dir, 'debug.log');
    process.env['TELEGRAM_MCP_DEBUG_LOG'] = logPath;
    const credential = 'operator-pin-must-not-be-logged';

    try {
      expect(debugLogError('setup', new Error(credential))).toBe(true);
      const written = readFileSync(logPath, 'utf8');
      expect(written).toContain('setup: Error');
      expect(written).not.toContain(credential);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('setup host lifecycle', () => {
  it('gives the QR the whole frame without reserving an empty status lane', async () => {
    const controller = new SetupUiController();
    const never = new Promise<void>(() => undefined);
    const app = render(
      <SetupApp
        controller={controller}
        run={(ui) => {
          ui.notify('transient status must not consume QR rows');
          ui.showQr({
            title: 'Scan with Telegram',
            qr: 'QR-ROW-1\nQR-ROW-2',
            footer: ['URL: tg://login?token=demo'],
            expiresAtMs: Date.now() + 30_000,
          });
          return never;
        }}
        onComplete={vi.fn()}
        onInterrupt={vi.fn()}
      />,
    );
    await tick();

    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('QR-ROW-1');
    expect(frame).toContain('QR-ROW-2');
    expect(frame).not.toContain('transient status must not consume QR rows');
    app.unmount();
  });

  it('propagates flow failures to the composition root', async () => {
    const controller = new SetupUiController();
    const onComplete = vi.fn();
    const failure = new Error('teardown failed');
    const app = render(
      <SetupApp
        controller={controller}
        run={() => Promise.reject(failure)}
        onComplete={onComplete}
        onInterrupt={vi.fn()}
      />,
    );
    await tick();

    expect(onComplete).toHaveBeenCalledWith({ ok: false, error: failure });
    app.unmount();
  });

  it('routes raw Ctrl-C to fail-stop even while async work is still pending', async () => {
    const controller = new SetupUiController();
    const onInterrupt = vi.fn();
    const never = new Promise<void>(() => undefined);
    const app = render(
      <SetupApp
        controller={controller}
        run={() => never}
        onComplete={vi.fn()}
        onInterrupt={onInterrupt}
      />,
    );
    await tick();

    app.stdin.write('\u0003');
    await tick();

    expect(onInterrupt).toHaveBeenCalledOnce();
    app.unmount();
  });
});

// ---------------------------------------------------------------------------
// Lanes 2/3 — the controller routes each intent to a DISTINCT sink (no render).
// ---------------------------------------------------------------------------

describe('SetupUiController — intent routing', () => {
  it('notify() pushes a status item; notice() emits a blocking screen; never crossed', async () => {
    const emitted: unknown[] = [];
    const pushed: StatusItem[] = [];
    const controller = new SetupUiController();
    controller.bind(
      (req) => emitted.push(req),
      (item) => pushed.push(item),
    );

    // Lane 2: ephemeral status → the status setter, NOT the router.
    controller.notify('Logged in as Ada.');
    expect(pushed).toEqual([{ id: 0, text: 'Logged in as Ada.' }]);
    expect(emitted).toHaveLength(0);

    // Lane 3: must-read → a blocking 'notice' router request that RESOLVES only
    // when the mounted screen acknowledges (proving it awaits acknowledgment).
    let resolved = false;
    const done = controller
      .notice({ title: 'HARDENED posture — PIN file setup', body: ['umask 077; …'] })
      .then(() => {
        resolved = true;
      });
    expect(emitted).toHaveLength(1);
    const req = emitted[0] as {
      kind: string;
      request: { title: string };
      resolve: () => void;
    };
    expect(req.kind).toBe('notice');
    expect(req.request.title).toContain('HARDENED');
    expect(resolved).toBe(false); // still blocking
    // A must-read never leaked into the ephemeral ring.
    expect(pushed).toHaveLength(1);

    req.resolve(); // operator presses Enter
    await done;
    expect(resolved).toBe(true);
    // Resolving clears the active screen (emit(undefined)).
    expect(emitted[emitted.length - 1]).toBeUndefined();
  });
});
