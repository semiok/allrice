# P28 / MET-141：发布准备交接与证据索引

2026-09-14。审查输入为 `35f6266c5826fd235493fcbd81c79ba0f74cb010`，**仅表示本次阅读的开发提交，不是最终候选 SHA、签名包或发布授权**。唯一排期仍以执行总表为准；本页只把 [P28 程序](p28-release-readiness.md)的准备交付与后续验收输入分开。

## 1. 141 交什么，142 再做什么

| 阶段               | 负责人                                              | 完成标准                                                                                | 不代表什么                                        |
| ------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 准备交付           | P28 / MET-141                                       | 清单合同、严格只读 checker、负向回归、迁移/恢复程序、证据索引与缺项负责人可审查并可复用 | 不要求未来产物或收据已经存在，不是 RC             |
| 固定候选与真实联验 | P27 / MET-142，P25/P26/P14 配合                     | 实际完整 SHA、干净构建、七份真实文件、准确迁移库存、逐项真实观察及修复后复验            | 一次 native smoke 不替代完整 Worker/业务/设备矩阵 |
| 候选材料检查       | P28 checker，由 P27 集成负责人调用                  | 对已提供的可信 manifest pin 核对 `prepare` / `dev` / `rc` 等材料条件                    | 检查器不执行测试，也不授予部署/迁移/开关权限      |
| 正式分发与环境发布 | P14 / MET-138、发布负责人；MET-143 提供签名外部条件 | 正式可信包实机证据、范围正确的独立批准、实际部署/冒烟回执                               | MET-141 Done 不解除任何实际安全门禁               |

**MET-141 的准备交付不依赖 MET-142 最终通过**；MET-142 使用本交接继续形成真实材料。检查器的 `preparationVerified` 是“某套实际候选材料的结构完整性”，不是 Linear 的“准备代码已交付”。草稿因 `sourceSha: null`、无真实包而拒绝 `prepare` 是正确行为，不应为了关闭 141 填假值；也不能反过来形成 141 等 142、142 又等 141 的循环。

若原工单另承诺真实签名、迁移执行或最终 RC，这些必须保留未完成并由项目负责人明确 scope；不能仅凭本页删掉。此处不变更 Linear 状态或依赖。

## 2. 可独立验收的准备交付清单

- [x] [草稿 manifest](p28-release-manifest.draft.json)：来源/产物/授权保留未填，14 个执行开关全部 false，`signedClientRequired=true`、`contractDeferred=true`。
- [x] [只读检查器](../../../scripts/acceptance/platform/p28-release-readiness.mjs)：精确 schema、trusted pin、路径和字节校验、47 场景、独立 Dev/租户/Prod 批准、7 天时效，不执行发布。
- [x] [负向测试](../../../scripts/acceptance/platform/p28-release-readiness.test.mjs)：假候选、缺签名/设备/断言、漏迁移、旧 reader、破坏性回退、未知开关及权限不得通过；本页索引与代码清单同步检查。
- [x] [迁移与恢复程序](p28-release-readiness.md)：expand/backfill/contract 分离；0093–0096 及后续库存不漏列；保留 prepared/dispatched、未知用量/费用、冻结价格与回执；无可信旧 reader 时仅前向修复。
- [x] 本交接索引：材料来源、执行负责人、固定观察要求及不能沿用的证据。
- [ ] 最终候选/正式包/真实矩阵/发布批准：见下表，**不属于“已完成准备项”的勾选范围**。

这些勾选只说明准备材料已经存在且可检查，不能复制进 `allrice-p27-evidence/v1` 当作 `real-execution` 回执。测试中的合成 receipt 也只能验证 parser。

## 3. 已有材料索引

| 材料                                                | 当前可用价值                                                      | 不能替代的证据                                 |
| --------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------- |
| [B5 集成历史](b5-integration-verification.md)       | 已交付基础能力及旧环境历史                                        | 最新 B6 包、兼容恢复或最终 Dev 结果            |
| [B6 集成历史](b6-integration-verification.md)       | 原批次各轮成功/失败及原始报告索引                                 | 同一最终候选的完整矩阵                         |
| [本轮收尾实测](b6-closeout-20260914.md)             | 本地/隔离 PG/native 合成协议、实际页面回归与 `7161caa` 候选记录   | 后续修改已全部复测、RC 或正式分发              |
| [P25 运行边界](p25-assistant-runtime-scope.md)      | 权限/两阶段准入/冻结价格及未知账务语义                            | 完整真实 Worker 后续月额度与真实 provider 成功 |
| [P26 工作台](p26-assistant-workbench.md)            | UI 会话隔离、刷新、迟到事件与停止确认边界                         | 真实模型/Worker 联合流程                       |
| [P27 基础 smoke 手册](p27-basic-assistant-smoke.md) | 显式 provider/SHA 授权、私有凭据解析、tariff/Token 对账和清理程序 | 全 P27/47 场景或供应商账单                     |
| [P14 可信更新](p14-trusted-updates.md)              | 实现、隔离/ad-hoc 包证据与实际缺口                                | Developer ID/公证成功及最终双架构升级验收      |

