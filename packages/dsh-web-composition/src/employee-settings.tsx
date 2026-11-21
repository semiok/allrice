import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type { Context } from '@deepseek-ai/cordis';
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives';
import type {
  SettingsLauncherOwnerProps,
  SettingsSectionOwnerProps,
} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import { EmployeeSettingsModel } from './employee-settings-model';
import type {
  EmployeeSettingsOptions,
  EmployeeSettingsScope,
  EmployeeSettingsSection,
} from './employee-settings-port';
import styles from './employee-settings.module.css';

export { bindEmployeeSettings } from './employee-settings-port';
export type * from './employee-settings-port';

function useSettings(model: EmployeeSettingsModel) {
  return useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
    model.getSnapshot,
  );
}

function Unavailable() {
  return <p role="alert">当前设置不可用，请重新打开设置。</p>;
}

function AccountSection({
  model,
  close,
}: SettingsSectionOwnerProps & { model: EmployeeSettingsModel }) {
  const { scope } = useSettings(model);
  if (!scope) return <Unavailable />;
  return (
    <section className={styles.section} aria-label="AllRice 账号">
      <h2 className={styles.heading}>AllRice 账号</h2>
      <div className={styles.row}>
        <p className={styles.description}>管理账号、密码和使用情况。</p>
        <Button
          variant="outline"
          onClick={() => model.openAccount(scope, close)}
        >
          打开账号设置
        </Button>
      </div>
    </section>
  );
}

function StreamingPreference({ model }: { model: EmployeeSettingsModel }) {
  const { scope, snapshot } = useSettings(model);
  useEffect(() => {
    if (scope) model.reloadPreferences(scope);
  }, [model, scope]);
  if (!scope || !snapshot) return null;
  const view = snapshot.preferences;
  return (
    <div className={styles.section} aria-busy={view.pending}>
      <div className={styles.row}>
        <div className={styles.copy}>
          <h3>流式输出</h3>
          <p>实时显示文字和阶段性回复，关闭后统一展示。</p>
        </div>
        {view.values && (
          <Switch
            label="流式输出"
            checked={view.values.streamingOutput}
            disabled={view.pending}
            onChange={(value) => model.setStreamingOutput(scope, value)}
          />
        )}
      </div>
      {!view.values && !view.error && <p role="status">正在读取个人偏好…</p>}
      {view.error && (
        <p role="alert">
          {view.error}{' '}
          <Button
            variant="ghost"
            size="sm"
            disabled={view.pending}
            onClick={() => model.reloadPreferences(scope)}
          >
            重新读取
          </Button>
        </p>
      )}
    </div>
  );
}

function NotificationPreferences({ model }: { model: EmployeeSettingsModel }) {
  const { scope, snapshot } = useSettings(model);
  useEffect(() => {
    if (scope) model.reloadNotifications(scope);
  }, [model, scope]);
  if (!scope || !snapshot) return null;
  const view = snapshot.notifications;
  return (
    <section
      className={styles.section}
      aria-label="通知"
      aria-busy={view?.pending}
    >
      <h3 className={styles.heading}>通知</h3>
      {view?.values ? (
        <>
          <div className={styles.row}>
            <div className={styles.copy}>
              <h3>任务完成</h3>
              <p>任务完成时通知我。</p>
            </div>
            <Switch
              label="任务完成通知"
              checked={view.values.taskCompleted}
              disabled={view.pending}
              onChange={(value) =>
                model.setNotification(scope, 'taskCompleted', value)
              }
            />
          </div>
          <div className={styles.row}>
            <div className={styles.copy}>
              <h3>需要确认</h3>
              <p>员工需要我确认时通知我。</p>
            </div>
            <Switch
              label="需要确认通知"
              checked={view.values.needsConfirmation}
              disabled={view.pending}
              onChange={(value) =>
                model.setNotification(scope, 'needsConfirmation', value)
              }
            />
          </div>
        </>
      ) : (
        !view?.error && <p role="status">正在读取通知偏好…</p>
      )}
      {view?.error && (
        <p role="alert">
          {view.error}{' '}
          <Button
            variant="ghost"
            size="sm"
            disabled={view.pending}
            onClick={() => model.reloadNotifications(scope)}
          >
            重新读取
          </Button>
        </p>
      )}
    </section>
  );
}

