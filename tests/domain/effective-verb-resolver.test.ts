/**
 * Per-chat verb resolution — the domain ACL precedence chat-override >
 * group-default > deny. Two layers are pinned here:
 *
 *   1. the allocation-free `effectiveVerbPermits` precedence predicate, and
 *   2. the `DefaultAclEvaluator` wired to a resolved override table — proving an
 *      override NARROWS and ESCALATES per chat, never widens scope, and that an
 *      override-free / target-free call is byte-for-byte the old verb-gate.
 */
import { describe, it, expect } from 'vitest';
import { unwrap } from '../../src/shared/result.js';
import {
  effectiveVerbPermits,
  chatOverridePermitsVerb,
  DefaultAclEvaluator,
  Endpoint,
  EndpointName,
  SessionRef,
  Scope,
  ChatId,
  ResolvedScope,
  PermissionVerb,
  DomainErrorCode,
  type ChatVerbOverrideTable,
} from '../../src/domain/index.js';

const buildEndpoint = (verbs: PermissionVerb[]): Endpoint =>
  Endpoint.create({
    name: unwrap(EndpointName.create('reader')),
    scope: Scope.create([], []),
    verbs,
    sessionRef: unwrap(SessionRef.create('main')),
    confirmWrites: true,
    tokenHash: `${'0'.repeat(32)}$${'0'.repeat(64)}`,
  });

const chat = (id: bigint): ChatId => unwrap(ChatId.create(id));
const overridden = chat(100n);
const inheriting = chat(200n);
const resolvedScope = unwrap(ResolvedScope.create([overridden, inheriting]));

describe('effectiveVerbPermits (chat-override > group-default > deny)', () => {
  const endpoint = buildEndpoint([PermissionVerb.Read]);

  it('uses an override instead of the endpoint default', () => {
    const overrideVerbs: ReadonlySet<PermissionVerb> = new Set([
      PermissionVerb.Send,
    ]);
    const overrides: ChatVerbOverrideTable = new Map([
      [overridden.toKey(), overrideVerbs],
    ]);
    expect(effectiveVerbPermits({
      target: overridden, verb: PermissionVerb.Send, endpoint, overrides,
    })).toBe(true);
    expect(effectiveVerbPermits({
      target: overridden, verb: PermissionVerb.Read, endpoint, overrides,
    })).toBe(false);
  });

  it('inherits the endpoint default when no override exists', () => {
    const overrides: ChatVerbOverrideTable = new Map();
    expect(effectiveVerbPermits({
      target: inheriting, verb: PermissionVerb.Read, endpoint, overrides,
    })).toBe(true);
    expect(effectiveVerbPermits({
      target: inheriting, verb: PermissionVerb.Send, endpoint, overrides,
    })).toBe(false);
  });

  it('treats an empty override as explicit deny-all', () => {
    const overrides: ChatVerbOverrideTable = new Map([
      [overridden.toKey(), new Set<PermissionVerb>()],
    ]);
    expect(effectiveVerbPermits({
      target: overridden, verb: PermissionVerb.Read, endpoint, overrides,
    })).toBe(false);
  });
});

