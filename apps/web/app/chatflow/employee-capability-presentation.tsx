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
      {(onUpdate || onStart) && (
        <div className={css.actions}>
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

export function EmployeeCapabilityDanger({
  children,
  disabled,
  onRemove,
}: {
  children: ReactNode;
  disabled?: boolean;
  onRemove: () => void;
}) {
  return (
    <div className={css.dangerZone}>
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
    icon: ReactNode;
    href: string;
  }>;
  onDetails: (id: string) => void;
  onAdd?: () => void;
}) {
  return (
    <section aria-labelledby={headingId}>
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
      <div className={css.list}>
        {plugins.map((plugin) => (
          <div className={css.pluginRow} key={plugin.id}>
            <div className={css.pluginInfo}>
              <div className={css.pluginHeading}>
                <span className={css.pluginIcon} aria-hidden="true">
                  {plugin.icon}
                </span>
                <strong>{plugin.name}</strong>
              </div>
              <p className={css.caption}>{plugin.description}</p>
            </div>
            <div className={css.pluginActions}>
              <a href={plugin.href} target="_blank" rel="noopener noreferrer">
                打开 ↗
              </a>
              <button type="button" onClick={() => onDetails(plugin.id)}>
                详情
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
