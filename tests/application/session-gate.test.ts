/**
 * SessionGate — the shared locked/unlocked SSOT and its one-time, ATOMIC,
 * fail-closed transition. Driven with in-memory fakes (no crypto, no socket):
 *  - starts locked for hardened+machine, unlocked (with a menu) for smooth/PIN;
 *  - a wrong PIN / tampered policy returns a secret-free error and rolls back;
 *  - a good PIN + valid config opens the policy ONCE, installs the source, and
 *    publishes the ENFORCED menu used by endpoint and kill-switch resolution.
 */
import { describe, it, expect } from 'vitest';

import {
  AppErrorCode,
  appError,
  SessionGate,
  type AppError,
  type LoadedConfiguration,
  type RuntimeUnlockableStore,
  type SessionKeySource,
  type ConfigRepository,
} from '../../src/application/index.js';
import { PermissionVerb, type Endpoint } from '../../src/domain/index.js';
import { ok, err, isOk, isErr, type Result } from '../../src/shared/index.js';
import { buildEndpoint, killSwitch } from './_support.js';

const PIN: SessionKeySource = { kind: 'passphrase', passphrase: 'correct-horse' };

/** A recording RuntimeUnlockableStore whose verify verdict is configurable. */
class FakeUnlockStore implements RuntimeUnlockableStore {
  public readonly setSources: SessionKeySource[] = [];
  public verifyCalls = 0;
  public constructor(private readonly verifyResult: Result<void, AppError>) {}
  public verifyUnlock(): Promise<Result<void, AppError>> {
    this.verifyCalls += 1;
    return Promise.resolve(this.verifyResult);
  }
  public setActiveSource(source: SessionKeySource): void {
    this.setSources.push(source);
  }
}

/** A ConfigRepository whose load verdict is configurable (enforced reload). */
class FakeAuthRepo implements ConfigRepository {
  public loadCalls = 0;
  public result: Result<LoadedConfiguration, AppError>;
  public constructor(result: Result<LoadedConfiguration, AppError>) {
    this.result = result;
  }
  public load(): Promise<Result<LoadedConfiguration, AppError>> {
    this.loadCalls += 1;
    return Promise.resolve(this.result);
  }
}

const enforcedMenu = (): LoadedConfiguration => ({
  endpoints: [buildEndpoint({ verbs: [PermissionVerb.Read] })],
  killSwitch: killSwitch(PermissionVerb.Send),
});

describe('SessionGate — initial state', () => {
  it('starts LOCKED for hardened+machine (no enforced menu yet)', () => {
    const gate = new SessionGate(
      new FakeUnlockStore(ok(undefined)),
      new FakeAuthRepo(ok(enforcedMenu())),
    );
    expect(gate.isUnlocked()).toBe(false);
    expect(gate.enforcedEndpoint('test-endpoint')).toBeUndefined();
    expect(gate.enforcedKillSwitch()).toBeUndefined();
    expect(gate.enforcedEndpoints()).toEqual([]);
  });

  it('starts UNLOCKED for smooth/PIN, publishing the boot enforced menu', () => {
    const menu = enforcedMenu();
    const gate = new SessionGate(
      new FakeUnlockStore(ok(undefined)),
      new FakeAuthRepo(ok(menu)),
      menu,
    );
    expect(gate.isUnlocked()).toBe(true);
    expect(gate.enforcedEndpoint('test-endpoint')).toBeDefined();
    expect(gate.enforcedKillSwitch()).toBe(menu.killSwitch);
  });
});

