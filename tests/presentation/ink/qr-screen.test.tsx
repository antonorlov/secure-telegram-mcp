/**
 * QrScreen regression test — the QR login code must render as ONE screen element,
 * NOT the capped rolling note tail (`TRANSCRIPT_TAIL = 12`) that used to drop the
 * TOP rows of a ~20-line QR (losing two of the three finder squares → an
 * unscannable, "not fully generated" code). This pins that EVERY line survives,
 * plus the title and dimmed footer.
 */
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';

import { QrScreen } from '../../../src/presentation/cli/ink/run-setup-app.js';

describe('QrScreen', () => {
  it('renders EVERY QR line (never truncated) plus the title and footer', () => {
    // A QR far taller than the transcript tail cap — the old note-based rendering
    // would have shown only the last 12 of these.
    const lines = Array.from(
      { length: 20 },
      (_, i) => `QRROW${String(i).padStart(2, '0')}BLOCKS`,
    );
    const { lastFrame } = render(
      <QrScreen
        request={{
          title: 'Scan this QR with Telegram',
          qr: lines.join('\n'),
          expiresAtMs: Date.now() + 30_000,
          footer: [
            'Login URL: tg://login?token=abc123',
            '(token refreshes in ~30s; a new QR will appear)',
          ],
        }}
      />,
    );
    const frame = lastFrame() ?? '';

    // The load-bearing assertion: NOT ONE row is dropped (including the top rows
    // that carry the finder patterns).
    for (const line of lines) {
      expect(frame).toContain(line);
    }
    expect(frame).toContain('Scan this QR with Telegram');
    expect(frame).toContain('Login URL: tg://login?token=abc123');
  });
});
