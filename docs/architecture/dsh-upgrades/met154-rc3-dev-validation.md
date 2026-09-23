# MET-154 PR-4：rc.3 Dev 发布与真实验收

验证日期：2026-09-24（Asia/Shanghai）。关联 [MET-154](https://linear.app/metasnowsky/issue/MET-154)、[复用清单](../dsh-reuse-and-replacement.md)、[兼容边界](met154-rc3-compatibility.md)。机器可读结果见 [验收摘要](met154-rc3-dev-evidence.json)。

**Dev 已部署，普通任务、旧会话、等待及重启恢复通过；MET-144 开发交付实测尚未完成，MET-154 不能关单。** 本记录不代表 Prod 晋级；`distribution.json` 继续保持候选渠道和 `rollback=null`。

## 固定产物与集成

- [#92](https://github.com/semiok/allrice/pull/92)、[#93](https://github.com/semiok/allrice/pull/93)、[#94](https://github.com/semiok/allrice/pull/94) 已依次合并。合并后 main 为 `c3d44e1404c8b3f6b75c26bfc76df429a4649e50`，与候选 `9e6ccca4b9475e0fd945c1151e9ac3241cb97485` 文件树相同；[main CI 通过](https://github.com/semiok/allrice/actions/runs/35888178761)。
- Dev Web / Worker 实际运行独立 release 目录中的 `9e6ccca`，冻结锁安装及全仓构建完成；[候选 CI](https://github.com/semiok/allrice/actions/runs/35884115053) 四项通过。不能把本验收文档后续提交的 SHA 当作已部署代码。
- 原 Dev SHA 为 `add83cbbbf5df2c78578596ed0070af5e3d30e76`，原发布目录和会话目录保留。候选使用另行复制的 `dsh-runtime-met154-rc3`。DSH 管理服务同步使用同一候选及独立 `dsh-admin-met154-rc3`，凭据路径不变。
- Web / Worker 本地 readiness、Snow 和管理后台公网 readiness 均通过，Web 返回确切候选 SHA。DSH 管理网页真实 Chrome 登录及原生 UI/API 加载通过，无页面脚本错误或被拒绝的 API 请求；原生端口未认证仍返回 401，网关未向浏览器下发原生认证 cookie。

## 发布前盘点与配置处理

先停止 Dev Web 新建入口，再核对并停止旧 Worker。该时点可执行/等待的队列任务、平台试用、活跃操作租约均为 0，74 个旧 DSH runtime 均已 offline。保存数据库、存储、DSH 会话、平台 home、启动配置及原发布身份。

数据库仍保留 8 个 `cancel_requested`、2 个 `unknown` 助手，以及 3 个 `running` 子 Run；其根任务和对应队列任务早已失败，没有活跃租约或原生进程。它们被列为历史未决记录，未改成成功/停止，未重放、迁移在途执行或释放未知用量。本次“无在途可执行任务”不等于所有历史行均为终态。

两个租户原先分别绑定 Rice r28 / r50。核对表明定义、冻结 Skill 及运行包语义一致，仍为 rc.2 generation。候选编译的差异仅为 `packageVersion`、`runtimeManifest.distributionGeneration` 及相应 `checksum` / `capabilityFingerprint`；22 个工具、10 个 Skill、模型、安全策略和提示词均相同。

通过真实管理员登录的正式 API 保存 r52，完成一次真实 Codex 试用，再通过预检及 revision/package/policy CAS 发布给原两个工作区。没有改写 r28 / r50 或旧 Run 的冻结快照。原 r51 草稿额外包含一项未发布 Skill；其内容另存为 r53，r51 原记录仍保留，没有随引擎升级发布。

发布试用 ID：`bf449219-c17d-4369-8539-06f98d852312`；发布 revision ID：`2015c5d1-9e94-4e6e-95c4-de362bc1ed8d`。试用通过只证明当前确切包可运行，不替代下面的租户验收。

## 真实模型与恢复证据

Snow 始终是普通成员，原明确的 30 分钟任务时限、500 万月 Token 配额和租户策略未改。验收前后角色、额度与策略行摘要相同，Dev 环境文件及 Prod Web / Worker 的启动文件摘要和 PID 相同。

| 场景                              | Run / Session                                                                                 | 结果                                                                                                                                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 普通新任务                        | Run `5c21d8c2-c5cc-4e7a-9de7-1c853af94236`                                                    | succeeded；1 次模型请求、0 次工具、0 pending；运行 5,661 ms。                                                                                                                                                             |
| 原生提问、等待、重启、同 Run 续接 | Run `c9ddb9fb-9d88-45c1-ab38-cdd83d830868`                                                    | 提问持久化后释放原生进程及队列租约；Worker 被终止并由 launchd 重启，原 Run 等待计时继续，activeMs 保持 8,253。答案提交后原 Run succeeded；总 active 14,001 ms、waiting 50,011 ms，2 次模型请求、1 次提问工具、0 pending。 |
| rc.2 真实旧会话的新明确任务       | Session `e970e469-b3ef-4f2b-824f-422f3fd2e005`，新 Run `586b9d3b-d560-4bab-ac5b-615b34c4398f` | 同一原生 Session 的副本迁移到 v3，新任务 succeeded；1 次模型请求、0 次工具、0 pending；旧任务没有重做。                                                                                                                   |

等待场景的 durable dispatch 为 attempt 1 `parked`、attempt 2 `completed`。答案的临时 follow-up Run `15c9d618-73a9-4480-a22c-152f91328e22` 由既有输入采纳流程记为 `STEER_CONSUMED` / `consumed_by_active_turn`：1 份原生采纳证明、0 条模型 route decision；它不是第二次模型执行，也不是被掩盖的任务失败。普通成员刷新后仍能看到“等待中，运行计时暂停”和原 30 分钟限额。

本节是实际账号、实际模型和实际 Worker 重启证据。PR-2 / PR-3 的合成模型及隔离 PostgreSQL 回归仍按各自范围解释，不累计成真实租户验收。

## 旧日志副本与回退演练

从真实旧会话复制完整 sessions/attachments，源 v0 文件 77,642 字节、四项 Allrice 私有事实，SHA-256 为 `939bbee943a79209802129df5fd23860fff83896261e11db4374e6733963198c`。隔离候选加载迁移时无模型请求，私有 payload 完全保留；一次显式合成提示写入 v3 后再次重启，无重复请求，源文件与迁移后保留的 v0 文件哈希相同。这个副本探针使用合成模型；上节旧会话新任务才是实际 Dev 模型验证。

完整数据库备份已还原到独立 PostgreSQL 实例，核对原队列、clock、等待、操作、助手以及 rc.2 发布/草稿指针；未启动 Worker、未调用模型或工具，结束后关闭该临时数据库。没有用旧备份覆盖已经产生新任务的 Dev。完成真实验收后，124 份原始 JSONL 与备份逐字节一致，10 项历史未决助手的身份和状态也与发布前相同。

**候选已写入 v3，禁止仅切回 rc.2 二进制。** 探针确认保留的 v0 不含新 v3 消息；旧二进制读取它会漏掉新增事实。当前故障恢复方式是保留候选数据库/日志，由同一 rc.3 候选重启或向前修复。真实等待 Run 已验证这条恢复路径。数据库备份可还原不等于写入后可安全降级；未经验证的逆转换、删除 v3 或回放旧 v0 均不属于回退方案。

## 后续发布操作顺序

1. 核对固定 SHA、干净构建、exact SHA 的 CI、依赖身份及实际 Web/Worker/Admin 组合；保留上一个可识别产物。
2. 停止新派发，盘点根/子 Run、原生进程、操作租约、问题等待和未知执行。旧 generation 的在途任务由旧 Worker 排空；不能仅因 root 失败就把子事实清零。
3. 同步保存数据库、会话/附件、对象存储和发布配置；校验备份及源文件摘要。候选只写新副本。冻结旧 RuntimePackage 不得改 generation；新任务通过正式试用、预检和 CAS 发布新的运行包。
4. 候选写入前可在确认无新增模型/工具副作用后恢复旧路由和原副本；候选写入后先停止新派发，核对新增操作和未知结果，采用兼容版本排空或向前修复。仅在逆转换或一致恢复经过验证且新增副作用核清后考虑降级。
5. 用普通成员验证普通任务、旧历史、持久等待和重启续接；分别核对模型/工具调用、答案采纳、运行/等待时钟及权限。按产品范围补实际开发协作验证，再更新发行和验收结论。

## 尚未通过的门槛

MET-144 上次验收结束后已经恢复原配置；当前 `ALLRICE_ASSISTANTS_ENABLED=0`，Rice 未发布开发协作工具，M5 沙箱也不是本次已获准的常开执行面。不能通过“已有集成测试”宣称本候选的真实编辑→候选测试→独立审查→交付闭环已完成。

已提出仅 Dev / Snow / M5 的临时验收范围：正式配置协作工具和策略，保持命令/文件修改逐次审批，在独立样例目录验收，结束恢复临时配置、原文件和设备配对。确认前不启用；原 SSH 通道当前返回认证失败，也需恢复可用的既有认证。此项通过后再把 PR-4 标为完成、更新清单和 MET-154 关单条件。

原始日志、模型内容、截图、数据库导出、启动配置和凭据均只留本机私有证据目录 `.local/evidence/met154-dev/`。仓库仅提交脱敏结论、可关联的 Run ID 与摘要；没有提交原始会话或凭据。
