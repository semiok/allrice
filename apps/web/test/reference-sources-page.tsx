import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/dsh-upstream/scrollbar.css';
import '@allrice/ui/tokens.css';
import '../app/styles/base.css';
import { createRoot } from 'react-dom/client';
import { useRef, useState } from 'react';
import { ChatCitationSchema, type ChatCitation } from '@allrice/contracts';
import { ChatTranscript } from '../app/chatflow/chat-transcript';
import { ArtifactWorkbench } from '../app/chatflow/artifact-workbench';
import {
  referenceCitationAddress,
  type ReadReferenceCitation,
} from '../app/chatflow/reference-sources';
import { applyTheme } from '../lib/theme/theme';

const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const checksum = `sha256:${'a'.repeat(64)}`;
const reference = {
  sourceId: id(1),
  revisionId: id(2),
  revision: 1,
  fileName: '秋冬新品资料.zip',
  purpose: '秋冬新品资料',
  digest: checksum,
  checksum,
  ownership: { scope: 'company', organizationId: id(3) },
};
const member = {
  entryId: `entry:${checksum}`,
  path: '文案/上新说明.md',
  checksum,
  sizeBytes: 86,
  mediaType: 'text/markdown',
};
const image = {
  attachmentId: checksum,
  mediaType: 'image/png',
  bytes: 100,
  width: 20,
  height: 20,
};
const params = new URLSearchParams(location.search);
applyTheme(params.get('theme') === 'dark' ? 'dark' : 'light');
const long = params.has('long');
const empty = params.has('empty');
const citations = [
  {
    type: 'reference',
    id: id(11),
    label: '秋冬新品资料.zip',
    referenceLabel: 'R1',
    reference,
    locator: {
      kind: 'archive_directory',
      directoryChecksum: checksum,
      pageChecksum: checksum,
      startEntryIndex: 0,
      endEntryIndex: empty ? 0 : 4,
      totalEntries: empty ? 0 : 4,
    },
  },
  {
    type: 'reference',
    id: id(12),
    label: '文案/上新说明.md',
    referenceLabel: 'R2',
    reference,
    locator: {
      kind: 'archive_member_text',
      member: {
        ...member,
        path: long ? '产品资料/'.repeat(40) + '上新说明.md' : member.path,
      },
      textChecksum: checksum,
      start: 0,
      end: 86,
      locations: [],
    },
  },
  {
    type: 'reference',
    id: id(13),
    label: '产品图/主图.png',
    referenceLabel: 'R3',
    reference,
    locator: {
      kind: 'image',
      member: { ...member, path: '产品图/主图.png', mediaType: 'image/png' },
      sourceChecksum: checksum,
      image,
    },
  },
  {
    type: 'reference',
    id: id(14),
    label: '秋冬新品主图.png',
    referenceLabel: 'R4',
    reference: { ...reference, fileName: '秋冬新品主图.png' },
    locator: { kind: 'image', member: null, sourceChecksum: checksum, image },
  },
].map((c) => ChatCitationSchema.parse(c)) as ReadReferenceCitation[];
const legacy = ChatCitationSchema.parse({
  type: 'knowledge',
  id: id(15),
  label: '品牌语气规范',
  knowledgeRevisionId: id(2),
  documentId: id(16),
  sourceKind: 'managed',
  scope: 'workspace',
  locator: { sourceRef: 'brand', chunk: 0, start: 0, end: 30 },
  updatedAt: '2026-11-15T00:00:00Z',
  score: 1,
  reference,
  referenceLabel: 'R5',
});

function App() {
  const column = useRef<HTMLDivElement>(null);
  const [request, setRequest] = useState<{
    kind: 'reference';
    revision: number;
    id: string;
    title: string;
  }>();
  const [open, setOpen] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [sent, setSent] = useState(false);
  const refs: ChatCitation[] = params.has('legacy') ? [legacy] : citations;
  const onOpen = (citation: ReadReferenceCitation) => {
    setRequest((previous) => ({
      kind: 'reference',
      id: referenceCitationAddress(citation.id),
      title: `[${citation.referenceLabel}] ${citation.label}`,
      revision: (previous?.revision ?? 0) + 1,
    }));
    setOpen(true);
  };
  return (
    <main style={{ display: 'flex', height: '100dvh', minWidth: 0 }}>
      <section
        ref={column}
        style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: 24 }}
      >
        <h1 style={{ fontSize: 18 }}>R4c · 对话来源</h1>
        <ChatTranscript
          atBottom
          employeeName="Rice"
          messages={[
            {
              id: id(20),
              role: 'user',
              status: 'completed',
              runId: null,
              createdAt: '2026-11-15T00:00:00Z',
              content: { text: '请查看这些资料的来源。' },
            },
            {
              id: id(21),
              role: 'assistant',
              status: 'completed',
              runId: id(22),
              createdAt: '2026-11-15T00:00:01Z',
              content: {
                text: '已读取的资料来源如下。目录读取不代表包内文件已读取。',
                citations: refs,
              },
            },
          ]}
          runTraces={{ [id(22)]: { status: 'loaded', events: [] } }}
          runViews={{}}
          tenantHeaders={{}}
          workspaceId={id(3)}
          transcriptColumn={column}
          onLoadRunTrace={() => {}}
          onRecoverRun={() => {}}
          onScrollToBottom={() => {}}
          onOpenReference={() =>
            (document.documentElement.dataset.legacyOpened = 'true')
          }
          onOpenReferenceCitation={onOpen}
        />
        <button onClick={() => setRevoked(true)}>模拟后来失权</button>
        {revoked && <p role="alert">引用失败，文件可能被调整权限或移除</p>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSent(true);
          }}
        >
          <textarea aria-label="给 Rice 发消息" />
          <button type="submit">发送</button>
        </form>
        {sent && <p role="status">已发送后续问题</p>}
      </section>
      <ArtifactWorkbench
        desktop={innerWidth >= 800}
        open={open}
        width={520}
        narrow={innerWidth < 800}
        dockScope="r4c-test"
        sessionId={id(23)}
        workspaceId={id(3)}
        tenantHeaders={{}}
        moduleRequest={request}
        referenceCitations={citations}
        artifacts={[]}
        selectedId={null}
        nextCursor={null}
        listError=""
        listLoading={false}
        onSelect={() => {}}
        onClose={() => setOpen(false)}
        onReload={async () => {}}
        renderModule={() => <p>企业资料入口</p>}
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
