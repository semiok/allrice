// Synthetic component fixture only. No production route or memory HTTP adapter.
import { createRoot } from 'react-dom/client';
import { useRef, useState } from 'react';
import {
  EmployeeMemorySidebar,
  type MemorySidebarDetail,
  type MemorySidebarInput,
  type MemorySidebarRow,
} from '../app/chatflow/employee-memory-sidebar';
import { setAppearance } from '../lib/theme/appearance';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '@allrice/ui/tokens.css';
import '../app/styles/base.css';
import '@allrice/ui/styles.css';

const query = new URLSearchParams(location.search);
setAppearance(query.get('theme') === 'dark' ? 'dark' : 'light');
const at = new Date().toISOString();
const before = new Date(Date.now() - 86_400_000 * 3).toISOString();
const sample = (
  id: string,
  state: 'active' | 'pending',
  details: string | null,
): MemorySidebarDetail => ({
  id,
  state,
  summary:
    id === 'p1'
      ? '周报统一用表格，先写结论再写数据'
      : id === 'a1'
        ? '报价规则：含税、PDF、文件名带客户和日期'
        : '回复先给结论，300 字以内',
  details,
  capturedAt: before,
  updatedAt: before,
});
const initial = [
  sample('p1', 'pending', '先给结论。详细表格保留原始数据。'),
  sample('a1', 'active', '金额超过 5 万先发给我看，再发客户。'),
  sample('a2', 'active', null),
];
function Fixture() {
  const [target, setTarget] = useState('rice');
  const [rows, setRows] = useState<MemorySidebarDetail[]>(
    query.has('empty')
      ? []
      : query.has('full')
        ? [
            initial[0]!,
            ...Array.from({ length: 100 }, (_, i) => ({
              ...initial[1]!,
              id: 'active-' + i,
              summary: '测试记忆 ' + i,
            })),
          ]
        : initial,
  );
  const [operations, setOperations] = useState<unknown[]>([]);
  const release = useRef<(() => void) | null>(null);
  async function record(action: string, payload: unknown) {
    setOperations((value) => [...value, { action, payload }]);
    if (query.get('hold') === action)
      await new Promise<void>((resolve) => {
        release.current = resolve;
      });
    if (query.get('reject') === action)
      throw Error('Synthetic adapter rejection');
  }
  async function read(row: MemorySidebarRow) {
    await record('read', row.id);
    return rows.find((item) => item.id === row.id)!;
  }
  async function confirm(row: MemorySidebarRow) {
    await record('confirm', row.id);
    setRows((value) =>
      value.map((item) =>
        item.id === row.id ? { ...item, state: 'active', updatedAt: at } : item,
      ),
    );
  }
  async function remove(row: MemorySidebarRow) {
    await record('delete', row.id);
    setRows((value) => value.filter((item) => item.id !== row.id));
  }
  async function save(input: MemorySidebarInput, row: MemorySidebarRow | null) {
    await record('save', { input, id: row?.id ?? null });
    setRows((value) => [
      ...value.filter((item) => item.id !== row?.id),
      {
        ...input,
        id: row?.id ?? 'new-memory',
        state: 'active',
        capturedAt: row?.capturedAt ?? at,
        updatedAt: at,
      },
    ]);
  }
  return (
    <>
      <div style={{ padding: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <span>独立组件测试夹具 · 未接产品 API</span>
        <button type="button" id="release" onClick={() => release.current?.()}>
          释放测试回执
        </button>
        <button
          type="button"
          id="switch-target"
          onClick={() => {
            setTarget('flow');
            setRows([
              { ...initial[2]!, id: 'flow-memory', summary: '另一员工的记忆' },
            ]);
          }}
        >
          切换测试员工
        </button>
      </div>
      <div
        style={{
          width: 'min(440px,100%)',
          height: 'calc(100dvh - 100px)',
          marginLeft: 'auto',
          borderLeft: '1px solid var(--ar-border)',
        }}
      >
        <EmployeeMemorySidebar
          targetKey={target}
          employeeName={target === 'rice' ? 'Rice' : 'Flow'}
          rows={rows}
          onReload={() =>
            setOperations((value) => [...value, { action: 'reload' }])
          }
          onReadDetail={read}
          onConfirm={confirm}
          onDelete={remove}
          onSave={save}
        />
      </div>
      <output aria-label="操作记录" style={{ display: 'none' }}>
        {JSON.stringify(operations)}
      </output>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
