# 每晚 main 全量 CI

`CI`（`.github/workflows/ci.yml`）每天 UTC 18:23，即北京时间次日 02:23，
在 main 复用原来的四门定义。GitHub schedule 可能延迟或在平台高负载时丢失；实际受测提交以 run 的
`head_sha` 为准。每晚不计 AllRice 4.0 的 10 个节点，也不作为 PR 的新增阻塞检查。
schedule 使用独立 run ID concurrency 分组，不取消 push、PR 或其他 nightly。
PR/push 的审计基线沿旧值，schedule 没有 before/base，使用受测 HEAD 的第一父提交。

`Nightly CI Summary`（`nightly-ci-summary.yml`）在同仓库 scheduled main `CI`
进入 completed 后运行，包括失败和取消。它不调用测试、模型、M5、QA 或 rerun。
所有结果固定读取 source run 的 **attempt 1**；之后人为补跑不会覆盖首败，
`triggerAttempt` 记录哪个 attempt 触发了本次收集。原始 artifact 和摘要保留 14 天。

看护可通过固定 workflow 文件名和 artifact 名读取：

```bash
nightly_run=$(gh run list -R semiok/allrice --workflow ci.yml --event schedule --branch main --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view "$nightly_run" -R semiok/allrice --json createdAt,headSha,status,conclusion
summary_run=$(gh run list -R semiok/allrice --workflow nightly-ci-summary.yml --event workflow_run --limit 100 --json databaseId,displayTitle --jq ".[] | select(.displayTitle == \"Nightly CI $nightly_run attempt 1\") | .databaseId" | head -1)
gh run download "$summary_run" -R semiok/allrice --name "nightly-ci-summary-$nightly_run-1" --dir "nightly-$nightly_run"
jq '{status,headSha,runId,runAttempt,sourceConclusion,evidenceComplete,failureKind,firstFailureUrl,failedTests,failedSteps,evidenceProblems}' "nightly-$nightly_run/summary.json"
```

读取时必须核对 `summary.runId == nightly_run`、`runAttempt == 1`、`headSha`
及 artifact 名，并核对 source run 的 `createdAt` 属于目标北京时间夜次。
缺 run、run 过旧或 nightly 尚未完成时没有本夜通过证据，不得沿用上一晚的绿结果。
若最新 summary workflow 属于另一个 source run，下载指定 artifact 会失败；
用 `gh api repos/semiok/allrice/actions/runs/<summary_run>/artifacts`
按 `nightly-ci-summary-<nightly_run>-1` 找到对应摘要运行再取，不重跑 CI。

`summary.json` 的 `status` 只有 success/failure。只有源 attempt 1、四门全部成功、
完整 gate receipts 和三个测试门的原批 JSON/instances 身份及结果都通过校验才能 success。
schedule receipt 使用独立 `allrice.repository-nightly-ci.v1` scope；push/PR 的
`allrice.repository-ci.v1` 及产品侧合同保持原语义，nightly 原件不作为发布凭据。
每个原始 ZIP 先核 API 的 source run/repository/head、大小和 SHA256，再只读 JSON；
不执行 artifact 内的代码。`source-api.json` 与原 ZIP 一并保留便于核验。

`failedTests` 只取现有 Vitest 原始 `testResults[].assertionResults[]` 的 failed 项，
包含测试名、文件、原件位置和 job 链接。Node 自测、Python unittest、构建、安装等
门禁没有这份结构化测试名时，保留 `failedSteps` 和首败 step/job 链接，
`evidenceComplete=false`；空 `failedTests` 不代表零个失败。取消、超时、缺原件、
摘要收集 API/校验失败均记 failure，不伪造测试名，不自动补跑。

次晨所属线查看首败并保留原件；无关不稳定项只按用户“补跑一次”的单独授权处理，
产品问题在当批修。看护读取和向规划线汇总由现有看护负责；本实现不增加常驻同步器、
通知发送、隔离规则或自动修复。平台在 checkout/runner 启动前失败而未产摘要时，
缺摘要本身视为缺证，不能判绿。

GitHub 的 schedule/default-branch 与 workflow_run completed 语义见
[事件文档](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)，
原件下载见 [GitHub CLI 文档](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts?tool=cli)。
