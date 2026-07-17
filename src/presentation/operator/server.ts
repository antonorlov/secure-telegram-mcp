import { createServer, type Server, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';

import type {
  AccountSnapshotDto,
  AppError,
  SessionKeySource,
} from '../../application/index.js';
import type { Result } from '../../shared/index.js';
import {
  MAX_OPERATOR_FRAME_BYTES,
  isSerialOperatorOperation,
  parseOperatorRequest,
  type OperatorResponse,
  type OperatorAccountDto,
  type OperatorStatusDto,
  type OperatorRequest,
  type OperatorResult,
} from './protocol.js';
import type { LoginInteraction } from './login-sessions.js';
import { BoundedLineFramer } from '../bounded-line-framer.js';

export interface OperatorHandlers {
  requiresAuthentication(): Promise<boolean>;
  status(): Promise<OperatorStatusDto>;
  listAccounts(): Promise<
    Result<{ readonly accounts: readonly OperatorAccountDto[] }, AppError>
  >;
  authenticate(
    source: Exclude<SessionKeySource, { readonly kind: 'machine' }>,
  ): Promise<Result<void, AppError>>;
  applyPolicy(raw: string): Promise<Result<{ readonly digest: string }, AppError>>;
  snapshotAccount(
    sessionRef: string,
  ): Promise<Result<AccountSnapshotDto, AppError>>;
  beginLogin(
    ownerId: string,
    flowId: string,
    input: {
      readonly apiId: number;
      readonly apiHash: string;
      readonly method: 'qr' | 'phone';
    },
    interaction: LoginInteraction,
  ): Promise<
    Result<
      {
        readonly flowId: string;
        readonly account: {
          readonly id: string;
          readonly displayName: string;
          readonly username?: string;
        };
      },
      AppError
    >
  >;
  commitLogin(
    ownerId: string,
    flowId: string,
    sessionRef: string,
    source: SessionKeySource,
  ): Promise<Result<{ readonly sessionRef: string }, AppError>>;
  cancelLogin(ownerId: string, flowId: string): Promise<void>;
  disconnect(ownerId: string): Promise<void>;
  removeAccount(sessionRef: string): Promise<Result<{ readonly changed: true }, AppError>>;
  setPin(
    current: SessionKeySource,
    pin: SessionKeySource,
  ): Promise<Result<{ readonly changed: true }, AppError>>;
  changePin(
    current: SessionKeySource,
    replacement: SessionKeySource,
  ): Promise<Result<{ readonly changed: true }, AppError>>;
  removePin(
    current: SessionKeySource,
  ): Promise<Result<{ readonly changed: true }, AppError>>;
  exportRecovery(
    current: SessionKeySource,
    outputPath: string,
  ): Promise<Result<{ readonly changed: true }, AppError>>;
}

export interface OperatorServerOptions {
  readonly handlers: OperatorHandlers;
  readonly onActivity?: () => void;
  /** Test/deployment seam; defaults to the short local-socket timeout. */
  readonly firstFrameTimeoutMs?: number;
}

export interface OperatorServer extends Server {
  /** Stop every authenticated workflow before daemon ownership teardown. */
  closeConnections(): void;
  /** Wait until the operator mutation already in progress has settled. */
  drain(): Promise<void>;
}

const responseFrame = (response: OperatorResponse): string => {
  const frame = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(frame, 'utf8') <= MAX_OPERATOR_FRAME_BYTES) {
    return frame;
  }
  return `${JSON.stringify({
    v: 1,
    id: response.id,
    ok: false,
    error: 'operator response exceeds the size limit',
  })}\n`;
};

const FIRST_FRAME_TIMEOUT_MS = 3_000;
const MAX_QUEUED_REQUESTS = 32;

const advancesAuthenticationGeneration = (
  operation: OperatorRequest['op'],
): boolean =>
  operation === 'pin.set' ||
  operation === 'pin.change' ||
  operation === 'pin.remove';

