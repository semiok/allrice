'use client';

import {
  createContext,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import type {
  EmployeeSkillCatalog,
  PersonalSkillConfirmResponse,
  PersonalSkillPreviewResponse,
} from '@allrice/contracts';
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  EmployeeSkillApiError,
  confirmEmployeeSkill,
  previewEmployeeSkill,
  readEmployeeSkills,
  removeEmployeeSkill,
  type EmployeeSkillScope,
} from './employee-skills-api';
import {
  EmployeeSkillDetails,
  EmployeeSkillsSection,
  type EmployeePersonalSkill,
  type EmployeeSkill,
  type EmployeeSkillsView,
} from './employee-skills-section';
import {
  EmployeeSkillFeedback,
  EmployeeSkillPage,
  EmployeeSkillSourceForm,
  type EmployeeSkillSourceDraft,
} from './employee-skill-source-form';
import {
  EmployeeSkillConfirmation,
  EmployeeSkillRemoval,
  EmployeeSkillSuccess,
  employeeSkillPreviewName,
} from './employee-skill-confirmation';
import css from './employee-skills-host.module.css';

/** The host supplies user-facing text without changing the API outcome rules. */
export interface EmployeeSkillHostCopy {
  loading: string;
  catalogError: string;
  accessLost: string;
  sourceInvalid: string;
  sourceLimit: string;
  sourceConflict: string;
  nameMismatch: string;
  previewInvalid: string;
  submissionUnknown: string;
  submissionUnresolved: string;
  removalFailed: string;
  unchanged: { title: string; message: string };
  disabledBindingLabel: string;
}

type SourcePage = {
  kind: 'source';
  current?: EmployeePersonalSkill;
  draft: EmployeeSkillSourceDraft;
  reading: boolean;
  error?: string;
};
type ConfirmPayload = {
  kind: 'confirm';
  preview: PersonalSkillPreviewResponse;
  current?: EmployeePersonalSkill;
  source: SourcePage;
};
type RemovePayload = {
  kind: 'remove';
  skill: EmployeePersonalSkill;
  fromDetail: boolean;
};

/** Identity survives an uncertain response; private content is independently
 * discardable on access loss. This store belongs to the authenticated page,
 * not localStorage, URLs, a module singleton, or a refreshed browser. */
export interface EmployeeSkillUnsettledWrite {
  scopeId: string;
  workspaceId: string;
  instanceId: string;
  requestId: string;
  operation: 'install' | 'update' | 'remove';
  installationId?: string;
  revision?: number;
  versionId?: string;
  payload?: ConfirmPayload | RemovePayload;
}
export type EmployeeSkillWriteStore = Map<string, EmployeeSkillUnsettledWrite>;

export function clearEmployeeSkillWriteContents(
  writes: EmployeeSkillWriteStore,
  matches: (write: EmployeeSkillUnsettledWrite) => boolean,
) {
  for (const [id, write] of writes) {
    if (matches(write)) writes.set(id, { ...write, payload: undefined });
  }
}

function sameScope(
  write: EmployeeSkillUnsettledWrite,
  scope: EmployeeSkillScope,
) {
  return (
    write.scopeId === scope.scopeId &&
    write.workspaceId === scope.workspaceId &&
    write.instanceId === scope.instanceId
  );
}

type ConfirmPage = {
  kind: 'confirm';
  write: EmployeeSkillUnsettledWrite;
  payload: ConfirmPayload;
  pending: boolean;
  unknown: boolean;
  reread: boolean;
  error?: string;
};
type RemovePage = {
  kind: 'remove';
  stale?: boolean;
  write: EmployeeSkillUnsettledWrite;
  payload: RemovePayload;
  pending: boolean;
  unknown: boolean;
  error?: string;
};
type Page =
  | SourcePage
  | ConfirmPage
  | RemovePage
  | { kind: 'detail'; skill: EmployeeSkill }
  | { kind: 'detail-read'; installationId: string; title: string }
  | {
      kind: 'success';
      payload: ConfirmPayload;
      result: PersonalSkillConfirmResponse;
    }
  | { kind: 'unresolved'; operation: EmployeeSkillUnsettledWrite['operation'] }
  | null;

