'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
} from 'react';
import {
  Button,
  PluginArtworkTerminal,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { createPortal } from 'react-dom';
import type { TerminalView } from '@deepseek-ai/dsh-api-terminal-controller/client';
import type { BridgeDevice } from './chatflow-types';
import { readJson } from './chatflow-utils';
import {
  nativeTerminalRuntime,
  retainNativeTerminalTab,
  terminalPin,
  terminalShellPath,
  terminalCleanupFailures,
  terminalRecoveryView,
  type TerminalRuntime,
  type TerminalScreenProps,
} from './terminal-native';
import type { TerminalIdentity, TerminalPin } from './terminal-transport';
import { WorkbenchIcon } from './workbench-modules';
import guide from './workbench-modules.module.css';
import css from './terminal-workbench.module.css';

type TerminalDevice = BridgeDevice & { humanTerminalVersion?: 1 | 2 };
type Target = TerminalPin & {
  deviceName: string;
  label: string;
  online: boolean;
  supported: boolean;
};

export function TerminalCleanupStatus(props: {
  owner: Pick<TerminalIdentity, 'organizationId' | 'workspaceId' | 'ownerId'>;
}) {
  const snapshot = useSyncExternalStore(
    terminalCleanupFailures.subscribe,
    terminalCleanupFailures.getSnapshot,
    terminalCleanupFailures.getSnapshot,
  );
  const failures = snapshot.filter(
    (failure) =>
      failure.owner.organizationId === props.owner.organizationId &&
      failure.owner.workspaceId === props.owner.workspaceId &&
      failure.owner.ownerId === props.owner.ownerId,
  );
  return failures.length && typeof document !== 'undefined'
    ? createPortal(
        <div className={css.cleanup}>
          {failures.map((failure) => (
            <div key={failure.key} role="alert">
              <span>
                终端「{failure.title}」未能结束：{failure.message}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={failure.retry}
              >
                重试结束
              </Button>
            </div>
          ))}
        </div>,
        document.body,
      )
    : null;
}

export function TerminalIcon({ size = 17 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m4 6 6 6-6 6m9 0h7" />
    </svg>
  );
}

export function TerminalGuide(props: {
  identity: TerminalIdentity;
  headers: Record<string, string>;
  active: boolean;
  readOnly?: boolean;
  onLaunch: (pin: TerminalPin, shellPath?: string) => void;
  onOpenComputerSettings?: () => void;
}) {
  const [devices, setDevices] = useState<TerminalDevice[] | null>(null);
  const [selected, setSelected] = useState('');
  const [notice, setNotice] = useState('');
  const [launching, setLaunching] = useState(false);
  const launchRequest = useRef<AbortController | null>(null);
  const [revision, setRevision] = useState(0);
  const scope = `${props.identity.organizationId}/${props.identity.workspaceId}/${props.identity.ownerId}`;
  useEffect(() => {
    if (!props.active) return;
    const abort = new AbortController();
    void fetch(
      `/api/v1/bridge/devices?workspaceId=${props.identity.workspaceId}`,
      {
        headers: props.headers,
        cache: 'no-store',
        signal: abort.signal,
      },
    )
      .then((response) => readJson<{ devices: TerminalDevice[] }>(response))
      .then((value) => {
        if (!abort.signal.aborted)
          setDevices(
            value.devices.filter((device) => device.status !== 'revoked'),
          );
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setNotice(
            error instanceof Error ? error.message : '电脑状态读取失败',
          );
      });
    return () => abort.abort();
  }, [props.active, props.identity.workspaceId, scope, revision]);
  const targets = useMemo(
    () =>
      (devices ?? []).flatMap((device) =>
        device.folderGrants.map((grant): Target => ({
          deviceId: device.id,
          deviceName: device.name,
          grantId: grant.id,
          label: grant.label,
          online: device.status === 'online',
          supported:
            device.humanTerminalVersion === 1 ||
            device.humanTerminalVersion === 2,
        })),
      ),
    [devices],
  );
  const target =
    targets.find(
      (value) => `${value.deviceId}/${value.grantId}` === selected,
    ) ??
    (selected
      ? undefined
      : (targets.find((value) => value.online && value.supported) ??
        targets[0]));
  useEffect(() => {
    if (!selected && target)
      setSelected(target.deviceId + '/' + target.grantId);
  }, [selected, target?.deviceId, target?.grantId]);
  const check = () => {
    if (props.readOnly) {
      setNotice('归档会话不能新建终端');
      return false;
    }
    if (!target) {
      setNotice('安装并连接 Bridge，授权文件夹后即可使用终端。');
      return false;
    }
    if (!target.online) {
      setNotice('这台电脑的 Bridge 当前离线，请先连接。');
      return false;
    }
    if (!target.supported) {
      setNotice('更新 Bridge 后可使用终端。');
      return false;
    }
    return true;
  };
  useEffect(() => {
    setLaunching(false);
    return () => {
      const pending = launchRequest.current;
      launchRequest.current = null;
      pending?.abort();
    };
  }, [
    scope,
    props.identity.sessionId,
    props.active,
    props.readOnly,
    target?.deviceId,
    target?.grantId,
  ]);
  const launch = async () => {
    if (!props.active || launchRequest.current || !check() || !target) return;
    const abort = new AbortController();
    launchRequest.current = abort;
    setLaunching(true);
    setNotice('');
    try {
      const runtime = await nativeTerminalRuntime(props.identity, target);
      const choices = await runtime.models.launchShells(
        props.identity.sessionId as never,
        abort.signal,
      );
      if (abort.signal.aborted) return;
      // Pinned DSH discovery returns the verified execution default first.
      // Its remembered selection belongs to the former chooser, not new tabs.
      const shellPath = choices.shells[0]?.path;
      if (!shellPath) throw Error('这台电脑没有可用的默认 Shell');
      props.onLaunch(target, shellPath);
    } catch (error) {
      if (!abort.signal.aborted)
        setNotice(
          error instanceof Error ? error.message : '默认 Shell 读取失败',
        );
    } finally {
      if (launchRequest.current === abort) launchRequest.current = null;
      if (!abort.signal.aborted) setLaunching(false);
    }
  };
  return (
    <div className={css.guideEntry} data-terminal-guide>
      <div className={`${guide.card} ${css.card}`}>
        <Button
          type="button"
          variant="ghost"
          className={css.launch}
          aria-label="新建终端"
          disabled={launching || !props.active}
          aria-busy={launching}
          onClick={() => void launch()}
        />
        <span className={`${guide.tile} ${css.tile}`} aria-hidden="true">
          <PluginArtworkTerminal size={30} />
        </span>
        <span className={css.guideCopy}>
          <strong>{launching ? '正在打开终端…' : '新建终端'}</strong>
          <small>
            {target
              ? `${target.deviceName} · ${target.label}`
              : '在你的电脑上运行命令'}
          </small>
        </span>
        <span className={`${guide.chevron} ${css.chevron}`} aria-hidden="true">
          <WorkbenchIcon kind="chevron-right" />
        </span>
      </div>
      {targets.length > 1 && (
        <select
          className={css.targetPicker}
          aria-label="终端电脑与文件夹"
          disabled={launching}
          value={target ? `${target.deviceId}/${target.grantId}` : ''}
          onChange={(event) => {
            setSelected(event.target.value);
            setNotice('');
          }}
        >
          {!target && (
            <option value="" disabled>
              选择电脑与文件夹
            </option>
          )}
          {targets.map((value) => (
            <option
              key={`${value.deviceId}/${value.grantId}`}
              value={`${value.deviceId}/${value.grantId}`}
            >
              {value.deviceName} · {value.label}
              {value.online ? '' : '（离线）'}
              {value.supported ? '' : '（需更新）'}
            </option>
          ))}
        </select>
      )}
      {notice && (
        <div className={css.notice}>
          <span role="status">{notice}</span>
          <div>
            <button type="button" onClick={props.onOpenComputerSettings}>
              连接电脑
            </button>
            <button
              type="button"
              onClick={() => {
                setNotice('');
                setRevision((value) => value + 1);
              }}
            >
              刷新状态
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const dictionary: Record<string, string> = {
  title: '终端',
  new: '新建终端',
  loading: '正在读取终端环境…',
  creating: '正在启动…',
  connecting: '正在连接…',
  disconnected: '连接已断开。',
  reconnect: '重新连接',
  readonly: '此页面当前只读。',
  control: '接管输入',
  closed: '终端已关闭。',
  exited: '进程已退出（{code}）',
  failed: '终端错误：{message}',
  unavailable: '不可用',
  retry: '重试',
  missingTerminal: '此终端已不存在，请新建终端。',
  inputFull: '输入缓冲区已满，请重新连接后重试。',
  attachmentEnded: '终端连接已结束，请重新连接。',
  invalidOutput: '终端画面传输异常，请重新连接。',
  terminalLimit:
    '终端数量已达上限，请关闭不用的终端后重试。已退出的终端也计入数量。',
};
const t = (key: string, values: Record<string, string> = {}) =>
  Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, value),
    dictionary[key] ?? key,
  );

export function TerminalWorkbench(props: {
  identity: TerminalIdentity;
  tabId: string;
  contentId: string;
  active: boolean;
  onNew: () => void;
  onTitle?: (title: string) => void;
  onOpenComputerSettings?: () => void;
}) {
  const [loaded, setLoaded] = useState<{
    runtime: TerminalRuntime;
    model: TerminalView;
  } | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const pin = terminalPin(props.contentId);
    if (!pin) {
      setError('终端目标无效，请新建终端');
      return;
    }
    let current = true;
    void nativeTerminalRuntime(props.identity, pin)
      .then((runtime) => {
        retainNativeTerminalTab(runtime, props.tabId, props.contentId);
        const model = runtime.models.view(
          props.identity.sessionId as never,
          props.tabId,
          props.contentId,
          undefined,
          terminalShellPath(props.contentId),
        );
        if (current) setLoaded({ runtime, model });
      })
      .catch((error) => {
        if (current)
          setError(error instanceof Error ? error.message : '终端组件加载失败');
      });
    return () => {
      current = false;
    };
  }, [props.contentId, props.tabId, revision]);
  if (!loaded)
    return (
      <div className={css.pending} role="status">
        {error || '正在打开终端…'}
        {error && (
          <button
            type="button"
            onClick={() => {
              setError('');
              setRevision((value) => value + 1);
            }}
          >
            重试
          </button>
        )}
      </div>
    );
  return (
    <NativeTerminalBody
      {...props}
      runtime={loaded.runtime}
      model={loaded.model}
    />
  );
}

function NativeTerminalBody(props: {
  tabId: string;
  active: boolean;
  runtime: TerminalRuntime;
  model: TerminalView;
  onNew: () => void;
  onTitle?: (title: string) => void;
  onOpenComputerSettings?: () => void;
}) {
  const carrier = useSyncExternalStore(
    props.runtime.carrier.state.subscribe,
    props.runtime.carrier.state.getSnapshot,
    props.runtime.carrier.state.getSnapshot,
  );
  const state = useSyncExternalStore(
    props.model.state.subscribe,
    props.model.state.getSnapshot,
    props.model.state.getSnapshot,
  );
  const previousCarrierPhase = useRef(carrier.phase);
  useEffect(() => {
    const recovered =
      carrier.phase === 'connected' &&
      previousCarrierPhase.current !== 'connected';
    previousCarrierPhase.current = carrier.phase;
    // A permanent carrier end leaves DSH's view failed. Once fresh browser
    // authorization succeeds, reuse its public inventory recovery to distinguish
    // a retained PTY from a process destroyed by a complete Bridge restart.
    if (recovered && state.phase === 'failed' && state.info) {
      void props.model.refresh();
      return;
    }
    // Native failInput detaches its stream if a resize/input races carrier loss.
    // Recover only a confirmed process after fresh carrier authorization.
    if (
      carrier.phase === 'connected' &&
      state.phase === 'disconnected' &&
      state.info
    )
      props.model.connect();
  }, [carrier.phase, state.phase, state.info, props.model]);
  useEffect(() => {
    if (state.title) props.onTitle?.(state.title);
  }, [state.title, props.onTitle]);
  const [themeRevision, setThemeRevision] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setThemeRevision((value) => value + 1),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style'],
    });
    const media = matchMedia('(prefers-color-scheme: dark)');
    const change = () => setThemeRevision((value) => value + 1);
    media.addEventListener('change', change);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', change);
    };
  }, []);
  const theme = useMemo(
    () => ({
      fontFamilies: { terminal: '' },
      fontSizes: { terminal: 13 },
      revision: themeRevision,
    }),
    [themeRevision],
  );
  const useTerminal = useCallback(
    () =>
      useSyncExternalStore(
        props.model.state.subscribe,
        props.model.state.getSnapshot,
        props.model.state.getSnapshot,
      ),
    [props.model],
  );
  const Body: ComponentType<TerminalScreenProps> =
    props.runtime.screen.TerminalBody;
  const view = useMemo(
    () => terminalRecoveryView(props.runtime, props.model),
    [props.runtime, props.model],
  );
  return (
    <section
      className={css.terminal}
      aria-label="电脑终端"
      data-terminal-workbench
    >
      <div className={css.metadata}>
        <span className={css.device} title={carrier.deviceName ?? '我的电脑'}>
          {carrier.deviceName ?? '我的电脑'}
        </span>
        <span
          className={css.folder}
          title={
            '授权文件夹：' +
            (state.environment?.cwd ?? carrier.target?.label ?? '')
          }
          aria-label={
            '授权文件夹 ' +
            (state.environment?.cwd ?? carrier.target?.label ?? '')
          }
        >
          {state.environment?.cwd ??
            carrier.target?.label ??
            '正在读取授权文件夹…'}
        </span>
        <span
          className={css.connection}
          data-connected={carrier.phase === 'connected'}
        >
          <i />
          {carrier.phase === 'connected'
            ? '终端已连接'
            : carrier.phase === 'ended'
              ? '连接已结束'
              : carrier.error
                ? '正在重新验证终端授权'
                : '终端连接中'}
        </span>
      </div>
      <div className={css.screen}>
        <Body
          useTabInfo={() => ({
            tab: {
              id: props.tabId,
              visible: props.active,
              actions: { openTab: props.onNew },
            },
          })}
          useTerminal={useTerminal}
          useTheme={(selector) => selector(theme)}
          view={() => view}
          t={t}
        />
      </div>
      {carrier.error && carrier.phase !== 'ended' && (
        <div className={css.notice}>
          <span role="status">{carrier.error}</span>
          <button
            type="button"
            disabled={carrier.phase !== 'disconnected'}
            onClick={() => props.runtime.carrier.retryConnection()}
          >
            立即重试连接
          </button>
        </div>
      )}
      {carrier.phase === 'ended' && (
        <div className={css.notice}>
          <span role="alert">{carrier.error}</span>
          <button
            type="button"
            onClick={() => props.runtime.carrier.reauthorizeConnection()}
          >
            重新验证并连接
          </button>
          <button type="button" onClick={props.onOpenComputerSettings}>
            连接电脑
          </button>
        </div>
      )}
    </section>
  );
}
