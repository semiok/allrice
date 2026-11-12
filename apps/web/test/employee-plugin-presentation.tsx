// Controlled presentation fixture only: no employee plugin API or runtime.
import { useState } from 'react';
import {
  EmployeeCapabilityDetailsHeader,
  EmployeeCapabilityEmpty,
  EmployeeCapabilityRow,
  EmployeePluginDetails,
  EmployeePluginSection,
} from '../app/chatflow/employee-capability-presentation';
import capabilityCss from '../app/chatflow/employee-capability-presentation.module.css';
import css from './employee-skills-section-page.module.css';

export function EmployeePluginPresentationFixture() {
  const [host, setHost] = useState('sidebar');
  const [detail, setDetail] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [removed, setRemoved] = useState(0);
  const [canAdd, setCanAdd] = useState(true);
  const [added, setAdded] = useState(0);
  const backLabel = host === 'sidebar' ? '返回能力列表' : '返回员工详情';
  const plugin = {
    id: 'controlled-plugin',
    name: '品牌内容',
    description: '按品牌规范准备内容',
    href: `${location.origin}/plugin-fixture?employee=Rice`,
  };
  return (
    <main className={css.candidate}>
      <aside className={css.toolbar} aria-label="插件展示夹具">
        <p>受控插件展示 · 未接员工目录、绑定或插件后台</p>
        <select
          aria-label="插件展示宿主"
          value={host}
          onChange={(event) => setHost(event.target.value)}
        >
          <option value="sidebar">能力侧栏</option>
          <option value="employee">员工详情</option>
        </select>
        <label>
          <input
            type="checkbox"
            checked={empty}
            onChange={(event) => setEmpty(event.target.checked)}
          />
          空态
        </label>
        <label>
          <input
            type="checkbox"
            checked={disabled}
            onChange={(event) => setDisabled(event.target.checked)}
          />
          禁用打开
        </label>
        <label>
          <input
            type="checkbox"
            checked={canAdd}
            onChange={(event) => setCanAdd(event.target.checked)}
          />
          提供添加操作
        </label>
      </aside>
      <article
        className={css.card}
        style={{ maxWidth: host === 'sidebar' ? 520 : 920 }}
      >
        <div
          role="region"
          aria-label={host === 'sidebar' ? '受控能力侧栏' : '受控员工详情'}
          className={capabilityCss.detailContainer}
        >
          {detail ? (
            <EmployeePluginDetails
              {...plugin}
              version="v1.0.0"
              employeeName="Rice"
              backLabel={backLabel}
              onBack={() => setDetail(false)}
              onRemove={() => setRemoved((count) => count + 1)}
              disabled={disabled}
            />
          ) : (
            <div className={css.body}>
              <EmployeePluginSection
                headingId="controlled-plugins"
                plugins={empty ? [] : [plugin]}
                onDetails={() => setDetail(true)}
                onAdd={
                  canAdd ? () => setAdded((count) => count + 1) : undefined
                }
              />
              <div style={{ marginTop: 28 }} aria-label="受控工作场景参照">
                {empty ? (
                  <EmployeeCapabilityEmpty
                    title="还没有场景"
                    icon={
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M3 7h18v14H3z" />
                      </svg>
                    }
                  />
                ) : (
                  <div className={capabilityCss.list}>
                    <EmployeeCapabilityRow
                      name="写周报"
                      description="汇总本周进展、风险和下一步"
                      version="v1.2.0"
                      onOpen={() => {}}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        <div
          aria-label="受控开始工作参照"
          className={capabilityCss.detailContainer}
        >
          <EmployeeCapabilityDetailsHeader
            title="样式参照"
            backLabel="夹具返回"
            onBack={() => {}}
            onStart={() => {}}
            startDisabled={disabled}
          />
        </div>
      </article>
      <output className={css.events} aria-label="插件展示回调">
        {removed}
      </output>
      <output className={css.events} aria-label="插件添加回调">
        {added}
      </output>
    </main>
  );
}
