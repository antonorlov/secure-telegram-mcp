import type { SessionRefValue } from '../../domain/index.js';

/**
 * Decrypted Telegram credentials passed only between session persistence and
 * gateway adapters. Never log any field of this object.
 */
export interface SessionMaterial {
  readonly sessionRef: SessionRefValue;
  readonly secret: string;
  readonly apiId: number;
  readonly apiHash: string;
  readonly label?: string;
}
