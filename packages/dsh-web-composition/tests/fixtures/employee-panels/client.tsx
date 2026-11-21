import { useEffect } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {
  PropsRuntime,
  SessionIdOf,
} from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type {} from '@deepseek-ai/dsh-client-ui-theme/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type {
  EmployeePanelsPort,
  EmployeePanelsSnapshot,
} from '../../../src/employee-panels-port';
import type * as PanelsProduct from '../../../src/employee-panels';
import { syntheticMainKey, syntheticPanelSnapshot } from './presentation';
import { createSyntheticPanelsData, type PanelsState } from './data';

export const panelSessionA =
  'session-00000000-0000-4000-8000-000000000036' as SessionIdOf;
export const panelSessionB =
  'session-00000000-0000-4000-8000-000000000038' as SessionIdOf;
type Product = Pick<typeof PanelsProduct, 'bindEmployeePanels'>;

/** Loaded as a separate test package, excluded from the actual product tarball.
 * Only the business owner is synthetic. Native registry/layout/input are real. */
export function createFixture(require: (name: string) => unknown) {
  const product = require('@allrice/dsh-web-composition') as Product;
  return {
    inject: [
      'slots',
      'layout',
      'theme',
      'sessions',
      'workspaces',
      'uiWorkspace',
      'sidebarRight',
      'conversation',
    ],
    apply(ctx: Context) {
      installSyntheticPanelsOwner(ctx, product);
    },
  };
}

