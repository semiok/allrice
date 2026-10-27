#!/usr/bin/env node
/* global process, setImmediate */
import { createRequire } from 'node:module';
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol';

const runtimeName = 'allrice-dsh-jsonrpc-runtime';
// The parent may request a version, but cannot manufacture the loaded kernel's
// identity through an environment claim. Public package metadata resolves from
// this actual adapter, including the SDK and loop it imports.
const installedModules = [
  'dsh-app-boot',
  'dsh-agent',
  'dsh-agent-loop',
  'dsh-llm',
  'dsh-session',
  'dsh-sdk-protocol',
  'dsh-sdk-jsonrpc-server',
];
const requirePackage = createRequire(import.meta.url);
const installedVersions = installedModules.map(
  (name) => requirePackage(`@deepseek-ai/${name}/package.json`).version,
);
if (
  installedVersions.some((version) => typeof version !== 'string') ||
  new Set(installedVersions).size !== 1
)
  throw Error('DSH_INSTALLED_MODULE_VERSION_MISMATCH');
const installedDshRuntimeVersion = installedVersions[0];

// Appended after the original literal installedModules/version metadata block.
const transport = new JsonRpcLineTransport(process.stdin, process.stdout);
let initializeStarted = false;
let moduleLoadStarted = false;
let sdkCreated = false;
let rootCreated = false;
let ownedContext;
let ownedServer;
let runtimeTask;
let shutdownPreparation;
let exitTask;
let closing = false;
let detached = false;
let requestedExitCode = 0;

function assertInitializationOpen() {
  if (detached) throw new Error('QUESTION_DETACHING');
  if (closing) throw new Error('ALLRICE_RUNTIME_CLOSING');
}

function beginInitialize() {
  assertInitializationOpen();
  if (initializeStarted) throw new Error('SDK_ALREADY_INITIALIZED');
  // These facts become irreversible before the import starts. A pending or
  // failed import can never be reclassified as the never-created empty case.
  initializeStarted = true;
  moduleLoadStarted = true;
  runtimeTask = import('./allrice-jsonrpc-implementation.mjs').then(
    ({ createAllRiceRuntime }) => {
      assertInitializationOpen();
      return createAllRiceRuntime(transport, {
        runtimeName,
        installedDshRuntimeVersion,
        assertInitializationOpen,
        ownContext(ctx) {
          ownedContext = ctx;
          rootCreated = true;
        },
        ownServer(server) {
          ownedServer = server;
          sdkCreated = true;
        },
      });
    },
  );
  // Observe a rejected preparation immediately while retaining its original
  // rejection for initialize and the exact same task for shutdown to join.
  void runtimeTask.catch(() => {});
  return runtimeTask;
}

function prepareShutdown() {
  if (shutdownPreparation) return shutdownPreparation;
  closing = true;
  shutdownPreparation = (async () => {
    if (
      !initializeStarted &&
      !moduleLoadStarted &&
      !sdkCreated &&
      !rootCreated &&
      !runtimeTask &&
      !ownedServer &&
      !ownedContext
    ) {
      // This is a real transport-only shutdown. No SDK/root API is claimed.
      await transport.flush();
      return {
        version: 2,
        kind: 'never_created',
        initializeStarted: false,
        moduleLoadStarted: false,
        sdkCreated: false,
        rootCreated: false,
        priorFramesFlushed: true,
      };
    }
    await runtimeTask?.catch(() => {});
    const receipt = {
      version: 1,
      sdkShutdown: false,
      rootDisposed: false,
      priorFramesFlushed: false,
    };
    for (const [stage, operation] of [
      [
        'sdkShutdown',
        () => {
          if (!ownedServer) throw new Error('SDK_NOT_CREATED');
          return ownedServer.shutdown();
        },
      ],
      [
        'rootDisposed',
        () => {
          if (!ownedContext) throw new Error('ROOT_NOT_CREATED');
          return ownedContext.root.fiber.dispose();
        },
      ],
      ['priorFramesFlushed', () => transport.flush()],
    ]) {
      try {
        await operation();
        receipt[stage] = true;
      } catch {
        /* false remains visible; neither absence nor failure becomes success */
      }
    }
    return receipt;
  })();
  return shutdownPreparation;
}

// MET-210: the root only waits on a user question and its journal is flushed.
// Exit without shutdown or dispose: both cancel, and DSH would drop the question.
function exitDetached() {
  if (exitTask) return exitTask;
  exitTask = transport
    .flush()
    .catch(() => {})
    .then(() => process.exit(0));
  return exitTask;
}

function disposeAndExit(code) {
  if (detached) return exitDetached();
  if (code !== 0 && requestedExitCode === 0) requestedExitCode = code;
  if (exitTask) return exitTask;
  exitTask = (async () => {
    try {
      const receipt = await prepareShutdown();
      const complete =
        receipt.version === 2
          ? receipt.priorFramesFlushed === true
          : receipt.sdkShutdown &&
            receipt.rootDisposed &&
            receipt.priorFramesFlushed;
      if (!complete && requestedExitCode === 0) requestedExitCode = 1;
    } catch {
      if (requestedExitCode === 0) requestedExitCode = 1;
    }
    // The RPC response is queued before setImmediate enters this last barrier.
    try {
      await transport.flush();
    } catch {
      if (requestedExitCode === 0) requestedExitCode = 1;
    }
    process.exit(requestedExitCode);
  })();
  return exitTask;
}

transport.onRequest(async (method, params) => {
  if (method === 'shutdown') {
    if (detached) {
      setImmediate(() => void exitDetached());
      return { detached: true };
    }
    try {
      const allriceClose = await prepareShutdown();
      setImmediate(() => void disposeAndExit(0));
      return { allriceClose };
    } catch {
      setImmediate(() => void disposeAndExit(1));
      throw new Error('ALLRICE_RUNTIME_CLOSE_UNCONFIRMED');
    }
  }
  assertInitializationOpen();
  const task = method === 'initialize' ? beginInitialize() : runtimeTask;
  if (!task) throw new Error('SDK_NOT_INITIALIZED');
  const runtime = await task;
  assertInitializationOpen();
  if (method === 'initialize') await runtime.ctx.get('loader')?.await();
  assertInitializationOpen();
  const result = await runtime.server.handleRequest(method, params);
  if (method === 'session/detach' && result?.detached === true) {
    detached = true;
    // The reply is queued before setImmediate; exitDetached flushes it.
    setImmediate(() => void exitDetached());
  }
  return result;
});
process.stdin.on('end', () => void disposeAndExit(0));
process.on('SIGTERM', () => void disposeAndExit(0));
process.on('SIGINT', () => void disposeAndExit(130));
transport.start();
