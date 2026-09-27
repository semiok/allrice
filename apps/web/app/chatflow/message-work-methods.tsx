'use client';

import { useState } from 'react';
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { workMethodLabels, type WorkMethod } from '@allrice/contracts';
import css from './message-feedback.module.css';

export function MessageWorkMethods({ methods }: { methods: WorkMethod[] }) {
  const [expanded, setExpanded] = useState(false);
  const unique = [...new Set(methods)].filter((method) =>
    Object.hasOwn(workMethodLabels, method),
  );
  if (!unique.length) return null;
  return (
    <span className={css.methods} role="group" aria-label="工作方式">
      {(expanded ? unique : unique.slice(0, 2)).map((method) => (
        <span key={method}>{workMethodLabels[method]}</span>
      ))}
      {unique.length > 2 && (
        <Tooltip
          label={`工作方式：${unique.map((method) => workMethodLabels[method]).join('、')}`}
          side="top"
        >
          <button
            type="button"
            className={css.moreMethods}
            aria-label={
              expanded ? '收起工作方式' : `查看全部 ${unique.length} 种工作方式`
            }
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setExpanded(false);
            }}
          >
            {expanded ? '收起' : `+${unique.length - 2}`}
          </button>
        </Tooltip>
      )}
    </span>
  );
}
