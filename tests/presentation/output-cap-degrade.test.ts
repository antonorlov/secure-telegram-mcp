/**
 * Output byte-cap DEGRADE path (LOW fix, 2026-07-08): an over-cap PAGE result
 * becomes a PARTIAL page (`truncated: true`, cursor removed, counter kept
 * honest) instead of an always-failing SizeCapExceeded — while a non-page
 * shape still fails closed via the original cap error.
 */
import { describe, it, expect } from 'vitest';
import { degradeToPartialPage } from '../../src/presentation/mcp/registry.js';
import { checkByteCap } from '../../src/shared/index.js';

/** A page whose items are ~200 bytes each once serialized. */
const pageOf = (n: number): Record<string, unknown> => ({
  messages: Array.from({ length: n }, (_, i) => ({
    messageId: i + 1,
    text: { untrusted_text: 'x'.repeat(180) },
  })),
  next_cursor: 'opaque-cursor',
});

describe('degradeToPartialPage', () => {
  it('trims trailing items until the serialization fits, marks truncated, drops the cursor', () => {
    const structured = pageOf(50);
    const maxBytes = 2_000; // fits ~9 items

    const degraded = degradeToPartialPage(structured, maxBytes);
    expect(degraded).toBeDefined();
    if (degraded === undefined) return;

    expect(checkByteCap(degraded.json, maxBytes).withinCap).toBe(true);
    const messages = degraded.structured['messages'] as unknown[];
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.length).toBeLessThan(50);
    expect(degraded.structured['truncated']).toBe(true);
    // The full page's cursor would skip the dropped tail — it must be gone.
    expect(degraded.structured['next_cursor']).toBeUndefined();
    // Items keep their order (a prefix, not a sample).
    expect((messages[0] as { messageId: number }).messageId).toBe(1);

    const oneMore = {
      messages: (structured['messages'] as unknown[]).slice(0, messages.length + 1),
      truncated: true,
    };
    expect(checkByteCap(JSON.stringify(oneMore), maxBytes).withinCap).toBe(false);
  });

  it('keeps a `count` field honest', () => {
    const structured = { ...pageOf(50), count: 50 };

    const degraded = degradeToPartialPage(structured, 2_000);
    expect(degraded).toBeDefined();
    if (degraded === undefined) return;

    expect(degraded.structured['next_cursor']).toBeUndefined();
    const kept = (degraded.structured['messages'] as unknown[]).length;
    expect(degraded.structured['count']).toBe(kept);
  });

  it('returns undefined for a NON-page shape (no lone array) — the cap error stands', () => {
    expect(
      degradeToPartialPage({ chat_id: '100', title: 'x'.repeat(4000) }, 100),
    ).toBeUndefined();
  });

  it('degrades to an EMPTY page rather than failing when even one item is too big', () => {
    const structured = {
      messages: [{ text: { untrusted_text: 'y'.repeat(5000) } }],
    };
    const degraded = degradeToPartialPage(structured, 200);
    expect(degraded).toBeDefined();
    if (degraded === undefined) return;
    expect(degraded.structured['messages']).toEqual([]);
    expect(degraded.structured['truncated']).toBe(true);
  });
});
