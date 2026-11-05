'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ApiErrorSchema,
  EmployeeDetailsSchema,
  EmployeeInstanceSchema,
  EmployeeSceneSkillCatalogSchema,
  EmployeePublishedSceneSkillSchema,
  PersonalSceneSkillCatalogSchema,
  PersonalSceneSkillSchema,
  PersonalScenePreviewRequestSchema,
  PersonalScenePreviewResponseSchema,
  PersonalSceneConfirmRequestSchema,
  PersonalSceneConfirmResponseSchema,
  PersonalSceneRemoveRequestSchema,
  PersonalSceneRemoveResponseSchema,
  SkillSourceErrorReasonSchema,
  skillSourceErrorHeader,
  type EmployeeDetailsProfile,
  type EmployeeInstance,
  type EmployeeSceneSkillCatalog,
  type EmployeePublishedSceneSkill,
  type PersonalSceneSkill,
  type PersonalScenePreviewRequest,
  type PersonalScenePreviewResponse,
  type PersonalSceneConfirmRequest,
  type PersonalSceneConfirmReceipt,
  type PersonalSceneRemoveRequest,
  type PersonalSceneRemoveReceipt,
  type SkillSourceErrorReason,
} from '@allrice/contracts';
import { PersonalSceneHttpError } from './personal-scene-files';

type PersonalCatalog = ReturnType<typeof PersonalSceneSkillCatalogSchema.parse>;
export type SceneCatalog =
  | { personal: true; value: PersonalCatalog }
  | { personal: false; value: EmployeeSceneSkillCatalog };
export type SceneSelection =
  | { personal: true; value: PersonalSceneSkill }
  | { personal: false; value: EmployeePublishedSceneSkill };
type Scope = {
  scopeId: string;
  organizationId?: string;
  workspaceId?: string;
  viewerId?: string | null;
  instanceId?: string;
  headers: Record<string, string>;
};
type ReadView = {
  key: string;
  profile?: EmployeeDetailsProfile;
  instance?: EmployeeInstance;
  catalog?: SceneCatalog;
  loading: boolean;
  error?: string;
};
type Mutation = (
  | {
      kind: 'confirm';
      input: PersonalSceneConfirmRequest;
      preview: PersonalScenePreviewResponse;
      receipt?: PersonalSceneConfirmReceipt;
    }
  | {
      kind: 'remove';
      input: PersonalSceneRemoveRequest;
      scene: PersonalSceneSkill;
      receipt?: PersonalSceneRemoveReceipt;
    }
) & { busy: boolean; uncertain?: boolean; error?: string };

export class SceneSourceHttpError extends PersonalSceneHttpError {
  constructor(
    status: number,
    code: string,
    readonly reason?: SkillSourceErrorReason,
    readonly displayMessage?: string,
  ) {
    super(status, code);
    if (code === 'EMPLOYEE_INSTANCE_ARCHIVED')
      this.message = 'AI 员工已归档，可以查看历史；恢复后才能继续工作。';
  }
}

async function sceneJson(
  url: string,
  headers: Record<string, string>,
  options: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: { ...headers, ...options.headers },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = ApiErrorSchema.safeParse(body);
    const reason = SkillSourceErrorReasonSchema.safeParse(
      response.headers.get(skillSourceErrorHeader),
    );
    throw new SceneSourceHttpError(
      response.status,
      error.success ? error.data.error.code : 'UNKNOWN',
      reason.success ? reason.data : undefined,
      error.success ? error.data.error.message : undefined,
    );
  }
  return body;
}

