'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  Button,
  IconCloseOutlineRegular,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type {
  PersonalScenePreviewResponse,
  PersonalSceneSkill,
} from '@allrice/contracts';
import { AssistantMarkdown } from './assistant-markdown';
import {
  sceneSourceError,
  sceneSourceLabel,
  type SceneCatalogEntry,
  type SceneSelection,
  type EmployeeSceneCatalogController,
} from './use-employee-scene-catalog';
import css from './employee-scene-dialog.module.css';
import {
  EmployeeCapabilityDanger,
  EmployeeCapabilityDetailsHeader,
  EmployeeCapabilityHeading,
  EmployeeCapabilityRow,
} from './employee-capability-presentation';
import capabilityCss from './employee-capability-presentation.module.css';
import { useCapabilityEscape } from './use-capability-escape';

function SceneLayer(props: {
  inline?: boolean;
  open: boolean;
  title: string;
  onClose: () => void;
  className: string;
  children: ReactNode;
}) {
  const inline = useRef<HTMLElement>(null);
  useCapabilityEscape(
    inline,
    Boolean(props.inline && props.open),
    props.onClose,
  );
  return props.inline ? (
    props.open ? (
      <section
        ref={inline}
        role="region"
        className={`${props.className} ${css.inlinePanel}`}
        aria-label={props.title}
      >
        {props.children}
      </section>
    ) : null
  ) : (
    <Modal
      open={props.open}
      headless
      title={props.title}
      onClose={props.onClose}
      className={props.className}
    >
      {props.children}
    </Modal>
  );
}

type Entry = SceneCatalogEntry;
type Page = 'list' | 'detail' | 'source' | 'confirm' | 'success';
const version = (value?: string) => value || '未提供';

function SceneIcon({
  kind,
}: {
  kind: 'back' | 'chevron' | 'link' | 'box' | 'check';
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'back' ? (
        <path d="m10 5-7 7 7 7M3 12h18" />
      ) : kind === 'chevron' ? (
        <path d="m9 5 7 7-7 7" />
      ) : kind === 'check' ? (
        <path d="m5 12 4 4L19 6" />
      ) : kind === 'link' ? (
        <>
          <path d="m10 13 4-4M8 15l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M13 9l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" />
        </>
      ) : (
        <>
          <path d="m3 7 9-4 9 4v10l-9 4-9-4V7Z" />
          <path d="m3 7 9 4 9-4M12 11v10" />
        </>
      )}
    </svg>
  );
}

function Reading() {
  return (
    <div className={css.loading} role="status" aria-busy="true">
      <span className={css.spinner} aria-hidden="true" />
      正在读取…
    </div>
  );
}

function unchanged(preview: PersonalScenePreviewResponse) {
  const current = preview.current;
  const resources = preview.files.filter((item) => item.path !== 'SKILL.md');
  // Compare the authorized source projections, never ZIP and bundle digests.
  return (
    current &&
    current.content === preview.item.content &&
    JSON.stringify(current.frontmatter) ===
      JSON.stringify(preview.item.frontmatter) &&
    current.resources.length === resources.length &&
    resources.every((file) =>
      current.resources.some(
        (resource) =>
          resource.path === file.path &&
          resource.byteLength === file.byteLength &&
          resource.checksum === file.checksum,
      ),
    )
  );
}

