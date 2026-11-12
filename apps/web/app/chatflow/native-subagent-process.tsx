import { useRef } from 'react';
import type { NativeSubagentSnapshot } from './native-subagent-follow';
import {
  DisclosureRow,
  IconApiOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { AssistantMarkdown } from './assistant-markdown';
import {
  WorkProcessReadingState,
  useProcessDisclosure,
} from './work-process-reading-state';
import { WorkProcessStepView } from './work-process-step';
import type { ChatPresentationPolicy } from './dsh-upstream/presentation/presentation-policy';
import styles from './dsh-saas.module.css';

type Row = NativeSubagentSnapshot['rows'][number];
function Tool({
  row,
  policy,
}: {
  row: Extract<Row, { kind: 'tool' }>;
  policy: ChatPresentationPolicy;
}) {
  return (
    <WorkProcessStepView
      id={`tool:${row.callId}`}
      icon={<IconApiOutlineRegular />}
      title={row.activityDetail || row.name}
      status={
        row.result ? (row.result.failed ? '未成功' : '已完成') : '结果未确认'
      }
      failed={row.result?.failed}
      initialOpen={
        row.result?.failed ||
        policy.mode === 'verbose' ||
        policy.collapseTiming === 'next-input'
      }
      details={
        row.result
          ? [
              {
                label: row.result.failed ? '原因' : '结果',
                value: (
                  <AssistantMarkdown
                    text={row.result.summary}
                    allowRemoteImages={false}
                  />
                ),
              },
            ]
          : []
      }
    >
      {row.truncated && <small>文字已截断。</small>}
    </WorkProcessStepView>
  );
}

function ToolGroup({
  rows,
  policy,
}: {
  rows: Extract<Row, { kind: 'tool' }>[];
  policy: ChatPresentationPolicy;
}) {
  const [open, setOpen] = useProcessDisclosure(
    rows.map((row) => `child-group:${row.callId}`),
    policy.mode === 'verbose' ||
      policy.collapseTiming === 'next-input' ||
      rows.some(
        (row) =>
          row.result?.failed || (!row.result && policy.liveProcessDetail),
      ),
  );
  return (
    <section
      className={styles.workProcess}
      aria-label="工作过程"
      data-process-open={open}
    >
      <DisclosureRow
        icon={<IconApiOutlineRegular />}
        title="工作过程"
        open={open}
        expandable
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => setOpen(!open)}
        rowClassName={styles.processHeader}
        titleClassName={styles.processTitle}
        collapsedContent={rows.map((row) => (
          <span
            key={row.callId}
            data-process-control={`child-group:${row.callId}`}
          />
        ))}
      />
      <div className={styles.processDetails} hidden={!open}>
        <ul className={styles.processSteps} aria-label="工作步骤">
          {rows.map((row) => (
            <li key={row.callId}>
              <Tool row={row} policy={policy} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** Renders the bounded safe cut; never rebuilds native blocks or attempts. */
export function NativeSubagentProcess({
  snapshot,
  policy,
}: {
  snapshot: NativeSubagentSnapshot;
  policy: ChatPresentationPolicy;
}) {
  const root = useRef<HTMLDivElement>(null);
  const identity = JSON.stringify([
    snapshot.rootId,
    snapshot.childId,
    snapshot.hostEpoch,
    snapshot.stream.instanceId,
  ]);
  const parts: (
    | { kind: 'tools'; rows: Extract<Row, { kind: 'tool' }>[] }
    | Extract<Row, { kind: 'assistant' }>
  )[] = [];
  for (const row of snapshot.rows) {
    const previous = parts.at(-1);
    if (row.kind === 'tool') {
      if (previous?.kind === 'tools') previous.rows.push(row);
      else parts.push({ kind: 'tools', rows: [row] });
    } else parts.push(row);
  }
  return (
    <WorkProcessReadingState key={identity} root={root}>
      <div
        ref={root}
        className={styles.processBlock}
        data-process-region={identity}
      >
        {(snapshot.window.omittedEvents > 0 ||
          snapshot.window.omittedRows > 0) && (
          <p>
            仅显示安全窗口，已省略 {snapshot.window.omittedEvents} 条事件、
            {snapshot.window.omittedRows} 行。
          </p>
        )}
        {!snapshot.stream.complete && <p role="status">当前实时文字不完整。</p>}
        {parts.map((row) =>
          row.kind === 'tools' ? (
            <ToolGroup
              key={`tools:${row.rows[0]!.callId}`}
              rows={row.rows}
              policy={policy}
            />
          ) : (
            <div
              key={row.seq}
              className={styles.processReply}
              data-process-content={`child-reply:${row.seq}`}
            >
              <AssistantMarkdown text={row.text} allowRemoteImages={false} />
              {row.truncated && <small>文字已截断。</small>}
            </div>
          ),
        )}
        {snapshot.stream.active && (
          <div
            className={styles.processReply}
            data-process-content={`child-stream:${snapshot.stream.active.attemptId}:${snapshot.stream.active.turn}:${snapshot.stream.active.step}`}
          >
            <AssistantMarkdown
              text={snapshot.stream.active.text}
              streaming
              allowRemoteImages={false}
            />
            {snapshot.stream.active.truncated && (
              <small>实时文字已截断。</small>
            )}
          </div>
        )}
      </div>
    </WorkProcessReadingState>
  );
}
