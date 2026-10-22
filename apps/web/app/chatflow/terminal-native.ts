'use client';

import * as cordis from '@deepseek-ai/cordis';
import * as store from '@deepseek-ai/dsh-client-store';
import type * as gatewayTypes from '@deepseek-ai/dsh-api-gateway/client';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';
import type {
  ClientTerminals,
  TerminalView,
  TerminalViewState,
} from '@deepseek-ai/dsh-api-terminal-controller/client';
import { loadNativeClientModule } from './native-client-module';
import {
  TerminalCarrier,
  type TerminalIdentity,
  type TerminalPin,
} from './terminal-transport';

const version = '0.2.1-rc.2';
export type TerminalScreenProps = {
  useTabInfo: () => {
    tab: {
      id: string;
      visible: boolean;
      actions: {
        openTab: (kind: string, options: { replaceTab: boolean }) => void;
      };
    };
  };
  useTerminal: (key: string) => TerminalViewState;
  useTheme: <T>(
    selector: (value: {
      fontFamilies: { terminal: string };
      fontSizes: { terminal: number };
    }) => T,
  ) => T;
  view: (key: string) => TerminalView;
  t: (key: string, values?: Record<string, string>) => string;
};
type NativeScreen = { TerminalBody: React.ComponentType<TerminalScreenProps> };
type NativeModel = { ClientTerminals: typeof ClientTerminals };
type NativeGateway = Pick<
  typeof gatewayTypes,
  'RemoteStream' | 'RemoteStreamCarrierError'
>;
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Native model reset event, supplied by AllRice's authenticated carrier. */
    'connection/reset'(): void;
  }
}
export type TerminalRuntime = {
  carrier: TerminalCarrier;
  models: ClientTerminals;
  screen: NativeScreen;
  identity: TerminalIdentity;
  pin: TerminalPin;
  ownerGeneration: number;
  tabs: Map<string, string>;
  dispose: () => Promise<void>;
};
const runtimes = new Map<string, Promise<TerminalRuntime>>();
let currentOwner = '';
let ownerGeneration = 0;
type OwnerIdentity = Pick<
  TerminalIdentity,
  'organizationId' | 'workspaceId' | 'ownerId'
>;
type CleanupFailure = {
  key: string;
  id: string;
  title: string;
  message: string;
  owner: OwnerIdentity;
  retry: () => void;
};
const cleanupGroups = new Map<
  string,
  { model: ClientTerminals | null; failures: CleanupFailure[] }
>();
export const terminalCleanupFailures = store.createSnapshotStore<
  readonly CleanupFailure[]
>([]);
const publishCleanup = () =>
  terminalCleanupFailures.set(
    [...cleanupGroups.values()].flatMap((group) => group.failures),
  );

export function releaseTerminalOwner(
  expectedOwner?: OwnerIdentity,
): Promise<void> {
  if (
    expectedOwner &&
    JSON.stringify([
      expectedOwner.organizationId,
      expectedOwner.workspaceId,
      expectedOwner.ownerId,
    ]) !== currentOwner
  )
    return Promise.resolve();
  currentOwner = '';
  ownerGeneration++;
  cleanupGroups.clear();
  publishCleanup();
  const pending = [...runtimes.values()];
  runtimes.clear();
  return Promise.allSettled(
    pending.map((runtime) => runtime.then((value) => value.dispose())),
  ).then(() => undefined);
}

export function terminalTargetKey(
  identity: TerminalIdentity,
  pin: TerminalPin,
) {
  return JSON.stringify([
    identity.organizationId,
    identity.workspaceId,
    identity.ownerId,
    identity.sessionId,
    pin.deviceId,
    pin.grantId,
  ]);
}

function scopedStorage(scope: string) {
  const prefix = `allrice.terminal.native.v1.${scope}.`;
  const memory = new Map<string, string>();
  const keys = () => {
    const names = new Set(memory.keys());
    try {
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key?.startsWith(prefix)) names.add(key.slice(prefix.length));
      }
    } catch {
      /* Private storage retains this runtime's in-memory capability. */
    }
    return [...names];
  };
  return {
    get length() {
      return keys().length;
    },
    key(index: number) {
      return keys()[index] ?? null;
    },
    getItem(key: string) {
      try {
        return localStorage.getItem(prefix + key) ?? memory.get(key) ?? null;
      } catch {
        return memory.get(key) ?? null;
      }
    },
    setItem(key: string, value: string) {
      memory.set(key, value);
      localStorage.setItem(prefix + key, value);
    },
    removeItem(key: string) {
      memory.delete(key);
      localStorage.removeItem(prefix + key);
    },
  };
}

