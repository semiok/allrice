'use client';

import type { EmployeeDetailsProfile } from '@allrice/contracts';
import {
  Button,
  IconEditOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { employeeAccent, employeeAccentStyle } from './employee-navigation';
import css from './employee-persona-card.module.css';

const expressionStyleLabels = {
  concise: '简洁，结论优先',
  structured: '结构清晰，分步说明',
  exploratory: '比较方案与取舍',
} as const;

/** Render the authorized profile projection without deriving edit permission
 * from its saved values. The caller supplies an action only when allowed. */
export function EmployeePersonaCard({
  profile,
  view = 'personal',
  onEdit,
}: {
  profile: EmployeeDetailsProfile;
  view?: 'personal' | 'shared';
  onEdit?: () => void;
}) {
  return (
    <section
      className={css.card}
      aria-label="基础与人设"
      data-employee-accent={employeeAccent(
        profile.name,
        profile.appearance?.accentColor,
      )}
      style={employeeAccentStyle(profile.name, profile.appearance?.accentColor)}
    >
      <div className={css.identity}>
        <span className={css.avatar} aria-hidden="true">
          {Array.from(profile.name)[0]}
        </span>
        <h3 className={css.name}>{profile.name}</h3>
        {onEdit && (
          <Button
            className={css.edit}
            type="button"
            variant="outline"
            size="sm"
            aria-label="编辑员工"
            icon={<IconEditOutlineRegular size={16} />}
            onClick={onEdit}
          >
            编辑
          </Button>
        )}
      </div>
      <dl className={css.persona}>
        <div className={css.field}>
          <dt>使命</dt>
          <dd>{profile.identity.mission}</dd>
        </div>
        <div className={css.field}>
          <dt>工作方式</dt>
          <dd>{profile.identity.workStyle}</dd>
        </div>
        {view === 'personal' && (
          <div className={css.field}>
            <dt>表达偏好</dt>
            <dd>
              {profile.expressionStyle
                ? expressionStyleLabels[profile.expressionStyle]
                : '未设置'}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}
