import { describe, it, expect } from 'vitest';
import {
  UntrustedText,
  UntrustedTextKind,
  AclDecisionFactory,
  PermissionVerb,
  DomainErrorCode,
} from '../../src/domain/index.js';

describe('UntrustedText', () => {
  it('labels a sanitized string and surfaces it under its named key (INVARIANT #6)', () => {
    const t = UntrustedText.wrapSanitized(UntrustedTextKind.Body, 'hello');
    expect(t.kind).toBe('untrusted_text');
    expect(t.sanitizedValue).toBe('hello');
    expect(t.toStructured()).toEqual({ untrusted_text: 'hello' });
  });

  it('supports the sender_display_name and chat_title keys', () => {
    expect(
      UntrustedText.wrapSanitized(UntrustedTextKind.SenderDisplayName, 'Alice').toStructured(),
    ).toEqual({ sender_display_name: 'Alice' });
    expect(
      UntrustedText.wrapSanitized(UntrustedTextKind.ChatTitle, 'Ops').toStructured(),
    ).toEqual({ chat_title: 'Ops' });
  });

  it('is immutable, and its structured form is frozen', () => {
    const t = UntrustedText.wrapSanitized(UntrustedTextKind.Body, 'x');
    expect(Object.isFrozen(t)).toBe(true);
    expect(Object.isFrozen(t.toStructured())).toBe(true);
  });
});

describe('AclDecision', () => {
  it('allow carries the verb and no reason', () => {
    const d = AclDecisionFactory.allow(PermissionVerb.Read);
    expect(d.allowed).toBe(true);
    expect(d.verb).toBe(PermissionVerb.Read);
  });

  it('deny carries a machine-readable reason and a non-sensitive message', () => {
    const d = AclDecisionFactory.deny(
      PermissionVerb.Send,
      DomainErrorCode.VerbNotGranted,
      'nope',
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toBe(DomainErrorCode.VerbNotGranted);
      expect(d.message).toBe('nope');
    }
  });

  it('decisions are immutable (frozen)', () => {
    expect(Object.isFrozen(AclDecisionFactory.allow(PermissionVerb.Read))).toBe(true);
    expect(
      Object.isFrozen(
        AclDecisionFactory.deny(PermissionVerb.Send, DomainErrorCode.PeerOutOfScope, 'm'),
      ),
    ).toBe(true);
  });
});
