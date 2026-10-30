import type { NativeSubagentSnapshot } from './native-subagent-follow';
import {
  DisclosureRow,
  IconApiOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { AssistantMarkdown } from './assistant-markdown';
import { useProcessDisclosure } from './work-process-reading-state';
import type { ChatPresentationPolicy } from './dsh-upstream/presentation/presentation-policy';

type Row = NativeSubagentSnapshot['rows'][number];
function Tool({
  row,
  policy,
}: {
  row: Extract<Row, { kind: 'tool' }>;
  policy: ChatPresentationPolicy;
}) {
  const [manual, setManual] = useProcessDisclosure<boolean | undefined>(
    row.callId,
    undefined,
  );
  const open =
    manual ??
    (policy.mode === 'verbose' ||
      policy.collapseTiming === 'next-input' ||
      (!row.result && policy.liveProcessDetail));
  return (
    <DisclosureRow
      icon={<IconApiOutlineRegular />}
      title={row.name}
      open={open}
      expandable
      expandOnRowClick
      onToggle={() => setManual(!open)}
      keepContentWhenOpen
      collapsedContent={`${row.result ? (row.result.failed ? '失败' : '已返回') : '结果尚未确认'}${row.truncated ? ' · 已截断' : ''}`}
    >
      <AssistantMarkdown
        text={row.result?.summary ?? row.activityDetail ?? '结果尚未确认'}
        allowRemoteImages={false}
      />
    </DisclosureRow>
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
  return (
    <>
      {(snapshot.window.omittedEvents > 0 ||
        snapshot.window.omittedRows > 0) && (
        <p>
          仅显示安全窗口，已省略 {snapshot.window.omittedEvents} 条事件、
          {snapshot.window.omittedRows} 行。
        </p>
      )}
      {!snapshot.stream.complete && <p role="status">当前实时文字不完整。</p>}
      {snapshot.rows.map((row) =>
        row.kind === 'tool' ? (
          <Tool key={row.seq} row={row} policy={policy} />
        ) : (
          <div key={row.seq}>
            <AssistantMarkdown text={row.text} allowRemoteImages={false} />
            {row.truncated && <small>文字已截断。</small>}
          </div>
        ),
      )}
      {snapshot.stream.active && (
        <div>
          <AssistantMarkdown
            text={snapshot.stream.active.text}
            streaming
            allowRemoteImages={false}
          />
          {snapshot.stream.active.truncated && <small>实时文字已截断。</small>}
        </div>
      )}
    </>
  );
}
