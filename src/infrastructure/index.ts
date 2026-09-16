// Adapters implementing the application ports. This is the ONLY layer permitted to import
// GramJS, and those types must never escape it.
export { SystemClock } from './clock/system-clock.js';

export { UnicodeSanitizer } from './sanitize/unicode-sanitizer.js';
export { GramjsTelegramGateway } from './telegram/gramjs-telegram-gateway.js';

export { DialogFilterFolderResolver } from './telegram/DialogFilterFolderResolver.js';

export { GramjsAccountLoginClient } from './telegram/gramjs-account-login-client.js';
export type { DialogFilterFlags } from './telegram/telegram-peer-id.js';
export { EncryptedFileSessionStore } from './session/EncryptedFileSessionStore.js';
export type { SessionKdfProfile } from './session/EncryptedFileSessionStore.js';
// Only the injectable port is surfaced: the concrete reader and host probe are infra internals
// the store imports directly.
export type { MachineIdReader } from './session/machine-id.js';
// The envelope crypto engine plus the minimal format surface consumed through this barrel; the
// remaining guards and types are imported directly by the store.
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

export {
  ENDPOINT_TOKEN_ENV,
  createEndpointTokenVerifier,
  endpointTokenMatches,
} from './endpoint-token.js';

export {
  daemonAddress,
  operatorAddress,
  isSocketFile,
  socketDirRefusal,
} from './daemon-address.js';