function installSyntheticPanelsOwner(ctx: Context, product: Product) {
  let revision = 1,
    state: PanelsState = 'list',
    available = true,
    unknownCount = false;
  let rejectReference = false;
  let mainMode: 'registered' | 'missing' | 'held' = 'registered';
  let releaseMain: ((key: MainPanelId | null) => void) | undefined;
  const events: string[] = [];
  const listeners = new Set<() => void>();
  const snapshots = new Map<SessionIdOf, EmployeePanelsSnapshot>();
  const captures = new Map<
    SessionIdOf,
    PropsRuntime<'conversation.session.header.actions'>['inputActions']
  >();
  type NativeReference = ReturnType<Context['sessions']['retain']>;
  const references = new Map<SessionIdOf, NativeReference>();
  const bindings = new Map<SessionIdOf, Awaited<NativeReference['ready']>>();
  let accepted = 0,
    refused = 0,
    oldOwnerSignal: AbortSignal | undefined;
  let lastReference: {
    sessionId: string;
    scopeKey: string;
    revisionId: string;
    checksum: string;
  } | null = null;
  const event = (name: string) => {
    events.push(name);
  };
  const refresh = () => {
    snapshots.clear();
    for (const listener of [...listeners]) listener();
  };
  const port: EmployeePanelsPort = {
    getSnapshot(id) {
      if (!available || (id !== panelSessionA && id !== panelSessionB))
        return null;
      if (!snapshots.has(id)) {
        const value = syntheticPanelSnapshot(
          `synthetic/person/employee/${revision}/${id}`,
          state,
          event,
          (signal) => {
            signal.throwIfAborted();
            if (mainMode === 'held')
              return new Promise((resolve) => {
                releaseMain = resolve;
              });
            return Promise.resolve(
              mainMode === 'registered'
                ? syntheticMainKey
                : ('synthetic-unregistered-main' as MainPanelId),
            );
          },
        );
        snapshots.set(id, {
          ...value,
          filesUnread: unknownCount ? null : value.filesUnread,
        });
      }
      return snapshots.get(id)!;
    },
    subscribe(_id, listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    useReference(request) {
      const binding = bindings.get(request.sessionId),
        capture = captures.get(request.sessionId);
      if (
        !binding ||
        !capture ||
        request.signal.aborted ||
        port.getSnapshot(request.sessionId)?.scopeKey !== request.scopeKey
      )
        return false;
      const r = request.reference;
      const exact = createSyntheticPanelsData().references.find(
        (value) =>
          value.sourceId === r.sourceId &&
          value.revisionId === r.revisionId &&
          value.revision === r.revision,
      );
      if (!exact) return false;
      const input = ctx.conversation.input.for(binding.ctx);
      const span = capture.captureInsertion();
      // Deliberate stale-span CAS rejection in the actual native input.
      // Preserve existing chips through the public semantic editing action.
      if (rejectReference) {
        rejectReference = false;
        if (!capture.insertText('（合成并发编辑）', span))
          throw Error(
            'Synthetic concurrent edit was not accepted by native input',
          );
      }
      const result = input.insertReference(
        {
          source: 'allrice-synthetic-reference',
          ref: r.revisionId,
          label: r.fileName,
          appearance: 'file',
          clipboardText: `@${r.fileName}`,
        },
        span,
      );
      if (result) accepted++;
      else refused++;
      lastReference = {
        sessionId: request.sessionId,
        scopeKey: request.scopeKey,
        revisionId: exact.revisionId,
        checksum: exact.checksum,
      };
      return result;
    },
  };
  let owner = product.bindEmployeePanels(ctx, port);
  const CaptureInput = (
    props: PropsRuntime<'conversation.session.header.actions'>,
  ) => {
    useEffect(() => {
      captures.set(props.sessionId, props.inputActions);
      return () => {
        if (captures.get(props.sessionId) === props.inputActions)
          captures.delete(props.sessionId);
      };
    }, [props.sessionId, props.inputActions]);
    return null;
  };
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'synthetic-panels-input-capture',
      },
      CaptureInput,
    ),
  );
  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: syntheticMainKey }, () => (
      <section aria-label="合成能力的实际 native main">
        <h1>合成能力 main（仅接线测试）</h1>
        <p>这是公开 main registry 中实际注册的面板，不代表真实插件业务。</p>
        <button onClick={() => ctx.uiWorkspace.openSession(panelSessionA)}>
          返回真实原生会话
        </button>
      </section>
    )),
  );
  const test = {
    evidence: () => ({
      businessOwner: 'synthetic fixture only; no authenticated BFF/MCP',
      sessionId: ctx.sidebarRight.mounted.getSnapshot() ?? null,
      nativeInputReady: bindings.has(ctx.sidebarRight.mounted.getSnapshot()!),
      expanded: ctx.sidebarRight.isExpanded(),
      activeKind: ctx.sidebarRight.active()?.kind ?? null,
      ownerBound:
        !ctx.allriceEmployeePanels?.signal.aborted &&
        !!ctx.allriceEmployeePanels,
      scopeKey: ctx.sidebarRight.mounted.getSnapshot()
        ? (port.getSnapshot(ctx.sidebarRight.mounted.getSnapshot()!)
            ?.scopeKey ?? null)
        : null,
      listeners: listeners.size,
      accepted,
      refused,
      lastReference,
      events: [...events],
      oldOwnerAborted: oldOwnerSignal?.aborted ?? false,
      headerEntries: ctx.slots
        .entries('conversation.session.header.actions')
        .map((entry) => entry.options.id),
      panelEntries: ctx.slots
        .entries('sidebar.right.pane.tab')
        .map((entry) => entry.options.key)
        .filter((key) => String(key).startsWith('allrice-employee-panels.')),
      registeredMain: ctx.slots
        .entries('main')
        .some((entry) => entry.options.key === syntheticMainKey),
      heldMain: !!releaseMain,
    }),
    input: () => {
      const id = ctx.sidebarRight.mounted.getSnapshot();
      const binding = id && bindings.get(id);
      if (!binding) throw Error('No actual retained native input');
      const { draft, occurrences, draftRev } = ctx.conversation.input
        .for(binding.ctx)
        .state.getSnapshot();
      return { draft, occurrences: [...occurrences], draftRev };
    },
    clearInput: () => {
      const id = ctx.sidebarRight.mounted.getSnapshot();
      const binding = id && bindings.get(id);
      if (!binding) throw Error('No actual retained native input');
      ctx.conversation.input.for(binding.ctx).setDraft('');
    },
    setTheme: (theme: 'light' | 'dark') => ctx.theme.setTheme(theme),
    setState(value: PanelsState) {
      state = value;
      revision++;
      refresh();
    },
    switchScope() {
      revision++;
      refresh();
    },
    unknownFiles(value: boolean) {
      unknownCount = value;
      refresh();
    },
    available(value: boolean) {
      available = value;
      refresh();
    },
    rejectNextReference() {
      rejectReference = true;
    },
    setMainMode(value: typeof mainMode) {
      mainMode = value;
    },
    releaseMain() {
      if (!releaseMain) throw Error('No held actual main resolver');
      const resolve = releaseMain;
      releaseMain = undefined;
      resolve(syntheticMainKey);
    },
    openSession: (id: SessionIdOf) => ctx.uiWorkspace.openSession(id),
    async unload() {
      oldOwnerSignal = ctx.allriceEmployeePanels.signal;
      await owner.dispose();
    },
    async rebind() {
      owner = product.bindEmployeePanels(ctx, port);
      await owner;
    },
  };
  ctx.effect(() => {
    let opened = false,
      stopped = false;
    const open = () => {
      if (
        opened ||
        ctx.sessions.list.getSnapshot().phase !== 'ready' ||
        ctx.workspaces.list.getSnapshot().phase !== 'ready'
      )
        return;
      opened = true;
      for (const id of [panelSessionA, panelSessionB]) {
        const reference = ctx.sessions.retain(id, {
          source: 'workspaceOperation',
        });
        references.set(id, reference);
        void reference.ready.then(
          (binding) => {
            if (!stopped) bindings.set(id, binding);
          },
          (error: unknown) => {
            event(`native-retain-error:${String(error)}`);
          },
        );
      }
      ctx.uiWorkspace.openSession(panelSessionA);
      window.__allricePanelsIntegration = test;
    };
    const stopSessions = ctx.sessions.list.subscribe(open),
      stopWorkspaces = ctx.workspaces.list.subscribe(open);
    open();
    return () => {
      stopped = true;
      stopSessions();
      stopWorkspaces();
      for (const reference of references.values()) reference.release();
      bindings.clear();
      captures.clear();
      if (window.__allricePanelsIntegration === test)
        delete window.__allricePanelsIntegration;
    };
  });
  return test;
}

export type PanelsIntegration = ReturnType<typeof installSyntheticPanelsOwner>;
declare global {
  interface Window {
    __allricePanelsIntegration?: PanelsIntegration;
  }
}
