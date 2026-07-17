/**
 * run-setup-app — the single persistent Ink application for the whole setup wizard.
 *
 * One `render(<SetupApp/>)` owns `process.stdin` from the first main-menu frame to the
 * final "Goodbye": no readline `Console`, no second `render()` per prompt. The flow
 * (setup.ts) is handed a `SetupUi` and awaits screens; each call sets the app's active
 * request (router state) and the app renders the matching screen, resolving the promise
 * when the operator acts. Only one Ink runtime ever binds raw mode.
 *
 * The existing screens are reused as router spokes: the arrow-nav `MenuScreen`, the
 * pruned-tree `PickerScreen` + `ReviewScreen` (via `AccessPickerHost`), and the thin
 * `@inkjs/ui` input wrappers. Ink/React live only on this lazy path; `connect` never imports it.
 *
 * Renders to STDERR (the alt-screen guard likewise), keeping STDOUT reserved for the
 * copy-paste client-config block. On a non-TTY the guard is a no-op, but the flow never
 * mounts this app off a TTY (setup branches earlier).
 */
import { useEffect, useReducer, useState, type FC } from 'react';
import { Box, Text, render, useInput } from 'ink';
import {
  Spinner,
  ThemeProvider,
  defaultTheme as inkUiTheme,
  extendTheme,
} from '@inkjs/ui';

import { MenuScreen } from './screens/MenuScreen.js';
import { NoticeScreen } from './screens/NoticeScreen.js';
import { AccessPickerHost } from './run-access-picker.js';
import { LinePrompt, ConfirmPrompt } from './inputs/index.js';
import {
  AltScreenTerminalGuard,
  createProcessTerminalIo,
} from './terminal-guard.js';
import {
  classifyStatusTone,
  reduceStatus,
  STATUS_CAP,
  type StatusItem,
} from './notification-model.js';
import { colorProps, defaultTheme } from './theme.js';

/**
 * @inkjs/ui theme: its stock Spinner frame is ANSI `blue` — near-invisible on dark
 * terminals. Point the frame at our accent token instead; under NO_COLOR the token
 * is undefined and the frame renders in the terminal default like everything else.
 */
const inkUiBrandTheme = extendTheme(inkUiTheme, {
  components: {
    Spinner: {
      styles: {
        frame: () => colorProps(defaultTheme.color.cursor),
      },
    },
  },
});
import { debugLogError } from '../../../infrastructure/setup-debug-log.js';
import type { MenuRequest, MenuResult } from './ui-port.js';
import type {
  AccessPickerRequest,
  AccessPickerResult,
} from './run-access-picker.js';
import type {
  ConfirmPromptRequest,
  NoticeRequest,
  PasswordPromptRequest,
  PromptResult,
  QrRequest,
  SetupUi,
  TextPromptRequest,
} from './setup-ui-port.js';

// Router state — the discriminated "which screen is active" union. Exactly one is
// mounted at a time; `undefined` means the flow is between screens (or doing async work
// without a spinner), so only the transcript shows.

type ActiveRequest =
  | {
      readonly kind: 'menu';
      readonly request: MenuRequest<unknown>;
      readonly resolve: (result: MenuResult<unknown>) => void;
    }
  | {
      readonly kind: 'text';
      readonly request: TextPromptRequest;
      readonly resolve: (result: PromptResult<string>) => void;
    }
  | {
      readonly kind: 'password';
      readonly request: PasswordPromptRequest;
      readonly resolve: (result: PromptResult<string>) => void;
    }
  | {
      readonly kind: 'confirm';
      readonly request: ConfirmPromptRequest;
      readonly resolve: (result: PromptResult<boolean>) => void;
    }
  | {
      readonly kind: 'picker';
      readonly request: AccessPickerRequest;
      readonly resolve: (result: AccessPickerResult) => void;
    }
  | { readonly kind: 'busy'; readonly label: string }
  | { readonly kind: 'qr'; readonly request: QrRequest }
  | {
      readonly kind: 'notice';
      readonly request: NoticeRequest;
      readonly resolve: () => void;
    };