function BusinessSection({
  model,
  section,
}: {
  model: EmployeeSettingsModel;
  section: EmployeeSettingsSection;
}) {
  const { scope } = useSettings(model);
  if (!scope) return <Unavailable />;
  return (
    <Fragment key={scope.key}>
      {model.port.renderSection(section, scope)}
    </Fragment>
  );
}

function NativeLauncher({
  model,
  renderLauncher,
  ...native
}: SettingsLauncherOwnerProps & {
  model: EmployeeSettingsModel;
  renderLauncher: EmployeeSettingsOptions['renderLauncher'];
}) {
  const { scope } = useSettings(model);
  const owner = useMemo(
    () => native,
    [
      native.wide,
      native.settingsOpen,
      native.settingsShortcut,
      native.openSettings,
      native.openOnboarding,
    ],
  );
  const [committed, setCommitted] = useState<{
    scope: EmployeeSettingsScope;
    owner: SettingsLauncherOwnerProps;
    props: SettingsLauncherOwnerProps;
  } | null>(null);
  useEffect(() => {
    if (!scope) return;
    const binding = model.bindLauncherView(scope, owner);
    if (renderLauncher) setCommitted({ scope, owner, props: binding.props });
    return binding.dispose;
  }, [model, scope, owner, renderLauncher]);
  if (!scope || !renderLauncher) return null;
  const props =
    committed?.scope === scope && committed.owner === owner
      ? committed.props
      : { ...owner, openSettings: () => {}, openOnboarding: () => {} };
  return renderLauncher(props);
}

export const inject = ['slots'];

/** Public native settings contributions; no API, credentials or default host. */
export function apply(ctx: Context, options: EmployeeSettingsOptions = {}) {
  const notificationsEnabled = options.notifications === true;
  const renderLauncher = options.renderLauncher;
  const Hidden = () => null;
  for (const id of ['permission', 'developer-tools', 'session-log-deepseek'])
    ctx.slots.inject('settings.general.item', () =>
      ctx.slots.register(
        { name: 'settings.general.item', id, priority: -100 },
        Hidden,
      ),
    );
  ctx.slots.inject('settings.action', () =>
    ctx.slots.register(
      { name: 'settings.action', id: 'open-document', priority: -100 },
      Hidden,
    ),
  );
  ctx.inject(['allriceEmployeeSettings'], (scope) => {
    const model = new EmployeeSettingsModel(
      scope.allriceEmployeeSettings,
      notificationsEnabled,
    );
    scope.effect(() => () => model.dispose());
    scope.slots.inject('settings.launcher', () =>
      scope.slots.register(
        { name: 'settings.launcher', priority: -100 },
        (props: SettingsLauncherOwnerProps) => (
          <NativeLauncher
            {...props}
            model={model}
            renderLauncher={renderLauncher}
          />
        ),
      ),
    );
    scope.slots.inject('settings.section', function* () {
      yield scope.slots.register(
        {
          name: 'settings.section',
          id: 'allrice-account',
          order: 10,
          label: 'AllRice 账号',
        },
        (props: SettingsSectionOwnerProps) => (
          <AccountSection {...props} model={model} />
        ),
      );
      for (const [section, label, order] of [
        ['computer', '我的电脑', 20],
        ['work', '工作方式', 30],
        ['apps', '已链接应用', 40],
      ] as const)
        yield scope.slots.register(
          { name: 'settings.section', id: `allrice-${section}`, order, label },
          () => <BusinessSection model={model} section={section} />,
        );
    });
    scope.slots.inject('settings.general.item', function* () {
      yield scope.slots.register(
        {
          name: 'settings.general.item',
          id: 'allrice-streaming-output',
          order: 13,
        },
        () => <StreamingPreference model={model} />,
      );
      if (notificationsEnabled)
        yield scope.slots.register(
          {
            name: 'settings.general.item',
            id: 'allrice-notifications',
            order: 40,
          },
          () => <NotificationPreferences model={model} />,
        );
    });
  });
}
