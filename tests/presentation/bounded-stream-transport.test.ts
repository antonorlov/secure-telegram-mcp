import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  BoundedStreamServerTransport,
} from '../../src/presentation/mcp/bounded-stream-transport.js';

describe('BoundedStreamServerTransport', () => {
  it('delivers split and adjacent JSON-RPC frames in order', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new BoundedStreamServerTransport(input, output, 1024);
    const methods: string[] = [];
    transport.onmessage = (message): void => {
      if ('method' in message) methods.push(message.method);
    };
    await transport.start();

    input.write('{"jsonrpc":"2.0","id":1,"method":"pi');
    input.write('ng"}\n{"jsonrpc":"2.0","method":"notifications/cancelled"}\n');

    expect(methods).toEqual(['ping', 'notifications/cancelled']);
    await transport.close();
  });

  it('fails closed before retaining an oversized unterminated frame', async () => {
    const input = new PassThrough();
    const transport = new BoundedStreamServerTransport(
      input,
      new PassThrough(),
      32,
    );
    const errors: string[] = [];
    transport.onerror = (error): void => { errors.push(error.message); };
    await transport.start();

    input.write('x'.repeat(33));

    expect(errors).toEqual(['MCP request exceeds the frame size limit']);
    expect(input.destroyed).toBe(true);
  });

  it('serializes server messages as one NDJSON frame', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new BoundedStreamServerTransport(input, output);
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    await transport.start();

    await transport.send({ jsonrpc: '2.0', id: 1, result: { ok: true } });

    expect(Buffer.concat(chunks).toString('utf8')).toBe(
      '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n',
    );
    await transport.close();
  });

  it('rejects a backpressured send when the output closes before drain', async () => {
    const output = new Writable({
      highWaterMark: 1,
      write: (): void => {
        // Intentionally never completes: peer closure must settle the send.
      },
    });
    const transport = new BoundedStreamServerTransport(
      new PassThrough(),
      output,
    );
    await transport.start();

    const sending = transport.send({
      jsonrpc: '2.0',
      id: 1,
      result: { body: 'x'.repeat(1024) },
    });
    output.destroy();

    await expect(sending).rejects.toThrow('output closed before it drained');
    await transport.close();
  });

  it('closes before a non-reading client can retain unbounded request state', async () => {
    const input = new PassThrough();
    const output = new Writable({
      highWaterMark: 1,
      write: (): void => {
        // Never drain: every admitted response remains retained by the stream.
      },
    });
    const transport = new BoundedStreamServerTransport(input, output, 1024, 4);
    const errors: string[] = [];
    let admitted = 0;
    transport.onerror = (error): void => { errors.push(error.message); };
    transport.onmessage = (message): void => {
      admitted += 1;
      if ('id' in message && message.id !== undefined) {
        void transport.send({
          jsonrpc: '2.0',
          id: message.id,
          result: { body: 'x'.repeat(32 * 1024) },
        }).catch(() => undefined);
      }
    };
    await transport.start();

    input.write(
      Array.from(
        { length: 100 },
        (_, id) => `${JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })}\n`,
      ).join(''),
    );

    expect(admitted).toBe(4);
    expect(errors).toContain('too many in-flight MCP requests');
    expect(input.destroyed).toBe(true);
    expect(output.writableLength).toBeLessThan(160 * 1024);
    output.destroy();
    await transport.close();
  });
});