/** Keep native models alive across DOM/tab/session switches. The owner change
 * disposes only browser attachments; explicit tab close owns PTY cleanup. */
export function retainTerminalOwner(
  identity: Pick<
    TerminalIdentity,
    'organizationId' | 'workspaceId' | 'ownerId'
  >,
) {
  const owner = JSON.stringify([
    identity.organizationId,
    identity.workspaceId,
    identity.ownerId,
  ]);
  if (owner === currentOwner) return;
  currentOwner = owner;
  ownerGeneration++;
  cleanupGroups.clear();
  publishCleanup();
  for (const runtime of runtimes.values())
    void runtime.then((value) => value.dispose()).catch(() => undefined);
  runtimes.clear();
  // Reopen only the native cleanup owner, never a shell, for a saved close whose
  // tab has already gone. This restores upstream cleanup after browser reload.
  try {
    const prefix = 'allrice.terminal.native.v1.';
    const marker = '.dsh.terminal.close.v1.';
    const scopes = new Set<string>();
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix) && key.includes(marker))
        scopes.add(key.slice(prefix.length, key.indexOf(marker)));
    }
    for (const scope of scopes) {
      const parts: unknown = JSON.parse(scope);
      if (
        !Array.isArray(parts) ||
        parts.length !== 6 ||
        parts.some((part) => typeof part !== 'string')
      )
        continue;
      const [
        organizationId,
        workspaceId,
        ownerId,
        sessionId,
        deviceId,
        grantId,
      ] = parts as string[];
      if (
        organizationId !== identity.organizationId ||
        workspaceId !== identity.workspaceId ||
        ownerId !== identity.ownerId ||
        !sessionId ||
        !deviceId ||
        !grantId
      )
        continue;
      void nativeTerminalRuntime(
        { organizationId, workspaceId, ownerId, sessionId },
        { deviceId, grantId },
      ).catch(() => undefined);
    }
  } catch {
    /* No durable storage is available; the live native models remain. */
  }
}

export function nativeTerminalRuntime(
  identity: TerminalIdentity,
  pin: TerminalPin,
) {
  retainTerminalOwner(identity);
  const key = terminalTargetKey(identity, pin);
  let runtime = runtimes.get(key);
  if (!runtime) {
    const generation = ownerGeneration;
    runtime = (async (): Promise<TerminalRuntime> => {
      const gateway = await loadNativeClientModule<NativeGateway>({
        packageId: '@deepseek-ai/dsh-api-gateway',
        url: `/api/dsh-ui/terminal-gateway?version=${version}`,
        dependencies: { '@deepseek-ai/cordis': cordis },
      });
      const [model, screen] = await Promise.all([
        loadNativeClientModule<NativeModel>({
          packageId: '@deepseek-ai/dsh-api-terminal-controller',
          url: `/api/dsh-ui/terminal-model?version=${version}`,
          cacheKey: `terminal-model:${key}`,
          storage: scopedStorage(key),
          dependencies: {
            '@deepseek-ai/cordis': cordis,
            '@deepseek-ai/dsh-client-store': store,
            '@deepseek-ai/dsh-api-gateway/client': gateway,
          },
        }),
        loadNativeClientModule<NativeScreen>({
          packageId: '@deepseek-ai/dsh-client-ui-sidebar-terminal',
          chunk: 'client.terminal.js',
          url: `/api/dsh-ui/terminal-screen?version=${version}`,
          dependencies: {
            react: React,
            'react/jsx-runtime': jsxRuntime,
            '@deepseek-ai/dsh-client-ui-primitives': primitives,
          },
        }),
      ]);
      if (generation !== ownerGeneration) throw Error('终端所属工作区已切换');
      const carrier = new TerminalCarrier(
        identity,
        pin,
        (message) => new gateway.RemoteStreamCarrierError(message),
      );
      const ctx = new cordis.Context();
      const connection = { generation: carrier.generation };
      const remote = {
        terminal: carrier.remote,
        $stream: <T>(options: gatewayTypes.RemoteStreamOptions<T>) =>
          new gateway.RemoteStream(connection, options),
      };
      ctx.provide('connection', connection);
      ctx.provide('remote', remote);
      carrier.onReset = () => ctx.emit('connection/reset');
      const models = new model.ClientTerminals(ctx, carrier.remote);
      const cleanupChanged = () => {
        if (generation !== ownerGeneration) return;
        cleanupGroups.set(key, {
          model: models,
          failures: models.closeFailures.getSnapshot().map((failure) => ({
            ...failure,
            key: key + '/' + failure.id,
            owner: identity,
            retry: () => models.retryClose(failure.id),
          })),
        });
        publishCleanup();
      };
      const unsubscribeCleanup = models.closeFailures.subscribe(cleanupChanged);
      cleanupChanged();
      return {
        identity,
        pin,
        ownerGeneration: generation,
        carrier,
        models,
        screen,
        tabs: new Map(),
        dispose: async () => {
          unsubscribeCleanup();
          if (cleanupGroups.get(key)?.model === models) {
            cleanupGroups.delete(key);
            publishCleanup();
          }
          carrier.dispose();
          await ctx.fiber.dispose();
        },
      };
    })().catch((error) => {
      if (runtimes.get(key) === runtime) runtimes.delete(key);
      throw error;
    });
    runtimes.set(key, runtime);
  }
  return runtime;
}

