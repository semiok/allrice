import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminShell } from '../components/admin/admin-shell';
import {
  AdminButton,
  AdminDialog,
  AdminMenu,
} from '../components/admin/admin-ui';
import { CompanyDeliverableLibrary } from '../app/runtime-console/company-deliverables';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import { RuntimeSkillGroup } from '../app/runtime-console/runtime-skill-group';
import {
  aggregateRuntimeTimelineEvents,
  type RuntimeTimelineEvent,
} from '../app/runtime-console/runtime-timeline';
import runtimeStyles from '../app/runtime-console/runtime-console.module.css';

function SkillTimelineFixture() {
  const [bundled, setBundled] = useState(false);
  const [failed, setFailed] = useState(false);
  const names = [
    'browser-research',
    'business-reconciliation',
    'governed-memory',
    'market-data',
    'office',
    'operations-review',
    'project-development',
    'research-synthesis',
    'scientific-analysis',
    'web-research',
    'wechat-research',
    'workspace-briefing',
  ];
  const records: RuntimeTimelineEvent[] = names.map((name, index) => ({
    id: `run:${index}`,
    key: `run:${index}`,
    runId: 'run',
    sequence: index,
    kind: 'context',
    status: failed && index === 5 ? 'failed' : 'completed',
    title: failed && index === 5 ? 'Skill 不可用' : 'Skill 已就绪',
    detail: name,
    occurredAt: '2026-10-15T06:12:14.000Z',
  }));
  const events = bundled
    ? [
        {
          ...records[0]!,
          title: 'Skill 已就绪 · 13 个',
          detail: names.join('、'),
        },
      ]
    : records;
  return (
    <AdminShell items={[]}>
      <section className={runtimeStyles.detail}>
        <AdminButton onClick={() => setFailed(!failed)}>
          切换失败记录
        </AdminButton>
        <AdminButton
          onClick={() => {
            setFailed(false);
            setBundled(!bundled);
          }}
        >
          切换汇总格式
        </AdminButton>
        <ol className={runtimeStyles.eventList}>
          {aggregateRuntimeTimelineEvents(events).map((item) =>
            item.type === 'group' ? (
              <RuntimeSkillGroup key={item.key} item={item} />
            ) : null,
          )}
        </ol>
      </section>
    </AdminShell>
  );
}

function DesignFixture() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState('组织管理');
  return (
    <>
      <p data-outside>员工前台</p>
      <AdminShell
        items={(['组织管理', 'AI 员工', '公司看板', '平台设置'] as const).map(
          (label) => ({
            label,
            icon: 'organization',
            active: view === label,
            onSelect: () => setView(label),
          }),
        )}
      >
        <section style={{ padding: 24 }}>
          <h1>{view}</h1>
          <AdminButton variant="primary" onClick={() => setOpen(true)}>
            添加员工
          </AdminButton>
          <AdminMenu label="员工操作">
            <AdminButton>编辑员工</AdminButton>
          </AdminMenu>
          {open && (
            <AdminDialog
              title="添加员工"
              busy={busy}
              onClose={() => setOpen(false)}
            >
              <form onSubmit={(event) => event.preventDefault()}>
                <label>
                  姓名
                  <input name="name" />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={busy}
                    onChange={(event) => setBusy(event.target.checked)}
                  />
                  提交中
                </label>
                <AdminButton type="submit">保存员工</AdminButton>
              </form>
            </AdminDialog>
          )}
        </section>
      </AdminShell>
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  new URLSearchParams(window.location.search).has('company-files') ? (
    <AdminShell items={[]}>
      <section style={{ padding: 24 }}>
        <CompanyDeliverableLibrary
          organizationId="00000000-0000-4000-8000-000000000001"
          scopeQuery="fixture=1"
        />
      </section>
    </AdminShell>
  ) : new URLSearchParams(window.location.search).has('skills') ? (
    <SkillTimelineFixture />
  ) : (
    <DesignFixture />
  ),
);