// The controller — the bridge between the outside-React async flow and the
// inside-React router state. The flow calls its `SetupUi` methods; each sets the active
// request via `emit` and returns a promise resolved by the mounted screen. The app
// binds `emit`/`pushStatus` on mount.

export class SetupUiController implements SetupUi {
  private emit: (request: ActiveRequest | undefined) => void = () => undefined;
  private pushStatus: (item: StatusItem) => void = () => undefined;
  /** Monotonic id source for status items — a stable React key across eviction. */
  private seq = 0;

  /** Wire the controller to the mounted app's state setters (called in an effect). */
  public bind(
    emit: (request: ActiveRequest | undefined) => void,
    pushStatus: (item: StatusItem) => void,
  ): void {
    this.emit = emit;
    this.pushStatus = pushStatus;
  }

  /**
   * The shared promise-router for every blocking screen request: publish the
   * ActiveRequest, then (when the mounted screen calls back) clear it and resolve the
   * awaited promise. The typed public methods below are one-line wrappers; the single
   * localized cast pins the per-`kind` request/resolve correlation the discriminated
   * union encodes.
   */
  private request<Res>(kind: ActiveRequest['kind'], request: unknown): Promise<Res> {
    return new Promise<Res>((resolve) => {
      this.emit({
        kind,
        request,
        resolve: (result: Res): void => {
          this.emit(undefined);
          resolve(result);
        },
      } as ActiveRequest);
    });
  }

  public menu<T>(request: MenuRequest<T>): Promise<MenuResult<T>> {
    return this.request<MenuResult<T>>('menu', request);
  }

  public text(request: TextPromptRequest): Promise<PromptResult<string>> {
    return this.request<PromptResult<string>>('text', request);
  }

  public password(request: PasswordPromptRequest): Promise<PromptResult<string>> {
    return this.request<PromptResult<string>>('password', request);
  }

  public confirm(request: ConfirmPromptRequest): Promise<PromptResult<boolean>> {
    return this.request<PromptResult<boolean>>('confirm', request);
  }

  public pickAccess(request: AccessPickerRequest): Promise<AccessPickerResult> {
    return this.request<AccessPickerResult>('picker', request);
  }

  public notice(request: NoticeRequest): Promise<void> {
    return this.request<undefined>('notice', request);
  }

  public notify(line: string): void {
    // One visual row per item (the fixed STATUS_CAP-height area evicts by item count,
    // not row count). Collapse embedded newlines so a stray multi-line payload can never
    // consume the whole budget and clip newer status.
    const oneLine = line.replace(/\s*\n\s*/g, ' ').trim();
    this.pushStatus({ id: this.seq++, text: oneLine });
  }

  public showQr(request: QrRequest): void {
    this.emit({ kind: 'qr', request });
  }

  public async status<T>(label: string, task: () => Promise<T>): Promise<T> {
    this.emit({ kind: 'busy', label });
    try {
      return await task();
    } finally {
      this.emit(undefined);
    }
  }
}

// The router view — maps the active request onto its screen (pure switch).

const ActiveScreen: FC<{ readonly active: ActiveRequest | undefined }> = ({
  active,
}) => {
  if (active === undefined) {
    return null;
  }
  switch (active.kind) {
    case 'menu':
      return <MenuScreen request={active.request} onDone={active.resolve} />;
    case 'text':
      return (
        <LinePrompt masked={false} request={active.request} onDone={active.resolve} />
      );
    case 'password':
      return <LinePrompt masked request={active.request} onDone={active.resolve} />;
    case 'confirm':
      return <ConfirmPrompt request={active.request} onDone={active.resolve} />;
    case 'picker':
      return (
        <AccessPickerHost
          initialState={active.request.initialState}
          onDone={active.resolve}
        />
      );
    case 'busy':
      return <Spinner label={active.label} />;
    case 'qr':
      return <QrScreen request={active.request} />;
    case 'notice':
      return <NoticeScreen request={active.request} onDone={active.resolve} />;
  }
};

