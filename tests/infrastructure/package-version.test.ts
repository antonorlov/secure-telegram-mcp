/**
 * The version an MCP client is told is the version npm published. It used to be a literal in
 * the server constructor, which a release bump in package.json silently left behind; this pins
 * the surface a client actually sees, not the constant that feeds it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { PACKAGE_VERSION } from '../../src/infrastructure/index.js';
import { buildEndpointServer } from '../../src/presentation/mcp/server.js';
import { err } from '../../src/shared/index.js';
import { AppErrorCode, appError } from '../../src/application/index.js';

// Read independently of the code under test, so a shared bug cannot agree with itself.
const published = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    readonly version: string;
  }
).version;

describe('the package version has one source', () => {
  it('reads the version from package.json', () => {
    expect(PACKAGE_VERSION).toBe(published);
  });

  it('tells a connecting MCP client that same version in initialize', async () => {
    const { server } = buildEndpointServer({
      definitions: [],
      contextProvider: () =>
        Promise.resolve(err(appError(AppErrorCode.SessionLocked, 'locked'))),
    });
    const client = new Client({ name: 'version-test', version: '0.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
    try {
      expect(client.getServerVersion()).toMatchObject({
        name: 'secure-telegram-mcp',
        version: published,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