export interface EmployeeSkillLayer {
  title: string;
  navigationKey: string;
  content: ReactNode;
  small: boolean;
  detail?: boolean;
  blocked: boolean;
  onBack: () => void;
}

/** One native modal at a time. The final details host must replace its reader
 * shell with this layer, rather than leave a second focus/Escape owner below. */
export function EmployeeSkillLayerDialog({
  layer,
}: {
  layer: EmployeeSkillLayer | null;
}) {
  if (!layer) return null;
  return (
    <Modal
      key={layer.navigationKey}
      open
      headless
      title={layer.title}
      className={`${css.dialog} ${layer.small ? css.small : ''} ${layer.detail ? css.detailDialog : ''}`}
      onClose={() => {
        if (!layer.blocked) layer.onBack();
      }}
    >
      {layer.content}
    </Modal>
  );
}

export interface EmployeeSkillsHostProps {
  scope: EmployeeSkillScope;
  ownerView: boolean;
  employeeName: string;
  writes: EmployeeSkillWriteStore;
  copy: EmployeeSkillHostCopy;
  active?: boolean;
  activeEntry?: 'sidebar' | 'employee';
  backLabel?: string;
  /** The caller reports confirmed access loss through this reader's callback. */
  onStart?: (skill: EmployeeSkill, onAccessLost: () => void) => Promise<void>;
  navigationRef?: Ref<{ navigateHome: () => void }>;
  onNotice?: (message: string) => void;
  children: ReactNode | ((view: EmployeeSkillsHostView) => ReactNode);
}

interface EmployeeSkillsHostView {
  section: ReactNode;
  layer: EmployeeSkillLayer | null;
  renderSection: (onNavigate?: () => void) => ReactNode;
  navigateHome: () => void;
}
const EmployeeSkillsContext = createContext<EmployeeSkillsHostView | null>(
  null,
);
export const useEmployeeSkillsHostView = () =>
  useContext(EmployeeSkillsContext);
function renderHostChildren(
  children: EmployeeSkillsHostProps['children'],
  view: EmployeeSkillsHostView,
) {
  return (
    <EmployeeSkillsContext.Provider value={view}>
      {typeof children === 'function' ? children(view) : children}
    </EmployeeSkillsContext.Provider>
  );
}

export function EmployeeSkillConfirmationLayer({
  active,
}: {
  active: boolean;
}) {
  const view = useEmployeeSkillsHostView();
  return active && view?.layer?.small ? (
    <EmployeeSkillLayerDialog layer={view.layer} />
  ) : null;
}

export function EmployeeSkillsHost(props: EmployeeSkillsHostProps) {
  // Account changes erase content even when a pending request identity remains.
  clearEmployeeSkillWriteContents(
    props.writes,
    (write) =>
      write.scopeId !== props.scope.scopeId ||
      (!props.ownerView && sameScope(write, props.scope)),
  );
  if (!props.ownerView)
    return renderHostChildren(props.children, {
      section: null,
      layer: null,
      renderSection: () => null,
      navigateHome: () => {},
    });
  const key = JSON.stringify([
    props.scope.scopeId,
    props.scope.workspaceId,
    props.scope.instanceId,
    Object.entries(props.scope.headers).sort(),
  ]);
  return <EmployeeSkillsReader key={key} {...props} />;
}

function initialPage(
  scope: EmployeeSkillScope,
  writes: EmployeeSkillWriteStore,
  copy: EmployeeSkillHostCopy,
): Page {
  const write = [...writes.values()].find((item) => sameScope(item, scope));
  if (!write) return null;
  if (!write.payload) return { kind: 'unresolved', operation: write.operation };
  return write.payload.kind === 'confirm'
    ? {
        kind: 'confirm',
        write,
        payload: write.payload,
        pending: false,
        unknown: true,
        reread: false,
        error: copy.submissionUnknown,
      }
    : {
        kind: 'remove',
        write,
        payload: write.payload,
        pending: false,
        unknown: true,
        error: copy.submissionUnknown,
      };
}

