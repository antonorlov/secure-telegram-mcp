/**
 * Regression for the QR/phone login error-spam: a wrong 2FA password could reset
 * the login auth key, after which GramJS's `while(1)` sign-in loop re-invoked
 * account.GetPassword every iteration and threw `AUTH_KEY_UNREGISTERED` forever
 * (no re-prompt) because our `onError` hook only stopped on abort. The gate must
 * stop the loop on abort, on a terminal error, or at the attempt cap — and
 * record the true cause so the operator sees an actionable message.
 */
import { describe, it, expect } from 'vitest';

import {
  createLoginErrorGate,
  isTerminalLoginError,
} from '../../src/infrastructure/telegram/gramjs-account-login-client.js';

// The exact shape the daemon logged: a 401 AUTH_KEY_UNREGISTERED from GetPassword.
const authKeyUnregistered = (): Error =>
  new Error('401: AUTH_KEY_UNREGISTERED (caused by account.GetPassword)');
const wrongPassword = (): Error => new Error('PASSWORD_HASH_INVALID');

describe('isTerminalLoginError', () => {
  it('flags unrecoverable session / auth-key errors (the spam trigger)', () => {
    expect(isTerminalLoginError(authKeyUnregistered())).toBe(true);
    expect(isTerminalLoginError(new Error('SESSION_REVOKED'))).toBe(true);
    expect(isTerminalLoginError(new Error('AUTH_KEY_DUPLICATED'))).toBe(true);
  });

  it('does NOT treat a wrong password / code as terminal (allow re-prompt)', () => {
    expect(isTerminalLoginError(wrongPassword())).toBe(false);
    expect(isTerminalLoginError(new Error('PHONE_CODE_INVALID'))).toBe(false);
  });
});

describe('createLoginErrorGate — stops the sign-in loop', () => {
  it('stops IMMEDIATELY on a terminal error (kills the AUTH_KEY_UNREGISTERED spam)', async () => {
    const gate = createLoginErrorGate({ label: 'qr' });
    expect(await gate.onError(authKeyUnregistered())).toBe(true);
  });

  it('re-prompts a wrong password up to the cap, then stops', async () => {
    const gate = createLoginErrorGate({ label: 'qr' });
    expect(await gate.onError(wrongPassword())).toBe(false); // attempt 1 — re-prompt
    expect(await gate.onError(wrongPassword())).toBe(false); // attempt 2 — re-prompt
    expect(await gate.onError(wrongPassword())).toBe(true); //  attempt 3 — stop
  });

  it('stops at once when the abort signal is set', async () => {
    const ac = new AbortController();
    ac.abort();
    const gate = createLoginErrorGate({ label: 'qr', signal: ac.signal });
    expect(await gate.onError(wrongPassword())).toBe(true);
  });

  it('records the last real error so the caller maps the true cause', async () => {
    const gate = createLoginErrorGate({ label: 'qr' });
    const real = authKeyUnregistered();
    await gate.onError(real);
    expect(gate.lastError()).toBe(real);
  });

  it('logs each error through the injected logger (no spam past the stop)', async () => {
    const lines: string[] = [];
    const gate = createLoginErrorGate({
      label: 'phone',
      logger: (m) => lines.push(m),
    });
    await gate.onError(new Error('PHONE_CODE_INVALID'));
    expect(lines).toEqual(['phone login error: PHONE_CODE_INVALID']);
  });

  it('never copies arbitrary exception messages into the diagnostic sink', async () => {
    const lines: string[] = [];
    const gate = createLoginErrorGate({
      label: 'qr',
      logger: (message) => lines.push(message),
    });
    await gate.onError(new Error('phone=+15550000000 code=12345'));
    expect(lines).toEqual(['qr login error: NON_RPC_ERROR']);
  });
});
