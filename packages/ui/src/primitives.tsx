import type { HTMLAttributes, ReactNode } from 'react';

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

export function Surface({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={classes('ar-surface', className)} {...props} />;
}

export function Badge({
  className,
  tone = 'neutral',
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'accent';
}) {
  return (
    <span
      className={classes('ar-badge', `ar-badge-${tone}`, className)}
      {...props}
    />
  );
}

export function ContextPressureMeter({
  percentage,
  label,
  title,
}: {
  percentage: number;
  label?: ReactNode;
  title?: string;
}) {
  const normalized = Math.min(100, Math.max(0, Math.round(percentage)));
  return (
    <div
      className={classes(
        'ar-context-pressure',
        normalized >= 80 && 'ar-context-pressure-warning',
      )}
      title={title}
    >
      <span>{label ?? `上下文 ${normalized}%`}</span>
      <span
        aria-label={`会话上下文使用 ${normalized}%，达到 100% 后自动压缩`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={normalized}
        className="ar-meter"
        role="progressbar"
      >
        <span style={{ width: `${normalized}%` }} />
      </span>
    </div>
  );
}
