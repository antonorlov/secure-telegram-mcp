/**
 * Theme — the pure read-out formatters + the NO_COLOR-safe colour resolution.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyNoticeLine,
  accessColor,
  colorProps,
  createTheme,
  defaultTheme,
  formatAccessToken,
  formatBitsToken,
  memberGlyph,
  noColorRequested,
  toAlignableTitle,
  triStateGlyph,
  unicodeGlyphsSupported,
} from '../../../src/presentation/cli/ink/theme.js';
import type {
  AccessBits,
  EffectiveAccess,
} from '../../../src/presentation/cli/picker/index.js';

const bits = (read: boolean, write: boolean): AccessBits => ({ read, write });
const eff = (over: Partial<EffectiveAccess>): EffectiveAccess => ({
  member: true,
  bits: bits(true, false),
  ...over,
});

describe('formatAccessToken — minimal r / rw / empty (no dots, no provenance)', () => {
  it('is empty for a non-member', () => {
    expect(formatAccessToken(eff({ member: false }))).toBe('');
  });
  it("is 'r' for a read-only member", () => {
    expect(formatAccessToken(eff({ bits: bits(true, false) }))).toBe('r');
  });
  it("is 'rw' for a read+write member", () => {
    expect(formatAccessToken(eff({ bits: bits(true, true) }))).toBe('rw');
  });
  it("is 'w' for a write-only member (honest, not 'rw')", () => {
    expect(formatAccessToken(eff({ bits: bits(false, true) }))).toBe('w');
  });
});

describe('toAlignableTitle (emoji/flag runs -> space, for column alignment)', () => {
  it('replaces width-ambiguous emoji/flag runs with a single space', () => {
    expect(toAlignableTitle('Weather 🇪🇸')).toBe('Weather  ');
    expect(toAlignableTitle('News🇦🇺🇳🇿Feed😀')).toBe('News Feed ');
  });
  it('leaves a plain (no emoji/flag) title untouched, incl. accented Latin', () => {
    expect(toAlignableTitle('Café Résumé')).toBe('Café Résumé');
  });
});

describe('formatBitsToken (bare bits -> minimal token)', () => {
  it('maps read/write bits to r / rw / —', () => {
    expect(formatBitsToken(bits(true, true))).toBe('rw');
    expect(formatBitsToken(bits(true, false))).toBe('r');
    expect(formatBitsToken(bits(false, false))).toBe('—');
  });
});

describe('accessColor — green read / amber write / dim otherwise', () => {
  const theme = createTheme({ colorsEnabled: true });
  it('tints a read-only member green and a writable member amber', () => {
    expect(accessColor(eff({ bits: bits(true, false) }), theme)).toBe('#5CCB8B');
    expect(accessColor(eff({ bits: bits(true, true) }), theme)).toBe('#E8B23A');
  });
  it('dims a non-member', () => {
    expect(accessColor(eff({ member: false }), theme)).toBe('#64748B');
  });
  it('collapses to undefined under NO_COLOR', () => {
    const mono = createTheme({ colorsEnabled: false });
    expect(accessColor(eff({ bits: bits(true, true) }), mono)).toBeUndefined();
  });
});

describe('classifyNoticeLine — command / aside / prose tinting', () => {
  it('marks an indented line as a command and splits the trailing comment', () => {
    const line = '  npx secure-telegram-mcp start   # prompts for your PIN';
    const style = classifyNoticeLine(line);
    expect(style).toMatchObject({ kind: 'command' });
    if (style.kind === 'command') {
      expect(style.command + (style.comment ?? '')).toBe(line); // copy-fidelity
      expect(style.comment).toBe('# prompts for your PIN');
    }
  });

  it('keeps an indented line without a comment as one command segment', () => {
    expect(classifyNoticeLine('  npm run ci')).toEqual({
      kind: 'command',
      command: '  npm run ci',
    });
  });

  it('dims a fully parenthesised aside, tolerating trailing punctuation', () => {
    expect(classifyNoticeLine('(hand-edits to config.json stay inert).')).toEqual({
      kind: 'aside',
    });
    expect(
      classifyNoticeLine('(Headless/CI: point TELEGRAM_MCP_SESSION_PASSPHRASE_FILE at a 0600 PIN file.)'),
    ).toEqual({ kind: 'aside' });
  });

  it('leaves ordinary prose, even with inline parentheses, at full contrast', () => {
    expect(classifyNoticeLine('To unlock (once per boot):')).toEqual({ kind: 'text' });
    expect(classifyNoticeLine('')).toEqual({ kind: 'text' });
  });

  it('bolds the notice payload: shown-once keys and written file paths', () => {
    expect(classifyNoticeLine('  tgmcp_abc123DEF456')).toEqual({ kind: 'payload' });
    expect(classifyNoticeLine('  /tmp/recovery.key (0600)')).toEqual({ kind: 'payload' });
    expect(classifyNoticeLine('  ~/backup/recovery.key (0600)')).toEqual({ kind: 'payload' });
    // Unindented prose mentioning a path stays prose.
    expect(classifyNoticeLine('The file config.json stays inert.')).toEqual({ kind: 'text' });
  });

  it('splits a prose line around its first URL, peeling sentence punctuation', () => {
    const line = 'Create an app at https://my.telegram.org/apps';
    const style = classifyNoticeLine(line);
    expect(style).toMatchObject({ kind: 'link', url: 'https://my.telegram.org/apps' });
    if (style.kind === 'link') {
      expect(style.before + style.url + style.after).toBe(line); // copy-fidelity
    }
    const punct = classifyNoticeLine('Open https://example.org/x, then continue.');
    expect(punct).toMatchObject({ kind: 'link', url: 'https://example.org/x' });
    if (punct.kind === 'link') {
      expect(punct.after).toBe(', then continue.');
    }
  });

  it('an aside keeps priority over a URL inside it', () => {
    expect(classifyNoticeLine('(see https://example.org for details).')).toEqual({
      kind: 'aside',
    });
  });

  it('never mistakes indented bullets, continuations, or paths for commands', () => {
    expect(
      classifyNoticeLine('  - Telegram credentials are sealed INTO the session'),
    ).toEqual({ kind: 'text' });
    expect(
      classifyNoticeLine('             and to change which chats are accessible.'),
    ).toEqual({ kind: 'text' });
    expect(classifyNoticeLine('  docker run --rm -it setup')).toMatchObject({
      kind: 'command',
    });
  });
});

describe('glyph helpers', () => {
  const glyphs = createTheme({ colorsEnabled: false, unicodeGlyphs: false }).glyph;
  it('tri-state checkbox', () => {
    expect(triStateGlyph('full', glyphs)).toBe('[x]');
    expect(triStateGlyph('partial', glyphs)).toBe('[-]');
    expect(triStateGlyph('none', glyphs)).toBe('[ ]');
  });
  it('membership checkbox', () => {
    expect(memberGlyph(true, glyphs)).toBe('[x]');
    expect(memberGlyph(false, glyphs)).toBe('[ ]');
  });
});

describe('NO_COLOR-safe theme', () => {
  it('noColorRequested honours the convention (present AND non-empty)', () => {
    expect(noColorRequested({ NO_COLOR: '1' })).toBe(true);
    expect(noColorRequested({ NO_COLOR: '' })).toBe(false);
    expect(noColorRequested({})).toBe(false);
  });

  it('disabled colours collapse every token to undefined', () => {
    const mono = createTheme({ colorsEnabled: false, unicodeGlyphs: false });
    expect(mono.color.write).toBeUndefined();
    expect(mono.color.title).toBeUndefined();
    // Glyphs are unchanged (ASCII-faithful without colour).
    expect(mono.glyph.checkFull).toBe('[x]');
  });

  it('enabled colours provide hex brand tokens, error distinct from write', () => {
    const colored = createTheme({ colorsEnabled: true });
    expect(colored.color.write).toMatch(/^#[0-9A-F]{6}$/i);
    expect(colored.color.error).toMatch(/^#[0-9A-F]{6}$/i);
    expect(colored.color.error).not.toBe(colored.color.write);
  });

  it('colorProps omits the prop entirely when the token is undefined', () => {
    expect(colorProps(undefined)).toEqual({});
    expect(colorProps('red')).toEqual({ color: 'red' });
  });

  it('exposes a process-default theme with one of the two glyph sets', () => {
    expect(['>', '\u276F']).toContain(defaultTheme.glyph.cursor);
  });

  it('selects single-width unicode glyphs when asked', () => {
    const uni = createTheme({ unicodeGlyphs: true });
    expect(uni.glyph.cursor).toBe('\u276F');
    expect(uni.glyph.checkFull).toBe('[\u2713]');
    expect(uni.glyph.checkPartial).toBe('[\u2013]');
    // Same rendered width as the ASCII set — the column-alignment contract.
    expect(uni.glyph.checkFull.length).toBe(3);
    expect(uni.glyph.cursor.length).toBe(1);
  });

  it('sniffs unicode support from locale, honouring TERM=dumb', () => {
    expect(unicodeGlyphsSupported({ LANG: 'en_US.UTF-8' })).toBe(true);
    expect(unicodeGlyphsSupported({ LC_ALL: 'C.utf8' })).toBe(true);
    expect(unicodeGlyphsSupported({ LANG: 'C' })).toBe(false);
    expect(unicodeGlyphsSupported({})).toBe(false);
    expect(unicodeGlyphsSupported({ LANG: 'en_US.UTF-8', TERM: 'dumb' })).toBe(false);
  });
});
