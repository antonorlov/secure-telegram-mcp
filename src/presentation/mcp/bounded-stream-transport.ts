import type { Readable, Writable } from 'node:stream';

import {
  deserializeMessage,
  serializeMessage,
} from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import { BoundedLineFramer } from '../bounded-line-framer.js';

/** Generous ceiling over the largest shipped tool input (currently below 8 KiB). */
export const MAX_MCP_FRAME_BYTES = 256 * 1024;
/** Bound request state and queued responses retained for a non-reading client. */
export const MAX_MCP_IN_FLIGHT_REQUESTS = 32;

/**
 * SDK-compatible NDJSON transport with an input ceiling. The upstream stdio
 * transport retains an unterminated line without limit and repeatedly copies it;
 * this adapter frames once, validates through the SDK, and fails the stream
 * closed before an adversarial client can consume unbounded daemon resources.
 */
export class BoundedStreamServerTransport implements Transport {
  private readonly framer: BoundedLineFramer;
  private started = false;
  private closed = false;
  private pendingDrain: Promise<void> | undefined;
  private cancelDrain: ((error: Error) => void) | undefined;
  private readonly inFlightRequests = new Set<string>();

  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: (message: JSONRPCMessage) => void;

  public constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    maxFrameBytes: number = MAX_MCP_FRAME_BYTES,
    private readonly maxInFlightRequests: number = MAX_MCP_IN_FLIGHT_REQUESTS,
  ) {
    this.framer = new BoundedLineFramer(maxFrameBytes);
    if (!Number.isInteger(maxInFlightRequests) || maxInFlightRequests < 1) {
      throw new RangeError('maxInFlightRequests must be a positive integer');
    }
  }

  public start(): Promise<void> {
    if (this.started) {
      return Promise.reject(new Error('transport is already started'));
    }
    this.started = true;
    this.input.on('data', this.handleData);
    this.input.on('error', this.handleError);
    return Promise.resolve();
  }

  public send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return Promise.reject(new Error('transport is closed'));
    const responseKey = this.responseKey(message);
    const sending = new Promise<void>((resolve, reject) => {
      try {
        if (this.output.write(serializeMessage(message))) {
          resolve();
        } else {
          void this.waitForDrain().then(resolve, reject);
        }
      } catch (error) {
        reject(this.toError(error));
      }
    });
    return responseKey === undefined
      ? sending
      : sending.finally(() => { this.inFlightRequests.delete(responseKey); });
  }

  public close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.input.off('data', this.handleData);
    this.input.off('error', this.handleError);
    this.cancelDrain?.(new Error('transport closed before output drained'));
    this.framer.clear();
    this.inFlightRequests.clear();
    this.onclose?.();
    return Promise.resolve();
  }

  private readonly handleData = (chunk: Buffer): void => {
    const accepted = this.framer.push(chunk, (line) => {
      try {
        const message = deserializeMessage(line);
        const requestKey = this.requestKey(message);
        if (requestKey !== undefined) {
          if (
            this.inFlightRequests.has(requestKey) ||
            this.inFlightRequests.size >= this.maxInFlightRequests
          ) {
            this.fail(new Error('too many in-flight MCP requests'));
            return false;
          }
          this.inFlightRequests.add(requestKey);
        }
        try {
          this.onmessage?.(message);
        } catch (error) {
          if (requestKey !== undefined) this.inFlightRequests.delete(requestKey);
          throw error;
        }
        return undefined;
      } catch (error) {
        this.onerror?.(this.toError(error));
        return undefined;
      }
    });
    if (!accepted && !this.closed) {
      this.fail(new Error('MCP request exceeds the frame size limit'));
    }
  };

  private readonly handleError = (error: Error): void => {
    this.onerror?.(error);
  };

  private fail(error: Error): void {
    this.onerror?.(error);
    this.input.destroy();
    void this.close();
  }

  private requestKey(message: JSONRPCMessage): string | undefined {
    return 'method' in message && 'id' in message
      ? `${typeof message.id}:${String(message.id)}`
      : undefined;
  }

  private responseKey(message: JSONRPCMessage): string | undefined {
    return 'id' in message && ('result' in message || 'error' in message)
      ? `${typeof message.id}:${String(message.id)}`
      : undefined;
  }

  /** Share one backpressure waiter and settle it on drain, error, or close. */
  private waitForDrain(): Promise<void> {
    if (this.pendingDrain !== undefined) return this.pendingDrain;
    const pending = new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.output.off('drain', onDrain);
        this.output.off('error', onError);
        this.output.off('close', onClose);
        this.cancelDrain = undefined;
      };
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onClose = (): void => {
        onError(new Error('output closed before it drained'));
      };
      this.cancelDrain = onError;
      this.output.once('drain', onDrain);
      this.output.once('error', onError);
      this.output.once('close', onClose);
    });
    this.pendingDrain = pending;
    void pending
      .finally(() => {
        if (this.pendingDrain === pending) this.pendingDrain = undefined;
      })
      .catch(() => undefined);
    return pending;
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}
