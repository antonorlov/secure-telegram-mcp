/**
 * Exhaustive ACL-evaluation security suite.
 *
 * This file pins the NON-NEGOTIABLE security invariants of the inner-most
 * authorization primitive (`DefaultAclEvaluator`) so they cannot silently regress:
 *
 *   #1 SCOPED-CLIENT / fail-closed: out-of-scope peers are denied, and an
 *      empty allow-list (e.g. a folder that resolved to 0 peers) is physically
 *      unrepresentable — `ResolvedScope.create([])` fails closed.
 *   #3 VERB-GATED: a verb is allowed only if the endpoint's virtual group
 *      grants it; default-deny otherwise. The granted set IS the ACL.
 *   #6 No untrusted prose in a decision: denials carry a machine-readable
 *      DomainErrorCode + a static, non-sensitive message only.
 *   #10 KILL-SWITCH: the daemon-wide denied set (`deniedVerbs`) SUBTRACTS from
 *      every grant at evaluation time — including a per-chat override that
 *      escalated above the group.
 *
 * Because the evaluator is a PURE domain service with no I/O ports, we exercise
 * it against REAL domain value objects (faking them would weaken the invariant).
 */
import { describe, it, expect } from 'vitest';
import { unwrap, isErr } from '../../src/shared/result.js';
import {
  DefaultAclEvaluator,
  Endpoint,
  EndpointName,
  SessionRef,
  Scope,
  ChatId,
  ResolvedScope,
  PermissionVerb,
  ALL_PERMISSION_VERBS,
  DomainErrorCode,
} from '../../src/domain/index.js';
import type {
  AclDecision,
  AclEvaluationInput,
} from '../../src/domain/index.js';

// --- fixtures -------------------------------------------------------------

const inScope: ChatId = unwrap(ChatId.create(100n));
const alsoInScope: ChatId = unwrap(ChatId.create(200n));
const outOfScope: ChatId = unwrap(ChatId.create(999n));
const resolvedScope: ResolvedScope = unwrap(
  ResolvedScope.create([inScope, alsoInScope]),
);

/** Build an endpoint that grants EXACTLY `verbs` (else nothing). */
const endpointGranting = (verbs: readonly PermissionVerb[]): Endpoint =>
  Endpoint.create({
    name: unwrap(EndpointName.create('endpoint')),
    // Declared scope is irrelevant to the evaluator (it consumes the already
    // RESOLVED scope); folder resolution is an infrastructure concern.
    scope: Scope.create([], []),
    verbs,
    sessionRef: unwrap(SessionRef.create('main')),
    confirmWrites: true,
    tokenHash: `${'0'.repeat(32)}$${'0'.repeat(64)}`,
  });

const evaluator = new DefaultAclEvaluator();

/** exactOptionalPropertyTypes-safe input builder (omit `target` when absent). */
const decide = (
  endpoint: Endpoint,
  verb: PermissionVerb,
  target?: ChatId,
): AclDecision => {
  const input: AclEvaluationInput =
    target === undefined
      ? { endpoint, resolvedScope, verb }
      : { endpoint, resolvedScope, verb, target };
  return evaluator.evaluate(input);
};

// --- #3 default-deny ------------------------------------------------------

describe('ACL #3 — default-deny verb gate', () => {
  it('an endpoint that grants nothing denies EVERY verb in the vocabulary', () => {
    const endpoint = endpointGranting([]);
    for (const verb of ALL_PERMISSION_VERBS) {
      const decision = decide(endpoint, verb, inScope);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toBe(DomainErrorCode.VerbNotGranted);
        expect(decision.verb).toBe(verb);
      }
    }
  });

  it('grants exactly the requested verb and denies all others (per-verb isolation)', () => {
    for (const granted of ALL_PERMISSION_VERBS) {
      const endpoint = endpointGranting([granted]);

      // the single granted verb is allowed in-scope
      expect(decide(endpoint, granted, inScope).allowed).toBe(true);

      // every OTHER verb is denied as not-granted (no implicit escalation)
      for (const other of ALL_PERMISSION_VERBS) {
        if (other === granted) continue;
        const decision = decide(endpoint, other, inScope);
        expect(decision.allowed).toBe(false);
        if (!decision.allowed) {
          expect(decision.reason).toBe(DomainErrorCode.VerbNotGranted);
        }
      }
    }
  });

  it('duplicate verbs in a group collapse to the same single grant (idempotent set)', () => {
    const endpoint = endpointGranting([
      PermissionVerb.Read,
      PermissionVerb.Read,
      PermissionVerb.Read,
    ]);
    expect(decide(endpoint, PermissionVerb.Read, inScope).allowed).toBe(true);
    expect(decide(endpoint, PermissionVerb.Send, inScope).allowed).toBe(false);
  });
});

