/**
 * NoticeScreen tests (lane 3, the must-read screen) — mirrors QrScreen's 20-line
 * regression test. The load-bearing contract: a MUST-READ block (the HARDENED
 * PIN-file commands, a shown-once API key) renders INTACT and un-truncated on its
 * own screen, and BLOCKS until the operator presses Enter (which raises `onDone`).
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';

import { NoticeScreen } from '../../../src/presentation/cli/ink/screens/NoticeScreen.js';
import type { NoticeRequest } from '../../../src/presentation/cli/ink/setup-ui-port.js';

const ENTER = '\r';
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 25));

describe('NoticeScreen — must-read block', () => {
  it('renders EVERY body line intact (never truncated), plus title and hint', () => {
    // A body far taller than the old TRANSCRIPT_TAIL=12 cap.
    const body = Array.from(
      { length: 20 },
      (_, i) => `LINE${String(i).padStart(2, '0')}: copy-this-verbatim-command`,
    );
    const request = {
      title: 'HARDENED posture — PIN file setup',
      body,
    } satisfies NoticeRequest;

    const { lastFrame } = render(
      <NoticeScreen request={request} onDone={vi.fn()} />,
    );
    const frame = lastFrame() ?? '';

    // Not one body line dropped (the API-key / PIN-block truncation guard).
    for (const line of body) {
      expect(frame).toContain(line);
    }
    expect(frame).toContain('HARDENED posture — PIN file setup');
    // Default acknowledge hint present.
    expect(frame).toContain('Press Enter to continue');
  });

  it('CLEARS on dismiss — the block is not persisted above the next screen', () => {
    // The must-read (here a shown-once API key) shows while its screen is up, then
    // the flow replaces it with the next screen. Because the body is in the live
    // region (not <Static>), it is WIPED — it must not linger stacked above.
    const request = {
      title: "API key for 'reader' (shown ONCE)",
      body: ['  tgmcp_DO_NOT_LINGER_TOKEN', 'The config stores only its hash.'],
    } satisfies NoticeRequest;

    const { lastFrame, rerender } = render(
      <NoticeScreen request={request} onDone={vi.fn()} />,
    );
    expect(lastFrame() ?? '').toContain('tgmcp_DO_NOT_LINGER_TOKEN'); // shown

    // Dismiss -> the flow mounts the next screen in the notice's place.
    rerender(
      <Box>
        <Text>Main menu</Text>
      </Box>,
    );
    const after = lastFrame() ?? '';
    expect(after).toContain('Main menu');
    expect(after).not.toContain('tgmcp_DO_NOT_LINGER_TOKEN'); // wiped, not committed
  });

  it('BLOCKS until Enter, then raises onDone exactly once', async () => {
    const onDone = vi.fn();
    const request = {
      title: 'Recovery keyfile written',
      body: ['  /tmp/app.key (0600)'],
    } satisfies NoticeRequest;
    const { stdin } = render(
      <NoticeScreen request={request} onDone={onDone} />,
    );
    await tick();
    // Not acknowledged yet.
    expect(onDone).not.toHaveBeenCalled();
    stdin.write(ENTER);
    await tick();
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