/**
 * QrScreen — renders a login QR as one screen (never the capped note tail, so the code
 * is never truncated) at full contrast (a dim colour makes it unscannable). Only the
 * footer (URL / PNG path / countdown) is dimmed.
 */
export const QrScreen: FC<{ readonly request: QrRequest }> = ({ request }) => {
  const countdown = useQrCountdown(request.expiresAtMs);
  return (
    // One uniform indent for the whole screen; a blank row above and below the
    // block keeps the QR's white quiet zone off the title, footer, and screen edge.
    <Box flexDirection="column" paddingLeft={2}>
      <Box marginBottom={1}>
        <Text {...colorProps(defaultTheme.color.inherited)}>{request.title}</Text>
      </Box>
      {request.qr.split('\n').map((line, i) => (
        // No colour override => the terminal's default foreground => full contrast.
        <Text key={i} wrap="truncate-end">
          {line}
        </Text>
      ))}
      <Box flexDirection="column" marginTop={1}>
        {request.footer.map((line, i) => (
          <Text key={i} {...colorProps(defaultTheme.color.inherited)}>
            {line}
          </Text>
        ))}
        <Text {...colorProps(defaultTheme.color.inherited)}>{countdown}</Text>
      </Box>
    </Box>
  );
};

/**
 * Live once-per-second countdown for the QR token. Ticks only while an expiry is set
 * (no interval otherwise); each `showQr` replacement carries a fresh `expiresAtMs`,
 * which restarts the effect.
 */
const useQrCountdown = (expiresAtMs: number): string => {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return (): void => {
      clearInterval(timer);
    };
  }, [expiresAtMs]);
  const remaining = Math.max(0, Math.ceil((expiresAtMs - now) / 1_000));
  return remaining > 0
    ? `(token refreshes in ${String(remaining)}s; a new QR will appear)`
    : '(refreshing the QR…)';
};

/**
 * EphemeralStatus — the small, fixed, self-clearing status area. It projects the
 * bounded ring `items` into a reserved box whose height is pinned to {@link STATUS_CAP}.
 * The box sits below the active screen, and its fixed height means the screen above
 * never shifts as lines arrive and evict. `overflow="hidden"` keeps a momentarily-long
 * line from spilling past the reserved rows.
 */
export const EphemeralStatus: FC<{ readonly items: readonly StatusItem[] }> = ({
  items,
}) => (
  <Box
    flexDirection="column"
    height={STATUS_CAP}
    marginTop={1}
    overflow="hidden"
  >
    {items.map((item) => {
      // `id` is a stable key that survives eviction re-indexing (unlike an array index,
      // which shifts as the oldest item drops off). Tone follows the pure classifier:
      // failures in the error tint, cancellations dimmed, everything else at the
      // default foreground; the fixed height + below-the-menu placement keep it
      // unobtrusive.
      const tone = classifyStatusTone(item.text);
      const token =
        tone === 'error'
          ? defaultTheme.color.error
          : tone === 'muted'
            ? defaultTheme.color.inherited
            : undefined;
      return (
        <Text key={item.id} wrap="truncate-end" {...colorProps(token)}>
          {item.text}
        </Text>
      );
    })}
  </Box>
);

// The app — the single mounted component: ephemeral status lane + active screen.

interface SetupAppProps {
  readonly controller: SetupUiController;
  readonly run: (ui: SetupUi) => Promise<void>;
  readonly onComplete: (result: SetupAppResult) => void;
  readonly onInterrupt: () => void;
}

type SetupAppResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: Error };