// --- verb-merge -----------------------------------------------------------

describe('ACL — verb-merge (least-privilege composition)', () => {
  it('grants each verb in a multi-verb group independently, with no shadowing', () => {
    const granted = [
      PermissionVerb.Read,
      PermissionVerb.Send,
      PermissionVerb.Forward,
      PermissionVerb.MarkRead,
    ] as const;
    const endpoint = endpointGranting(granted);

    for (const verb of granted) {
      expect(decide(endpoint, verb, inScope).allowed).toBe(true);
    }
    // a verb outside the merged set stays denied (default-deny survives merge)
    const denied = decide(endpoint, PermissionVerb.Delete, inScope);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.reason).toBe(DomainErrorCode.VerbNotGranted);
    }
  });

  it('granting the ENTIRE vocabulary allows every verb on an in-scope peer', () => {
    const endpoint = endpointGranting(ALL_PERMISSION_VERBS);
    for (const verb of ALL_PERMISSION_VERBS) {
      const decision = decide(endpoint, verb, inScope);
      expect(decision.allowed).toBe(true);
      expect(decision.verb).toBe(verb);
    }
  });
});

// --- #1 scope gate (out-of-scope) -----------------------------------------

describe('ACL #1 — scope gate denies out-of-scope peers', () => {
  it('denies a GRANTED verb when the target is outside the resolved allow-list', () => {
    const endpoint = endpointGranting([PermissionVerb.Read, PermissionVerb.Send]);
    for (const verb of [PermissionVerb.Read, PermissionVerb.Send]) {
      const decision = decide(endpoint, verb, outOfScope);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toBe(DomainErrorCode.PeerOutOfScope);
        expect(decision.verb).toBe(verb);
      }
    }
  });

  it('allows a granted verb on EACH distinct in-scope peer', () => {
    const endpoint = endpointGranting([PermissionVerb.Read]);
    for (const peer of [inScope, alsoInScope]) {
      expect(decide(endpoint, PermissionVerb.Read, peer).allowed).toBe(true);
    }
  });

  it('skips the scope gate for scope-wide reads (no target) but still verb-gates', () => {
    const reader = endpointGranting([PermissionVerb.Read]);
    // no target => scope-wide (e.g. list_dialogs): the scoped client constrains results
    expect(decide(reader, PermissionVerb.Read).allowed).toBe(true);

    // verb gate is INDEPENDENT of target: an ungranted verb is denied even
    // without a target (no scope-wide bypass of the verb gate).
    const decision = decide(reader, PermissionVerb.Send);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe(DomainErrorCode.VerbNotGranted);
    }
  });

  it('verb gate fires BEFORE the scope gate (ungranted + out-of-scope -> verb denial)', () => {
    const reader = endpointGranting([PermissionVerb.Read]);
    const decision = decide(reader, PermissionVerb.Send, outOfScope);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      // reports the verb denial, never leaking that the peer was also out-of-scope
      expect(decision.reason).toBe(DomainErrorCode.VerbNotGranted);
    }
  });
});

// --- #1 / #5 fail-closed resolved scope (folder -> 0 peers) ---------------

