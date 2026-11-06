// Isolated real-HTTP adapter fixture. No production route or employee entry.
// Copy below is review-only, explicitly pending in SKILL-HOST-VISIBLE-GAPS.
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { setAppearance } from '../lib/theme/appearance';
import { useThemeSync } from '../components/theme/theme-controller';
import {
  EmployeeSkillLayerDialog,
  EmployeeSkillsHost,
  clearEmployeeSkillWriteContents,
  type EmployeeSkillHostCopy,
  type EmployeeSkillWriteStore,
} from '../app/chatflow/employee-skills-host';
import { skillTestId, skillTestScope } from './employee-skills-host-data';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/dsh-upstream/scrollbar.css';
import '@allrice/ui/tokens.css';
import '../app/styles/base.css';
import '@allrice/ui/styles.css';
import css from './employee-skills-host-page.module.css';

export const skillFixtureCopy: EmployeeSkillHostCopy = {
  loading: '正在读取…',
  catalogError: '技能读取失败，请重试。',
  accessLost: '暂时无法访问这个员工的技能，请返回后重新打开。',
  sourceInvalid: '无法读取这个技能包，请检查根目录的 SKILL.md 和文件限制。',
  sourceLimit: '无法读取这个技能包，请检查根目录的 SKILL.md 和文件限制。',
  sourceConflict: '技能名称已被使用，请选择其它技能包。',
  nameMismatch: '新包的 name 与当前技能不同，不能用于更新。',
  previewInvalid: '技能预览已失效或内容不完整，请重新读取后确认。',
  submissionUnknown: '暂时无法确认操作结果，操作可能已完成。请重试。',
  submissionUnresolved: '暂时无法确认操作结果，操作可能已完成。',
  removalFailed: '技能状态或权限已变化，请刷新后重试。',
  unchanged: { title: '确认更新', message: '和当前内容完全一样，不用更新。' },
  disabledBindingLabel: '已停用',
};

setAppearance(
  new URLSearchParams(location.search).get('theme') === 'dark'
    ? 'dark'
    : 'light',
);

function App() {
  useThemeSync('/chatflow');
  const [instanceId, setInstanceId] = useState(skillTestScope.instanceId);
  const [owner, setOwner] = useState(
    new URLSearchParams(location.search).get('shared') !== '1',
  );
  const [viewer, setViewer] = useState(skillTestScope.scopeId);
  const [open, setOpen] = useState(true);
  const [notice, setNotice] = useState('');
  const writes = useRef<EmployeeSkillWriteStore>(new Map());
  const scope = {
    ...skillTestScope,
    instanceId,
    scopeId: viewer,
    headers: { 'X-Synthetic-Viewer': viewer },
  };
  const employeeName = instanceId === skillTestId(7) ? 'Rice' : '流程哥';
  return (
    <main className={css.fixture}>
      <aside className={css.toolbar} aria-label="宿主审阅夹具">
        <p>Skill 独立宿主候选 · 未挂生产入口 · 合成 HTTP · 补充文案待确认</p>
        <label>
          员工{' '}
          <select
            aria-label="夹具员工"
            value={instanceId}
            onChange={(event) => setInstanceId(event.target.value)}
          >
            <option value={skillTestId(7)}>Rice</option>
            <option value={skillTestId(8)}>流程哥</option>
          </select>
        </label>
        <label>
          <input
            aria-label="夹具本人视图"
            type="checkbox"
            checked={owner}
            onChange={(event) => setOwner(event.target.checked)}
          />
          本人视图
        </label>
        <label>
          账号{' '}
          <select
            aria-label="夹具账号"
            value={viewer}
            onChange={(event) => {
              clearEmployeeSkillWriteContents(writes.current, () => true);
              setViewer(event.target.value);
            }}
          >
            <option value={skillTestScope.scopeId}>本人样例</option>
            <option value="other-synthetic">另一账号样例</option>
          </select>
        </label>
        <button type="button" onClick={() => setOpen(!open)}>
          {open ? '关闭夹具详情' : '重新打开夹具详情'}
        </button>
      </aside>
      {open && (
        <EmployeeSkillsHost
          scope={scope}
          ownerView={owner}
          employeeName={employeeName}
          writes={writes.current}
          copy={skillFixtureCopy}
          onNotice={setNotice}
        >
          {({ section, layer }) => (
            <>
              {!layer && (
                <article className={css.card}>
                  <header>
                    <h2>AI 员工详情</h2>
                    <p>{employeeName}</p>
                  </header>
                  <div className={css.body}>{section}</div>
                </article>
              )}
              <EmployeeSkillLayerDialog layer={layer} />
            </>
          )}
        </EmployeeSkillsHost>
      )}
      {notice && (
        <output role="status" aria-label="夹具回执提示">
          {notice}
        </output>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
