/**
 * CredentialPrompter — interactive acquisition of the Telegram app credentials
 * for setup, driven against a FAKE console (the narrow `CredentialPromptConsole`
 * port). No TTY, no readline, no env reads.
 *
 * Contract asserted:
 *   - A present-and-valid env PRE-FILL is used WITHOUT prompting (CI/--env-file).
 *   - When no pre-fill is present, both fields are PROMPTED; the api_hash prompt
 *     is taken from the ECHO-OFF channel (`askSecret`), never the plain one.
 *   - Validation is enforced AT THE PROMPT: api_id must be a positive integer;
 *     api_hash must be 32 hex chars (case-insensitive, lenient); empty/whitespace
 *     is rejected and re-prompted with a clear message.
 *   - An invalid pre-fill is ignored (and announced) — we fall through to prompt.
 *   - The my.telegram.org guidance rides ON both prompt screens (`help`), so it
 *     stays visible WHILE the operator types (never a separate vanished notice).
 *   - Exhausting the re-prompt budget returns `undefined` (caller aborts).
 */
import { describe, it, expect } from 'vitest';

import {
  InteractiveCredentialPrompter,
  parseApiId,
  parseApiHash,
  type CredentialPromptConsole,
} from '../../src/presentation/cli/credential-prompter.js';

const VALID_HASH = 'deadbeefdeadbeefdeadbeefdeadbeef';

/**
 * A scripted fake console. `ask`/`askSecret` dequeue from their OWN queues so a
 * test can prove which channel a field was read from (echo-off vs. plain).
 */
class FakeConsole implements CredentialPromptConsole {
  public readonly prints: string[] = [];
  public readonly askedPlain: string[] = [];
  public readonly askedSecret: string[] = [];
  /** The on-screen help block each prompt carried, flattened (one entry per ask). */
  public readonly helpPlain: string[] = [];
  public readonly helpSecret: string[] = [];

  public constructor(
    private readonly plainAnswers: string[],
    private readonly secretAnswers: string[],
  ) {}

  public print(message = ''): void {
    this.prints.push(message);
  }

  public ask(question: string, help?: readonly string[]): Promise<string> {
    this.askedPlain.push(question);
    this.helpPlain.push((help ?? []).join('\n'));
    return Promise.resolve(this.plainAnswers.shift() ?? '');
  }

  public askSecret(question: string, help?: readonly string[]): Promise<string> {
    this.askedSecret.push(question);
    this.helpSecret.push((help ?? []).join('\n'));
    return Promise.resolve(this.secretAnswers.shift() ?? '');
  }
}

describe('credential validators (shared, pure)', () => {
  it('parseApiId accepts a positive integer and rejects the rest', () => {
    expect(parseApiId('123')).toEqual({ ok: true, value: 123 });
    expect(parseApiId('  42 ')).toEqual({ ok: true, value: 42 });
    expect(parseApiId('0').ok).toBe(false);
    expect(parseApiId('-5').ok).toBe(false);
    expect(parseApiId('1.5').ok).toBe(false);
    expect(parseApiId('abc').ok).toBe(false);
    expect(parseApiId('   ').ok).toBe(false);
    expect(parseApiId('').ok).toBe(false);
  });

  it('parseApiHash accepts 32 hex (case-insensitive, trimmed) and lower-cases it', () => {
    expect(parseApiHash(`  ${VALID_HASH.toUpperCase()} `)).toEqual({
      ok: true,
      value: VALID_HASH,
    });
    expect(parseApiHash(VALID_HASH)).toEqual({ ok: true, value: VALID_HASH });
    // wrong length / non-hex / whitespace-only are rejected
    expect(parseApiHash('deadbeef').ok).toBe(false);
    expect(parseApiHash(`${VALID_HASH}ab`).ok).toBe(false);
    expect(parseApiHash('z'.repeat(32)).ok).toBe(false);
    expect(parseApiHash('   ').ok).toBe(false);
    expect(parseApiHash('').ok).toBe(false);
  });
});

describe('InteractiveCredentialPrompter', () => {
  it('uses a present-and-valid env pre-fill WITHOUT prompting', async () => {
    const con = new FakeConsole([], []);
    const prompter = new InteractiveCredentialPrompter(con);

    const creds = await prompter.acquire({ apiId: 7654321, apiHash: VALID_HASH });

    expect(creds).toEqual({ apiId: 7654321, apiHash: VALID_HASH });
    // Nothing was prompted on either channel (and so no guidance was needed).
    expect(con.askedPlain).toHaveLength(0);
    expect(con.askedSecret).toHaveLength(0);
    expect(con.prints.some((m) => m.includes('my.telegram.org'))).toBe(false);
  });

  it('PROMPTS for both fields when no pre-fill is given, reading api_hash echo-off', async () => {
    const con = new FakeConsole(['7654321'], [VALID_HASH]);
    const prompter = new InteractiveCredentialPrompter(con);

    const creds = await prompter.acquire({});

    expect(creds).toEqual({ apiId: 7654321, apiHash: VALID_HASH });
    // api_id from the PLAIN channel; api_hash from the ECHO-OFF channel.
    expect(con.askedPlain).toHaveLength(1);
    expect(con.askedSecret).toHaveLength(1);
    expect(con.askedSecret[0]?.toLowerCase()).toContain('api_hash');
    // The acquisition guidance rides ON BOTH prompt screens — the operator can
    // still read where each value comes from WHILE typing it.
    expect(con.helpPlain[0]).toContain('my.telegram.org');
    expect(con.helpSecret[0]).toContain('my.telegram.org');
  });

  it('re-prompts api_id until a positive integer is entered', async () => {
    const con = new FakeConsole(['0', 'abc', '999'], [VALID_HASH]);
    const prompter = new InteractiveCredentialPrompter(con);

    const creds = await prompter.acquire({});

    expect(creds?.apiId).toBe(999);
    // Three api_id attempts were consumed before success.
    expect(con.askedPlain).toHaveLength(3);
    expect(con.prints.some((m) => m.includes('positive integer'))).toBe(true);
  });

  it('re-prompts api_hash and REJECTS whitespace-only / malformed input', async () => {
    const con = new FakeConsole(['7654321'], ['   ', 'nothex', VALID_HASH]);
    const prompter = new InteractiveCredentialPrompter(con);

    const creds = await prompter.acquire({});

    expect(creds?.apiHash).toBe(VALID_HASH);
    expect(con.askedSecret).toHaveLength(3);
    expect(con.prints.some((m) => m.includes('32 hexadecimal'))).toBe(true);
  });

  it('ignores an INVALID env pre-fill (announced) and falls through to the prompt', async () => {
    const con = new FakeConsole(['7654321'], [VALID_HASH]);
    const prompter = new InteractiveCredentialPrompter(con);

    // api_hash pre-fill is not 32 hex -> ignored; both fields then prompted.
    const creds = await prompter.acquire({ apiHash: 'API_HASH_not_hex_value' });

    expect(creds).toEqual({ apiId: 7654321, apiHash: VALID_HASH });
    expect(con.askedSecret).toHaveLength(1);
    expect(
      con.prints.some((m) => m.includes('Ignoring api_hash from the environment')),
    ).toBe(true);
  });

  it('returns undefined after exhausting the re-prompt budget', async () => {
    const con = new FakeConsole(['0', '-1', 'x'], []);
    const prompter = new InteractiveCredentialPrompter(con);

    const creds = await prompter.acquire({});

    expect(creds).toBeUndefined();
    expect(con.prints.some((m) => m.includes('Too many invalid api_id'))).toBe(
      true,
    );
  });
});