已记录的真实 Gemini 候选 `7161caad6e74ca6410ddc2539fa36ce85a07e782` **失败**：父 unknown、一个子 completed、一个子 partial，保留未知预留；完整时间、计量及脱敏回执摘要见本轮收尾实测。它证明实际执行发生，不是成功收据。不得将隔离有价 PG、synthetic loopback HTTP 或随后诊断改动升级为成功。后续结果由执行者独立补录，不覆盖历史失败。

这些文档是定位入口，不是 checker 接受的 receipt。保留材料必须使用专用脱敏 staging 根、相对路径、实际 SHA-256/字节数、候选身份、原始观察与批准记录，按程序独立核验。

### 本次只读核对过的原始报告位置

以下四份文件在本次交接审查时实际存在，已重新计算 SHA-256，与收尾记录一致；没有读取或复制凭据。前三个相对路径均相对于 `/Users/a123/allrice-b6-closeout-20260914/`，第四个为绝对临时路径。它们未转成正式 staging 收据，不因记录了路径/hash 就满足最终候选、产物或 7 天时效要求；临时文件消失后不能据索引宣称仍可读。

| 本地报告                                                             | 本次核对 SHA-256                                                   | 使用边界                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `.local/b6-closeout-tests-final.json`                                | `eacb9a7e0d66463600f74d114ea9d34881bcefbd4039159c3301f8421875beb3` | 产品源码停笔后的普通回归；2139 passed、801 条件跳过，不是后续改动全测 |
| `.local/b6-closeout-pg-final.json`                                   | `bf81eaea37b22ffd4825b921e145bfe36224b4d7b92000fbd86cf47a5e5518dd` | 281 个隔离 PG/native 合成端点测试，不是真实 Google                    |
| `.local/p27-assistants-a6fc4add-8288-48f1-a0c8-ee1cd08f7a23/03.json` | `d5a1cc8907d0354259e421bd56b11c22bab386df354c6851d081d4e553e9ed68` | `7161caa` 真实 Gemini 失败及确认清理，不能标 passed                   |
| `/tmp/allrice-p26-ui-Chng8r/evidence/checks.json`                    | `bab54a19b8c5657af2808958b64b5b3d2442fd6e049d917c7c2822da20e03447` | `7161caa` built Next/Chrome/PG 页面复验；无 Worker/模型调用           |

## 4. 尚需提交的实际输入

| 缺项                  | 提交负责人                                  | 需要的实际材料                                                                                         | 阻断范围                                      |
| --------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| 最终来源/构建         | P27 / MET-142                               | 干净完整 SHA、source 归档、lockfile、DSH upstream、Web BUILD_ID、Worker build、同版本 arm64/x64 最终包 | 实际候选 `prepare`；本页审查 SHA 不冒充最终值 |
| 发布者与更新信任      | P14 / MET-138，MET-143 / 发布负责人         | 正式 Team/bundle/更新验证公钥 pin；真实 Developer ID/公证/Gatekeeper 和可信元数据                      | 正式分发及 RC；ad-hoc 不替代                  |
| 双架构原生生命周期    | P14 / MET-138，P27 联验                     | 两台不同原生 Mac 的实际包安装、Keychain、排空、更新中断、恢复、撤权观察                                | 22 个客户端 RC 场景                           |
| 最终迁移库存/兼容恢复 | P25 / MET-139、P27 / MET-142                | 最终 SQL 字节及 phase；旧/新 reader、未知 hold/成本/价格回执保存与恢复演练                             | 迁移/恢复实测与真实发布                       |
| 真实助手闭环          | P25 / MET-139、P26 / MET-140、P27 / MET-142 | 首因诊断及失败修复后真实成功；全树费用回执、后续 Worker 月额度、实际 UI/撤权/取消/恢复联验             | 助手 RC 场景；基础 adapter 子集不够           |
| 四线与治理矩阵        | P27 / MET-142                               | 非客户端各场景逐项执行，不以历史局部报告改写日期                                                       | RC                                            |
| 真实环境批准/冒烟     | 发布负责人，P27 / MET-142                   | 分别绑定版本/租户/开关/迁移/恢复模式的批准及真实 Dev、canary 回执                                      | 对应 Dev/租户/Prod；RC 不授予发布             |