describe('SessionGate.authenticateOperator — fail-closed transition', () => {
  it('a WRONG PIN returns the policy-open error, rolls back, and stays locked', async () => {
    const store = new FakeUnlockStore(ok(undefined));
    const authRepo = new FakeAuthRepo(
      err(appError(AppErrorCode.Validation, 'wrong passphrase/keyfile')),
    );
    const gate = new SessionGate(store, authRepo);

    const r = await gate.authenticateOperator(PIN);

    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe(AppErrorCode.Validation);
    expect(gate.isUnlocked()).toBe(false);
    // The candidate was used for one policy open, then rolled back.
    expect(store.setSources).toEqual([PIN, { kind: 'machine' }]);
    expect(store.verifyCalls).toBe(0);
    expect(authRepo.loadCalls).toBe(1);
  });

  it('a good PIN but TAMPERED config rolls back the candidate and stays locked', async () => {
    const store = new FakeUnlockStore(ok(undefined));
    const authRepo = new FakeAuthRepo(
      err(appError(AppErrorCode.Validation, 'sealed policy failed validation')),
    );
    const gate = new SessionGate(store, authRepo);

    const r = await gate.authenticateOperator(PIN);

    expect(isErr(r)).toBe(true);
    expect(gate.isUnlocked()).toBe(false);
    expect(gate.enforcedEndpoint('test-endpoint')).toBeUndefined();
    // Tentative candidate was rolled back to the machine source.
    expect(store.setSources).toEqual([PIN, { kind: 'machine' }]);
    expect(store.verifyCalls).toBe(0);
    expect(authRepo.loadCalls).toBe(1);
  });

  it('a good PIN + valid config opens the policy ONCE, re-keys, and publishes the menu', async () => {
    const menu = enforcedMenu();
    const store = new FakeUnlockStore(ok(undefined));
    const authRepo = new FakeAuthRepo(ok(menu));
    const gate = new SessionGate(store, authRepo);

    const r = await gate.authenticateOperator(PIN);

    expect(isOk(r)).toBe(true);
    expect(gate.isUnlocked()).toBe(true);
    // The policy open itself proves the candidate: no duplicate KDF verification.
    expect(store.setSources).toEqual([PIN]);
    expect(store.verifyCalls).toBe(0);
    expect(authRepo.loadCalls).toBe(1);
    // The ENFORCED menu is now the resolution source.
    expect(gate.enforcedEndpoint('test-endpoint')).toBe(menu.endpoints[0]);
    expect(gate.enforcedKillSwitch()).toBe(menu.killSwitch);
    expect(gate.enforcedEndpoint('no-such-endpoint')).toBeUndefined();
  });

  it('authenticates against a representative blob only when no policy exists yet', async () => {
    const store = new FakeUnlockStore(ok(undefined));
    const authRepo = new FakeAuthRepo(
      err(appError(AppErrorCode.NotFound, 'no sealed policy')),
    );
    const gate = new SessionGate(store, authRepo);

    const r = await gate.authenticateOperator(PIN);

    expect(isOk(r)).toBe(true);
    expect(store.verifyCalls).toBe(1);
    expect(store.setSources).toEqual([PIN]);
    expect(authRepo.loadCalls).toBe(1);
    expect(gate.isUnlocked()).toBe(true);
    expect(gate.enforcedEndpoints()).toEqual([]);
  });

  it('rolls back when the policy is absent and representative authentication fails', async () => {
    const store = new FakeUnlockStore(
      err(appError(AppErrorCode.Validation, 'wrong passphrase/keyfile')),
    );
    const authRepo = new FakeAuthRepo(
      err(appError(AppErrorCode.NotFound, 'no sealed policy')),
    );
    const gate = new SessionGate(store, authRepo);

    const r = await gate.authenticateOperator(PIN);

    expect(isErr(r)).toBe(true);
    expect(gate.isUnlocked()).toBe(false);
    expect(store.verifyCalls).toBe(1);
    expect(store.setSources).toEqual([PIN, { kind: 'machine' }]);
    expect(authRepo.loadCalls).toBe(1);
  });

  it('rolls back when the enforced repository rejects unexpectedly', async () => {
    const store = new FakeUnlockStore(ok(undefined));
    const gate = new SessionGate(store, {
      load: (): Promise<never> => Promise.reject(new Error('read failed')),
    });

    await expect(gate.authenticateOperator(PIN)).rejects.toThrow('read failed');

    expect(gate.isUnlocked()).toBe(false);
    expect(store.setSources).toEqual([PIN, { kind: 'machine' }]);
  });

  it('an already-unlocked gate only verifies the operator and never republishes', async () => {
    const store = new FakeUnlockStore(
      err(appError(AppErrorCode.Validation, 'wrong passphrase/keyfile')),
    );
    const menu = enforcedMenu();
    const authRepo = new FakeAuthRepo(ok(menu));
    // Start already-unlocked (boot-unlocked); attempt a re-key with a wrong PIN.
    const gate = new SessionGate(store, authRepo, menu);

    const r = await gate.authenticateOperator(PIN);

    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe(AppErrorCode.Validation);
    expect(gate.isUnlocked()).toBe(true);
    expect(store.setSources).toEqual([]);
    expect(authRepo.loadCalls).toBe(0);
  });

  it('unlock publishes ATOMICALLY: onPublished runs with the menu ALREADY swapped', async () => {
    // The same contract as reload's hook — the daemon retires its derived caches
    // (contexts, session stacks) inside onPublished, so it must observe the NEW
    // enforced menu in that same synchronous frame.
    const menu = enforcedMenu();
    const store = new FakeUnlockStore(ok(undefined));
    const authRepo = new FakeAuthRepo(ok(menu));
    const gate = new SessionGate(store, authRepo);

    let observed: Endpoint | undefined;
    const r = await gate.authenticateOperator(PIN, () => {
      observed = gate.enforcedEndpoint('test-endpoint');
    });

    expect(isOk(r)).toBe(true);
    expect(observed).toBe(menu.endpoints[0]);
  });

  it('does NOT run onPublished when the unlock is REJECTED (fail-closed)', async () => {
    const store = new FakeUnlockStore(ok(undefined));
    const authRepo = new FakeAuthRepo(
      err(appError(AppErrorCode.Validation, 'wrong passphrase/keyfile')),
    );
    const gate = new SessionGate(store, authRepo);

    let published = false;
    const r = await gate.authenticateOperator(PIN, () => {
      published = true;
    });

    expect(isErr(r)).toBe(true);
    expect(published).toBe(false);
  });
});
