import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DockLayout, type TabId } from '@deepseek-ai/dsh-client-ui-dockkit';
import {
  TerminalWorkbench,
  TerminalCleanupStatus,
  TerminalIcon,
  TerminalGuide,
} from '../app/chatflow/terminal-workbench';
import {
  closeNativeTerminalTab,
  retainTerminalOwner,
  releaseTerminalOwner,
  nativeTerminalRuntime,
  terminalPin,
} from '../app/chatflow/terminal-native';
import { useNativeDock, dockLabels } from '../app/chatflow/use-native-dock';
import workbench from '../app/chatflow/workbench.module.css';
import { WorkbenchStart } from '../app/chatflow/workbench-modules';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';

const identity = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  ownerId: '33333333-3333-4333-8333-333333333333',
  sessionId: '44444444-4444-4444-8444-444444444444',
};
const contentId =
  'terminal://55555555-5555-4555-8555-555555555555/66666666-6666-4666-8666-666666666666/88888888-8888-4888-8888-888888888888';
function TerminalSurface(props: { identity: typeof identity }) {
  const [visible, setVisible] = useState(true);
  const [resizeArmed, setResizeArmed] = useState(false);
  const [launched, setLaunched] = useState({ shell: '', grant: '' });
  const [launchCount, setLaunchCount] = useState(0);
  const [guideSessionId, setGuideSessionId] = useState(
    props.identity.sessionId,
  );
  const [guideActive, setGuideActive] = useState(true);
  const guideMode = new URLSearchParams(location.search).has('guide');
  const close = useRef<(id: TabId) => void>(() => {});
  const dock = useNativeDock(
    JSON.stringify(props.identity),
    (id) => {
      close.current(id);
      return true;
    },
    () => {},
    '开始',
  );
  close.current = (id) => {
    const tab = dock.surface.layout.tabs[id];
    if (tab?.kind === 'terminal')
      void closeNativeTerminalTab(props.identity, id, tab.contentId);
  };
  useEffect(() => {
    if (!guideMode) dock.open('terminal', contentId, 'zsh');
  }, []);
  if (guideMode)
    return (
      <div className={workbench.panel} style={{ height: 'calc(100vh - 30px)' }}>
        <WorkbenchStart
          experience
          workflow
          onOpen={() => {}}
          terminal={
            <TerminalGuide
              identity={{ ...props.identity, sessionId: guideSessionId }}
              headers={{}}
              active={guideActive}
              onLaunch={(pin, shell) => {
                setLaunched({ shell: shell ?? '', grant: pin.grantId });
                setLaunchCount((count) => count + 1);
              }}
            />
          }
        />
        <div data-test-controls>
          <button>普通工作台按钮</button>
          <button
            onClick={() =>
              setGuideSessionId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
            }
          >
            切换终端会话
          </button>
          <button onClick={() => setGuideActive((active) => !active)}>
            切换终端入口显示
          </button>
          <output aria-label="新终端 Shell">{launched.shell}</output>
          <output aria-label="新终端授权文件夹">{launched.grant}</output>
          <output aria-label="新终端启动次数">{launchCount}</output>
        </div>
      </div>
    );
  return (
    <>
      <div data-test-controls>
        <button onClick={() => setVisible((value) => !value)}>
          折叠或展开工作台
        </button>
        <button
          onClick={() => {
            const tab = Object.values(dock.surface.layout.tabs).find(
              (tab) => tab.kind === 'terminal',
            );
            const pin = terminalPin(contentId)!;
            if (!tab) return;
            void nativeTerminalRuntime(props.identity, pin).then((runtime) => {
              const model = runtime.models.view(
                props.identity.sessionId as never,
                tab.id,
                contentId,
              );
              const stop = runtime.carrier.state.subscribe(() => {
                if (
                  runtime.carrier.state.getSnapshot().phase !== 'disconnected'
                )
                  return;
                stop();
                const info = model.state.getSnapshot().info;
                if (info)
                  model.resize(
                    info.cols === 500 ? 499 : info.cols + 1,
                    info.rows,
                  );
              });
              setResizeArmed(true);
            });
          }}
        >
          {resizeArmed ? '已安排断连调整' : '断连时调整终端'}
        </button>
        <button
          onClick={() => {
            const tab = Object.values(dock.surface.layout.tabs).find(
              (tab) => tab.kind === 'terminal',
            );
            if (tab) dock.intents.closeTab(tab.id);
          }}
        >
          关闭终端标签
        </button>
      </div>
      <div className={workbench.panel} style={{ height: 'calc(100vh - 50px)' }}>
        {visible && (
          <DockLayout
            state={dock.surface.layout}
            intents={dock.intents}
            labels={{ ...dockLabels, addTab: '新建标签页' }}
            renderTabTitle={(tab) => (
              <span
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
              >
                {tab.kind === 'terminal' && <TerminalIcon />}
                {tab.title}
              </span>
            )}
            canCloseTab={dock.canCloseTab}
            canSplit={false}
            canAddTab={() => false}
            keepMounted={() => true}
            renderTab={(tab) =>
              tab.kind === 'terminal' ? (
                <TerminalWorkbench
                  identity={props.identity}
                  tabId={tab.id}
                  contentId={contentId}
                  active
                  onNew={() => {
                    dock.intents.closeTab(tab.id);
                  }}
                />
              ) : (
                <p>开始</p>
              )
            }
          />
        )}
      </div>
    </>
  );
}
function Fixture() {
  const [ownerId, setOwnerId] = useState(identity.ownerId);
  const owner = { ...identity, ownerId };
  useEffect(() => {
    retainTerminalOwner(owner);
    return () => {
      void releaseTerminalOwner(owner);
    };
  }, [ownerId]);
  return (
    <>
      <div data-test-controls>
        <button
          onClick={() =>
            setOwnerId((value) =>
              value === identity.ownerId
                ? '99999999-9999-4999-8999-999999999999'
                : identity.ownerId,
            )
          }
        >
          切换账号
        </button>
        <output aria-label="当前账号">{ownerId}</output>
      </div>
      <TerminalCleanupStatus owner={owner} />
      <TerminalSurface key={ownerId} identity={owner} />
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
