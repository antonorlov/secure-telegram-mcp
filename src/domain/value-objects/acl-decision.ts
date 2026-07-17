/**
 * AclDecision — the verdict of an access-control evaluation. A denial carries a
 * machine-readable `DomainErrorCode` reason plus a non-sensitive message; no
 * untrusted Telegram prose ever appears here.
 */
import type { DomainErrorCode } from '../errors.js';
import type { PermissionVerb } from './permission-verb.js';

export type AclDecision =
  | { readonly allowed: true; readonly verb: PermissionVerb }
  | {
      readonly allowed: false;
      readonly verb: PermissionVerb;
      readonly reason: DomainErrorCode;
      readonly message: string;
    };

export const AclDecisionFactory = {
  allow(verb: PermissionVerb): AclDecision {
    return Object.freeze({ allowed: true, verb } as const);
  },
  deny(verb: PermissionVerb, reason: DomainErrorCode, message: string): AclDecision {
    return Object.freeze({ allowed: false, verb, reason, message } as const);
  },
} as const;
