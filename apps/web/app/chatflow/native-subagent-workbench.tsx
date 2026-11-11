'use client';

import { useLayoutEffect, useState } from 'react';
import type { NativeSubagentSummary } from '@allrice/contracts';
import {
  nativeSubagentEntryState,
  nativeSubagentElapsedMs,
  nativeSubagentReferencedEntry,
  nativeSubagentTabId,
  type NativeSubagentEntry,
  type NativeSubagentReference,
  type NativeSubagentViewScope,
} from '../../lib/chatflow/native-subagent-view';
import { AssistantMarkdown } from './assistant-markdown';
import { NativeSubagentProcess } from './native-subagent-process';
import type { NativeSubagentSnapshot } from './native-subagent-follow';
import { useNativeSubagentFollow } from './use-native-subagent-follow';
import type { useNativeSubagents } from './use-native-subagents';
import type { ChatPresentationPolicy } from './dsh-upstream/presentation/presentation-policy';
import { WorkbenchIcon } from './workbench-modules';
import css from './native-subagent-directory.module.css';

type Props = {
  scope: NativeSubagentViewScope;
  reference: NativeSubagentReference;
  active: boolean;
  observation: ReturnType<typeof useNativeSubagents>;
  headers: Record<string, string>;
  presentation: ChatPresentationPolicy;
  employeeName?: string;
};
type Child = Extract<NativeSubagentEntry, { kind: 'child' }>;

function ReadingNotice({
  text = '当前活动状态未知，请重新读取摘要。',
}: {
  text?: string;
}) {
  return (
    <p className={css.message} role="status">
      {text}
    </p>
  );
}

/** A tab can stay mounted; only its active, currently verified child observes. */
export function NativeSubagentWorkbench(props: Props) {
  const { scope, reference, active, observation, headers } = props;
  if (!active) return null;
  const headersMatch =
    headers['x-allrice-organization-id'] === scope.organizationId &&
    headers['x-allrice-workspace-id'] === scope.workspaceId;
  const read = headersMatch ? observation.reads[scope.sessionId] : null;
  const summary = read && read !== 'error' ? read : null;
  const entry = nativeSubagentReferencedEntry(scope, reference, summary);
  return (
    <section
      className={css.workbench}
      aria-label="子智能体工作过程"
      data-native-subagent-id={reference.id}
    >
      {entry && summary ? (
        entry.kind === 'diagnostic' ? (
          <ReadingNotice text={nativeSubagentEntryState(summary, entry).text} />
        ) : (
          <ActiveSubagent
            key={nativeSubagentTabId(reference)}
            {...props}
            summary={summary}
            child={entry}
          />
        )
      ) : (
        <ReadingNotice
          text={
            read === 'error'
              ? observation.disconnected?.[scope.sessionId]
                ? '实时观察已断开，重试。'
                : '暂时无法读取摘要，请刷新。'
              : undefined
          }
        />
      )}
    </section>
  );
}

function ActiveSubagent(
  props: Props & { summary: NativeSubagentSummary; child: Child },
) {
  const { observation } = props;
  // A diagnostic from the hot read unmounts its observer in the same commit.
  // A new authorized baseline revision may then start a fresh read.
  const [stopped, setStopped] = useState<{ revision: number; text?: string }>();
  if (stopped?.revision === observation.revision)
    return <ReadingNotice text={stopped.text} />;
  return (
    <ObservedSubagent
      {...props}
      onInvalid={(text) => setStopped({ revision: observation.revision, text })}
    />
  );
}

function ObservedSubagent({
  scope,
  reference,
  summary,
  child,
  headers,
  observation,
  presentation,
  employeeName,
  onInvalid,
}: Props & {
  summary: NativeSubagentSummary;
  child: Child;
  onInvalid: (text?: string) => void;
}) {
  const follow = useNativeSubagentFollow(
    scope.workspaceId,
    scope.sessionId,
    headers,
    summary,
    child.id,
    String(observation.revision),
  );
  const hot =
    follow.view && typeof follow.view === 'object' ? follow.view : null;
  const receivedSummary = hot && 'descendants' in hot ? hot : null;
  const receivedEntry = receivedSummary
    ? nativeSubagentReferencedEntry(scope, reference, receivedSummary)
    : undefined;
  const prepared =
    summary.root.source !== 'live' || child.observation.source !== 'live';
  const currentSummary = prepared ? summary : (receivedSummary ?? summary);
  const entry = nativeSubagentReferencedEntry(scope, reference, currentSummary);
  const invalid = !!receivedSummary && receivedEntry?.kind !== 'child';
  useLayoutEffect(() => {
    if (invalid)
      onInvalid(
        receivedEntry
          ? nativeSubagentEntryState(receivedSummary!, receivedEntry).text
          : undefined,
      );
  }, [invalid, receivedEntry, receivedSummary, onInvalid]);
  if (invalid)
    return (
      <ReadingNotice
        text={
          receivedEntry
            ? nativeSubagentEntryState(receivedSummary!, receivedEntry).text
            : undefined
        }
      />
    );
  if (follow.view === 'error')
    return <ReadingNotice text="暂时无法读取摘要，请刷新。" />;
  if ((follow.enabled && !hot) || entry?.kind !== 'child')
    return <ReadingNotice />;
  return (
    <SubagentBody
      child={entry}
      summary={currentSummary}
      snapshot={!prepared && hot && 'rows' in hot ? hot : null}
      presentation={presentation}
      employeeName={employeeName}
    />
  );
}

function SubagentBody({
  child,
  summary,
  snapshot,
  presentation,
  employeeName = 'AI 员工',
}: {
  child: Child;
  summary: NativeSubagentSummary;
  snapshot: NativeSubagentSnapshot | null;
  presentation: ChatPresentationPolicy;
  employeeName?: string;
}) {
  const state = nativeSubagentEntryState(summary, child);
  const task = snapshot?.task?.text ?? child.task;
  const elapsed = nativeSubagentElapsedMs(summary, child);
  return (
    <>
      <header className={css.childHead}>
        <span className={css.childIdentity}>
          <WorkbenchIcon kind="subagent" />
          <span>
            {employeeName} · 子智能体
            <span className={css.childName}>{child.label ?? child.id}</span>
          </span>
        </span>
        <span className={css.status} data-state={state.state}>
          <span className={css.stateDot} aria-hidden />
          <span>{state.text}</span>
          {elapsed !== undefined && (
            <span>· {Math.floor(elapsed / 1000)}秒</span>
          )}
        </span>
      </header>
      <div className={css.childBody}>
        <div className={css.taskMessage} aria-label="交给子智能体的任务">
          <p>{task ?? '暂无自有任务记录'}</p>
          {snapshot?.task?.truncated && <small>文字已截断。</small>}
        </div>
        <div className={css.assistantLabel}>
          <WorkbenchIcon kind="subagent" />
          {child.label ?? child.id}
        </div>
        {snapshot ? (
          <NativeSubagentProcess
            key={`${snapshot.childId}/${snapshot.hostEpoch}/${snapshot.stream.instanceId}`}
            snapshot={snapshot}
            policy={presentation}
          />
        ) : child.lastReply ? (
          <div className={css.childReply}>
            <AssistantMarkdown
              text={child.lastReply}
              allowRemoteImages={false}
            />
            {child.lastReplyTruncated && <small>最后回复已截断。</small>}
          </div>
        ) : (
          <ReadingNotice text="暂无回复" />
        )}
      </div>
    </>
  );
}