function SceneDetails({
  selected,
  employeeName,
  onDeliveries,
}: {
  selected: SceneSelection;
  employeeName: string;
  onDeliveries: () => void;
}) {
  const frontmatter = selected.personal
    ? selected.value.frontmatter
    : selected.value.skillPackage.frontmatter;
  const description = selected.personal
    ? selected.value.description
    : (frontmatter?.description ?? selected.value.scene.appliesWhen);
  const nativeName = selected.personal
    ? selected.value.nativeName
    : frontmatter?.name;
  const source = selected.personal
    ? selected.value.source
    : selected.value.skillPackage.source;
  const when = selected.personal
    ? selected.value.whenToUse
    : frontmatter?.whenToUse;
  return (
    <>
      <div className={css.intro}>
        <p className={css.reading}>{description || '未提供'}</p>
        <p className={css.sourceLine}>
          <SceneIcon kind="link" />
          <span>来自 {sceneSourceLabel(source)}</span>
        </p>
      </div>
      <section className={css.section}>
        <h3>什么时候用</h3>
        <p>{when || '未提供'}</p>
      </section>
      <section className={css.section}>
        <h3>怎么用</h3>
        {nativeName ? (
          <p>
            点“开始工作”，或者在对话里直接说需求，{employeeName}
            会自己判断要不要用它。想指定用它，输入 <code>/{nativeName}</code>。
          </p>
        ) : (
          <p className={css.secondary}>未提供</p>
        )}
      </section>
      <section className={css.section}>
        <h3>工作步骤</h3>
        {selected.personal && selected.value.stepsMarkdown ? (
          <div className={css.markdown}>
            <AssistantMarkdown
              text={selected.value.stepsMarkdown}
              allowRemoteImages={false}
            />
          </div>
        ) : (
          <p className={css.secondary}>未提供</p>
        )}
      </section>
      <section className={`${css.section} ${css.delivery}`}>
        <div>
          <h3>交付内容</h3>
          {selected.personal && selected.value.deliverablesMarkdown ? (
            <div className={css.markdown}>
              <AssistantMarkdown
                text={selected.value.deliverablesMarkdown}
                allowRemoteImages={false}
              />
            </div>
          ) : (
            <p className={css.secondary}>未提供</p>
          )}
        </div>
        <button
          type="button"
          className={`${css.link} ${css.deliveryLink}`}
          onClick={onDeliveries}
        >
          查看交付结果 →
        </button>
      </section>
    </>
  );
}

/** The top entry and employee details consume the same authorized catalog. */
export function EmployeeSceneList(props: {
  controller: EmployeeSceneCatalogController;
  employeeName: string;
  embedded?: boolean;
  notice?: string;
  onChoose: (entry: Entry) => void;
  onCreate: () => void;
}) {
  const { controller: catalog } = props;
  const heading = useId();
  const writable = catalog.canMaintain && !catalog.loading && !catalog.error;
  const create = (
    <Button
      variant="outline"
      disabled={catalog.busy || catalog.uncertain}
      onClick={props.onCreate}
    >
      新建场景
    </Button>
  );
  return (
    <section
      className={capabilityCss.typography}
      aria-labelledby={props.embedded ? heading : undefined}
    >
      {props.notice && (
        <p className={css.caption} role="status">
          {props.notice}
        </p>
      )}
      {props.embedded && (
        <EmployeeCapabilityHeading
          id={heading}
          title="工作场景"
          kind="Workflow"
          description="固定流程的工作，你发起，它按步骤做。"
          action={writable && create}
        />
      )}
      {catalog.loading ? (
        <Reading />
      ) : catalog.error ? (
        <>
          <p className={css.error} role="alert">
            {catalog.error}
          </p>
          <div className={css.requestActions}>
            <Button variant="primary" onClick={() => void catalog.load()}>
              重试
            </Button>
          </div>
        </>
      ) : catalog.catalog?.value.skills.length ? (
        <div className={capabilityCss.list}>
          {catalog.catalog.value.skills.map((item) => {
            const personal = 'sceneId' in item;
            return (
              <EmployeeCapabilityRow
                key={personal ? item.sceneId : JSON.stringify(item.pin)}
                name={personal ? item.name : item.scene.name}
                description={
                  personal ? item.description : item.scene.appliesWhen
                }
                version={personal ? version(item.version) : '未提供'}
                disabled={catalog.busy}
                onOpen={() => props.onChoose(item)}
              />
            );
          })}
        </div>
      ) : (
        <div className={css.empty}>
          <SceneIcon kind="box" />
          <h3>还没有工作场景</h3>
          <p className={css.caption}>
            安装一个 Workflow，{props.employeeName}就能按固定流程干活。
          </p>
          {!props.embedded && writable && create}
        </div>
      )}
      {!props.embedded &&
        writable &&
        !!catalog.catalog?.value.skills.length && (
          <div className={css.requestActions}>{create}</div>
        )}
    </section>
  );
}

