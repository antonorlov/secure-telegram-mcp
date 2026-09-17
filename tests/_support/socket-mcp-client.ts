// The newline-delimited-JSON MCP transport the daemon speaks, plus the cheap scrypt profile.
import { connect as netConnect, type Socket } from 'node:net';

// Production is pin N=2^17 / machine N=2^15; tests need the format, not the work.
export const CHEAP_KDF = {
  pin: { N: 1 << 8, r: 8, p: 1 },
  machine: { N: 1 << 8, r: 8, p: 1 },
} as const;

export class SocketClientTransport {
  private socket: Socket | undefined;
  private buf = Buffer.alloc(0);
  public onmessage?: (m: unknown) => void;
  public onclose?: () => void;
  public onerror?: (e: Error) => void;
  public constructor(
    private readonly address: string,
    private readonly handshake: Record<string, unknown>,
  ) {}
  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = netConnect(this.address);
      this.socket = socket;
      socket.once('connect', () => {
        socket.write(`${JSON.stringify(this.handshake)}\n`);
        socket.on('data', (c: Buffer) => {
          this.onData(c);
        });
        socket.on('close', () => this.onclose?.());
        resolve();
      });
      socket.once('error', reject);
    });
  }
  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    let nl = this.buf.indexOf(0x0a);
    while (nl !== -1) {
      const line = this.buf.subarray(0, nl).toString('utf8');
      this.buf = this.buf.subarray(nl + 1);
      if (line.trim().length > 0) {
        try {
          this.onmessage?.(JSON.parse(line));
        } catch {
          // a non-JSON refusal line — ignore
        }
      }
      nl = this.buf.indexOf(0x0a);
    }
  }
  public send(message: unknown): Promise<void> {
    this.socket?.write(`${JSON.stringify(message)}\n`);
    return Promise.resolve();
  }
  public close(): Promise<void> {
    this.socket?.end();
    return Promise.resolve();
  }
}
