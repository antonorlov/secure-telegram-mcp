import type { Socket } from 'node:net';

import type {
  AccountSnapshotDto,
  SessionKeySource,
} from '../../application/index.js';
import { operatorAddress } from '../../infrastructure/daemon-address.js';
import { err, isErr, ok, type Result } from '../../shared/index.js';
import {
  openDaemonSocket,
  type DaemonCommand,
} from '../daemon-socket.js';
import { BoundedLineFramer } from '../bounded-line-framer.js';
import type {
  OperatorRequest,
  OperatorResponse,
  OperatorResult,
  OperatorAccountDto,
  OperatorStatusDto,
} from './protocol.js';
import {
  isOperatorResultFor,
  MAX_OPERATOR_FRAME_BYTES,
  parseOperatorResponse,
} from './protocol.js';

export interface OperatorClientOptions {
  readonly sessionDir: string;
  readonly daemonCommand: DaemonCommand;
}

interface Pending {
  readonly operation: OperatorRequest['op'];
  readonly resolve: (response: Extract<OperatorResponse, { readonly ok: boolean }>) => void;
  readonly onEvent?: (
    event: Extract<OperatorResponse, { readonly event: string }>,
  ) => void | Promise<void>;
}

/** Persistent setup-side client; authentication is scoped to this socket. */
export class OperatorClient {
  private socket: Socket | undefined;
  private readonly framer = new BoundedLineFramer(MAX_OPERATOR_FRAME_BYTES);
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();

  public constructor(private readonly options: OperatorClientOptions) {}

