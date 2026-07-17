/**
 * Infrastructure public surface — adapters implementing application ports. This
 * is the ONLY layer permitted to import GramJS (`telegram`); those types must
 * never escape it. Every symbol below is a concrete adapter plus the minimal
 * construction surface the composition root needs. Optional tuning knobs
 * (CircuitBreakerOptions) are NOT surfaced here — import them from the module
 * path when a non-default policy is required.
 */
export { SystemClock } from './clock/system-clock.js';

export { UnicodeSanitizer } from './sanitize/unicode-sanitizer.js';
export { GramjsTelegramGateway } from './telegram/gramjs-telegram-gateway.js';

// Real FolderResolver adapter (the folder differentiator).
export { DialogFilterFolderResolver } from './telegram/DialogFilterFolderResolver.js';

// Temporary unscoped login capability, constructed only inside the daemon.
export { GramjsAccountLoginClient } from './telegram/gramjs-account-login-client.js';
export type { DialogFilterFlags } from './telegram/telegram-peer-id.js';
// Encrypted session + policy repository (encrypted at rest, 0600, atomic).
export { EncryptedFileSessionStore } from './session/EncryptedFileSessionStore.js';
export type { SessionKdfProfile } from './session/EncryptedFileSessionStore.js';
// Host machine-id binding port (SMOOTH posture). `SystemMachineIdReader`/
// `nodeHostProbe`/`HostProbe` are infra internals the store defaults to (imported
// directly, never via this barrel), so only the injectable PORT is surfaced.
export type { MachineIdReader } from './session/machine-id.js';
// The v2 envelope crypto/format engine + the minimal shared format surface the
// store/tests consume THROUGH this barrel. The remaining guards/types
// (SESSION_ALGORITHM, isSlot, …) are imported directly by the store, off the barrel.
export {
  SessionEnvelopeCodec,
  isSessionEnvelopeV2,
} from './session/session-envelope.js';
export type {
  KdfParams,
  SessionPayload,
  Slot,
  SlotSecret,
  SessionEnvelopeV2,
} from './session/session-envelope.js';

export { FileAuditLog } from './audit/file-audit-log.js';

export { TokenBucketRateLimiter } from './rate-limit/token-bucket-rate-limiter.js';

// Endpoint API keys — mint/hash/verify (setup mints; the daemon verifies).
export {
  ENDPOINT_TOKEN_ENV,
  createEndpointTokenVerifier,
  endpointTokenMatches,
} from './endpoint-token.js';

// Daemon rendezvous address (unix socket in the 0700 session dir / named pipe).
export {
  daemonAddress,
  operatorAddress,
  isSocketFile,
  socketDirRefusal,
} from './daemon-address.js';

