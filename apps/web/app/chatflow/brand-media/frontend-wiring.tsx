'use client';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { z } from 'zod';
import {
  Button,
  Checkbox,
  Input,
  InlineEditor,
  Modal,
  SegmentedTabs,
  Tag,
  MarkdownText,
  useModalLayer,
} from '@deepseek-ai/dsh-client-ui-primitives';
import {
  BrandMediaReadResultSchema,
  BrandMediaCandidateSchema,
  BrandMediaMutationResultSchema,
  BrandMediaInvocationSchema,
  BrandMediaFileSchema,
  EmployeeModuleBindingSchema,
  RunSnapshotSchema,
  ReferenceRevisionSchema,
  ReferenceInputSelectionResultSchema,
  ReferenceSearchCursorSchema,
  WorkbenchDeliverablesCatalogSchema,
  type ReferenceRevision,
  brandMediaModule,
  brandMediaRelease,
  type BrandMediaArticle,
  type BrandMediaGenerateInput,
  type BrandMediaUserCommand,
  type BrandMediaReadInput,
  type BrandMediaTopic,
} from '@allrice/contracts';
import { EmployeePluginSection } from '../employee-capability-presentation';
import { createSessionRunStream } from '../session-run-stream';
import css from './frontend-wiring.module.css';
export { Button, Checkbox, Input, InlineEditor, Modal, SegmentedTabs, Tag };
export const ui = css;
const labels = {
  code: { copyLabel: '复制', copiedLabel: '已复制' },
  footnotes: '注释',
};
export function Markdown({ text }: { text: string }) {
  return <MarkdownText text={text} labels={labels} />;
}
export type BrandMediaClientScope = {
  workspaceId: string;
  instanceId: string;
  organizationId: string;
  ownerId: string;
  headers: Record<string, string>;
};
const runsSchema = z.object({
  runs: z.array(
    z.object({
      run: RunSnapshotSchema,
      sessionId: z.uuid(),
      invocation: BrandMediaInvocationSchema,
      addedCandidates: z.array(BrandMediaCandidateSchema),
      unavailable: z.boolean(),
      submission: z
        .object({
          articleUpdated: z.boolean(),
          revision: z.number().int().positive().nullable(),
        })
        .nullable(),
      deliveries: z.array(
        z.object({
          file: BrandMediaFileSchema,
          content: z.string(),
          format: z.string(),
        }),
      ),
    }),
  ),
});
export type BrandMediaRun = z.infer<typeof runsSchema>['runs'][number];
export const runActive = (run: BrandMediaRun) =>
  !['succeeded', 'failed', 'canceled', 'needs_attention'].includes(
    run.run.status,
  );