export function sceneSourceError(cause: unknown, sourceKind: 'github' | 'zip') {
  if (cause instanceof SceneSourceHttpError) {
    if (cause.reason === 'skill_missing')
      return sourceKind === 'zip'
        ? '没找到 SKILL.md。请确认它在压缩包根目录，不要多包一层文件夹。'
        : '没找到 SKILL.md。请确认它在根目录。';
    if (cause.reason === 'source_unavailable')
      return '读不到这个仓库。目前只支持公开仓库，请检查链接。';
    if (cause.reason === 'workflow_invalid')
      return '该技能不符合 workflow 规范。';
    if (
      cause.reason === 'preview_invalid' ||
      cause.reason === 'preview_expired'
    )
      return '技能预览已失效或内容不完整，请重新读取后确认。';
    // #774 supplies the already approved sentence as plain ApiError text.
    // No name is extracted from user content or the message.
    if (cause.reason === 'name_mismatch' && cause.displayMessage)
      return cause.displayMessage;
    // A general CAS conflict is not evidence of a different Workflow name.
    return cause.message;
  }
  return '当前读取未完成，请重新读取。';
}

export function sceneSourceLabel(source: PersonalSceneSkill['source']) {
  return source?.kind === 'github'
    ? source.requestedUrl
    : (source?.fileName ?? '未提供');
}

export function sceneSelectionId(scene: SceneSelection) {
  return scene.personal ? scene.value.sceneId : scene.value.pin.sceneId;
}

/** One current employee directory, shared by the real host and future details
 * entry. This is a browser projection, never execution/installation authority. */