export function retainNativeTerminalTab(
  runtime: TerminalRuntime,
  tabId: string,
  contentId: string,
) {
  runtime.tabs.set(tabId, contentId);
  runtime.models.retainTabs(
    [...runtime.tabs].map(([tabId, contentId]) => ({
      sessionId: runtime.identity.sessionId as never,
      tabId,
      contentId,
    })),
  );
}

export async function closeNativeTerminalTab(
  identity: TerminalIdentity,
  tabId: string,
  contentId: string,
) {
  const pin = terminalPin(contentId);
  if (!pin) return;
  // A restored tab may be closed while its lazy native chunk is downloading.
  // Save the same pinned upstream close record synchronously before Dock removes
  // the tab, so a reload cannot abandon the known process in that short interval.
  const storage = scopedStorage(terminalTargetKey(identity, pin));
  try {
    const saved = storage.getItem(
      `dsh.terminal.binding.v1.${JSON.stringify([identity.sessionId, contentId])}`,
    );
    const id: unknown = saved === null ? null : JSON.parse(saved);
    if (typeof id === 'string' && /^[\w-]{1,128}$/u.test(id))
      storage.setItem(
        `dsh.terminal.close.v1.${id}`,
        JSON.stringify({ sessionId: identity.sessionId, id, title: '终端' }),
      );
  } catch {
    /* The native owner also retains its close request in memory. */
  }
  const owner = JSON.stringify([
    identity.organizationId,
    identity.workspaceId,
    identity.ownerId,
  ]);
  const failureKey =
    terminalTargetKey(identity, pin) + '/adapter-close/' + contentId;
  try {
    if (owner !== currentOwner) return;
    const runtime = await nativeTerminalRuntime(identity, pin);
    if (runtime.ownerGeneration !== ownerGeneration)
      throw Error('终端所属工作区已切换');
    runtime.models.close(identity.sessionId as never, tabId, contentId);
    runtime.tabs.delete(tabId);
    runtime.models.retainTabs(
      [...runtime.tabs].map(([tabId, contentId]) => ({
        sessionId: identity.sessionId as never,
        tabId,
        contentId,
      })),
    );
    if (cleanupGroups.delete(failureKey)) publishCleanup();
  } catch (error) {
    if (owner !== currentOwner) return;
    cleanupGroups.set(failureKey, {
      model: null,
      failures: [
        {
          key: failureKey,
          id: contentId,
          owner: identity,
          title: '终端',
          message:
            error instanceof Error ? error.message : '终端清理组件加载失败',
          retry: () => {
            cleanupGroups.delete(failureKey);
            publishCleanup();
            void closeNativeTerminalTab(identity, tabId, contentId);
          },
        },
      ],
    });
    publishCleanup();
  }
}

export function terminalContentId(pin: TerminalPin, shellPath?: string) {
  return `terminal://${pin.deviceId}/${pin.grantId}/${crypto.randomUUID()}${shellPath ? `?shell=${encodeURIComponent(shellPath)}` : ''}`;
}

export function terminalPin(contentId: string): TerminalPin | null {
  const match =
    /^terminal:\/\/([a-f\d-]{36})\/([a-f\d-]{36})\/[a-f\d-]{36}(?:\?shell=[^\s]*)?$/iu.exec(
      contentId,
    );
  return match?.[1] && match[2]
    ? { deviceId: match[1], grantId: match[2] }
    : null;
}

export function terminalShellPath(contentId: string) {
  const path = new URLSearchParams(contentId.split('?')[1] ?? '').get('shell');
  return path && path.length <= 1024 ? path : undefined;
}
