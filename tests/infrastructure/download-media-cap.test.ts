/**
 * download_media guards (pure, no network): the operator-configurable DECLARED-size
 * cap and the SERVER-GENERATED, traversal-free basename. These are the two pieces of
 * `download_media` that don't need a live Telegram client — the gateway builds its own
 * client internally, so the cap logic + name builder are exported and pinned here.
 */
import { describe, it, expect } from 'vitest';
import {
  overDownloadCap,
  downloadBasename,
} from '../../src/infrastructure/telegram/gramjs-telegram-gateway.js';
import { AppErrorCode } from '../../src/application/index.js';
import { UntrustedText, UntrustedTextKind } from '../../src/domain/index.js';

describe('overDownloadCap — the operator-configurable declared-size guard', () => {
  it('REFUSES a declared size over the cap and NAMES the cap in the error', () => {
    const error = overDownloadCap(100, 50);
    expect(error).toBeDefined();
    expect(error?.code).toBe(AppErrorCode.SizeCapExceeded);
    // The cap value AND the declared size appear in the message.
    expect(error?.message).toContain('50');
    expect(error?.message).toContain('100');
  });

  it('RAISING the cap admits the same download (config knob takes effect)', () => {
    expect(overDownloadCap(100, 50)).toBeDefined(); // refused at the 50-byte cap
    expect(overDownloadCap(100, 200)).toBeUndefined(); // admitted at the 200-byte cap
  });

  it('admits a declared size at or under the cap', () => {
    expect(overDownloadCap(50, 50)).toBeUndefined();
    expect(overDownloadCap(49, 50)).toBeUndefined();
  });

  it('cannot pre-check an undefined declared size (e.g. a photo) — passes', () => {
    expect(overDownloadCap(undefined, 50)).toBeUndefined();
  });
});

describe('downloadBasename — server-generated, confined to a single path component', () => {
  const doc = (name?: string): { kind: string; fileName?: UntrustedText } => ({
    kind: 'document',
    ...(name !== undefined
      ? { fileName: UntrustedText.wrapSanitized(UntrustedTextKind.Body, name) }
      : {}),
  });

  it('builds <chatKey>_<messageId>_<name> from a clean original name', () => {
    expect(downloadBasename('-1001234', 42, doc('report.pdf'))).toBe(
      '-1001234_42_report.pdf',
    );
  });

  it('falls back to the media kind when there is no original name', () => {
    expect(downloadBasename('100', 7, doc())).toBe('100_7_document');
  });

  it('NEUTRALISES a traversal-laden original name (no path separator survives)', () => {
    const name = downloadBasename('100', 7, doc('../../etc/passwd'));
    // The name is a SINGLE path component: no separator, so join() cannot escape.
    expect(name.includes('/')).toBe(false);
    expect(name.includes('\\')).toBe(false);
    // It also never IS a bare traversal segment.
    expect(name).not.toBe('..');
    expect(name.startsWith('100_7_')).toBe(true);
  });

  it('sanitizes a marked channel id into a legal key component', () => {
    // The `-100…` prefix keeps its leading '-' (legal in a filename); nothing else leaks.
    const name = downloadBasename('-1009999999999', 5, doc('a b*c?.jpg'));
    expect(name.includes('/')).toBe(false);
    expect(name.includes(' ')).toBe(false);
    expect(name.includes('*')).toBe(false);
  });
});