export function useEmployeeSceneCatalog(input: Scope) {
  const key = JSON.stringify([
    input.scopeId,
    input.workspaceId,
    input.viewerId,
    input.instanceId,
  ]);
  const lifetime = useRef({ key, generation: 0 });
  if (lifetime.current.key !== key)
    lifetime.current = {
      key,
      generation: lifetime.current.generation + 1,
    };
  const generation = lifetime.current.generation;
  const mounted = useRef(true);
  const [view, setView] = useState<ReadView>({ key, loading: false });
  const [selection, setSelection] = useState<{
    key: string;
    loading: boolean;
    value?: SceneSelection;
    error?: string;
  }>({ key, loading: false });
  const [, changed] = useState(0);
  const directoryRead = useRef<AbortController | null>(null);
  const detailRead = useRef<AbortController | null>(null);
  const sourceRead = useRef<AbortController | null>(null);
  const write = useRef<AbortController | null>(null);
  const pending = useRef(new Map<string, Mutation>());
  const ownerScope = `${input.scopeId}/${input.workspaceId}/${input.viewerId}`;
  const lastOwner = useRef(ownerScope);
  if (lastOwner.current !== ownerScope) {
    lastOwner.current = ownerScope;
    pending.current.clear();
  }
  const current = () =>
    mounted.current &&
    lifetime.current.key === key &&
    lifetime.current.generation === generation;
  const available = Boolean(
    input.organizationId &&
    input.workspaceId &&
    input.viewerId &&
    input.instanceId,
  );
  const base = `/api/v1/employee-instances/${encodeURIComponent(input.instanceId ?? '')}`;
  const query = `workspaceId=${encodeURIComponent(input.workspaceId ?? '')}`;
  const visible: ReadView = view.key === key ? view : { key, loading: false };
  const detail: typeof selection =
    selection.key === key ? selection : { key, loading: false };
  const mutation = pending.current.get(key);
  const canMaintain =
    visible.catalog?.personal === true &&
    visible.profile?.canMaintainPersonal === true &&
    visible.instance?.archivedAt === null;

  function store(next: Mutation) {
    pending.current.set(key, next);
    if (current()) changed((value) => value + 1);
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      directoryRead.current?.abort();
      detailRead.current?.abort();
      sourceRead.current?.abort();
      write.current?.abort();
      const unfinished = pending.current.get(key);
      if (unfinished?.busy)
        pending.current.set(key, {
          ...unfinished,
          busy: false,
          uncertain: true,
        });
      directoryRead.current = null;
      detailRead.current = null;
      sourceRead.current = null;
      write.current = null;
    };
  }, [key]);

  function revoked(cause: unknown) {
    if (
      cause instanceof SceneSourceHttpError &&
      ([401, 403, 404].includes(cause.status) ||
        cause.code === 'EMPLOYEE_INSTANCE_ARCHIVED')
    ) {
      directoryRead.current?.abort();
      detailRead.current?.abort();
      sourceRead.current?.abort();
      setSelection({ key, loading: false });
      setView({ key, loading: false, error: cause.message });
      pending.current.delete(key);
      changed((value) => value + 1);
      return true;
    }
    return false;
  }
  function validateInstance(instance: EmployeeInstance) {
    if (
      instance.id !== input.instanceId ||
      instance.organizationId !== input.organizationId ||
      instance.workspaceId !== input.workspaceId ||
      instance.ownerId !== input.viewerId
    )
      throw Error('target_changed');
    if (instance.archivedAt)
      throw new SceneSourceHttpError(409, 'EMPLOYEE_INSTANCE_ARCHIVED');
  }
  async function load() {
    if (!available) return;
    directoryRead.current?.abort();
    const controller = new AbortController();
    directoryRead.current = controller;
    setView((previous) => ({
      ...(previous.key === key ? previous : { key }),
      loading: true,
      error: undefined,
    }));
    try {
      const [rawDetails, rawInstance, rawCatalog] = await Promise.all([
        sceneJson(`${base}/content?${query}`, input.headers, {
          signal: controller.signal,
        }),
        sceneJson(`${base}?${query}`, input.headers, {
          signal: controller.signal,
        }),
        sceneJson(`${base}/scene-skills?${query}`, input.headers, {
          signal: controller.signal,
        }),
      ]);
      const details = EmployeeDetailsSchema.parse(rawDetails);
      const instance = EmployeeInstanceSchema.parse(
        rawInstance &&
          typeof rawInstance === 'object' &&
          'instance' in rawInstance
          ? rawInstance.instance
          : undefined,
      );
      validateInstance(instance);
      if (
        details.profile.instanceId !== instance.id ||
        details.profile.revision !== instance.revision
      )
        throw Error('target_changed');
      const personal = PersonalSceneSkillCatalogSchema.safeParse(rawCatalog);
      const catalog: SceneCatalog = personal.success
        ? { personal: true, value: personal.data }
        : {
            personal: false,
            value: EmployeeSceneSkillCatalogSchema.parse(rawCatalog),
          };
      if (catalog.value.instanceId !== instance.id)
        throw Error('target_changed');
      if (current() && !controller.signal.aborted)
        setView({
          key,
          loading: false,
          instance,
          profile: details.profile,
          catalog,
        });
    } catch (cause) {
      if (current() && !controller.signal.aborted && !revoked(cause))
        setView((previous) => ({
          ...(previous.key === key ? previous : { key }),
          loading: false,
          error: '工作场景读取失败，请重试。',
        }));
    }
  }
  async function inspect(entry: SceneCatalog['value']['skills'][number]) {
    if (!visible.catalog) return;
    detailRead.current?.abort();
    const controller = new AbortController();
    detailRead.current = controller;
    setSelection({ key, loading: true });
    try {
      const personal = 'sceneId' in entry;
      const params = new URLSearchParams({ workspaceId: input.workspaceId! });
      if (personal) params.set('sceneId', entry.sceneId);
      else
        for (const [name, value] of Object.entries(entry.pin))
          params.set(name, value);
      const raw = await sceneJson(
        `${base}/scene-skills?${params}`,
        input.headers,
        {
          signal: controller.signal,
        },
      );
      const value: SceneSelection = personal
        ? { personal: true, value: PersonalSceneSkillSchema.parse(raw) }
        : {
            personal: false,
            value: EmployeePublishedSceneSkillSchema.parse(raw),
          };
      if (
        sceneSelectionId(value) !==
          (personal ? entry.sceneId : entry.pin.sceneId) ||
        (value.personal &&
          personal &&
          entry.contentRef &&
          value.value.contentRef !== entry.contentRef) ||
        (!value.personal &&
          !personal &&
          JSON.stringify(value.value.pin) !== JSON.stringify(entry.pin))
      )
        throw Error('target_changed');
      if (current() && !controller.signal.aborted)
        setSelection({ key, loading: false, value });
    } catch (cause) {
      if (current() && !controller.signal.aborted && !revoked(cause))
        setSelection({
          key,
          loading: false,
          error:
            cause instanceof SceneSourceHttpError
              ? cause.message
              : '工作场景读取失败，请重试。',
        });
    }
  }
  function clearSelection() {
    detailRead.current?.abort();
    setSelection({ key, loading: false });
  }
  function cancelPreview() {
    sourceRead.current?.abort();
    sourceRead.current = null;
  }
  async function preview(
    target: PersonalScenePreviewRequest['target'],
    source: PersonalScenePreviewRequest['source'],
    file?: File,
  ) {
    if (!canMaintain || !current() || mutation?.busy || mutation?.uncertain)
      return;
    cancelPreview();
    const controller = new AbortController();
    sourceRead.current = controller;
    const request = PersonalScenePreviewRequestSchema.parse({
      workspaceId: input.workspaceId,
      target,
      source,
    });
    let body: BodyInit;
    const headers: Record<string, string> = {};
    if (source.kind === 'zip') {
      if (!file || file.name !== source.fileName) return;
      const form = new FormData();
      form.append(
        'input',
        JSON.stringify({ workspaceId: request.workspaceId, target }),
      );
      form.append('file', file);
      body = form;
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(request);
    }
    try {
      const result = PersonalScenePreviewResponseSchema.parse(
        await sceneJson(`${base}/scene-skills/preview`, input.headers, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        }),
      );
      if (
        result.instanceId !== input.instanceId ||
        result.operation !== target.operation ||
        result.source.kind !== request.source.kind ||
        (result.source.kind === 'github' &&
          request.source.kind === 'github' &&
          result.source.requestedUrl !== request.source.url) ||
        (result.source.kind === 'zip' &&
          request.source.kind === 'zip' &&
          result.source.fileName !== request.source.fileName) ||
        (target.operation === 'update' &&
          (result.target.sceneId !== target.sceneId ||
            result.target.expectedRevision !== target.expectedRevision ||
            result.target.expectedContentRef !== target.expectedContentRef))
      )
        throw Error('target_changed');
      if (current() && !controller.signal.aborted) return result;
    } catch (cause) {
      if (current() && !controller.signal.aborted) {
        revoked(cause);
        throw cause;
      }
    }
  }
  async function confirm(preview: PersonalScenePreviewResponse) {
    if (!canMaintain || !current() || write.current) return;
    const previous = pending.current.get(key);
    if (
      previous?.uncertain &&
      (previous.kind !== 'confirm' ||
        previous.preview.previewId !== preview.previewId)
    )
      return;
    const request =
      previous?.kind === 'confirm' &&
      previous.preview.previewId === preview.previewId
        ? previous.input
        : PersonalSceneConfirmRequestSchema.parse({
            workspaceId: input.workspaceId,
            requestId: crypto.randomUUID(),
            previewId: preview.previewId,
            digest: preview.digest,
          });
    const operation: Mutation = {
      kind: 'confirm',
      input: request,
      preview,
      busy: true,
    };
    store(operation);
    if (Date.parse(preview.expiresAt) <= Date.now()) {
      store({
        ...operation,
        busy: false,
        error: sceneSourceError(
          new SceneSourceHttpError(422, 'VALIDATION_FAILED', 'preview_expired'),
          preview.source.kind,
        ),
      });
      return;
    }
    const controller = new AbortController();
    write.current = controller;
    try {
      const { receipt } = PersonalSceneConfirmResponseSchema.parse(
        await sceneJson(`${base}/scene-skills/confirm`, input.headers, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
          signal: controller.signal,
        }),
      );
      if (
        receipt.instanceId !== input.instanceId ||
        receipt.requestId !== request.requestId ||
        receipt.sceneId !== preview.target.sceneId ||
        receipt.operation !== preview.operation ||
        receipt.revision <= preview.target.expectedRevision ||
        JSON.stringify(receipt.source) !== JSON.stringify(preview.source)
      )
        throw Error('receipt_mismatch');
      if (current() && !controller.signal.aborted) {
        store({ ...operation, busy: false, receipt });
        void load();
        return receipt;
      }
    } catch (cause) {
      if (current() && !controller.signal.aborted) {
        const known =
          cause instanceof SceneSourceHttpError && cause.status < 500;
        if (!revoked(cause)) {
          store({
            ...operation,
            busy: false,
            uncertain: !known,
            error: known
              ? sceneSourceError(cause, preview.source.kind)
              : undefined,
          });
          // Read back current facts without manufacturing this request's receipt.
          if (!known) await load();
        }
      }
    } finally {
      if (write.current === controller) write.current = null;
    }
  }
  async function remove(scene: PersonalSceneSkill) {
    if (
      !canMaintain ||
      !current() ||
      write.current ||
      !visible.catalog?.personal
    )
      return;
    const previous = pending.current.get(key);
    if (
      previous?.uncertain &&
      (previous.kind !== 'remove' || previous.scene.sceneId !== scene.sceneId)
    )
      return;
    const request =
      previous?.kind === 'remove' &&
      previous.scene.contentRef === scene.contentRef
        ? previous.input
        : PersonalSceneRemoveRequestSchema.parse({
            workspaceId: input.workspaceId,
            requestId: crypto.randomUUID(),
            expectedRevision: visible.catalog.value.revision,
            expectedContentRef: scene.contentRef,
          });
    const operation: Mutation = {
      kind: 'remove',
      input: request,
      scene,
      busy: true,
    };
    store(operation);
    const controller = new AbortController();
    write.current = controller;
    try {
      const { receipt } = PersonalSceneRemoveResponseSchema.parse(
        await sceneJson(
          `${base}/scene-skills/${encodeURIComponent(scene.sceneId)}`,
          input.headers,
          {
            method: 'DELETE',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
            signal: controller.signal,
          },
        ),
      );
      if (
        receipt.instanceId !== input.instanceId ||
        receipt.sceneId !== scene.sceneId ||
        receipt.requestId !== request.requestId ||
        receipt.revision <= request.expectedRevision
      )
        throw Error('receipt_mismatch');
      if (current() && !controller.signal.aborted) {
        store({ ...operation, busy: false, receipt });
        clearSelection();
        void load();
        return receipt;
      }
    } catch (cause) {
      if (current() && !controller.signal.aborted) {
        const known =
          cause instanceof SceneSourceHttpError && cause.status < 500;
        if (!revoked(cause)) {
          store({
            ...operation,
            busy: false,
            uncertain: !known,
            error: known ? cause.message : undefined,
          });
          if (!known) await load();
        }
      }
    } finally {
      if (write.current === controller) write.current = null;
    }
  }
  async function currentInstance() {
    try {
      const raw = await sceneJson(`${base}?${query}`, input.headers);
      const instance = EmployeeInstanceSchema.parse(
        raw && typeof raw === 'object' && 'instance' in raw
          ? raw.instance
          : undefined,
      );
      validateInstance(instance);
      return current() ? instance : undefined;
    } catch (cause) {
      if (current()) revoked(cause);
      throw cause;
    }
  }
  return {
    key,
    available,
    profile: visible.profile,
    instance: visible.instance,
    catalog: visible.catalog,
    loading: visible.loading,
    error: visible.error,
    detail,
    canMaintain,
    mutation,
    busy: mutation?.busy === true,
    load,
    inspect,
    clearSelection,
    preview,
    cancelPreview,
    confirm,
    remove,
    currentInstance,
  };
}