export const SetupApp: FC<SetupAppProps> = ({
  controller,
  run,
  onComplete,
  onInterrupt,
}) => {
  const [active, setActive] = useState<ActiveRequest | undefined>(undefined);
  // The bounded ephemeral-status ring — owned by the pure `reduceStatus` reducer,
  // capped/self-evicting at STATUS_CAP.
  const [status, dispatch] = useReducer(reduceStatus, []);

  // Root-level Ctrl-C: Ink holds stdin in raw mode (ISIG off), so an interactive Ctrl-C
  // arrives as byte 0x03 rather than a SIGINT signal — the guard's SIGINT handler never
  // sees it. Route the raw byte through the guard's synchronous restore +
  // exit path. OS teardown then closes Telegram and the ownership sentinel as
  // one operation, even while QR login or another network wait is in flight.
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onInterrupt();
    }
  });

  useEffect(() => {
    controller.bind(
      (request): void => {
        setActive(request);
        // Context change: dismissing a screen (emit(undefined)) makes the status it
        // produced stale, so clear it. One hook on the shared screen-dismiss path — no
        // timers, no TTL. A line lives until the user's next action, never past its context.
        if (request === undefined) {
          dispatch({ type: 'clear' });
        }
      },
      (item: StatusItem): void => {
        dispatch({ type: 'push', item });
      },
    );
    // The flow uses `Result` types, but an infra call could still reject (network/fs)
    // inside `ui.status`. Send the full error to the debug file, surface a terse
    // ephemeral line, and propagate it to the composition root's fail-stop path.
    void run(controller).then(
      (): void => {
        onComplete({ ok: true });
      },
      (err: unknown): void => {
        const logged = debugLogError('setup', err);
        controller.notify(
          logged ? 'Setup failed — see the debug log for details.' : 'Setup failed.',
        );
        onComplete({
          ok: false,
          error: err instanceof Error ? err : new Error('setup failed'),
        });
      },
    );
  }, [controller, run, onComplete]);

  // The picker is a full-screen mode. Rendering the rolling transcript above it would
  // make the frame taller than the terminal — and Ink redraws in place by moving the
  // cursor up over the previous frame, so a frame that does not fit the screen cannot be
  // erased and gets appended instead. So while the picker is mounted it owns the whole screen.
  const fullScreen = active?.kind === 'picker';
  // Full-screen and must-read screens own the whole frame. Reserving the empty
  // status lane below a QR can push its final rows beyond the terminal and make
  // Ink append the next prompt instead of replacing it.
  const showStatus =
    !fullScreen && active?.kind !== 'notice' && active?.kind !== 'qr';
  return (
    <Box flexDirection="column">
      <ActiveScreen active={active} />
      {showStatus ? <EphemeralStatus items={status} /> : null}
    </Box>
  );
};

// The lazy entry — owns the alt-screen guard + the single Ink runtime lifecycle.

/**
 * Mount the one setup app and drive `flow` against its `SetupUi`, resolving when the
 * flow returns. The alt-screen guard guarantees the terminal is restored on normal exit
 * and on Ctrl-C/crash; it renders to STDERR so a piped STDOUT stays protocol-clean. On a
 * non-TTY the guard is a no-op — callers gate the TTY branch before reaching here.
 */
export const runSetupApp = async (
  flow: (ui: SetupUi) => Promise<void>,
): Promise<void> => {
  const guard = new AltScreenTerminalGuard(createProcessTerminalIo(process.stderr));
  return guard.run(async () => {
    const controller = new SetupUiController();
    let settle: (result: SetupAppResult) => void = () => undefined;
    const done = new Promise<void>((resolve, reject) => {
      settle = (result): void => {
        if (result.ok) {
          resolve();
        } else {
          reject(result.error);
        }
      };
    });

    const instance = render(
      <ThemeProvider theme={inkUiBrandTheme}>
        <SetupApp
          controller={controller}
          run={flow}
          onComplete={settle}
          onInterrupt={() => {
            guard.interrupt();
          }}
        />
      </ThemeProvider>,
      // Ink renders to STDERR: STDOUT is the copy-paste config surface (protocol).
      { stdout: process.stderr, exitOnCtrlC: false },
    );

    try {
      await done;
    } finally {
      instance.unmount();
    }
  });
};
