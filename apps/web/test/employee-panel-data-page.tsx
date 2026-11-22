// Test-only business port substitute. The panels, preview and publication form
// are product components; no backend identity, storage or delivery is claimed.
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/dsh-upstream/scrollbar.css';
import '@allrice/ui/tokens.css';
import '../app/styles/base.css';
import '../app/styles/focus.css';
import '@allrice/ui/styles.css';
import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { Context } from '@deepseek-ai/cordis';
import { bindEmployeePanels } from '../../../packages/dsh-web-composition/src/employee-panels';
import type { EmployeePanelsPort } from '../../../packages/dsh-web-composition/src/employee-panels-port';
import { syntheticPanelSnapshot } from '../../../packages/dsh-web-composition/tests/fixtures/employee-panels/presentation';
import type {
  ReferenceRevision,
  WorkbenchDeliverable,
} from '@allrice/contracts';
import {
  createEmployeePanelDataClient,
  type EmployeePanelDataMethod,
} from '../lib/chatflow/employee-panel-data';
import { uploadPersonalDeliverable } from '../lib/chatflow/employee-panel-upload';
import { EnterpriseMaterialsPanel } from '../app/chatflow/enterprise-materials-panel';
import { WorkbenchFilesPanel } from '../app/chatflow/workbench-files-panel';
import { WorkbenchDeliverablePreview } from '../app/chatflow/workspace-file-preview';
import {
  ReferencePublicationDialog,
  type ReferencePublicationTarget,
} from '../app/chatflow/reference-publication-dialog';
import { applyTheme } from '../lib/theme/theme';
import {
  createSyntheticPanelsData,
  panelsEmployee,
  panelsViewer,
  panelsWorkspace,
  uid,
} from '../../../packages/dsh-web-composition/tests/fixtures/employee-panels/data';

export type PanelDataState =
  'list' | 'empty' | 'loading' | 'error' | 'denied' | 'unbound' | 'longname';
const sample = createSyntheticPanelsData();
let files = structuredClone(sample.files.files);
const otherEmployee = uid(8);
files[2]!.sources[0]!.employeeInstanceId = otherEmployee;
files[2]!.sources[0]!.employeeName = 'Mika';
files[2]!.favorite = true;
let references = structuredClone(sample.references);
let state: PanelDataState = 'list';
let serial = 850;
const calls: {
  method: EmployeePanelDataMethod;
  input: unknown;
  aborted: boolean;
}[] = [];
const used: unknown[] = [];
const writes = new Map<string, { sourceId: string; revisionId: string }>();
const uploads = new Map<string, { objectId: string }>();
const bytes = new Map(files.map((file) => [file.objectId, '固定原件内容']));
const copies = new Map<string, string>();
const headers = {};

