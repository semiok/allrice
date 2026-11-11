'use client';

import type { ReactNode, Ref } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './employee-capability-presentation.module.css';

export function EmployeeCapabilityRow({
  name,
  description,
  version,
  disabled,
  onOpen,
}: {
  name: string;
  description: string;
  version: string;
  disabled?: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className={css.row}
      aria-label={name}
      aria-description={description}
      disabled={disabled}
      onClick={onOpen}
    >
      <span className={css.rowMain}>
        <strong>{name}</strong>
        <span className={css.caption}>{description}</span>
      </span>
      <span className={css.version}>{version}</span>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        aria-hidden="true"
      >
        <path d="m9 5 7 7-7 7" />
      </svg>
    </button>
  );
}

export function EmployeeCapabilityHeading({
  id,
  title,
  kind,
  description,
  action,
}: {
  id: string;
  title: string;
  kind: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <>
      <div className={css.heading}>
        <h3 id={id}>
          {title} <span>{kind}</span>
        </h3>
        {action}
      </div>
      <p className={css.description}>{description}</p>
    </>
  );
}

export function EmployeeCapabilityDetailsHeader({
  title,
  version,
  titleRef,
  backLabel,
  onBack,
  disabled,
  updateDisabled,
  startDisabled,
  starting,
  onUpdate,
  onStart,
  action,
}: {
  title: string;
  version?: string;
  titleRef?: Ref<HTMLHeadingElement>;
  backLabel: string;
  onBack: () => void;
  disabled?: boolean;
  updateDisabled?: boolean;
  startDisabled?: boolean;
  starting?: boolean;
  onUpdate?: () => void;
  onStart?: () => void;
  action?: ReactNode;
}) {
  return (
    <header className={css.detailHeader}>
      <Button
        type="button"
        variant="ghost"
        className={css.back}
        aria-label={backLabel}
        disabled={disabled}
        onClick={onBack}
        data-modal-autofocus
        icon={
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m10 5-7 7 7 7M3 12h18" />
          </svg>
        }
      />
      <div className={css.title}>
        <h2 ref={titleRef} tabIndex={-1}>
          {title}
        </h2>
        {version && <span className={css.pill}>{version}</span>}
      </div>
      {(action || onUpdate || onStart) && (
        <div className={css.actions}>
          {action}
          {onUpdate && (
            <Button
              type="button"
              variant="outline"
              disabled={disabled || updateDisabled}
              onClick={onUpdate}
            >
              更新
            </Button>
          )}
          {onStart && (
            <Button
              type="button"
              variant="primary"
              className={css.primaryAction}
              disabled={disabled || startDisabled}
              aria-busy={starting}
              onClick={onStart}
            >
              开始工作
            </Button>
          )}
        </div>
      )}
    </header>
  );
}

export function EmployeeCapabilityEmpty({
  title,
  icon,
}: {
  title: string;
  icon: ReactNode;
}) {
  return (
    <div className={css.empty}>
      {icon}
      <h3>{title}</h3>
    </div>
  );
}

/** A real link when usable; disabled states never retain a navigation target. */
export function EmployeePluginOpenLink({
  href,
  pluginName,
  children,
  disabled,
}: {
  href: string;
  pluginName: string;
  children: string;
  disabled?: boolean;
}) {
  return disabled ? (
    <Button variant="primary" className={css.primaryAction} disabled>
      {children} <span aria-hidden="true">↗</span>
    </Button>
  ) : (
    <a
      className={css.primaryAction}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${children} ${pluginName}，在新标签页打开`}
    >
      {children} <span aria-hidden="true">↗</span>
    </a>
  );
}

export function EmployeeCapabilityDanger({
  children,
  description,
  disabled,
  onRemove,
}: {
  children: ReactNode;
  description?: string;
  disabled?: boolean;
  onRemove: () => void;
}) {
  return (
    <div className={css.dangerZone}>
      {description && <p className={css.caption}>{description}</p>}
      <button
        type="button"
        className={css.dangerAction}
        disabled={disabled}
        onClick={onRemove}
      >
        {children}
      </button>
    </div>
  );
}

/** Display seam only. No employee plugin catalog/binding or URL is fabricated.
 * The production host must not mount this until a real authorized catalog exists. */
export function EmployeePluginSection({
  headingId,
  plugins,
  onDetails,
  onAdd,
}: {
  headingId: string;
  plugins: ReadonlyArray<{
    id: string;
    name: string;
    description: string;
    href: string;
  }>;
  onDetails: (id: string) => void;
  onAdd?: () => void;
}) {
  return (
    <section
      className={`${css.typography} ${css.detailContainer}`}
      aria-labelledby={headingId}
    >
      <EmployeeCapabilityHeading
        id={headingId}
        title="插件"
        kind="Plugins"
        description="带有独立界面的工具，点击打开新页面。"
        action={
          onAdd && (
            <Button type="button" variant="outline" size="sm" onClick={onAdd}>
              添加插件
            </Button>
          )
        }
      />
      {plugins.length ? (
        <div className={css.list}>
          {plugins.map((plugin) => (
            <div className={css.pluginRow} key={plugin.id}>
              <div className={css.pluginInfo}>
                <div className={css.pluginHeading}>
                  <strong>{plugin.name}</strong>
                </div>
                <p className={css.caption}>{plugin.description}</p>
              </div>
              <div className={css.pluginActions}>
                <EmployeePluginOpenLink
                  href={plugin.href}
                  pluginName={plugin.name}
                >
                  打开
                </EmployeePluginOpenLink>
                <button type="button" onClick={() => onDetails(plugin.id)}>
                  详情
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    aria-hidden="true"
                  >
                    <path d="m9 5 7 7-7 7" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmployeeCapabilityEmpty
          title="还没有插件"
          icon={
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              aria-hidden="true"
            >
              <path d="M8 3v4M16 3v4M6 7h12v4a6 6 0 0 1-6 6v4M6 7v4a6 6 0 0 0 6 6" />
            </svg>
          }
        />
      )}
    </section>
  );
}

/** Presentation only, for the same future authorized plugin host as the list.
 * Removing a binding and its confirmation belong to that caller, not this view. */
export function EmployeePluginDetails({
  name,
  description,
  version,
  employeeName,
  href,
  backLabel,
  onBack,
  onRemove,
  disabled,
}: {
  name: string;
  description: string;
  version?: string;
  employeeName: string;
  href: string;
  backLabel: string;
  onBack: () => void;
  onRemove?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className={css.detailContainer}>
      <EmployeeCapabilityDetailsHeader
        title={name}
        version={version}
        backLabel={backLabel}
        onBack={onBack}
        action={
          <EmployeePluginOpenLink
            href={href}
            pluginName={name}
            disabled={disabled}
          >
            打开插件
          </EmployeePluginOpenLink>
        }
      />
      <div className={css.pluginBody}>
        <section>
          <h3>插件介绍</h3>
          <p>{description}</p>
        </section>
        <section>
          <h3>使用说明</h3>
          <p>点击「打开插件」，在新页面使用。</p>
        </section>
        {onRemove && (
          <EmployeeCapabilityDanger
            description={`只从 ${employeeName} 移除，其他员工不受影响。`}
            disabled={disabled}
            onRemove={onRemove}
          >
            从此员工移除
          </EmployeeCapabilityDanger>
        )}
      </div>
    </div>
  );
}