/** Real host entry. One native modal owns the pages; the native confirmation
 * layer owns its own focus. No legacy Dialog or private modal stack is added. */
export function EmployeeSceneDialog(props: {
  controller: EmployeeSceneCatalogController;
  open: boolean;
  employeeName: string;
  onClose: () => void;
  onStart: (scene: SceneSelection) => Promise<void>;
  onDeliveries: () => void;
  onRemoved?: (name: string) => void;
  initial?: { page: 'detail'; entry: Entry } | { page: 'source' };
  onBackToEmployee?: () => void;
  onBackToList?: () => void;
  inline?: boolean;
}) {
  const { controller: catalog } = props;
  const returnToList = props.onBackToEmployee ?? props.onBackToList;
  const initial = useRef(props.initial).current;
  const pending = catalog.mutation;
  const [requestedPage, setPage] = useState<Page>(() =>
    pending?.uncertain && pending.kind === 'confirm'
      ? 'confirm'
      : (initial?.page ?? 'list'),
  );
  const [entry, setEntry] = useState<Entry | undefined>(
    initial?.page === 'detail' ? initial.entry : undefined,
  );
  const [sourceTarget, setSourceTarget] = useState<
    PersonalSceneSkill | undefined
  >(() => {
    if (
      pending?.kind !== 'confirm' ||
      !pending.uncertain ||
      pending.preview.operation !== 'update'
    )
      return undefined;
    // Only the intact, same-scope preview owns the original update target.
    // Redacted unresolved identities cannot restore private source content.
    const { current, target } = pending.preview;
    return current?.sceneId === target.sceneId &&
      current.contentRef === target.expectedContentRef
      ? current
      : undefined;
  });
  const [tab, setTab] = useState<'github' | 'zip'>('github');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<
    PersonalScenePreviewResponse | undefined
  >(() =>
    pending?.kind === 'confirm' && pending.uncertain
      ? pending.preview
      : undefined,
  );
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<PersonalSceneSkill | undefined>(
    () =>
      pending?.kind === 'remove' && pending.uncertain
        ? pending.scene
        : undefined,
  );
  const [starting, setStarting] = useState(false);
  const [mounted, setMounted] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const sourceGeneration = useRef(0);
  const open = useRef(props.open);
  open.current = props.open;
  const currentCatalog = useRef(catalog);
  currentCatalog.current = catalog;
  const selected = catalog.detail.value;
  const busy = catalog.busy || starting;
  const employeeName = catalog.profile?.name ?? props.employeeName;
  const personal = selected?.personal ? selected.value : undefined;
  const selectedName = selected
    ? selected.personal
      ? selected.value.name
      : selected.value.scene.name
    : entry
      ? 'sceneId' in entry
        ? entry.name
        : entry.scene.name
      : '工作场景';
  const selectedVersion = selected
    ? selected.personal
      ? selected.value.version
      : selected.value.skillPackage.frontmatter?.metadata.version
    : undefined;
  const selectedNativeName = selected
    ? selected.personal
      ? selected.value.nativeName
      : selected.value.skillPackage.frontmatter?.name
    : undefined;
  const userInvocable = selected
    ? selected.personal
      ? selected.value.invocation?.userInvocable
      : selected.value.skillPackage.frontmatter?.invocation.userInvocable
    : false;
  const writable = catalog.canMaintain && !catalog.loading && !catalog.error;
  const page =
    catalog.accessUnavailable || (catalog.loading && !catalog.profile)
      ? 'list'
      : requestedPage;
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!catalog.accessUnavailable) return;
    sourceGeneration.current += 1;
    setPage('list');
    setSourceTarget(undefined);
    setPreview(undefined);
    setRemoving(undefined);
    setFile(undefined);
    setUrl('');
    setReading(false);
    setError('');
  }, [catalog.accessUnavailable]);
  useEffect(() => {
    if (props.open) {
      if (initial) currentCatalog.current.ensureLoaded();
      else void currentCatalog.current.load(true);
      if (initial?.page === 'detail')
        void currentCatalog.current.inspect(initial.entry);
    }
  }, [props.open, catalog.key, initial]);
  useEffect(() => {
    if (props.open && mounted && !removing)
      title.current?.focus({ preventScroll: true });
  }, [props.open, page, mounted, removing]);
  useEffect(
    () => () => {
      sourceGeneration.current += 1;
    },
    [catalog.key],
  );

  function close() {
    if (busy) return;
    sourceGeneration.current += 1;
    catalog.cancelPreview();
    setReading(false);
    props.onClose();
  }
  function back() {
    if (busy) return;
    setError('');
    if (page === 'confirm') setPage('source');
    else if (page === 'source') {
      sourceGeneration.current += 1;
      catalog.cancelPreview();
      setReading(false);
      if (!sourceTarget && returnToList) returnToList();
      else setPage(sourceTarget ? 'detail' : 'list');
    } else {
      catalog.clearSelection();
      if (returnToList) returnToList();
      else setPage('list');
    }
  }
  function choose(entry: Entry) {
    if (busy) return;
    setEntry(entry);
    setError('');
    setPage('detail');
    void catalog.inspect(entry);
  }
  function source(target?: PersonalSceneSkill) {
    if (!writable || busy || catalog.uncertain) return;
    setSourceTarget(target);
    setTab(target?.source?.kind === 'zip' ? 'zip' : 'github');
    setUrl(target?.source?.kind === 'github' ? target.source.requestedUrl : '');
    setFile(undefined);
    setPreview(undefined);
    setError('');
    setPage('source');
  }
  async function read(nextFile?: File) {
    if (reading || busy || !writable || catalog.uncertain) return;
    const zip = Boolean(nextFile) || tab === 'zip';
    const selectedFile = nextFile ?? file;
    if (zip && !selectedFile) return;
    if (!zip && !url.trim()) {
      setError('请先填写仓库链接。');
      return;
    }
    const generation = ++sourceGeneration.current;
    setReading(true);
    setError('');
    setPreview(undefined);
    try {
      const value = await catalog.preview(
        sourceTarget
          ? {
              operation: 'update',
              sceneId: sourceTarget.sceneId,
              expectedRevision: sourceTarget.revision,
              expectedContentRef: sourceTarget.contentRef,
            }
          : { operation: 'install' },
        zip
          ? { kind: 'zip', fileName: selectedFile!.name }
          : { kind: 'github', url: url.trim() },
        selectedFile,
      );
      if (value && generation === sourceGeneration.current && open.current) {
        if (value.operation === 'update' && unchanged(value))
          setError('和当前内容完全一样，不用更新。');
        else {
          setPreview(value);
          setPage('confirm');
        }
      }
    } catch (cause) {
      if (generation === sourceGeneration.current && open.current)
        setError(sceneSourceError(cause, zip ? 'zip' : 'github'));
    } finally {
      if (generation === sourceGeneration.current) setReading(false);
    }
  }
  function upload(next?: File) {
    if (!next || reading || busy || catalog.uncertain) return;
    setTab('zip');
    setFile(next);
    void read(next);
  }
  function chooseFile() {
    if (reading || busy || catalog.uncertain || !fileInput.current) return;
    fileInput.current.value = '';
    fileInput.current.click();
  }
  function switchTab(next: typeof tab) {
    if (busy) return;
    sourceGeneration.current += 1;
    catalog.cancelPreview();
    setReading(false);
    setPreview(undefined);
    setError('');
    setTab(next);
  }
  async function confirm() {
    if (!preview || busy) return;
    if (await catalog.confirm(preview)) setPage('success');
  }
  async function remove() {
    if (!removing || busy) return;
    if (await catalog.remove(removing)) {
      props.onRemoved?.(removing.name);
      setRemoving(undefined);
      if (returnToList) returnToList();
      else setPage('list');
    }
  }
  async function start() {
    if (!selected || !selectedNativeName || userInvocable === false || busy)
      return;
    setStarting(true);
    setError('');
    try {
      await props.onStart(selected);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : '工作场景读取失败，请重试。',
      );
    } finally {
      setStarting(false);
    }
  }
  function finish() {
    if (busy || !preview) return;
    const receipt = pending?.kind === 'confirm' ? pending.receipt : undefined;
    if (preview.operation === 'update' && sourceTarget && receipt) {
      // The exact verified receipt is enough to address the real detail read;
      // navigation never depends on the background catalog refresh finishing.
      choose({
        ...sourceTarget,
        name: preview.item.frontmatter.metadata.displayName,
        revision: receipt.revision,
        contentRef: receipt.contentRef,
      });
    } else if (returnToList) returnToList();
    else {
      setPage('list');
      setError('');
    }
  }
  const pageTitle =
    page === 'list'
      ? '工作场景'
      : page === 'detail'
        ? selectedName
        : page === 'source'
          ? sourceTarget
            ? `更新“${sourceTarget.name}”`
            : '新建工作场景'
          : page === 'confirm'
            ? sourceTarget || preview?.operation === 'update'
              ? '确认更新'
              : '确认安装'
            : preview?.operation === 'update'
              ? '更新完成'
              : '安装完成';
  const zip = tab === 'zip';
  const confirmMutation =
    pending?.kind === 'confirm' &&
    pending.preview.previewId === preview?.previewId
      ? pending
      : undefined;
  const mutationError = page === 'confirm' ? confirmMutation?.error : '';
  // DESIGN TODO (reported): pending.uncertain needs the user's approved sentence.
  // It stops being busy and keeps the exact requestId. Never label it failed/success.
  return (
    <>
      <SceneLayer
        inline={props.inline}
        open={props.open && mounted}
        title={page === 'list' ? '工作场景 Workflow' : pageTitle}
        onClose={
          removing
            ? () => {}
            : page === 'success'
              ? finish
              : page === 'list'
                ? close
                : back
        }
        className={`${css.panel} ${capabilityCss.detailContainer} ${page === 'detail' ? css.detailPanel : css.formPanel}`}
      >
        {page === 'detail' ? (
          <EmployeeCapabilityDetailsHeader
            title={pageTitle}
            version={selected ? version(selectedVersion) : undefined}
            titleRef={title}
            backLabel={props.onBackToEmployee ? '返回员工详情' : '返回能力列表'}
            onBack={back}
            disabled={busy}
            updateDisabled={catalog.uncertain}
            startDisabled={!!catalog.error}
            starting={starting}
            onUpdate={
              selected && writable && personal
                ? () => source(personal)
                : undefined
            }
            onStart={
              selected && selectedNativeName && userInvocable !== false
                ? () => void start()
                : undefined
            }
          />
        ) : (
          <header className={css.header}>
            {page !== 'list' && (
              <button
                type="button"
                className={css.iconButton}
                aria-label="返回上一层"
                disabled={busy}
                onClick={page === 'success' ? finish : back}
              >
                <SceneIcon kind="back" />
              </button>
            )}
            <div className={css.titleGroup}>
              <h2 tabIndex={-1} ref={title}>
                {pageTitle}
                {page === 'list' && <span className={css.kind}>Workflow</span>}
              </h2>
              {page === 'list' && <p className={css.caption}>{employeeName}</p>}
            </div>
            {page === 'list' && (
              <button
                type="button"
                className={css.iconButton}
                aria-label="关闭工作场景"
                onClick={close}
                disabled={busy}
              >
                <IconCloseOutlineRegular size={18} />
              </button>
            )}
          </header>
        )}
        <div className={css.body}>
          {page === 'list' ? (
            <>
              <EmployeeSceneList
                controller={catalog}
                employeeName={employeeName}
                onChoose={choose}
                onCreate={() => source()}
              />
            </>
          ) : page === 'detail' ? (
            <>
              {catalog.detail.loading ? (
                <Reading />
              ) : catalog.detail.error ? (
                <>
                  <p className={css.error} role="alert">
                    {catalog.detail.error}
                  </p>
                  {entry && (
                    <Button
                      variant="outline"
                      onClick={() => void catalog.inspect(entry)}
                    >
                      重试
                    </Button>
                  )}
                </>
              ) : (
                selected && (
                  <>
                    <SceneDetails
                      selected={selected}
                      employeeName={employeeName}
                      onDeliveries={props.onDeliveries}
                    />
                    {writable && personal && (
                      <EmployeeCapabilityDanger
                        disabled={busy || catalog.uncertain}
                        onRemove={() => setRemoving(personal)}
                      >
                        删除场景
                      </EmployeeCapabilityDanger>
                    )}
                  </>
                )
              )}
            </>
          ) : page === 'source' ? (
            <>
              <div className={css.tabs} role="tablist" aria-label="安装来源">
                {(['github', 'zip'] as const).map((kind) => (
                  <button
                    type="button"
                    key={kind}
                    role="tab"
                    id={`scene-source-${kind}`}
                    aria-controls="scene-source-panel"
                    aria-selected={tab === kind}
                    tabIndex={tab === kind ? 0 : -1}
                    onClick={() => switchTab(kind)}
                    onKeyDown={(event) => {
                      if (
                        ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
                          event.key,
                        )
                      ) {
                        event.preventDefault();
                        const next =
                          event.key === 'Home'
                            ? 'github'
                            : event.key === 'End'
                              ? 'zip'
                              : tab === 'github'
                                ? 'zip'
                                : 'github';
                        switchTab(next);
                        document
                          .getElementById(`scene-source-${next}`)
                          ?.focus();
                      }
                    }}
                  >
                    {kind === 'github' ? 'GitHub 链接' : '压缩包'}
                  </button>
                ))}
              </div>
              <div
                role="tabpanel"
                id="scene-source-panel"
                aria-labelledby={`scene-source-${tab}`}
              >
                {zip ? (
                  <>
                    {file ? (
                      <div className={css.fileRow}>
                        <span>{file.name}</span>
                        {reading && (
                          <span className={css.spinner} aria-hidden="true" />
                        )}
                      </div>
                    ) : (
                      <div
                        className={css.fileDrop}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault();
                          upload(event.dataTransfer.files[0]);
                        }}
                      >
                        <SceneIcon kind="box" />
                        <p>把 .zip 文件拖到这里</p>
                        <Button
                          variant="outline"
                          disabled={reading || busy || catalog.uncertain}
                          onClick={chooseFile}
                        >
                          选择文件
                        </Button>
                      </div>
                    )}
                    <input
                      className={css.fileInput}
                      type="file"
                      ref={fileInput}
                      aria-label="选择 Workflow 压缩包"
                      accept=".zip,application/zip"
                      disabled={reading || busy || catalog.uncertain}
                      onChange={(event) =>
                        upload(event.currentTarget.files?.[0])
                      }
                    />
                    <p className={css.caption}>
                      根目录要有 SKILL.md，压缩包不超过 8 MB。
                    </p>
                  </>
                ) : (
                  <div className={css.field}>
                    <label htmlFor="scene-github-url">仓库链接</label>
                    <input
                      id="scene-github-url"
                      className={css.input}
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="https://github.com/账号/仓库"
                      value={url}
                      readOnly={reading || busy}
                      onChange={(event) => {
                        setUrl(event.target.value);
                        setPreview(undefined);
                        setError('');
                      }}
                    />
                    <p className={css.caption}>
                      目前只支持公开仓库，根目录要有 SKILL.md。
                    </p>
                  </div>
                )}
                {reading && <Reading />}
              </div>
              <section className={css.limits}>
                <h3>文件要求</h3>
                <p>
                  正文不超过 256 KB；资源最多 32 个，每个不超过 128
                  KB，合计不超过 512 KB。压缩包不超过 8 MB。
                </p>
              </section>
            </>
          ) : page === 'confirm' && preview ? (
            <>
              <dl className={css.metadata}>
                <div>
                  <dt>名称</dt>
                  <dd className={css.previewName}>
                    {preview.item.frontmatter.metadata.displayName}
                  </dd>
                </div>
                <div>
                  <dt>版本</dt>
                  <dd>
                    {preview.operation === 'update' ? (
                      <span className={css.versionChange}>
                        <span className={css.pill}>
                          {version(preview.current?.version)}
                        </span>{' '}
                        →{' '}
                        <span className={css.pill}>
                          {version(preview.item.frontmatter.metadata.version)}
                        </span>
                      </span>
                    ) : (
                      version(preview.item.frontmatter.metadata.version)
                    )}
                  </dd>
                </div>
                {preview.operation === 'install' && (
                  <div>
                    <dt>说明</dt>
                    <dd>{preview.item.frontmatter.description}</dd>
                  </div>
                )}
                <div>
                  <dt>来源</dt>
                  <dd>{sceneSourceLabel(preview.source)}</dd>
                </div>
                {preview.operation === 'install' && (
                  <div>
                    <dt>文件</dt>
                    <dd>
                      {preview.files.length} 个
                      {preview.files.some((item) =>
                        item.path.startsWith('scripts/'),
                      )
                        ? '，脚本不会运行'
                        : ''}
                    </dd>
                  </div>
                )}
              </dl>
              {preview.operation === 'update' && (
                <p className={css.updateNote}>
                  新对话会用新版本。已有对话保留已加载内容，再次调用会读取新版。
                </p>
              )}
              {mutationError && (
                <p className={css.error} role="alert">
                  {mutationError}
                </p>
              )}
            </>
          ) : page === 'success' && preview ? (
            <div className={css.success}>
              <span className={css.successMark}>
                <SceneIcon kind="check" />
              </span>
              <h3>
                {preview.operation === 'update' ? '已更新' : '已安装'}“
                {preview.item.frontmatter.metadata.displayName}”
              </h3>
              {preview.operation === 'update' && (
                <p className={css.caption}>
                  已有对话保留已加载内容，再次调用会读取新版。
                </p>
              )}
            </div>
          ) : null}
          {error && (
            <p className={css.error} role="alert">
              {error}
            </p>
          )}
        </div>
        {(page === 'source' || page === 'confirm' || page === 'success') && (
          <footer className={css.footer}>
            {page === 'success' ? (
              <Button variant="primary" onClick={finish}>
                完成
              </Button>
            ) : (
              <>
                <Button variant="outline" disabled={busy} onClick={back}>
                  取消
                </Button>
                {page === 'confirm' ? (
                  <Button
                    variant="primary"
                    disabled={busy || !writable}
                    aria-busy={catalog.busy}
                    onClick={() => void confirm()}
                  >
                    {confirmMutation?.error || confirmMutation?.uncertain
                      ? '重试'
                      : preview?.operation === 'update'
                        ? '确认更新'
                        : '确认安装'}
                  </Button>
                ) : (
                  (!zip || file) && (
                    <>
                      {zip && !reading && (
                        <Button
                          variant="outline"
                          disabled={busy || catalog.uncertain}
                          onClick={chooseFile}
                        >
                          重新选择
                        </Button>
                      )}
                      <Button
                        variant="primary"
                        disabled={
                          reading || busy || !writable || catalog.uncertain
                        }
                        onClick={() => void read()}
                      >
                        {reading ? '正在读取…' : error ? '重试' : '读取'}
                      </Button>
                    </>
                  )
                )}
              </>
            )}
          </footer>
        )}
      </SceneLayer>
      {removing && !catalog.accessUnavailable && (
        <Modal
          open={props.open && mounted}
          headless
          title={`删除“${removing.name}”？`}
          onClose={() => {
            if (!busy) setRemoving(undefined);
          }}
          className={`${css.panel} ${css.confirmation}`}
        >
          <header className={css.header}>
            <h2>删除“{removing.name}”？</h2>
          </header>
          <div className={css.body}>
            <p className={css.description}>
              {employeeName}以后不会再用这个
              Workflow。用过它的对话还能看，但不能继续，要开新对话。
            </p>
            {pending?.kind === 'remove' && pending.error && (
              <p className={css.error} role="alert">
                {pending.error}
              </p>
            )}
          </div>
          <footer className={css.footer}>
            <Button
              variant="outline"
              data-modal-autofocus
              disabled={busy}
              onClick={() => setRemoving(undefined)}
            >
              取消
            </Button>
            <Button
              variant="primary"
              className={css.dangerButton}
              disabled={busy || !writable}
              aria-busy={catalog.busy}
              onClick={() => void remove()}
            >
              {pending?.kind === 'remove' &&
              (pending.error || pending.uncertain)
                ? '重试'
                : '删除'}
            </Button>
          </footer>
        </Modal>
      )}
    </>
  );
}