async function call(
  name: EmployeePanelDataMethod,
  input: unknown,
  signal: AbortSignal,
) {
  const event = { method: name, input: structuredClone(input), aborted: false };
  calls.push(event);
  signal.addEventListener(
    'abort',
    () => {
      event.aborted = true;
    },
    { once: true },
  );
  if (state === 'loading')
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
    });
  signal.throwIfAborted();
  if (state === 'denied')
    throw Object.assign(Error('当前权限已撤销或不允许此操作。'), {
      status: 403,
    });
  if (state === 'error') throw Error('合同替身读取失败，请重试。');
}
const bound = createEmployeePanelDataClient({
  async queryMaterials(input, signal) {
    await call('queryMaterials', input, signal);
    const q = input.query;
    const visible =
      state === 'empty'
        ? []
        : references.filter(
            (r) =>
              r.status === 'active' &&
              (!q.sourceId || q.sourceId === r.sourceId) &&
              (q.category === 'all' ||
                (q.category === 'mine'
                  ? r.publication?.publisherId === panelsViewer
                  : r.publication?.audience.scope === q.category)) &&
              (!q.query ||
                `${r.fileName} ${r.purpose} 销售正文`.includes(q.query)),
          );
    return {
      ...sample.catalog,
      references: visible,
      fullTextCoverage: { ready: visible.length, unavailable: 0 },
      matches: q.query
        ? visible.map((r) => ({
            revisionId: r.revisionId,
            content: '销售正文与统计口径',
            start: 0,
            end: 10,
            locations: [],
            warnings: [],
          }))
        : [],
    };
  },
  async publicationOptions(input, signal) {
    await call('publicationOptions', input, signal);
    return { viewerId: panelsViewer, options: sample.options };
  },
  async selectMaterial(input, signal) {
    await call('selectMaterial', input, signal);
    return sample.selection(input.revisionId);
  },
  async listDeliverables(input, signal) {
    await call('listDeliverables', input, signal);
    const visible =
      state === 'empty'
        ? []
        : files.filter(
            (file) =>
              (!input.objectId || file.objectId === input.objectId) &&
              (!input.employeeInstanceId ||
                file.sources.some(
                  (s) => s.employeeInstanceId === input.employeeInstanceId,
                )) &&
              (!input.query || file.fileName.includes(input.query)) &&
              (input.category === 'all' ||
                (input.category === 'favorite'
                  ? file.favorite
                  : file.category === input.category)),
          );
    return {
      ...sample.files,
      files: visible,
      employees: [
        ...sample.files.employees,
        { id: otherEmployee, name: 'Mika' },
      ],
      quotableFileIds: visible.map((f) => f.objectId),
    };
  },
  async favorite(input, signal) {
    await call('favorite', input, signal);
    files = files.map((f) =>
      f.objectId === input.objectId
        ? { ...f, favorite: input.body.favorite }
        : f,
    );
    return {
      viewerId: panelsViewer,
      objectId: input.objectId,
      favorite: input.body.favorite,
    };
  },
  async captureReference(input, signal) {
    await call('captureReference', input, signal);
    return {
      reference:
        sample.references[
          files.findIndex((f) => f.objectId === input.objectId)
        ]!,
    };
  },
  async readPreparedReference(input, signal) {
    await call('readPreparedReference', input, signal);
    return references.find((r) => r.revisionId === input.revisionId)!;
  },
  async previewDeliverable(input, signal) {
    await call('previewDeliverable', input, signal);
    return textPage(input.offset);
  },
  async previewMaterial(input, signal) {
    await call('previewMaterial', input, signal);
    return textPage(input.offset);
  },
  async downloadDeliverable(input, signal) {
    await call('downloadDeliverable', input, signal);
    return new Blob([bytes.get(input.objectId)!], { type: 'text/plain' });
  },
  async downloadMaterial(input, signal) {
    await call('downloadMaterial', input, signal);
    return new Blob([copies.get(input.revisionId) ?? '固定资料内容'], {
      type: 'text/plain',
    });
  },
  async publishFile(input, signal) {
    await call('publishFile', input, signal);
    const prior = writes.get(input.requestId);
    if (prior) return prior;
    const saved = { sourceId: uid(serial++), revisionId: uid(serial++) };
    copies.set(saved.revisionId, bytes.get(input.objectId)!);
    files = files.map((f) =>
      f.objectId === input.objectId
        ? { ...f, publication: { ...saved, audience: input.audience } }
        : f,
    );
    references.push({
      ...sample.references[0]!,
      ...saved,
      fileName: files.find((f) => f.objectId === input.objectId)!.fileName,
      purpose: input.purpose,
      publication: {
        ...sample.references[0]!.publication!,
        audience: input.audience,
        origin: 'file',
      },
    });
    writes.set(input.requestId, saved);
    return saved;
  },
  async publishUpload(input, signal) {
    await call('publishUpload', input, signal);
    const saved = { sourceId: uid(serial++), revisionId: uid(serial++) };
    references.push({
      ...sample.references[0]!,
      ...saved,
      fileName: input.fileName,
      purpose: input.purpose,
      publication: {
        ...sample.references[0]!.publication!,
        audience: input.audience,
        origin: 'upload',
      },
    });
    return saved;
  },
  async changePublication(input, signal) {
    await call('changePublication', input, signal);
    references = references.map((r) =>
      r.sourceId === input.sourceId ? { ...r, status: 'archived' } : r,
    );
    return { sourceId: input.sourceId };
  },
  async changeSource(input, signal) {
    await call('changeSource', input, signal);
    return { sourceId: input.sourceId };
  },
  async uploadDeliverable(input, signal) {
    await call('uploadDeliverable', input, signal);
    const prior = uploads.get(input.requestId);
    if (prior) return prior;
    const objectId = uid(serial++);
    const count = files.filter(
      (f) =>
        f.fileName === input.fileName ||
        f.fileName.startsWith(input.fileName + ' ('),
    ).length;
    files.push({
      ...sample.files.files[0]!,
      objectId,
      fileName: input.fileName + (count ? ` (${count + 1})` : ''),
      category: 'upload',
      origin: 'user-upload',
      sources: [],
      favorite: false,
      publication: null,
    });
    bytes.set(objectId, atob(input.contentBase64));
    const result = { objectId };
    uploads.set(input.requestId, result);
    return result;
  },
});
function textPage(offset = 1) {
  return {
    kind: 'text',
    mediaType: 'text/plain',
    text:
      offset === 1
        ? '销售正文与统计口径\n这是固定文件第一页。'
        : '这是固定文件末页。',
    offset,
    lines: 2,
    eof: offset > 1,
  } as const;
}

export interface PanelDataFixture {
  setState(value: PanelDataState): void;
  setKind(value: 'files' | 'materials'): void;
  mutateOriginal(): void;
  evidence(): {
    calls: typeof calls;
    used: unknown[];
    files: WorkbenchDeliverable[];
    copies: [string, string][];
    writes: [string, { sourceId: string; revisionId: string }][];
  };
}
declare global {
  interface Window {
    __panelDataFixture: PanelDataFixture;
  }
}