describe('ACL #1/#5 — fail-closed empty scope (folder resolves to 0 peers)', () => {
  it('refuses to build a ResolvedScope from an empty allow-list (no allow-all)', () => {
    const result = ResolvedScope.create([]);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe(DomainErrorCode.EmptyScope);
    }
  });

  it('a single-peer resolved scope contains only that peer (membership is exact)', () => {
    const scope = unwrap(ResolvedScope.create([inScope]));
    expect(scope.size).toBe(1);
    expect(scope.contains(inScope)).toBe(true);
    expect(scope.contains(outOfScope)).toBe(false);
    expect(scope.contains(alsoInScope)).toBe(false);
  });
});

// --- #10 kill-switch (deniedVerbs) and per-chat overrides ------------------

describe('ACL #10 — deniedVerbs subtracts from every grant (daemon kill-switch)', () => {
  it('deniedVerbs SUBTRACTS a granted verb (the kill-switch at execution)', () => {
    const endpoint = endpointGranting([PermissionVerb.Read, PermissionVerb.Send]);
    // Send is granted by the group but daemon-denied -> denied, verb-gate reason.
    const decision = evaluator.evaluate({
      endpoint,
      resolvedScope,
      verb: PermissionVerb.Send,
      target: inScope,
      deniedVerbs: new Set([PermissionVerb.Send]),
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe(DomainErrorCode.VerbNotGranted);
    }
    // A different granted verb is unaffected by the denied set.
    expect(
      evaluator.evaluate({
        endpoint,
        resolvedScope,
        verb: PermissionVerb.Read,
        target: inScope,
        deniedVerbs: new Set([PermissionVerb.Send]),
      }).allowed,
    ).toBe(true);
  });

  it('deniedVerbs subtracts even a per-chat ESCALATED override (kill-switch wins over escalation)', () => {
    // Group is read-only; the in-scope chat carries a Send override -> escalated.
    const endpoint = endpointGranting([PermissionVerb.Read]);
    const overrides = new Map([
      [inScope.toKey(), new Set([PermissionVerb.Read, PermissionVerb.Send])],
    ]);
    // Without denial the escalated Send is allowed...
    expect(
      evaluator.evaluate({
        endpoint,
        resolvedScope,
        overrides,
        verb: PermissionVerb.Send,
        target: inScope,
      }).allowed,
    ).toBe(true);
    // ...but the kill-switch subtracts it.
    const killed = evaluator.evaluate({
      endpoint,
      resolvedScope,
      overrides,
      verb: PermissionVerb.Send,
      target: inScope,
      deniedVerbs: new Set([PermissionVerb.Send]),
    });
    expect(killed.allowed).toBe(false);
  });
});

// --- #6 decision shape: machine-readable, no untrusted prose, immutable ----

describe('ACL #6 — decision is structured, non-sensitive, immutable', () => {
  it('allow decisions echo the verb, carry no reason, and are frozen', () => {
    const endpoint = endpointGranting([PermissionVerb.Read]);
    const decision = decide(endpoint, PermissionVerb.Read, inScope);
    expect(decision.allowed).toBe(true);
    expect(decision.verb).toBe(PermissionVerb.Read);
    expect('reason' in decision).toBe(false);
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it('deny decisions carry a DomainErrorCode + static message and are frozen', () => {
    const endpoint = endpointGranting([PermissionVerb.Read]);
    const verbDenied = decide(endpoint, PermissionVerb.Send, inScope);
    const scopeDenied = decide(endpoint, PermissionVerb.Read, outOfScope);

    for (const decision of [verbDenied, scopeDenied]) {
      expect(decision.allowed).toBe(false);
      expect(Object.isFrozen(decision)).toBe(true);
      if (!decision.allowed) {
        // machine-readable reason from the ACL family
        expect([
          DomainErrorCode.VerbNotGranted,
          DomainErrorCode.PeerOutOfScope,
        ]).toContain(decision.reason);
        // a short, static, operator-facing message — never untrusted Telegram
        // prose and never the offending peer id.
        expect(typeof decision.message).toBe('string');
        expect(decision.message.length).toBeGreaterThan(0);
        expect(decision.message).not.toContain(outOfScope.toString());
      }
    }
  });
});