七个 artifact ID 是 `source`、`lockfile`、`dsh-upstream`、`web`、`worker`、`bridge-arm64`、`bridge-x64`。目前不填入假文件、假 hash 或新 release ID；没有安全旧包也不填伪 rollback target。

## 5. 47 个 RC 场景交接索引

以下是**待最终候选收据逐项覆盖的索引**，不是通过清单。固定断言以 checker `CASE_ASSERTIONS` 为权威；本表从该覆盖合同列出名称，不生成 expected/observed 或 receipt。执行负责人必须提交与断言对应的真实文件/退出码/进程/审批/副作用/页面/持久状态观察。

25 个联合场景绑定全部七份候选产物；22 个客户端场景绑定 source 与相应 ZIP，并分别带真实设备身份。兼容重部署还须绑定 `rollback/<id>` 实际目标摘要。签名项另核对发布者 Team/bundle；更新元数据项另核对真实更新验证公钥，这些动态身份断言不能用表中的布尔项替代。

| RC case ID                                              | 执行负责人    | 固定原始观察断言                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source-build-package-provenance`                       | P27 / MET-142 | `clean-pinned-checkout`、`archive-matches-source`、`all-artifacts-built-from-pinned-source`                                                                                                                                                                                            |
| `local-edit-diff-test-exit`                             | P27 / MET-142 | `actual-diff`、`actual-test-exit-code`、`user-changes-preserved`                                                                                                                                                                                                                       |
| `local-cancel-disconnect-approval-drift`                | P27 / MET-142 | `cancel-confirmed`、`disconnect-reconciled`、`changed-approved-input-rejected`                                                                                                                                                                                                         |
| `local-process-tree-isolation`                          | P27 / MET-142 | `out-of-root-denied`、`sensitive-access-denied`、`escaped-descendants-stopped`                                                                                                                                                                                                         |
| `cloud-no-bridge-reconciliation-download`               | P27 / MET-142 | `bridge-absent`、`deterministic-reference-match`、`download-reopened`                                                                                                                                                                                                                  |
| `cloud-container-destroy-artifact-read`                 | P27 / MET-142 | `container-destroyed`、`artifact-readable`、`wrong-tenant-denied`                                                                                                                                                                                                                      |
| `cloud-browser-actions-takeover-revoke`                 | P27 / MET-142 | `real-actions`、`takeover-stops-ai`、`revoked-no-side-effect`                                                                                                                                                                                                                          |
| `local-browser-actions-takeover-revoke`                 | P27 / MET-142 | `real-actions`、`takeover-stops-ai`、`personal-profile-not-used`、`revoked-no-side-effect`                                                                                                                                                                                             |
| `preview-reachable-stop-offline-malicious-isolation`    | P27 / MET-142 | `actual-target-reachability`、`stop-offline-closed`、`malicious-content-isolated`                                                                                                                                                                                                      |
| `cross-tenant-denial`                                   | P27 / MET-142 | `api-denied`、`artifact-denied`、`no-side-effects`                                                                                                                                                                                                                                     |
| `policy-revocation-frozen-config-audit`                 | P27 / MET-142 | `revocation-effective`、`running-snapshot-unchanged`、`audit-linked`                                                                                                                                                                                                                   |
| `budget-stop-and-unknown-no-replay`                     | P27 / MET-142 | `root-budget-enforced`、`stop-reason-accurate`、`unknown-not-replayed`                                                                                                                                                                                                                 |
| `old-bridge-http-wss-and-existing-session`              | P27 / MET-142 | `old-bridge-works`、`http-wss-no-double-execution`、`existing-sessions-preserved`                                                                                                                                                                                                      |
| `skill-contents-review-next-run-version`                | P27 / MET-142 | `real-resources-pinned`、`review-required`、`next-run-loads-approved-version`                                                                                                                                                                                                          |
| `workbench-version-feedback-revision-review`            | P27 / MET-142 | `version-bound-feedback`、`revision-created`、`new-review-required`                                                                                                                                                                                                                    |
| `workbench-duplicate-late-events-usage`                 | P27 / MET-142 | `no-false-terminal`、`no-duplicate-usage`、`refresh-consistent`                                                                                                                                                                                                                        |
| `assistants-real-dsh-two-children-no-bridge`            | P27 / MET-142 | `real-dsh`、`two-distinct-children`、`bridge-absent`、`results-and-artifacts-collected`、`frozen-price-and-whole-tree-cost-receipts`、`worker-follow-up-quota-available`                                                                                                               |
| `assistants-narrow-permissions-approval`                | P27 / MET-142 | `permission-intersection`、`exact-approval`、`no-expansion`                                                                                                                                                                                                                            |
| `assistants-root-budget-child-tree-cancel`              | P27 / MET-142 | `shared-root-budget`、`child-cancel-confirmed`、`whole-tree-cancel-confirmed`                                                                                                                                                                                                          |
| `assistants-outbox-checkpoint-cold-recovery`            | P27 / MET-142 | `durable-outbox`、`cold-recovery`、`no-duplicate-side-effects`、`prepared-grant-not-dispatch-proof`、`dispatch-ack-loss-no-model-replay`                                                                                                                                               |
| `assistants-partial-failure-artifact-conflict-refresh`  | P27 / MET-142 | `partial-failure-visible`、`conflict-not-overwritten`、`refresh-traceable`                                                                                                                                                                                                             |
| `unreleased-modes-all-entry-denial-single-agent`        | P27 / MET-142 | `ui-denied`、`language-denied`、`api-denied`、`single-agent-preserved`                                                                                                                                                                                                                 |
| `migration-expand-backfill-compatibility`               | P27 / MET-142 | `old-and-new-reader-compatible`、`backfill-idempotent-resumable`、`no-contract-in-first-release`、`assistant-model-admissions-expand-compatible`、`nullable-model-cost-readers-compatible`、`immutable-assistant-pricing-expand-compatible`                                            |
| `rollback-drain-reconcile-preserve-state`               | P27 / MET-142 | `drain-confirmed`、`unknown-reconciled-no-replay`、`state-preserved`、`current-credential-reader-preserved`、`prepared-and-dispatched-model-holds-preserved`、`model-dispatch-identity-not-replayed`、`unknown-usage-and-cost-not-zeroed`、`frozen-prices-and-call-receipts-preserved` |
| `dev-final-sha-login-history-downloads-flags-smoke`     | P27 / MET-142 | `deployed-sha-and-build-match`、`real-login`、`existing-history-preserved`、`both-download-hashes-match`、`flags-remain-off`                                                                                                                                                           |
| `client/arm64/developer-id-signature-notarization`      | P14 / MET-138 | `developer-id-valid`、`notarization-valid`、`gatekeeper-accepted`                                                                                                                                                                                                                      |
| `client/arm64/authenticated-update-metadata`            | P14 / MET-138 | `publisher-authenticated`、`metadata-signature-valid`、`replay-downgrade-rejected`                                                                                                                                                                                                     |
| `client/arm64/fresh-install-gui-pair-workspace`         | P14 / MET-138 | `fresh-install`、`gui-pair`、`native-workspace-selection`                                                                                                                                                                                                                              |
| `client/arm64/restart-without-repair`                   | P14 / MET-138 | `normal-launch`、`restart`、`pairing-and-directory-preserved`                                                                                                                                                                                                                          |
| `client/arm64/keychain-save-read-migration`             | P14 / MET-138 | `real-keychain-save`、`real-keychain-read`、`migration-preserves-identity`                                                                                                                                                                                                             |
| `client/arm64/credential-denial-partial-cleanup`        | P14 / MET-138 | `denial-visible`、`partial-cleanup-visible`、`no-credential-exposure`                                                                                                                                                                                                                  |
| `client/arm64/invalid-signature-and-package-rejection`  | P14 / MET-138 | `invalid-publisher-rejected`、`corrupt-package-rejected`、`no-install-side-effect`                                                                                                                                                                                                     |
| `client/arm64/update-drain-and-interruption`            | P14 / MET-138 | `active-task-drained`、`interruption-recovered`、`unknown-not-replayed`                                                                                                                                                                                                                |
| `client/arm64/compatible-rollback-preserves-state`      | P14 / MET-138 | `compatible-reader`、`pairing-preserved`、`journal-outbox-preserved`、`no-forced-repair`                                                                                                                                                                                               |
| `client/arm64/revoke-device-and-directory`              | P14 / MET-138 | `device-revocation-effective`、`directory-revocation-effective`、`no-late-side-effect`                                                                                                                                                                                                 |
| `client/arm64/local-command-changeset-cancel-isolation` | P14 / MET-138 | `real-native-architecture`、`actual-command-exit`、`changeset-user-changes-preserved`、`tree-cancel-confirmed`、`out-of-root-denied`、`no-cross-architecture-fallback`                                                                                                                 |
| `client/x64/developer-id-signature-notarization`        | P14 / MET-138 | `developer-id-valid`、`notarization-valid`、`gatekeeper-accepted`                                                                                                                                                                                                                      |
| `client/x64/authenticated-update-metadata`              | P14 / MET-138 | `publisher-authenticated`、`metadata-signature-valid`、`replay-downgrade-rejected`                                                                                                                                                                                                     |
| `client/x64/fresh-install-gui-pair-workspace`           | P14 / MET-138 | `fresh-install`、`gui-pair`、`native-workspace-selection`                                                                                                                                                                                                                              |
| `client/x64/restart-without-repair`                     | P14 / MET-138 | `normal-launch`、`restart`、`pairing-and-directory-preserved`                                                                                                                                                                                                                          |
| `client/x64/keychain-save-read-migration`               | P14 / MET-138 | `real-keychain-save`、`real-keychain-read`、`migration-preserves-identity`                                                                                                                                                                                                             |
| `client/x64/credential-denial-partial-cleanup`          | P14 / MET-138 | `denial-visible`、`partial-cleanup-visible`、`no-credential-exposure`                                                                                                                                                                                                                  |
| `client/x64/invalid-signature-and-package-rejection`    | P14 / MET-138 | `invalid-publisher-rejected`、`corrupt-package-rejected`、`no-install-side-effect`                                                                                                                                                                                                     |
| `client/x64/update-drain-and-interruption`              | P14 / MET-138 | `active-task-drained`、`interruption-recovered`、`unknown-not-replayed`                                                                                                                                                                                                                |
| `client/x64/compatible-rollback-preserves-state`        | P14 / MET-138 | `compatible-reader`、`pairing-preserved`、`journal-outbox-preserved`、`no-forced-repair`                                                                                                                                                                                               |
| `client/x64/revoke-device-and-directory`                | P14 / MET-138 | `device-revocation-effective`、`directory-revocation-effective`、`no-late-side-effect`                                                                                                                                                                                                 |
| `client/x64/local-command-changeset-cancel-isolation`   | P14 / MET-138 | `real-native-architecture`、`actual-command-exit`、`changeset-user-changes-preserved`、`tree-cancel-confirmed`、`out-of-root-denied`、`no-cross-architecture-fallback`                                                                                                                 |

Prod 另需 `tenant-canary-real-smoke`：发布负责人提交真实单租户、准确版本/开关及无跨租户变化的观察。它不在上述 47 个 RC 场景中，不得遗漏，也不得拿 RC 结论替代。

## 6. 交接顺序与缺项处理

1. 141 交付合同/索引/负向测试，登记真实缺项，不要求伪造材料先跑绿 `prepare`。
2. 142 集成负责人固定真实候选，构建七项材料并核对迁移，填新的正式待审查 manifest；草稿保留为草稿。
3. 对实际材料运行 `prepare`：成功只证明结构/字节/政策完整，签名和未执行场景仍列 `technicalBlockers`。结构拒绝则修正材料，不改 checker 门槛。
4. 逐项执行并审核原始观察；签名条件由 143 提供、138 实测。失败保留，修复后在准确候选重跑；无权访问/设备缺失继续登记，不伪造/跳过。
5. 最终 Dev 部署前按原 `dev` 规则检查独立批准，只允许其未来最终 Dev smoke 缺失，其他技术阻断仍拒绝。部署后补真实 Dev receipt，再判断 `rc`，不要求部署前先证明部署后结果。
6. RC 完整与否由142真实收据决定，租户/Prod 再走各自批准与 canary；不因141准备完成自动执行任何动作。

若尚无最终候选/签名/完整收据，正确交接是“MET-141 准备完成，MET-142/正式分发按缺项继续”，不是“RC 通过”。这以原工单确属准备 scope 为前提，最终状态由项目负责人按原验收定义确认。

## 7. 本次准备材料自测

`pnpm exec vitest run scripts/acceptance/platform/p28-release-readiness.test.mjs --maxWorkers=1`：2026-09-14 21:35:46，**28/28 通过**，4.09 秒。新增交接索引与 47 个 case/固定断言/本地文档链接的一致性检查；强化 `prepare` 可以独立成立时仍完整报告 47 个缺证项且所有执行/授权字段为 false。原草稿拒绝、RC/正式签名、默认关闭、独立授权和安全拒绝测试保留。

这只验证准备文档/合同/parser，不运行发布、不接触真实租户、不调用 provider。未改 checker 生产判断逻辑；最终候选/包/矩阵收据仍未在草稿中填入。
