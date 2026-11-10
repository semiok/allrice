'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { useEmployeeSkillsHostView } from './employee-skills-host';
import css from './employee-capabilities-panel.module.css';

export function EmployeeCapabilitiesSections({
  children,
  onSkillNavigate,
}: {
  children: ReactNode;
  onSkillNavigate: () => void;
}) {
  const skills = useEmployeeSkillsHostView();
  return (
    <div className={css.sections}>
      {children}
      {skills?.renderSection(onSkillNavigate)}
    </div>
  );
}

/** The native Dock owns navigation/focus. This is the current employee's body;
 * its children consume the same U1 controllers as EmployeeDetailsDialog. */
export function EmployeeCapabilitiesPanel({
  employeeName,
  scopeKey,
  active,
  onRead,
  layer,
  showSkills,
  children,
}: {
  employeeName: string;
  scopeKey: string;
  active: boolean;
  onRead: () => void;
  layer?: ReactNode;
  showSkills: boolean;
  children: ReactNode;
}) {
  const read = useRef(onRead);
  const content = useRef<HTMLDivElement>(null);
  const listFocus = useRef<HTMLElement | null>(null);
  const hadLayer = useRef(false);
  const skills = useEmployeeSkillsHostView();
  const skillLayer =
    showSkills && !skills?.layer?.small ? skills?.layer : undefined;
  const layerKey = skillLayer?.navigationKey;
  const hasLayer = Boolean(layer || skillLayer);
  read.current = onRead;
  useEffect(() => {
    if (active) read.current();
  }, [active, scopeKey]);
  useEffect(() => {
    if (active && layerKey)
      content.current
        ?.querySelector<HTMLElement>('[data-modal-autofocus]')
        ?.focus({ preventScroll: true });
    else if (active && !hasLayer && hadLayer.current) {
      const previous = listFocus.current;
      if (previous?.isConnected && content.current?.contains(previous))
        previous.focus({ preventScroll: true });
      else
        content.current
          ?.querySelector<HTMLElement>('button:not([disabled])')
          ?.focus({ preventScroll: true });
    }
    hadLayer.current = hasLayer;
  }, [active, layerKey, hasLayer]);
  return (
    <section className={css.panel} aria-label={`${employeeName} · 能力`}>
      <header className={css.identity}>
        <div className={css.avatar} aria-hidden="true">
          {employeeName.slice(0, 1)}
        </div>
        <div>
          <h2>{employeeName} · 能力</h2>
          <p>插件、工作场景和技能</p>
        </div>
      </header>
      <div
        ref={content}
        className={css.content}
        onFocusCapture={(event) => {
          if (!hasLayer && event.target instanceof HTMLElement)
            listFocus.current = event.target;
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.defaultPrevented && skillLayer) {
            event.stopPropagation();
            if (!skillLayer.blocked) skillLayer.onBack();
          }
        }}
      >
        {layer || skillLayer ? (
          <div className={css.layer}>{layer ?? skillLayer?.content}</div>
        ) : (
          <div className={css.body}>{children}</div>
        )}
      </div>
    </section>
  );
}
