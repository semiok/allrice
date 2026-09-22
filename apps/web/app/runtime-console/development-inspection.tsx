import type { TenantDevelopmentInspection } from '@allrice/contracts';

export function DevelopmentInspection({
  data,
}: {
  data: TenantDevelopmentInspection;
}) {
  const version = (candidateId: string, digest: string) =>
    candidateId === data.candidateId && digest === data.digest
      ? '当前候选'
      : '历史候选（不证明当前版本）';
  return (
    <section aria-label="开发协作证据链">
      <h4>开发协作证据链 · 只读</h4>
      <p>
        当前候选 v{data.revision}：{data.candidateId}
      </p>
      <p>
        SHA：<code>{data.digest}</code>
      </p>
      <p>
        以下为已记录证据，不是执行授权或文件已落盘的证明。测试、审查及交付必须对应同一候选版本。
      </p>
      <h5>提案作者</h5>
      {data.proposals.length ? (
        data.proposals.map((p) => (
          <p key={p.artifactId}>
            作者 Run {p.authorRunId} · {p.accepted ? '已纳入候选' : '未合入'} ·
            工件 {p.artifactId} · SHA {p.digest}
          </p>
        ))
      ) : (
        <p>尚无提案记录</p>
      )}
      <h5>实际沙箱测试</h5>
      {data.tests.length ? (
        data.tests.map((t) => (
          <p key={t.operationId}>
            {version(t.candidateId, t.digest)} · 测试者 Run {t.testerRunId} ·
            Operation {t.operationId} · {t.status} ·{' '}
            {t.evidenceMatched
              ? `回执已匹配，退出码 ${t.exitCode ?? '未知'}（${t.reason}）`
              : '尚无匹配的完整测试回执'}{' '}
            · SHA {t.digest}
          </p>
        ))
      ) : (
        <p>尚无候选版本测试操作；模型文字不能代替真实回执</p>
      )}
      <h5>独立审查</h5>
      {data.reviews.length ? (
        data.reviews.map((r) => (
          <p key={r.id}>
            {version(r.candidateId, r.digest)} · 审查者 Run {r.reviewerRunId} ·{' '}
            {r.verdict === 'accept' ? '接受' : '要求修改'} · 测试 Operation{' '}
            {r.operationId} · SHA {r.digest} · {r.summary}
          </p>
        ))
      ) : (
        <p>尚无独立审查记录</p>
      )}
      <h5>根任务交付</h5>
      {data.deliveries.length ? (
        data.deliveries.map((d) => (
          <p key={d.artifactId}>
            {version(d.candidateId, d.digest)} · 已记录交付工件 {d.artifactId} ·
            审查 {d.reviewId} · SHA {d.digest}
          </p>
        ))
      ) : (
        <p>尚无正式开发交付记录</p>
      )}
      {data.truncated ? (
        <p>每类最多展示最近 64 条；这不是完整审计导出。</p>
      ) : null}
    </section>
  );
}
