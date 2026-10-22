'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  ExperienceCandidateSchema,
  ExperienceDraftBatchSchema,
  ExperienceOverviewSchema,
  type ExperienceOverview,
  type ExperienceSummary,
  type ExperienceCandidate,
  type ExperienceDraftBatch,
} from '@allrice/contracts';
import styles from './experience.module.css';
import { ExperienceSources } from './experience-provenance';

const scopeNames = {
  private: '仅我自己',
  workspace: '原工作区共享',
  platform: '历史平台建议 · 未发布',
};
async function response(request: Promise<Response>) {
  const r = await request;
  const v = await r.json().catch(() => ({}));
  if (!r.ok)
    throw Error(
      r.status === 404
        ? '当前经验记录不可用，请重新打开或核对访问权限。'
        : '读取或撤回未完成，请稍后重试。',
    );
  return v;
}
export function ExperienceReviewCard({
  candidate,
  onWithdraw,
}: {
  candidate: ExperienceCandidate;
  onWithdraw?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const withdraw = async () => {
    setBusy(true);
    setError('');
    try {
      await onWithdraw?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : '撤回失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className={styles.card} data-candidate-id={candidate.id}>
      <div className={styles.heading}>
        <strong>{scopeNames[candidate.scope]}</strong>
        <span>
          {candidate.archived
            ? '已归档 · 不再采用'
            : candidate.status === 'rejected'
              ? '已拒绝'
              : candidate.originKind === 'incremental'
                ? candidate.consolidatedAt
                  ? '工作反馈 · 已整理'
                  : '工作反馈 · 待整理'
                : candidate.status === 'approved'
                  ? '历史经验 · 已启用'
                  : '历史候选 · 未启用'}{' '}
          · v{candidate.revision}
        </span>
      </div>
      <p className={styles.rule}>{candidate.content}</p>
      {candidate.originKind === 'incremental' && (
        <p>
          {candidate.consolidatedAt
            ? '已用于自动整理，实际形成的经验及生效状态见整理记录。'
            : '这是原始反馈，尚未形成可采用的经验。'}
        </p>
      )}
      {candidate.source ? (
        <details>
          <summary>查看私密来源</summary>
          <p className={styles.rule}>{candidate.source.excerpt}</p>
          <small>
            Run {candidate.source.runId} · 消息 {candidate.source.messageId}
          </small>
          {candidate.evidence && (
            <p>
              保留 {candidate.evidence.artifacts.length} 份成果版本和{' '}
              {candidate.evidence.skills.length} 项实际技能加载依据。
            </p>
          )}
        </details>
      ) : (
        <p>原始私密对话未共享给查看人。</p>
      )}
      {candidate.status === 'approved' && !candidate.archived && (
        <p>
          后续相关新任务可采用 v{candidate.revision}；正在执行的快照不会改写。
        </p>
      )}
      {candidate.reviewReason && <p>历史处理说明：{candidate.reviewReason}</p>}
      {candidate.ownedByMe && !candidate.archived && onWithdraw && (
        <button type="button" disabled={busy} onClick={() => void withdraw()}>
          {busy
            ? '正在撤回…'
            : candidate.originKind === 'incremental'
              ? '忘掉这条反馈'
              : '撤回这条记录'}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </article>
  );
}
export function ExperienceDraftCard({
  batch,
  sourceContext,
  activeOnly = false,
}: {
  activeOnly?: boolean;
  batch: ExperienceDraftBatch;
  sourceContext?: { workspaceId: string; headers?: Record<string, string> };
}) {
  return (
    <article className={styles.card} data-experience-batch={batch.id}>
      <strong>
        {batch.adoptions?.some((a) => a.state === 'active')
          ? '私人经验 · 已采用'
          : batch.adoptions?.length
            ? '私人经验 · 已停用'
            : batch.status === 'succeeded' && batch.drafts.length === 0
              ? batch.sourceIds.length
                ? '未形成新经验'
                : '本次没有新增反馈'
              : batch.state === 'pending_validation'
                ? batch.validations?.length
                  ? '经验草稿 · 尚未启用'
                  : '经验草稿 · 待验证'
                : batch.status === 'failed' || batch.status === 'canceled'
                  ? '本次整理未完成'
                  : batch.status === 'succeeded'
                    ? batch.sourceIds.length
                      ? '未形成新经验'
                      : '本次没有新增反馈'
                    : '正在整理'}
      </strong>
      <p>
        {new Date(batch.createdAt).toLocaleString('zh-CN')} ·{' '}
        {batch.sourceIds.length} 条私有反馈
      </p>
      {batch.sourceState === 'unavailable' && (
        <p>来源或访问权限已变化，仅保留历史；不会据此新增采用。</p>
      )}
      {batch.drafts.map((draft, index) =>
        activeOnly &&
        !batch.adoptions?.some(
          (adoption) =>
            adoption.draftIndex === index && adoption.state === 'active',
        ) ? null : (
          <section key={index}>
            <p className={styles.rule}>{draft.rule}</p>
            <p>适用范围：{draft.applicability}</p>
            {batch.adoptions
              ?.filter(
                (a) =>
                  a.draftIndex === index &&
                  (!activeOnly || a.state === 'active'),
              )
              .map((a) => (
                <div key={a.memoryId} data-experience-adoption={a.memoryId}>
                  <p>
                    {a.state === 'active'
                      ? '已采用 · 仅用于此私人 AI 员工'
                      : a.state === 'forgotten'
                        ? '已撤回 · 不再采用'
                        : '已停用 · 依据已变化'}
                  </p>
                  <p>
                    {a.reason ??
                      `版本 ${a.revision} · 已为 ${a.recallCount} 次任务提供经验`}
                  </p>
                  {a.state === 'active' && (
                    <p>
                      如需撤回，可在聊天中说：请忘记“{draft.rule}”这条个人经验。
                    </p>
                  )}
                  {a.state === 'active' && sourceContext && (
                    <ExperienceSources
                      {...sourceContext}
                      instanceId={batch.instanceId}
                      memoryId={a.memoryId}
                      revision={a.revision}
                    />
                  )}
                </div>
              ))}
            {batch.validations
              .filter((v) => v.draftIndex === index)
              .map((v) => (
                <div key={v.id} data-experience-validation={v.id}>
                  <p>
                    {v.validationStatus === 'passed'
                      ? batch.adoptions?.some((a) => a.draftIndex === index)
                        ? '专项样例通过'
                        : '专项样例通过 · 尚未启用'
                      : v.validationStatus === 'failed'
                        ? '专项验证未通过 · 未启用'
                        : v.validationStatus === 'not_verified'
                          ? '验证未完成 · 未启用'
                          : '专项验证中 · 未启用'}
                  </p>
                  <p>
                    {batch.adoptions?.some((a) => a.draftIndex === index)
                      ? v.coverage.replace('，尚未启用。', '。')
                      : v.coverage}
                  </p>
                  <details>
                    <summary>查看验证依据</summary>
                    <p>
                      验证任务：{v.runId ?? '等待执行'}；原稿版本：
                      {batch.revision}
                    </p>
                    <p>原稿校验值：{v.outputDigest}</p>
                    {v.assertion?.checks.map((c) => (
                      <p key={c.id}>
                        {c.id}：{c.passed ? '通过' : '未通过'}
                      </p>
                    ))}
                  </details>
                </div>
              ))}
            <details>
              <summary>查看整理依据</summary>
              <p>{draft.reason}</p>
              <p>
                {draft.confidence === 'consistent'
                  ? '多条反馈一致；采用状态以验证结果为准。'
                  : '初步提炼；采用状态以验证结果为准。'}
              </p>
              <small>来源：{draft.sourceIds.join('、')}</small>
              {(batch.skillDependencies ?? []).map((pin) => (
                <p key={`${pin.bindingId}/${pin.versionId}`}>
                  本批来源使用的个人技能版本：{pin.versionId}；校验值：
                  {pin.packageChecksum ?? pin.definitionChecksum}
                  。仅当前仍有权限且版本匹配时可采用。
                </p>
              ))}
            </details>
          </section>
        ),
      )}
      {batch.validationNotes.map((note, index) => (
        <p key={index}>{note}</p>
      ))}
      {batch.state === 'pending_validation' && batch.drafts.length === 0 && (
        <p>本批反馈暂不适合形成长期经验，原始记录已保留。</p>
      )}
      {batch.errorCode && batch.status !== 'succeeded' && (
        <p>未启用任何新经验；来源已保留。</p>
      )}
    </article>
  );
}
const frequencyNames = {
  off: '已关闭',
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
};
const outcomeNames = {
  queued: '等待整理',
  running: '正在整理',
  failed: '整理未完成',
  canceled: '整理已停止',
  no_sources: '没有新增反馈',
  no_draft: '未形成新经验',
  drafted: '已形成经验草稿',
};
const dateText = (value: string | null, timezone: string) =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'short',
        timeStyle: 'short',
        timeZone: timezone,
      }).format(new Date(value))
    : '暂无';
export function ExperienceSummaryCard({
  summary,
  shared = false,
}: {
  summary: ExperienceSummary;
  shared?: boolean;
}) {
  const { policy, schedule, counts } = summary;
  const frequency = frequencyNames[policy.frequency];
  const scheduleText = {
    off: '自动整理已关闭',
    not_scheduled: counts.pendingSources ? '等待后台安排' : '等待新增反馈',
    scheduled: '已安排自动整理',
    preparing: '正在准备自动整理',
    paused: '自动整理已暂停',
    unavailable: '员工暂不可用，保留历史记录',
  }[schedule.state];
  return (
    <section className={styles.card} aria-label="经验整理概况">
      <div className={styles.heading}>
        <strong>经验整理</strong>
        <span>{scheduleText}</span>
      </div>
      <dl className={styles.summary}>
        <div>
          <dt>整理频率</dt>
          <dd>
            {frequency}
            {policy.frequency !== 'off' && (
              <>
                {' '}
                ·{' '}
                {policy.frequency === 'weekly'
                  ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][
                      policy.weekday
                    ]
                  : policy.frequency === 'monthly'
                    ? `${policy.monthDay} 日（不足则月底）`
                    : ''}{' '}
                {policy.time}
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>配置来源</dt>
          <dd>
            {policy.source === 'company' ? '公司设置' : '平台默认'} · v
            {policy.revision}
          </dd>
        </div>
        <div>
          <dt>最近整理记录</dt>
          <dd>
            {schedule.lastOccurrence
              ? `${outcomeNames[schedule.lastOccurrence.outcome]} · ${dateText(schedule.lastOccurrence.createdAt, policy.timezone)}`
              : '尚无整理记录'}
          </dd>
        </div>
        <div>
          <dt>下次整理</dt>
          <dd>
            {schedule.nextRunAt
              ? dateText(schedule.nextRunAt, policy.timezone)
              : scheduleText}
          </dd>
        </div>
        <div>
          <dt>待整理反馈</dt>
          <dd>{counts.pendingSources} 条</dd>
        </div>
        <div>
          <dt>待验证草稿</dt>
          <dd>{counts.awaitingValidation} 条</dd>
        </div>
        <div>
          <dt>累计采用</dt>
          <dd>{counts.adoptedTotal} 条</dd>
        </div>
      </dl>
      <p>按 {policy.timezone} 显示。没有新增反馈时不会调用模型整理。</p>
      <p>
        {policy.adoptionMode === 'supported_private'
          ? '通过支持的验证后可自动采用，具体生效状态见每条经验。'
          : '当前保留整理草稿，未开启自动采用。'}
        累计采用包含后来停用或撤回的记录。
      </p>
      {shared && (
        <p>仅显示整理配置和汇总；私人反馈、经验内容及技能版本仅本人可见。</p>
      )}
      <details>
        <summary>查看调度信息</summary>
        <p>
          最近调度检查：{dateText(schedule.lastCheckedAt, policy.timezone)}
          ；检查不代表已调用模型或整理成功。
        </p>
      </details>
    </section>
  );
}

type ExperiencePanelProps = {
  workspaceId: string;
  sessionId?: string;
  instanceId?: string;
  scopeId?: string;
  headers?: Record<string, string>;
  embedded?: boolean;
  readOnly?: boolean;
};
export function ExperiencePanel(props: ExperiencePanelProps) {
  return (
    <ExperienceReader
      key={`${props.scopeId ?? props.workspaceId}/${props.instanceId ?? props.sessionId ?? 'history'}`}
      {...props}
    />
  );
}
function ExperienceReader({
  workspaceId,
  instanceId,
  headers,
  embedded = false,
  readOnly = false,
}: ExperiencePanelProps) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    attempt: number;
    candidates?: ExperienceCandidate[];
    batches?: ExperienceDraftBatch[];
    overview?: ExperienceOverview | null;
    error?: string;
  }>();
  const suffix = `?workspaceId=${encodeURIComponent(workspaceId)}${instanceId ? `&instanceId=${encodeURIComponent(instanceId)}` : ''}`;
  const current = result?.attempt === attempt ? result : undefined;
  useEffect(() => {
    const controller = new AbortController();
    void response(
      fetch(`/api/v1/experiences${suffix}`, {
        cache: 'no-store',
        signal: controller.signal,
        headers,
      }),
    )
      .then((value) => {
        const overview = value.overview
          ? ExperienceOverviewSchema.parse(value.overview)
          : null;
        if (
          instanceId &&
          (!overview ||
            overview.workspaceId !== workspaceId ||
            overview.instanceId !== instanceId)
        )
          throw Error('员工经验读取目标已变化，请重新打开。');
        const candidates = ExperienceCandidateSchema.array().parse(
          value.candidates,
        );
        const batches = ExperienceDraftBatchSchema.array().parse(
          value.draftBatches ?? [],
        );
        if (
          instanceId &&
          (candidates.some((c) => c.instanceId !== instanceId) ||
            batches.some((b) => b.instanceId !== instanceId))
        )
          throw Error('员工经验读取目标已变化，请重新打开。');
        if (!controller.signal.aborted)
          setResult({ attempt, candidates, batches, overview });
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setResult({ attempt, error: e.message });
      });
    return () => controller.abort();
  }, [attempt, suffix, headers, instanceId, workspaceId]);
  const refresh = () => setAttempt((value) => value + 1);
  return (
    <section className={`${styles.page} ${embedded ? styles.embedded : ''}`}>
      {!embedded && (
        <>
          <Link href="/chatflow">← 返回工作台</Link>
          <h1>经验积累</h1>
        </>
      )}
      <p>
        根据有依据的工作反馈自动整理。需要纠正或忘掉经验时，直接在聊天中说明；一次性要求不会自动成为长期规则。
      </p>
      {current?.error ? (
        <p role="alert">{current.error}</p>
      ) : !current ? (
        <p role="status">正在读取经验记录…</p>
      ) : (
        <>
          {current.overview && (
            <ExperienceSummaryCard summary={current.overview.summary} />
          )}
          <section aria-label="自动整理记录">
            <h2>自动整理记录</h2>
            <p>最近 50 次整理，保留来源、验证结果和当前采用状态。</p>
            {current.batches?.map((batch) => (
              <ExperienceDraftCard
                key={batch.id}
                batch={batch}
                sourceContext={{ workspaceId, headers }}
              />
            ))}
            {!current.batches?.length && (
              <p>尚无整理记录。有新增且符合策略的反馈后，会按生效频率安排。</p>
            )}
          </section>
          <section aria-label="反馈与历史记录">
            <h2>反馈与历史记录</h2>
            <p>
              显示最近的 100
              条记录，未处理反馈优先。旧人工候选保留为历史，不会自动启用。
            </p>
            {current.candidates?.map((candidate) => (
              <ExperienceReviewCard
                key={`${candidate.id}/${candidate.revision}/${candidate.archived}`}
                candidate={candidate}
                onWithdraw={
                  readOnly
                    ? undefined
                    : async () => {
                        const response = await fetch(
                          `/api/v1/memories/${encodeURIComponent(candidate.id)}?workspaceId=${encodeURIComponent(workspaceId)}`,
                          { method: 'DELETE', headers },
                        );
                        if (!response.ok)
                          throw Error('撤回未完成，请重新读取后确认。');
                        refresh();
                      }
                }
              />
            ))}
            {!current.candidates?.length && <p>暂无反馈与历史记录。</p>}
          </section>
        </>
      )}
      <button type="button" onClick={refresh}>
        重新读取
      </button>
    </section>
  );
}