/** Separate, sequential operator plane. It never parses MCP frames. */
export const createOperatorServer = (options: OperatorServerOptions): OperatorServer => {
  const sockets = new Set<Socket>();
  let closing = false;
  let authenticationGeneration = 0;
  const activeLogins = new Set<() => void>();
  let serialOperations: Promise<void> = Promise.resolve();
  const serialize = (work: () => Promise<void>): Promise<void> => {
    const running = serialOperations.catch(() => undefined).then(work);
    serialOperations = running.then(
      () => undefined,
      () => undefined,
    );
    return running;
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    const ownerId = randomUUID();
    let authenticatedGeneration: number | undefined;
    const framer = new BoundedLineFramer(MAX_OPERATOR_FRAME_BYTES);
    let pending = Promise.resolve();
    let queuedRequests = 0;
    let answerOperations = 0;
    let disconnected = false;
    let outputDrain: Promise<void> | undefined;
    let promptSequence = 1;
    const abort = new AbortController();
    const prompts = new Map<
      string,
      { readonly flowId: string; readonly resolve: (value: string) => void }
    >();
    const waitForOutput = async (): Promise<void> => {
      while (outputDrain !== undefined) await outputDrain;
    };
    const resumeInput = (): void => {
      if (outputDrain === undefined && !closing && !socket.destroyed) {
        socket.resume();
      }
    };
    const writeResponse = (response: OperatorResponse): Promise<void> => {
      if (socket.destroyed || !socket.writable) return Promise.resolve();
      if (socket.write(responseFrame(response))) return Promise.resolve();

      const drain = new Promise<void>((resolve) => {
        const settled = (): void => {
          socket.off('drain', settled);
          socket.off('close', settled);
          resolve();
        };
        socket.once('drain', settled);
        socket.once('close', settled);
      });
      outputDrain = drain;
      socket.pause();
      void drain.then(() => {
        if (outputDrain !== drain) return;
        outputDrain = undefined;
        resumeInput();
      });
      return drain;
    };
    const send = (response: OperatorResponse): Promise<void> => {
      if (outputDrain === undefined) {
        return writeResponse(response);
      }
      return waitForOutput().then(() => send(response));
    };
    const reject = (id: string, error: string): Promise<void> => {
      return send({ v: 1, id, ok: false, error });
    };
    const firstFrameTimer = setTimeout(() => {
      void reject('', 'operator request timed out');
      socket.end();
    }, options.firstFrameTimeoutMs ?? FIRST_FRAME_TIMEOUT_MS);
    firstFrameTimer.unref();
    let receivedFrame = false;

    const handle = async (request: OperatorRequest): Promise<void> => {
      options.onActivity?.();
      if (request.op === 'status') {
        await send({
          v: 1,
          id: request.id,
          ok: true,
          result: await options.handlers.status(),
        });
        return;
      }
      if (request.op === 'authenticate') {
        const result = await options.handlers.authenticate(request.source);
        if (!result.ok) {
          await reject(request.id, 'operator authentication failed');
          return;
        }
        authenticatedGeneration = authenticationGeneration;
        await send({
          v: 1,
          id: request.id,
          ok: true,
          result: { authenticated: true },
        });
        return;
      }
      const requiredBefore = await options.handlers.requiresAuthentication();
      if (
        authenticatedGeneration !== authenticationGeneration &&
        requiredBefore
      ) {
        await reject(request.id, 'operator authentication required');
        return;
      }
      const requestGeneration = authenticationGeneration;
      if (request.op === 'login.answer') {
        const prompt = prompts.get(request.promptId);
        if (prompt?.flowId !== request.flowId) {
          await reject(request.id, 'login prompt is not pending');
          return;
        }
        prompts.delete(request.promptId);
        prompt.resolve(request.value);
        await send({
          v: 1,
          id: request.id,
          ok: true,
          result: { accepted: true },
        });
        return;
      }
      if (request.op === 'login.cancel') {
        await options.handlers.cancelLogin(ownerId, request.flowId);
        await send({
          v: 1,
          id: request.id,
          ok: true,
          result: { accepted: true },
        });
        return;
      }

      let result: Result<OperatorResult, AppError>;
      switch (request.op) {
        case 'accounts.list':
          result = await options.handlers.listAccounts();
          break;
        case 'policy.apply':
          result = await options.handlers.applyPolicy(request.raw);
          break;
        case 'account.snapshot':
          result = await options.handlers.snapshotAccount(request.sessionRef);
          break;
        case 'account.remove':
          result = await options.handlers.removeAccount(request.sessionRef);
          break;
        case 'login.commit':
          result = await options.handlers.commitLogin(
            ownerId,
            request.flowId,
            request.sessionRef,
            request.source,
          );
          break;
        case 'pin.set':
          result = await options.handlers.setPin(request.current, request.pin);
          break;
        case 'pin.change':
          result = await options.handlers.changePin(
            request.current,
            request.replacement,
          );
          break;
        case 'pin.remove':
          result = await options.handlers.removePin(request.current);
          break;
        case 'recovery.export':
          result = await options.handlers.exportRecovery(
            request.current,
            request.outputPath,
          );
          break;
        case 'login.begin': {
          const loginAbort = new AbortController();
          const revoke = (): void => {
            loginAbort.abort();
            for (const [promptId, prompt] of prompts) {
              if (prompt.flowId !== request.id) continue;
              prompts.delete(promptId);
              prompt.resolve('');
            }
          };
          abort.signal.addEventListener('abort', revoke, { once: true });
          activeLogins.add(revoke);
          try {
            result = await options.handlers.beginLogin(
              ownerId,
              request.id,
              {
                apiId: request.apiId,
                apiHash: request.apiHash,
                method: request.method,
              },
              {
                signal: loginAbort.signal,
                qr: (info): Promise<void> => {
                  if (requestGeneration !== authenticationGeneration) {
                    return Promise.resolve();
                  }
                  return send({
                    v: 1,
                    id: request.id,
                    event: 'login.qr',
                    ...info,
                  });
                },
                ask: async (kind, hint): Promise<string> => {
                  if (requestGeneration !== authenticationGeneration) {
                    return '';
                  }
                  const promptId = String(promptSequence++);
                  const answer = new Promise<string>((resolve) => {
                    prompts.set(promptId, {
                      flowId: request.id,
                      resolve,
                    });
                  });
                  await send({
                    v: 1,
                    id: request.id,
                    event: 'login.prompt',
                    promptId,
                    kind,
                    ...(hint !== undefined ? { hint } : {}),
                  });
                  return answer;
                },
              },
            );
          } finally {
            activeLogins.delete(revoke);
            abort.signal.removeEventListener('abort', revoke);
          }
          break;
        }
      }
      if (requestGeneration !== authenticationGeneration) {
        if (request.op === 'login.begin') {
          await options.handlers.cancelLogin(ownerId, request.id);
        }
        await reject(request.id, 'operator authentication required');
        return;
      }
      if (!result.ok) {
        await reject(request.id, result.error.message);
        return;
      }
      const hardenedTransition =
        !requiredBefore &&
        (request.op === 'login.commit' || request.op === 'policy.apply') &&
        (await options.handlers.requiresAuthentication());
      if (
        advancesAuthenticationGeneration(request.op) ||
        hardenedTransition
      ) {
        authenticationGeneration += 1;
        for (const revoke of activeLogins) revoke();
        // The successful transition request either supplied the replacement
        // credential or durably sealed state under it. Carry only this socket;
        // every other authenticated socket must prove the new generation.
        authenticatedGeneration = authenticationGeneration;
      }
      await send({
        v: 1,
        id: request.id,
        ok: true,
        result: result.value,
      });
    };

    const releaseQueuedRequest = (): void => {
      queuedRequests -= 1;
    };

    const enqueue = (request: OperatorRequest): boolean => {
      if (queuedRequests >= MAX_QUEUED_REQUESTS) {
        void reject(request.id, 'too many queued operator requests');
        socket.destroy();
        return false;
      }
      queuedRequests += 1;
      const running = pending.catch(() => undefined).then(async () => {
        await waitForOutput();
        if (closing || disconnected) {
          return reject(request.id, 'operator server is shutting down');
        }
        return isSerialOperatorOperation(request.op)
          ? serialize(() => handle(request))
          : handle(request);
      });
      pending = running.then(
        () => { releaseQueuedRequest(); },
        () => {
          void reject(request.id, 'operator request failed');
          releaseQueuedRequest();
        },
      );
      return true;
    };

    socket.on('data', (chunk: Buffer) => {
      const accepted = framer.push(chunk, (line) => {
        if (outputDrain !== undefined) {
          socket.destroy();
          return false;
        }
        const request = parseOperatorRequest(line);
        if (request === undefined) {
          void reject('', 'malformed operator request');
          return;
        }
        if (!receivedFrame) {
          receivedFrame = true;
          clearTimeout(firstFrameTimer);
        }
        if (request.op === 'login.answer') {
          if (answerOperations >= MAX_QUEUED_REQUESTS) {
            void reject(request.id, 'too many operator answers in flight');
            socket.destroy();
            return false;
          }
          answerOperations += 1;
          // Order prompt answers with PIN changes without putting login.begin
          // itself on the serial queue (it is waiting for this answer).
          void waitForOutput().then(() => serialize(() => handle(request))).then(
            () => { answerOperations -= 1; },
            () => {
              answerOperations -= 1;
              void reject(request.id, 'operator request failed');
            },
          );
        } else {
          return enqueue(request);
        }
        return;
      });
      if (!accepted && !socket.destroyed) {
        void reject('', 'operator request exceeds the size limit');
        socket.destroy();
      }
    });
    const disconnect = (): void => {
      disconnected = true;
      clearTimeout(firstFrameTimer);
      framer.clear();
      sockets.delete(socket);
      abort.abort();
      for (const prompt of prompts.values()) prompt.resolve('');
      prompts.clear();
      void options.handlers.disconnect(ownerId).catch(() => undefined);
    };
    socket.once('close', disconnect);
    socket.on('error', () => socket.destroy());
  });
  const operatorServer = server as OperatorServer;
  operatorServer.closeConnections = (): void => {
    closing = true;
    for (const socket of sockets) socket.destroy();
  };
  operatorServer.drain = (): Promise<void> => serialOperations;
  server.maxConnections = 4;
  return operatorServer;
};