/** One immutable candidate selection keeps its identity across host remounts. */
export async function candidateRequestId(
  scope: BrandMediaClientScope,
  runId: string,
  candidate: BrandMediaTopic['candidate'],
) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify([
        'brand-media-candidate',
        scope.organizationId,
        scope.workspaceId,
        scope.ownerId,
        scope.instanceId,
        runId,
        candidate.title,
        candidate.summary,
      ]),
    ),
  );
  const hex = Array.from(new Uint8Array(bytes), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
async function json(
  url: string,
  headers: Record<string, string>,
  options?: RequestInit,
): Promise<unknown> {
  const response = await fetch(url, {
    cache: 'no-store',
    ...options,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  const body = await response.json();
  if (!response.ok)
    throw Error(
      body.message ?? body.error?.message ?? '暂时无法完成，请刷新后重试。',
    );
  return body;
}
type Scoped<T> = T extends unknown
  ? Omit<T, 'workspaceId' | 'instanceId'>
  : never;
export function createBrandMediaClient(scope: BrandMediaClientScope) {
  const base = `/api/v1/employee-instances/${scope.instanceId}`,
    q = `?workspaceId=${encodeURIComponent(scope.workspaceId)}`;
  return {
    scope,
    catalog: async (signal?: AbortSignal) =>
      z
        .object({
          modules: z.array(
            z.object({
              descriptor: z.object({ id: z.string(), displayName: z.string() }),
              binding: EmployeeModuleBindingSchema.nullable(),
              available: z.boolean(),
              enabled: z.boolean(),
            }),
          ),
        })
        .parse(await json(base + '/modules' + q, scope.headers, { signal })),
    add: (requestId: string) =>
      json(base + '/modules', scope.headers, {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: scope.workspaceId,
          instanceId: scope.instanceId,
          release: brandMediaRelease,
          requestId,
        }),
      }),
    read: async (input: Scoped<BrandMediaReadInput>, signal?: AbortSignal) => {
      const params = new URLSearchParams({ workspaceId: scope.workspaceId });
      for (const [key, value] of Object.entries(input))
        if (value !== undefined)
          params.set(
            key,
            typeof value === 'object' ? JSON.stringify(value) : String(value),
          );
      return BrandMediaReadResultSchema.parse(
        await json(base + '/brand-media?' + params, scope.headers, { signal }),
      );
    },
    command: async (command: Scoped<BrandMediaUserCommand>) => {
      const response = z
        .object({
          result: BrandMediaMutationResultSchema,
          replayed: z.boolean(),
        })
        .parse(
          await json(base + '/brand-media', scope.headers, {
            method: 'POST',
            body: JSON.stringify({
              ...command,
              workspaceId: scope.workspaceId,
              instanceId: scope.instanceId,
            }),
          }),
        );
      return response.result;
    },
    generate: async (intent: Scoped<BrandMediaGenerateInput>) =>
      z
        .object({
          run: RunSnapshotSchema,
          invocation: BrandMediaInvocationSchema,
          userMessage: z.object({ sessionId: z.uuid() }),
        })
        .parse(
          await json(base + '/brand-media', scope.headers, {
            method: 'POST',
            body: JSON.stringify({
              ...intent,
              workspaceId: scope.workspaceId,
              instanceId: scope.instanceId,
            }),
          }),
        ),
    runs: async (signal?: AbortSignal) =>
      runsSchema.parse(
        await json(base + '/brand-media' + q + '&view=runs', scope.headers, {
          signal,
        }),
      ),
    help: async (signal?: AbortSignal) =>
      z.object({ content: z.string(), checksum: z.string() }).parse(
        await json(base + '/brand-media' + q + '&view=help', scope.headers, {
          signal,
        }),
      ),
    cancel: (runId: string) =>
      json(`/api/v1/runs/${runId}/cancel${q}`, scope.headers, {
        method: 'POST',
        body: JSON.stringify({ reason: '用户取消品牌自媒体生成' }),
      }),
    body: async (
      file: NonNullable<BrandMediaArticle['body']>,
      signal?: AbortSignal,
    ) => {
      const response = await fetch(
        `/api/v1/files/${file.objectId}/download${q}`,
        { headers: scope.headers, signal, cache: 'no-store' },
      );
      if (!response.ok) throw Error('正文文件暂时不可读，请重新核对权限。');
      return response.text();
    },
    references: async (
      query: string,
      cursor?: z.infer<typeof ReferenceSearchCursorSchema>,
      signal?: AbortSignal,
    ) => {
      const params = new URLSearchParams({
        workspaceId: scope.workspaceId,
        query,
        category: 'all',
        limit: '20',
      });
      if (cursor) params.set('cursor', JSON.stringify(cursor));
      return z
        .object({
          viewerId: z.uuid(),
          references: z.array(ReferenceRevisionSchema),
          nextCursor: ReferenceSearchCursorSchema.nullable(),
        })
        .parse(
          await json(
            '/api/v1/references/publications?' + params,
            scope.headers,
            { signal },
          ),
        );
    },
    selectReference: async (reference: ReferenceRevision) => {
      const result = ReferenceInputSelectionResultSchema.parse(
        await json(
          `/api/v1/references/revisions/${reference.revisionId}/selection${q}`,
          scope.headers,
        ),
      );
      if (
        result.viewerId !== scope.ownerId ||
        result.workspaceId !== scope.workspaceId ||
        result.selection.sourceId !== reference.sourceId ||
        result.selection.revisionId !== reference.revisionId
      )
        throw Error('资料版本或当前权限已变化，请重试。');
      return {
        origin: 'reference' as const,
        sourceId: result.selection.sourceId,
        revisionId: result.selection.revisionId,
      };
    },
    uploadReference: async (request: {
      requestId: string;
      fileName: string;
      mediaType: string;
      contentBase64: string;
    }) => {
      const uploaded = z.object({ objectId: z.uuid() }).parse(
        await json('/api/v1/workbench/files' + q, scope.headers, {
          method: 'POST',
          body: JSON.stringify({
            ...request,
            workspaceId: scope.workspaceId,
          }),
        }),
      );
      const catalog = WorkbenchDeliverablesCatalogSchema.parse(
        await json(
          '/api/v1/workbench/files' +
            q +
            '&view=deliverables&objectId=' +
            uploaded.objectId,
          scope.headers,
        ),
      );
      const file = catalog.files.find(
        (entry) => entry.objectId === uploaded.objectId,
      );
      if (!file || !file.ownedByMe)
        throw Error('文件已保存，暂时无法读取上传回执，请重试同一上传。');
      return file;
    },
  };
}
export type BrandMediaClient = ReturnType<typeof createBrandMediaClient>;
export function useBrandMediaEntry(scope: BrandMediaClientScope | null) {
  const key = scope
    ? `${scope.organizationId}/${scope.workspaceId}/${scope.ownerId}/${scope.instanceId}`
    : '';
  const client = useMemo(
    () => (scope ? createBrandMediaClient(scope) : null),
    [key, scope?.headers],
  );
  const [directory, setDirectory] = useState<{
    key: string;
    enabled: boolean;
    available: boolean;
  } | null>(null);
  const [picker, setPicker] = useState(false),
    [checked, setChecked] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const current = useRef(key);
  current.current = key;
  const pending = useRef<{ key: string; requestId: string } | null>(null);
  const reload = useCallback(
    async (signal?: AbortSignal) => {
      if (!client) return;
      const result = await client.catalog(signal);
      if (current.current !== key || signal?.aborted) return;
      const entry = result.modules.find(
        (module) => module.descriptor.id === brandMediaModule.id,
      );
      setDirectory({
        key,
        enabled: !!entry?.enabled,
        available: !!entry?.available,
      });
    },
    [client, key],
  );
  useEffect(() => {
    const controller = new AbortController();
    setPicker(false);
    setBusy(false);
    pending.current = null;
    setChecked(false);
    setError('');
    void reload(controller.signal).catch((cause) => {
      if (!controller.signal.aborted && current.current === key)
        setError(cause.message);
    });
    return () => controller.abort();
  }, [reload, key]);
  const add = async () => {
    if (!client || busy || !checked) return;
    const capturedKey = key;
    const request =
      pending.current?.key === key
        ? pending.current
        : { key, requestId: crypto.randomUUID() };
    pending.current = request;
    setBusy(true);
    setError('');
    try {
      await client.add(request.requestId);
      if (current.current !== capturedKey) return;
      await reload();
      pending.current = null;
      setPicker(false);
    } catch (cause) {
      if (current.current === capturedKey)
        setError(cause instanceof Error ? cause.message : '添加失败');
    } finally {
      if (current.current === capturedKey) setBusy(false);
    }
  };
  return {
    client,
    picker,
    setPicker,
    checked,
    setChecked,
    busy,
    error,
    add,
    enabled: directory?.key === key && directory.enabled,
    available: directory?.key === key && directory.available,
  };
}
export function BrandMediaPluginSection({
  controller,
  headingId,
  onOpen,
}: {
  controller: ReturnType<typeof useBrandMediaEntry>;
  headingId: string;
  onOpen: () => void;
}) {
  return (
    <>
      <EmployeePluginSection
        headingId={headingId}
        plugins={
          controller.enabled
            ? [
                {
                  id: brandMediaModule.id,
                  name: brandMediaModule.displayName,
                  description: '想选题、写文章、安排发布计划',
                  href: '#brand-media',
                  onOpen,
                },
              ]
            : []
        }
        onAdd={() => controller.setPicker(true)}
      />
      {controller.error && <p role="alert">{controller.error}</p>}
    </>
  );
}
export function BrandMediaPluginPicker({
  controller,
  employeeName,
}: {
  controller: ReturnType<typeof useBrandMediaEntry>;
  employeeName: string;
}) {
  return (
    <section className={css.picker} aria-label="选择插件">
      <header className={css.header}>
        <Button
          aria-label="返回插件列表"
          onClick={() => controller.setPicker(false)}
        >
          ←
        </Button>
        <h3>添加插件</h3>
      </header>
      <p>选择插件，添加给 {employeeName}。</p>
      {controller.available ? (
        <div className={css.selectionCard}>
          <Checkbox
            checked={controller.checked}
            onChange={controller.setChecked}
            label="品牌自媒体"
            disabled={controller.busy}
          />
          <p>想选题、写文章、安排发布计划</p>
        </div>
      ) : (
        <>
          <h4>暂无可添加的插件</h4>
          <p>有可用插件时，会显示在这里。</p>
        </>
      )}
      {controller.error && <p role="alert">{controller.error}</p>}
      <footer className={css.pickerFooter}>
        <Button onClick={() => controller.setPicker(false)}>取消</Button>
        <Button
          variant="primary"
          disabled={
            !controller.available || !controller.checked || controller.busy
          }
          onClick={() => void controller.add()}
        >
          添加
        </Button>
      </footer>
    </section>
  );
}
/** Only the center panel transitions. The host owns conversation DOM/drafts;
 * closing never selects a Session or cancels a native Run. */
export function BrandMediaHost({
  open,
  serial,
  children,
  panel,
}: {
  open: boolean;
  serial: number;
  children: ReactNode;
  panel: ReactNode;
}) {
  const [shown, setShown] = useState(false),
    root = useRef<HTMLDivElement>(null),
    panelRef = useRef<HTMLDivElement>(null),
    previousFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (!open) {
      if (!wasOpen.current) return;
      wasOpen.current = false;
      setShown(false);
      const frame = requestAnimationFrame(() => {
        const previous = previousFocus.current;
        if (
          previous?.isConnected &&
          root.current?.contains(previous) &&
          !previous.closest('[inert]')
        )
          previous.focus({ preventScroll: true });
        else
          root.current
            ?.querySelector<HTMLElement>('textarea, input, button')
            ?.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    }
    wasOpen.current = true;
    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setShown(false);
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, [open, serial]);
  useLayoutEffect(() => {
    if (open && shown)
      panelRef.current
        ?.querySelector<HTMLElement>('[data-brand-return]')
        ?.focus({ preventScroll: true });
  }, [open, shown]);
  return (
    <div ref={root} className={css.host}>
      <div
        className={css.conversation}
        inert={open}
        aria-hidden={open || undefined}
      >
        {children}
      </div>
      <div
        ref={panelRef}
        className={css.slide}
        data-open={open && shown}
        inert={!open || !shown}
        aria-hidden={!open || !shown}
        data-brand-media-host
      >
        {panel}
      </div>
    </div>
  );
}
export function HelpDrawer({
  content,
  onClose,
}: {
  content: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useModalLayer(ref, true, onClose);
  return (
    <div
      className={css.helpMask}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        ref={ref}
        className={css.help}
        role="dialog"
        aria-modal="true"
        aria-label="使用说明"
        tabIndex={-1}
      >
        <header className={css.header}>
          <h3>使用说明</h3>
          <Button
            data-modal-autofocus
            onClick={onClose}
            aria-label="关闭使用说明"
          >
            ×
          </Button>
        </header>
        <Markdown text={content} />
      </aside>
    </div>
  );
}
/** Reuse native chat streaming/reconnection. Terminal truth is always reread
 * from the Run endpoint, never inferred from connection or assistant wording. */
export function useBrandMediaRunEvents(
  client: BrandMediaClient,
  runs: BrandMediaRun[],
  refresh: () => Promise<void>,
  setError: (value: string) => void,
) {
  const ids = runs
    .filter(runActive)
    .map((row) => `${row.sessionId}:${row.run.id}`)
    .sort()
    .join(',');
  useEffect(() => {
    const streams = new Map<
      string,
      ReturnType<typeof createSessionRunStream>
    >();
    for (const row of runs.filter(runActive)) {
      let stream = streams.get(row.sessionId);
      if (!stream) {
        stream = createSessionRunStream({
          sessionId: row.sessionId,
          workspaceId: client.scope.workspaceId,
          tenantHeaders: client.scope.headers,
          loadHistory: refresh,
          loadWorkspace: async () => {},
          setError,
        });
        stream.activate();
        streams.set(row.sessionId, stream);
      }
      void stream.streamRun(row.run.id);
    }
    const reconnect = () => {
      for (const stream of streams.values()) stream.recoverConnections();
      void refresh();
    };
    window.addEventListener('online', reconnect);
    return () => {
      window.removeEventListener('online', reconnect);
      for (const stream of streams.values()) stream.deactivate();
    };
  }, [client, ids, refresh, setError]);
}