describe('DefaultAclEvaluator with per-chat overrides', () => {
  const evaluator = new DefaultAclEvaluator();

  it('ESCALATES: an override grants a verb the group default denies', () => {
    const endpoint = buildEndpoint([PermissionVerb.Read]); // group: read-only
    const overrides: ChatVerbOverrideTable = new Map([
      [overridden.toKey(), new Set([PermissionVerb.Read, PermissionVerb.Send])],
    ]);
    const decision = evaluator.evaluate({
      endpoint,
      resolvedScope,
      verb: PermissionVerb.Send,
      target: overridden,
      overrides,
    });
    expect(decision.allowed).toBe(true);
  });

  it('NARROWS: an override revokes a verb the group default grants', () => {
    const endpoint = buildEndpoint([PermissionVerb.Read, PermissionVerb.Send]);
    const overrides: ChatVerbOverrideTable = new Map([
      [overridden.toKey(), new Set([PermissionVerb.Read])], // read-only here
    ]);
    const decision = evaluator.evaluate({
      endpoint,
      resolvedScope,
      verb: PermissionVerb.Send,
      target: overridden,
      overrides,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe(DomainErrorCode.VerbNotGranted);
    }
  });

  it('INHERITS: a target with no override falls through to the group default', () => {
    const endpoint = buildEndpoint([PermissionVerb.Read, PermissionVerb.Send]);
    const overrides: ChatVerbOverrideTable = new Map([
      [overridden.toKey(), new Set([PermissionVerb.Read])],
    ]);
    const decision = evaluator.evaluate({
      endpoint,
      resolvedScope,
      verb: PermissionVerb.Send,
      target: inheriting, // not in the table -> group default applies
      overrides,
    });
    expect(decision.allowed).toBe(true);
  });

  it('an override NEVER widens scope — an out-of-scope target is still denied', () => {
    const endpoint = buildEndpoint([PermissionVerb.Read]);
    const stranger = chat(999n);
    const overrides: ChatVerbOverrideTable = new Map([
      [stranger.toKey(), new Set([PermissionVerb.Read, PermissionVerb.Send])],
    ]);
    const decision = evaluator.evaluate({
      endpoint,
      resolvedScope,
      verb: PermissionVerb.Send,
      target: stranger,
      overrides,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      // verb-gate passes via the override, so the SCOPE gate is what denies.
      expect(decision.reason).toBe(DomainErrorCode.PeerOutOfScope);
    }
  });

  it('is byte-for-byte the old verb-gate when no overrides are supplied', () => {
    const endpoint = buildEndpoint([PermissionVerb.Read]);
    const denied = evaluator.evaluate({
      endpoint,
      resolvedScope,
      verb: PermissionVerb.Send,
      target: overridden,
    });
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.reason).toBe(DomainErrorCode.VerbNotGranted);
    }
    // an empty table behaves identically to "no overrides".
    const emptyTable = evaluator.evaluate({
      endpoint,
      resolvedScope,
      verb: PermissionVerb.Send,
      target: overridden,
      overrides: new Map(),
    });
    expect(emptyTable.allowed).toBe(false);
  });

  it('overrides are ignored for scope-wide (target-less) reads', () => {
    const endpoint = buildEndpoint([PermissionVerb.Read]);
    const overrides: ChatVerbOverrideTable = new Map([
      [overridden.toKey(), new Set([PermissionVerb.Send])],
    ]);
    const decision = evaluator.evaluate({
      endpoint,
      resolvedScope,
      verb: PermissionVerb.Read,
      overrides,
    });
    expect(decision.allowed).toBe(true);
  });
});

describe('chatOverridePermitsVerb — the post-resolution gate (H1 regression)', () => {
  const key = overridden.toKey();

  it('a chat with NO override defers to the group gate (permits — override layer is silent)', () => {
    expect(
      chatOverridePermitsVerb({ key, verb: PermissionVerb.Send, overrides: new Map() }),
    ).toBe(true);
  });

  it('a NARROWING override (read-only) DENIES the write — regardless of how the id was resolved', () => {
    // The key is the SAME whether the peer arrived as {id}, {username} or {me};
    // enforcement is keyed by the resolved canonical id, so all three forms are
    // gated identically (this is exactly the id-only bypass the audit found).
    const overrides: ChatVerbOverrideTable = new Map([[key, new Set([PermissionVerb.Read])]]);
    expect(chatOverridePermitsVerb({ key, verb: PermissionVerb.Send, overrides })).toBe(false);
    expect(chatOverridePermitsVerb({ key, verb: PermissionVerb.Read, overrides })).toBe(true);
  });

  it('an override that GRANTS the verb permits it (override replaces the group default)', () => {
    const overrides: ChatVerbOverrideTable = new Map([
      [key, new Set([PermissionVerb.Read, PermissionVerb.Send])],
    ]);
    expect(chatOverridePermitsVerb({ key, verb: PermissionVerb.Send, overrides })).toBe(true);
  });

  it('an empty override set is explicit deny-all for that chat', () => {
    const overrides: ChatVerbOverrideTable = new Map([[key, new Set()]]);
    expect(chatOverridePermitsVerb({ key, verb: PermissionVerb.Read, overrides })).toBe(false);
  });
});