function Fixture() {
  const [kind, setKind] = useState<'files' | 'materials'>('files');
  const [revision, setRevision] = useState(0);
  const [opened, setOpened] = useState<string | null>(null);
  const [publication, setPublication] =
    useState<ReferencePublicationTarget | null>(null);
  const [error, setError] = useState('');
  const uploadInput = useRef<HTMLInputElement>(null);
  const client = state === 'unbound' ? unbound : bound;
  const common = {
    ownerKey: `substitute/${revision}`,
    viewerId: panelsViewer,
    workspaceId: panelsWorkspace,
    sessionId: uid(7),
    headers,
    active: true,
    dataClient: client,
  };
  const onUse = (reference: unknown) => {
    used.push(reference);
  };
  const onSaved = () => {
    setPublication(null);
    window.dispatchEvent(new Event('allrice:workbench-files-changed'));
  };
  useEffect(() => {
    window.__panelDataFixture = {
      setState(value) {
        state = value;
        setOpened(null);
        setPublication(null);
        setRevision((n) => n + 1);
      },
      setKind(value) {
        setOpened(null);
        setKind(value);
      },
      mutateOriginal() {
        bytes.set(uid(300), '后续另存的内容');
      },
      evidence: () => ({
        calls,
        used,
        files,
        copies: [...copies],
        writes: [...writes],
      }),
    };
  }, []);
  return (
    <>
      <nav aria-label="测试控制（合同替身）">
        <Button
          onClick={() => {
            setOpened(null);
            setKind('files');
          }}
        >
          交付成果
        </Button>
        <Button
          onClick={() => {
            setOpened(null);
            setKind('materials');
          }}
        >
          企业资料
        </Button>
        <Button onClick={() => uploadInput.current?.click()}>
          现有上传入口合同替身
        </Button>
        <input
          ref={uploadInput}
          type="file"
          hidden
          aria-label="上传个人成果"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file)
              void uploadPersonalDeliverable(
                client,
                {
                  workspaceId: panelsWorkspace,
                  requestId: crypto.randomUUID(),
                  file,
                },
                new AbortController().signal,
              ).catch((cause: Error) => setError(cause.message));
            event.target.value = '';
          }}
        />
      </nav>
      {error && <p role="alert">{error}</p>}
      <main
        aria-label="资料成果真实组件"
        style={{
          width: 'min(100%, 420px)',
          height: 'calc(100vh - 72px)',
          margin: '0 auto',
          background: 'var(--dsw-alias-bg-base)',
        }}
      >
        {kind === 'materials' ? (
          <EnterpriseMaterialsPanel
            {...common}
            key={common.ownerKey + kind}
            onUse={onUse}
            onUpload={() => setPublication({ kind: 'upload' })}
            onManage={(reference: ReferenceRevision, action) =>
              setPublication({ kind: action, reference })
            }
          />
        ) : opened ? (
          <WorkbenchDeliverablePreview
            {...common}
            key={common.ownerKey + opened}
            scope={common.ownerKey}
            objectId={opened}
            tenantHeaders={headers}
            onBack={() => setOpened(null)}
            onPublish={(file) => setPublication({ kind: 'file', file })}
            fileActions={{ sessionId: uid(7), onUse }}
          />
        ) : (
          <WorkbenchFilesPanel
            {...common}
            key={common.ownerKey + kind}
            refreshKey={String(revision)}
            currentEmployee={{ id: panelsEmployee, name: 'Rice' }}
            onUse={onUse}
            onOpen={(file) => setOpened(file.objectId)}
            onPublish={(file) => setPublication({ kind: 'file', file })}
          />
        )}
      </main>
      {publication && (
        <ReferencePublicationDialog
          workspaceId={panelsWorkspace}
          viewerId={panelsViewer}
          headers={headers}
          dataClient={client}
          options={sample.options}
          target={publication}
          onClose={() => setPublication(null)}
          onSaved={onSaved}
        />
      )}
    </>
  );
}
// Exercise the formal default binder, without a resolver. The existing unbound
// matrix opens both real panels and asserts zero legacy HTTP requests.
const unboundOwner = new Context();
const unboundSession = uid(7) as Parameters<
  EmployeePanelsPort['getSnapshot']
>[0];
const unboundSnapshot = syntheticPanelSnapshot(
  'default-unbound',
  'list',
  () => {},
);
await bindEmployeePanels(unboundOwner, {
  getSnapshot: (id) => (id === unboundSession ? unboundSnapshot : null),
  subscribe: () => () => {},
});
const unbound =
  unboundOwner.allriceEmployeePanels.port.getSnapshot(unboundSession)!.files
    .dataClient!;
window.addEventListener(
  'pagehide',
  () => {
    void unboundOwner.fiber.dispose();
  },
  { once: true },
);
applyTheme(
  new URLSearchParams(location.search).get('theme') === 'dark'
    ? 'dark'
    : 'light',
);
createRoot(document.getElementById('root')!).render(<Fixture />);
