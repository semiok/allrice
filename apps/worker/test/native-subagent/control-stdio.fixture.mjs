/* global process */
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol';
import { DshProtocolClient } from '../../src/harness/dsh-protocol-client.ts';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Byte-only relay puts real OS stdio between the production client and the
 * SDK transport. Native Host/LLM fixtures stay inspectable in the test process;
 * the relay never parses frames, invents a response or maps an exception. */
export async function controlStdio(
  h,
  runId,
  {
    handle = (method, params) => h.server.handleRequest(method, params),
    requestTimeoutMs = 5_000,
    onPeer = () => {},
  } = {},
) {
  const path = join(h.directory, 'control.sock');
  let socket, peer;
  const server = createServer((connected) => {
    socket = connected;
    peer = new JsonRpcLineTransport(socket, socket);
    peer.onRequest(handle);
    peer.start();
    onPeer(peer);
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(path, done);
  });
  const client = new DshProtocolClient({
    command: process.execPath,
    args: [
      '-e',
      `
      const socket = require('node:net').connect(process.argv[1]);
      socket.on('error', () => process.exit(1));
      process.stdin.pipe(socket);
      socket.pipe(process.stdout);
    `,
      path,
    ],
    cwd: h.directory,
    environment: {},
    requestTimeoutMs,
  });
  cleanups.push(async () => {
    const child = Reflect.get(client, 'child');
    child.kill('SIGTERM');
    await Reflect.get(client, 'closed');
    peer?.close();
    socket?.destroy();
    await new Promise((done) => server.close(done));
  });
  // The shared native fixture starts an idle Run itself. Rebind that same Run
  // through the actual client before any model/input work begins.
  await h.server.handleRequest('run/end', { sessionId: h.root.id, runId });
  await client.beginRun(h.root.id, runId);
  return client;
}
