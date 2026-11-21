import {
  EmployeeCapabilityHeading,
  EmployeeCapabilityRow,
} from '../../../../../apps/web/app/chatflow/employee-capability-presentation';
import { EmployeeSkillsSection } from '../../../../../apps/web/app/chatflow/employee-skills-section';
import type { EmployeePanelsSnapshot } from '../../../src/employee-panels-port';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import {
  createSyntheticPanelsData,
  panelsEmployee,
  panelsViewer,
  panelsWorkspace,
  uid,
  type PanelsState,
} from './data';
import './presentation.css';

export const syntheticMainKey =
  'synthetic-employee-capability-main' as MainPanelId;

/** Pure synthetic props composition. Original component props remain the type
 * authority; this fixture does not reproduce ChatflowClient or BFF controllers. */
export function syntheticPanelSnapshot(
  scopeKey: string,
  state: PanelsState,
  event: (name: string) => void,
  resolveMain: (
    signal: AbortSignal,
  ) => Promise<MainPanelId | null> = async () => syntheticMainKey,
): EmployeePanelsSnapshot {
  const data = createSyntheticPanelsData(state);
  const common = {
    ownerKey: scopeKey,
    workspaceId: panelsWorkspace,
    viewerId: panelsViewer,
    sessionId: uid(7),
    headers: {},
  };
  return {
    scopeKey,
    filesUnread: 5,
    materials: {
      ...common,
      onUpload: () => event('synthetic-upload-intent'),
      onManage: () => event('synthetic-material-management-intent'),
    },
    files: {
      ...common,
      refreshKey: state,
      currentEmployee: { id: panelsEmployee, name: 'Rice' },
      employees: [{ id: panelsEmployee, name: 'Rice' }],
      onOpen: () => event('synthetic-file-open-intent'),
      onRead: () => event('synthetic-files-read'),
      onPublish: () => event('synthetic-publication-intent'),
    },
    experience: {
      targetKey: scopeKey,
      employeeName: 'Rice',
      rows: data.memories,
      loading: state === 'loading',
      error: state === 'denied' ? '无权访问' : undefined,
      onReload: () => event('synthetic-memory-reload'),
      onReadDetail: async (row, signal) => {
        signal.throwIfAborted();
        const record = data.memories.find((item) => item.id === row.id);
        if (!record) throw Error('Unknown synthetic memory');
        return record;
      },
      onConfirm: async () => {
        event('synthetic-memory-confirm-intent');
      },
      onDelete: async () => {
        event('synthetic-memory-delete-intent');
      },
      onSave: async () => {
        event('synthetic-memory-save-intent');
      },
    },
    workflow: (actions) => ({
      employeeName: 'Rice',
      scopeKey,
      onRead: () => event('synthetic-capabilities-read'),
      showSkills: false,
      children: (
        <div className="rev2-capability-sections">
          <section>
            <EmployeeCapabilityHeading
              id="plugins"
              title="插件"
              kind="Plugins"
              description="员工能使用的插件。"
            />
            {state === 'empty' ? (
              <p>暂无插件</p>
            ) : (
              <EmployeeCapabilityRow
                name="品牌内容助手"
                description="选题、起草和内容审核"
                version="0.2.2"
                onOpen={() => {
                  void actions.openMain(resolveMain).then(
                    () => event('synthetic-main-selected'),
                    (error: unknown) =>
                      event(
                        `main-rejected:${error instanceof Error ? error.name : String(error)}`,
                      ),
                  );
                }}
              />
            )}
          </section>
          <section>
            <EmployeeCapabilityHeading
              id="scenes"
              title="工作场景"
              kind="Workflow"
              description="工作的方法和流程。"
            />
            {state === 'empty' ? (
              <p>暂无工作场景</p>
            ) : (
              <EmployeeCapabilityRow
                name="每周销售复盘"
                description="核对销售明细并整理行动项"
                version="1"
                onOpen={() => event('synthetic-scene-intent')}
              />
            )}
          </section>
          <EmployeeSkillsSection
            view={
              state === 'loading'
                ? { status: 'loading', label: '正在读取技能…' }
                : state === 'denied'
                  ? { status: 'error', message: '无权访问' }
                  : { status: 'ready', catalog: data.skills }
            }
            onOpen={() => event('synthetic-skill-intent')}
            onAdd={() => event('synthetic-install-intent')}
          />
        </div>
      ),
    }),
  };
}