function sourceError(
  error: unknown,
  source: EmployeeSkillSourceDraft,
  copy: EmployeeSkillHostCopy,
) {
  if (!(error instanceof EmployeeSkillApiError)) return copy.sourceInvalid;
  if (error.accessLost) return copy.accessLost;
  if (!error.reason && error.code === 'VERSION_CONFLICT')
    return '受影响员工或技能内容已变化，请重新读取后再确认。';
  switch (error.reason) {
    case 'source_unavailable':
      return source.tab === 'github'
        ? '读不到这个仓库。目前只支持公开仓库，请检查链接。'
        : copy.sourceInvalid;
    case 'skill_missing':
      return source.tab === 'github'
        ? '没找到 SKILL.md。请确认它在根目录。'
        : '没找到 SKILL.md。请确认它在压缩包根目录，不要多包一层文件夹。';
    case 'version_conflict':
      return '受影响员工或技能内容已变化，请重新读取后再确认。';
    case 'name_mismatch':
      return copy.nameMismatch;
    case 'name_conflict':
      return copy.sourceConflict;
    case 'preview_expired':
    case 'preview_invalid':
      return copy.previewInvalid;
    case 'limit':
      return copy.sourceLimit;
    default:
      return copy.sourceInvalid;
  }
}

function EmployeeSkillsReader({
  scope,
  employeeName,
  writes,
  copy,
  active,
  activeEntry,
  backLabel,
  onStart,
  navigationRef,
  onNotice,
  children,
}: EmployeeSkillsHostProps) {
  const [view, setView] = useState<EmployeeSkillsView>({
    status: 'loading',
    label: copy.loading,
  });
  const catalog = useRef<EmployeeSkillCatalog | null>(null);
  const [page, setPage] = useState<Page>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const resumeAfterRead = useRef(true);
  const currentPage = useRef(page);
  const mounted = useRef(true);
  const read = useRef<AbortController | null>(null);
  const submission = useRef<AbortController | null>(null);
  const readSequence = useRef(0);
  const pending = useRef(false);
  const show = (next: Page) => {
    currentPage.current = next;
    setPage(next);
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      read.current?.abort();
      submission.current?.abort();
    };
  }, []);

  const revoke = () => {
    read.current?.abort();
    read.current = null;
    readSequence.current += 1;
    catalog.current = null;
    clearEmployeeSkillWriteContents(writes, (write) => sameScope(write, scope));
    show(null);
    setView({ status: 'error', message: copy.accessLost });
  };

  const loadCatalog = async (signal: AbortSignal) => {
    const result = await readEmployeeSkills(scope, signal);
    if (signal.aborted || !mounted.current) return null;
    catalog.current = result;
    setView({ status: 'ready', catalog: result });
    return result;
  };

  const retryCatalog = () => {
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    const sequence = ++readSequence.current;
    catalog.current = null;
    setView({ status: 'loading', label: copy.loading });
    void loadCatalog(controller.signal)
      .then((result) => {
        if (
          result &&
          resumeAfterRead.current &&
          sequence === readSequence.current
        ) {
          resumeAfterRead.current = false;
          show(initialPage(scope, writes, copy));
        }
      })
      .catch((error: unknown) => {
        if (
          !mounted.current ||
          controller.signal.aborted ||
          sequence !== readSequence.current
        )
          return;
        if (error instanceof EmployeeSkillApiError && error.accessLost) {
          revoke();
          return;
        }
        setView({
          status: 'error',
          message: copy.catalogError,
          onRetry: retryCatalog,
        });
      });
  };

  useEffect(() => {
    if (active !== false && !read.current) retryCatalog();
    // The keyed reader fixes every scope/header used by its requests.
  }, [active, activeEntry]);

  const returnFromSource = (source: SourcePage) => {
    read.current?.abort();
    readSequence.current += 1;
    const skill =
      source.current &&
      catalog.current?.personalSkills.find(
        (item) => item.installationId === source.current?.installationId,
      );
    show(skill ? { kind: 'detail', skill } : null);
  };

  const blockingWrite = (installationId?: string) =>
    [...writes.values()].find(
      (write) =>
        write.scopeId === scope.scopeId &&
        (sameScope(write, scope) ||
          (installationId
            ? write.installationId === installationId
            : write.operation === 'install')),
    );

  const resume = (write: EmployeeSkillUnsettledWrite) => {
    if (!sameScope(write, scope) || !write.payload) {
      show({ kind: 'unresolved', operation: write.operation });
      return;
    }
    show(
      write.payload.kind === 'confirm'
        ? {
            kind: 'confirm',
            write,
            payload: write.payload,
            pending: false,
            unknown: true,
            reread: false,
            error: copy.submissionUnknown,
          }
        : {
            kind: 'remove',
            write,
            payload: write.payload,
            pending: false,
            unknown: true,
            error: copy.submissionUnknown,
          },
    );
  };

  const openSource = (skill?: EmployeePersonalSkill) => {
    const current = catalog.current;
    if (!current?.canInstall) return;
    const unresolved = blockingWrite(skill?.installationId);
    if (unresolved) {
      resume(unresolved);
      return;
    }
    show({
      kind: 'source',
      current: skill,
      reading: false,
      draft: {
        tab: skill?.source.kind === 'attachment' ? 'zip' : 'github',
        github:
          skill?.source.kind === 'github' ? skill.source.requestedUrl : '',
        file: null,
      },
    });
  };

  const readSource = async () => {
    const source = currentPage.current;
    if (source?.kind !== 'source' || source.reading || pending.current) return;
    const unresolved = blockingWrite(source.current?.installationId);
    if (unresolved) {
      resume(unresolved);
      return;
    }
    if (source.draft.tab === 'github' && !source.draft.github.trim()) {
      show({ ...source, error: '请先填写仓库链接。' });
      return;
    }
    const file = source.draft.file;
    const sourceInput =
      source.draft.tab === 'github'
        ? { kind: 'github' as const, url: source.draft.github }
        : file
          ? { kind: 'zip' as const, file }
          : null;
    if (!sourceInput) return;
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    const sequence = ++readSequence.current;
    const live = () =>
      mounted.current &&
      !controller.signal.aborted &&
      sequence === readSequence.current;
    show({ ...source, reading: true, error: undefined });
    try {
      const fresh = await loadCatalog(controller.signal);
      if (!live() || !fresh) return;
      if (!fresh.canInstall) {
        revoke();
        return;
      }
      const current = source.current
        ? fresh.personalSkills.find(
            (skill) => skill.installationId === source.current?.installationId,
          )
        : undefined;
      if (source.current && !current) {
        show({
          ...source,
          reading: false,
          error: '受影响员工或技能内容已变化，请重新读取后再确认。',
        });
        return;
      }
      const preview = await previewEmployeeSkill(
        scope,
        current
          ? {
              operation: 'update',
              installationId: current.installationId,
              expectedRevision: current.revision,
              expectedVersionId: current.versionId,
            }
          : { operation: 'install' },
        sourceInput,
        controller.signal,
      );
      if (!live()) return;
      if (preview.operation === 'install') {
        const existing = fresh.personalSkills.find(
          (skill) =>
            skill.installationId ===
            (preview.target.operation === 'install'
              ? preview.target.expectedInstallation?.id
              : undefined),
        );
        if (existing) {
          show({
            ...source,
            reading: false,
            error: `已经添加“${existing.displayName}”这个技能。`,
          });
          return;
        }
      }
      const payload: ConfirmPayload = {
        kind: 'confirm',
        preview,
        current,
        source: { ...source, current, reading: false, error: undefined },
      };
      const write: EmployeeSkillUnsettledWrite = {
        scopeId: scope.scopeId,
        workspaceId: scope.workspaceId,
        instanceId: scope.instanceId,
        requestId: crypto.randomUUID(),
        operation: preview.operation,
        installationId: current?.installationId,
        revision: current?.revision,
        versionId: current?.versionId,
        payload,
      };
      show({
        kind: 'confirm',
        payload,
        write,
        pending: false,
        unknown: false,
        reread: false,
      });
    } catch (error) {
      if (!live()) return;
      if (error instanceof EmployeeSkillApiError && error.accessLost) {
        revoke();
        return;
      }
      show({
        ...source,
        reading: false,
        error: sourceError(error, source.draft, copy),
      });
    }
  };

  const finishRead = () => {
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    const sequence = ++readSequence.current;
    catalog.current = null;
    setView({ status: 'loading', label: copy.loading });
    void loadCatalog(controller.signal).catch((error: unknown) => {
      if (
        !mounted.current ||
        controller.signal.aborted ||
        sequence !== readSequence.current
      )
        return;
      if (error instanceof EmployeeSkillApiError && error.accessLost) {
        revoke();
        return;
      }
      setView({
        status: 'error',
        message: copy.catalogError,
        onRetry: retryCatalog,
      });
    });
  };

  const confirm = async () => {
    const current = currentPage.current;
    if (current?.kind !== 'confirm' || pending.current) return;
    if (current.reread && !current.unknown) {
      show(current.payload.source);
      return;
    }
    // An elapsed local clock cannot establish the outcome of an earlier write.
    if (
      !current.unknown &&
      Date.parse(current.payload.preview.expiresAt) <= Date.now()
    ) {
      show({ ...current, error: copy.previewInvalid, reread: true });
      return;
    }
    pending.current = true;
    const controller = new AbortController();
    submission.current = controller;
    writes.set(current.write.requestId, current.write);
    show({ ...current, pending: true, error: undefined });
    try {
      const result = await confirmEmployeeSkill(
        scope,
        current.payload.preview,
        current.write.requestId,
        current.payload.current,
        controller.signal,
      );
      writes.delete(current.write.requestId);
      if (!mounted.current || controller.signal.aborted) return;
      show({ kind: 'success', payload: current.payload, result });
      finishRead();
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      const unknown =
        current.unknown ||
        !(error instanceof EmployeeSkillApiError) ||
        error.kind === 'unknown';
      if (!unknown) writes.delete(current.write.requestId);
      if (error instanceof EmployeeSkillApiError && error.accessLost) {
        revoke();
        return;
      }
      if (
        current.unknown &&
        error instanceof EmployeeSkillApiError &&
        error.kind === 'rejected' &&
        (error.reason === 'preview_invalid' ||
          error.reason === 'preview_expired')
      ) {
        // A server-rejected signature cannot recover an earlier write receipt.
        // Keep its blocking identity without reviving an unusable replay.
        clearEmployeeSkillWriteContents(
          writes,
          (write) => write.requestId === current.write.requestId,
        );
        show({ kind: 'unresolved', operation: current.write.operation });
        return;
      }
      const reread =
        !unknown &&
        error instanceof EmployeeSkillApiError &&
        (['preview_invalid', 'preview_expired', 'version_conflict'].includes(
          error.reason ?? '',
        ) ||
          (!error.reason && error.code === 'VERSION_CONFLICT'));
      show({
        ...current,
        pending: false,
        unknown,
        reread,
        error: unknown
          ? copy.submissionUnknown
          : sourceError(error, current.payload.source.draft, copy),
      });
    } finally {
      pending.current = false;
    }
  };

  const openRemoval = (skill: EmployeePersonalSkill, fromDetail: boolean) => {
    if (!skill.canUninstall || pending.current) return;
    const unresolved = blockingWrite(skill.installationId);
    if (unresolved) {
      resume(unresolved);
      return;
    }
    const payload: RemovePayload = { kind: 'remove', skill, fromDetail };
    const write: EmployeeSkillUnsettledWrite = {
      scopeId: scope.scopeId,
      workspaceId: scope.workspaceId,
      instanceId: scope.instanceId,
      requestId: crypto.randomUUID(),
      operation: 'remove',
      installationId: skill.installationId,
      revision: skill.revision,
      versionId: skill.versionId,
      payload,
    };
    show({ kind: 'remove', payload, write, pending: false, unknown: false });
  };

  const remove = async () => {
    const current = currentPage.current;
    if (current?.kind !== 'remove' || pending.current) return;
    if (current.stale && !current.unknown) {
      pending.current = true;
      const controller = new AbortController();
      read.current?.abort();
      read.current = controller;
      show({ ...current, pending: true });
      try {
        const fresh = await loadCatalog(controller.signal);
        if (!mounted.current || controller.signal.aborted || !fresh) return;
        const skill = fresh.personalSkills.find(
          (item) =>
            item.installationId === current.payload.skill.installationId,
        );
        if (!skill?.canUninstall) {
          show(null);
          return;
        }
        const payload: RemovePayload = { ...current.payload, skill };
        show({
          kind: 'remove',
          payload,
          write: {
            ...current.write,
            requestId: crypto.randomUUID(),
            revision: skill.revision,
            versionId: skill.versionId,
            payload,
          },
          pending: false,
          unknown: false,
        });
      } catch (error) {
        if (!mounted.current || controller.signal.aborted) return;
        if (error instanceof EmployeeSkillApiError && error.accessLost) {
          revoke();
          return;
        }
        show({ ...current, pending: false, error: copy.catalogError });
      } finally {
        pending.current = false;
      }
      return;
    }
    pending.current = true;
    const controller = new AbortController();
    submission.current = controller;
    writes.set(current.write.requestId, current.write);
    show({ ...current, pending: true, error: undefined });
    try {
      await removeEmployeeSkill(
        scope,
        current.payload.skill,
        current.write.requestId,
        controller.signal,
      );
      writes.delete(current.write.requestId);
      if (!mounted.current || controller.signal.aborted) return;
      show(null);
      onNotice?.(`已卸载“${current.payload.skill.displayName}”`);
      finishRead();
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      const unknown =
        current.unknown ||
        !(error instanceof EmployeeSkillApiError) ||
        error.kind === 'unknown';
      if (!unknown) writes.delete(current.write.requestId);
      if (error instanceof EmployeeSkillApiError && error.accessLost) {
        revoke();
        return;
      }
      show({
        ...current,
        pending: false,
        unknown,
        stale:
          !unknown &&
          error instanceof EmployeeSkillApiError &&
          error.code === 'VERSION_CONFLICT',
        error: unknown ? copy.submissionUnknown : copy.removalFailed,
      });
    } finally {
      pending.current = false;
    }
  };

  const back = () => {
    const current = currentPage.current;
    if (pending.current || starting || !current) return;
    setStartError('');
    if (current.kind === 'source') {
      returnFromSource(current);
      return;
    }
    if (current.kind === 'confirm') {
      show(current.payload.source);
      return;
    }
    if (current.kind === 'remove') {
      show(
        current.payload.fromDetail
          ? { kind: 'detail', skill: current.payload.skill }
          : null,
      );
      return;
    }
    if (
      current.kind === 'success' &&
      current.result.receipt.operation === 'update'
    ) {
      show({
        kind: 'detail-read',
        installationId: current.result.receipt.installationId,
        title: employeeSkillPreviewName(current.payload.preview),
      });
      return;
    }
    show(null);
  };

  const start = async (skill: EmployeeSkill) => {
    if (!onStart || pending.current || starting || !catalog.current) return;
    setStarting(true);
    setStartError('');
    try {
      await onStart(skill, () => {
        if (mounted.current) revoke();
      });
      if (mounted.current) show(null);
    } catch (cause) {
      if (mounted.current)
        setStartError(
          cause instanceof Error ? cause.message : copy.catalogError,
        );
    } finally {
      if (mounted.current) setStarting(false);
    }
  };

  const navigateHome = () => {
    if (pending.current || starting) return;
    if (currentPage.current?.kind === 'source') {
      read.current?.abort();
      readSequence.current += 1;
    }
    setStartError('');
    show(null);
  };
  useImperativeHandle(navigationRef, () => ({ navigateHome }));

  let layer: EmployeeSkillLayer | null = null;
  if (page) {
    let title: string;
    let content: ReactNode;
    if (page.kind === 'detail') {
      title = page.skill.displayName;
      content = (
        <EmployeeSkillDetails
          skill={page.skill}
          canInstall={catalog.current?.canInstall ?? false}
          onBack={back}
          onUpdate={openSource}
          onUninstall={(skill) => openRemoval(skill, true)}
          onStart={onStart ? () => void start(page.skill) : undefined}
          starting={starting}
          error={startError}
          backLabel={backLabel}
        />
      );
    } else if (page.kind === 'detail-read') {
      const skill =
        view.status === 'ready'
          ? view.catalog.personalSkills.find(
              (item) => item.installationId === page.installationId,
            )
          : undefined;
      title = skill?.displayName ?? page.title;
      content = skill ? (
        <EmployeeSkillDetails
          skill={skill}
          canInstall={view.status === 'ready' && view.catalog.canInstall}
          onBack={back}
          onUpdate={openSource}
          onUninstall={(item) => openRemoval(item, true)}
          onStart={onStart ? () => void start(skill) : undefined}
          starting={starting}
          error={startError}
          backLabel={backLabel}
        />
      ) : (
        <EmployeeSkillPage
          title={title}
          backLabel={backLabel ?? '返回员工详情'}
          onBack={back}
        >
          <EmployeeSkillFeedback busy={view.status === 'loading'}>
            {view.status === 'loading'
              ? copy.loading
              : view.status === 'error'
                ? view.message
                : copy.accessLost}
          </EmployeeSkillFeedback>
          {view.status === 'error' && view.onRetry && (
            <Button type="button" variant="outline" onClick={view.onRetry}>
              重试
            </Button>
          )}
        </EmployeeSkillPage>
      );
    } else if (page.kind === 'source') {
      title = page.current ? `更新“${page.current.displayName}”` : '添加技能';
      content = (
        <EmployeeSkillSourceForm
          operation={page.current ? 'update' : 'install'}
          name={page.current?.displayName}
          draft={page.draft}
          reading={page.reading}
          error={page.error}
          onChange={(draft) => {
            if (!page.reading) show({ ...page, draft, error: undefined });
          }}
          onRead={() => void readSource()}
          onBack={back}
          parentBackLabel={backLabel}
        />
      );
    } else if (page.kind === 'confirm') {
      title =
        page.payload.preview.operation === 'update' ? '确认更新' : '确认添加';
      content = (
        <EmployeeSkillConfirmation
          preview={page.payload.preview}
          current={page.payload.current}
          pending={page.pending}
          error={page.error}
          reread={page.reread}
          disabledBindingLabel={copy.disabledBindingLabel}
          onBack={back}
          onConfirm={() => void confirm()}
        />
      );
    } else if (page.kind === 'success') {
      title = page.result.receipt.unchanged
        ? copy.unchanged.title
        : page.result.receipt.operation === 'update'
          ? '更新完成'
          : '添加完成';
      content = (
        <EmployeeSkillSuccess
          preview={page.payload.preview}
          result={page.result}
          unchanged={copy.unchanged}
          onDone={back}
          parentBackLabel={backLabel}
        />
      );
    } else if (page.kind === 'remove') {
      title = `卸载“${page.payload.skill.displayName}”？`;
      content = (
        <EmployeeSkillRemoval
          employeeName={employeeName}
          skill={page.payload.skill}
          pending={page.pending}
          error={page.error}
          onBack={back}
          onConfirm={() => void remove()}
        />
      );
    } else {
      title =
        page.operation === 'update'
          ? '确认更新'
          : page.operation === 'install'
            ? '确认添加'
            : '卸载';
      content = (
        <EmployeeSkillPage
          title={title}
          backLabel={backLabel ?? '返回员工详情'}
          onBack={back}
          footer={
            <Button type="button" variant="outline" onClick={back}>
              取消
            </Button>
          }
        >
          <EmployeeSkillFeedback>
            {copy.submissionUnresolved}
          </EmployeeSkillFeedback>
        </EmployeeSkillPage>
      );
    }
    const navigationKey =
      page.kind === 'detail'
        ? `detail/${page.skill.kind === 'personal' ? page.skill.installationId : page.skill.id}`
        : page.kind === 'detail-read'
          ? `detail-read/${page.installationId}/${view.status}`
          : page.kind === 'source'
            ? `source/${page.current?.installationId ?? 'install'}`
            : page.kind === 'confirm' || page.kind === 'remove'
              ? `${page.kind}/${page.write.requestId}`
              : page.kind === 'success'
                ? `success/${page.result.receipt.requestId}`
                : `unresolved/${page.operation}`;
    layer = {
      title,
      navigationKey,
      content,
      small: page.kind === 'remove',
      detail: page.kind === 'detail' || page.kind === 'detail-read',
      blocked: pending.current || starting,
      onBack: back,
    };
  }
  const renderSection = (onNavigate?: () => void) => (
    <EmployeeSkillsSection
      view={view}
      disabled={pending.current || starting}
      onOpen={(skill) => {
        onNavigate?.();
        setStartError('');
        show({ kind: 'detail', skill });
      }}
      onAdd={() => {
        onNavigate?.();
        openSource();
      }}
    />
  );
  return renderHostChildren(children, {
    section: renderSection(),
    layer,
    renderSection,
    navigateHome,
  });
}