  public async connect(): Promise<Result<void, string>> {
    if (this.socket !== undefined) return ok(undefined);
    const address = operatorAddress(this.options.sessionDir);
    const opened = await openDaemonSocket({
      address,
      daemonCommand: this.options.daemonCommand,
      unavailableError: 'Telegram MCP did not start',
    });
    if (isErr(opened)) return opened;
    const socket = opened.value;
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => { this.onData(socket, chunk); });
    socket.once('close', () => { this.onClose(socket); });
    socket.once('error', () => {
      this.onClose(socket, 'operator connection failed');
    });
    return ok(undefined);
  }

  public status(): Promise<Result<OperatorStatusDto, string>> {
    return this.request<OperatorStatusDto>({ op: 'status' });
  }

  public listAccounts(): Promise<
    Result<{ readonly accounts: readonly OperatorAccountDto[] }, string>
  > {
    return this.request({ op: 'accounts.list' });
  }

  public authenticate(source: SessionKeySource): Promise<Result<void, string>> {
    if (source.kind === 'machine') return Promise.resolve(ok(undefined));
    return this.request<{ readonly authenticated: true }>({
      op: 'authenticate',
      source,
    }).then((result) => (result.ok ? ok(undefined) : result));
  }

  public applyPolicy(raw: string): Promise<Result<{ readonly digest: string }, string>> {
    return this.request({ op: 'policy.apply', raw });
  }

  public snapshotAccount(
    sessionRef: string,
  ): Promise<Result<AccountSnapshotDto, string>> {
    return this.request({ op: 'account.snapshot', sessionRef });
  }

  public login(input: {
    readonly apiId: number;
    readonly apiHash: string;
    readonly method: 'qr' | 'phone';
    readonly onQr: (info: {
      readonly url: string;
      readonly expiresInSeconds: number;
    }) => void | Promise<void>;
    readonly ask: (
      kind: 'phone' | 'code' | 'password',
      hint?: string,
    ) => Promise<string>;
  }): Promise<
    Result<
      {
        readonly flowId: string;
        readonly account: {
          readonly id: string;
          readonly displayName: string;
          readonly username?: string;
        };
      },
      string
    >
  > {
    return this.request(
      {
        op: 'login.begin',
        apiId: input.apiId,
        apiHash: input.apiHash,
        method: input.method,
      },
      async (event) => {
        if (event.event === 'login.qr') {
          await input.onQr({
            url: event.url,
            expiresInSeconds: event.expiresInSeconds,
          });
          return;
        }
        const value = await input.ask(event.kind, event.hint);
        const answered = await this.request({
          op: 'login.answer',
          flowId: event.id,
          promptId: event.promptId,
          value,
        });
        if (isErr(answered)) throw new Error(answered.error);
      },
    );
  }

  public commitLogin(input: {
    readonly flowId: string;
    readonly sessionRef: string;
    readonly source: SessionKeySource;
  }): Promise<Result<{ readonly sessionRef: string }, string>> {
    return this.request({ op: 'login.commit', ...input });
  }

  public cancelLogin(flowId: string): Promise<Result<{ readonly accepted: true }, string>> {
    return this.request({ op: 'login.cancel', flowId });
  }

  public removeAccount(
    sessionRef: string,
  ): Promise<Result<{ readonly changed: true }, string>> {
    return this.request({ op: 'account.remove', sessionRef });
  }

  public setPin(
    current: SessionKeySource,
    pin: SessionKeySource,
  ): Promise<Result<{ readonly changed: true }, string>> {
    return this.request({ op: 'pin.set', current, pin });
  }

  public changePin(
    current: SessionKeySource,
    replacement: SessionKeySource,
  ): Promise<Result<{ readonly changed: true }, string>> {
    return this.request({ op: 'pin.change', current, replacement });
  }

  public removePin(
    current: SessionKeySource,
  ): Promise<Result<{ readonly changed: true }, string>> {
    return this.request({ op: 'pin.remove', current });
  }

  public exportRecovery(
    current: SessionKeySource,
    outputPath: string,
  ): Promise<Result<{ readonly changed: true }, string>> {
    return this.request({ op: 'recovery.export', current, outputPath });
  }

  public close(): void {
    const socket = this.socket;
    if (socket === undefined) return;
    this.onClose(socket);
    socket.end();
  }

  private request<T extends OperatorResult>(
    body: Readonly<Record<string, unknown>> & {
      readonly op: OperatorRequest['op'];
    },
    onEvent?: (
      event: Extract<OperatorResponse, { readonly event: string }>,
    ) => void | Promise<void>,
  ): Promise<Result<T, string>> {
    const socket = this.socket;
    if (socket === undefined) {
      return Promise.resolve(err('operator client is not connected'));
    }
    const id = String(this.nextId++);
    return new Promise((resolve) => {
      this.pending.set(id, {
        operation: body.op,
        ...(onEvent !== undefined ? { onEvent } : {}),
        resolve: (response): void => {
          resolve(
            response.ok
              ? ok(response.result as T)
              : err(response.error),
          );
        },
      });
      socket.write(`${JSON.stringify({ v: 1, id, ...body })}\n`);
    });
  }

  private onData(socket: Socket, chunk: Buffer): void {
    if (socket !== this.socket) return;
    const accepted = this.framer.push(chunk, (line) => {
      const response = parseOperatorResponse(line);
      if (response === undefined) {
        this.onClose(socket, 'malformed operator response');
        socket.destroy();
        return false;
      }
      const waiter = this.pending.get(response.id);
      if (waiter === undefined) {
        this.onClose(socket, 'unexpected operator response');
        socket.destroy();
        return false;
      }
      if ('event' in response) {
        if (waiter.operation !== 'login.begin' || waiter.onEvent === undefined) {
          this.onClose(socket, 'unexpected operator event');
          socket.destroy();
          return false;
        }
        void Promise.resolve(waiter.onEvent(response)).catch(() => {
          // Abort the connection-bound login flow if its UI callback fails;
          // otherwise the daemon would wait forever for an answer.
          this.onClose(socket, 'operator event handler failed');
          socket.destroy();
        });
        return;
      }
      if (response.ok && !isOperatorResultFor(waiter.operation, response.result)) {
        this.onClose(socket, 'operator response did not match its request');
        socket.destroy();
        return false;
      }
      this.pending.delete(response.id);
      waiter.resolve(response);
      return;
    });
    if (!accepted && socket === this.socket) {
      this.onClose(socket, 'operator response exceeds the size limit');
      socket.destroy();
    }
  }

  private onClose(
    socket: Socket,
    reason = 'operator connection closed',
  ): void {
    if (socket !== this.socket) return;
    this.socket = undefined;
    this.framer.clear();
    const failed: Extract<OperatorResponse, { readonly ok: boolean }> = {
      v: 1,
      id: '',
      ok: false,
      error: reason,
    };
    for (const waiter of this.pending.values()) waiter.resolve(failed);
    this.pending.clear();
  }
}

export type OperatorClientPort = Pick<OperatorClient, keyof OperatorClient>;
