# 品牌自媒体数据合同与 P2 可信接线（MET-224）

依据 MET-224 定稿评论 `10c27c4e`（2026-11-16），设计文件
`plugin-brand-media-lite-s1.3.html`，SHA256
`1df681cf07f271074758964e77908a9aa6122deaa75018865cc2fed188956995`。

P1 固定两张新业务表及 `brand-media.ts` 合同，已应用的 0245 不改写。
2026-11-16 用户批准快车道（MET-224 `bbb67fb2`），覆盖原来的等待
MET-252/253 依赖：P2 落绑定与业务 API，P3 再落页面、文本工具/Skill，
P4 验图片。后台、可记忆提示和旧账本迁移不在本期。

## 数据与读取

- `allrice_brand_media_topics` 只保存用户选入的候选；未选候选属于原生 Run
  结果。`source_run_id` 是来源记录，不能据此授予当前读取或写入权限。
- `allrice_brand_media_articles` 一条选题最多关联一篇文章。开始写时先创建
  `draft`，正文引用允许为空；生成失败不撤销这条草稿，修改失败不替换正文。
- 选题库读同范围且不存在文章的选题；删除文章时同事务先删文章、再删其选题，
  不让已用选题重新出现在库中。选题库删除不得删除已有文章的选题，外键会阻止。
- 范围为组织、工作区、所有者、员工实例。组织和所有者由可信上下文派生，
  公共 DTO 仅指定工作区和实例，不能自报权限、用户身份或租约。
- 正文和图片引用现有不可变交付成果的 object/version/checksum，图片数组顺序
  就是显示顺序，第一张为封面。移除引用或删除业务记录不删除交付文件。
- 企业资料固定 source/revision；上传资料固定交付文件版本。每次读取与使用
  都复查现有 ACL、版本和校验和。结构合法不等于能访问，模型不得自造授权。
- 列表使用 `(createdAt,id)` 游标，按时间/id 倒序；不能先截旧接口 201 条再过滤。
  排期表直接按请求时区计算当地月份的半开时间区间，只读已排期/已发布文章，
  返回整个月；`nextCursor` 为 null 才表示列表结束。月份切换不创建定时任务。

## 流转与写入形状

| 入口动作    | 允许原状态     | 结果                                     |
| ----------- | -------------- | ---------------------------------------- |
| 开始写      | 尚无文章的选题 | 草稿，正文暂可为空                       |
| 排期/改时间 | 草稿、已排期   | 已排期，保存时间及显示时区               |
| 取消排期    | 已排期         | 草稿，清除排期                           |
| 标记已发布  | 已排期         | 已发布，沿用排期时间，两平台链接都可不填 |
| 改回已排期  | 已发布         | 保留原时间和内容，清除发布链接           |

已发布只读；更正链接需先改回已排期再标记。正文/配图/参考资料只能在
草稿或已排期时修改。`transitionBrandMediaPublication` 是业务合同函数，
不是写入口，也不作权限判断。数据库保护基本状态关系、范围外键、修订递增
和已发布内容；文件 pin 的语义校验、用户/Worker 权限和 CAS 属于后续可信入口。

`BrandMediaUserCommand` 只描述人工加入/删除选题、开始写、排期/发布、
引用和图片操作、删除文章。正文结果用独立 `BrandMediaArticleSubmission`，
后续只有具有真实来源和有效原生租约的 Worker 可以提交，不开放浏览器改字。
提交只替换 title/body，不连带覆盖用户改动的配图、参考资料或排期。

P2 在一个事务内检查当前实例启用/权限、目标 revision，并以完整范围和
`revision = expectedRevision` 条件更新；0 行返回冲突，不能覆盖后来的修改。
复用 `allrice_brand_content_requests`，以 `brand-media:<requestId>` 命名空间
记录输入摘要与回执；重放须先重新检查当前权限，再核对同请求同输入。
旧 `user/workflow/scheduler` 字段不自行扩权，Worker 来源沿已有工具门卫处理。
复用现有审计，不新增任务表、队列、重试状态或幂等机制。

## 依据与后续验证

DSH 对照：本片不涉及 Agent 原生能力，三态是人工发布业务进度，
不是 DSH Run 状态。新增表属于产品业务持久化；没有 Agent 能力自建项。
类型/URL/月份正则只校验技术格式，不判断用户意愿。文件结构复用已有合同。

数据库集成测试在专用库随机 schema 演练完整迁移、三态与纠正、跨范围引用、
重复开始写、迟到 revision、已发布只读、删除引用保留交付成果。现有品牌
合同、服务和集成测试保持原断言。CI 自动发现新增 `.integration.test.ts`，
资源声明沿 `packages/database/` 的 DB 规则，不另加跳过条件。

P1 不接生产入口；P2 接真实 HTTP 入口，真实 Run 仍为 0。发布前仍需用户批准合并/部署；迁移走现有
快照和停写门禁，不能回退数据库假装没执行。旧数据/旧账本没有删除或重写。
P2 接线行为测试覆盖当前授权、存量配置与冷读取、模块撤销、文件/资料撤权、
CAS 并发和完整当地月历；不能以 P1 的结构测试代替。P3/P4 仍需对应的
真实消费者、Worker 原生门卫与用户流程验收。

## P2 静态清单与实例绑定

`packages/contracts/src/brand-media-module.ts` 是当前静态 import 的单一声明，
稳定 ID `allrice.brand-media`、合同版本 1、内容版本 `0.1.0`。
`digest` 是清单除 digest 字段外全部内容的 canonical JSON SHA256；
`requires/views/tools/skills/resources/enablement/data/contracts` 都在摘要内。
本片 `views/tools/skills/resources` 均为空，不声称已有页面或可调用工具。
P3 增加实现必须发布新内容版本和摘要，并明确相应的启用策略；
不能在 0.1.0 或同一摘要下热加能力，也不能因显示名相同自动更新绑定。
P2 添加接口遇到既有其他版本或已撤销绑定会拒绝，不作升级/重新激活。

所有当前可访问实例（基础 Rice、存量、新建）都可由真人自助添加，
没有预装，也不改员工配置、工具目录、Skill、文件权限或生图权限。
0246 新增 `allrice_employee_module_bindings`，唯一主键是
`organization/workspace/owner/instance/moduleId`，保存精确合同/内容版本、
摘要、revision、enabled_at/revoked_at。组织和所有者只从当前登录上下文派生。
这是获用户批准的 SaaS 门卫存储事实，不是插件注册器或 Agent 状态机；
已同 PR 登记 EXACT_TABLE_NAMES 和收敛基线。MET-253 接管同一表和合同，
不复制、不双写、不新增另一个安装权威。

`requireEmployeeModuleBinding` 核对当前有效性、精确发布引用，且可核对冻结的
binding revision。当前撤权会拦截重放和后续提交；不会替旧 Run 热换版本。
P2 仅有 Browser 人工入口，尚无 Worker 正文写入入口或工具实现。

## 具名端口与 HTTP

`packages/database/src/brand-media/server-wiring.ts` 独占当前核心适配：

- 身份/实例：复用 `requireBrandContentScope`，重新查真实 session、成员、
  员工配发/实例，不信任请求的 org/actor/enablement。写入口在当前事务内持锁；
  GET 沿旧品牌读取语义，使用一致性 repeatable-read 快照且显式 `lock=false`，
  不让轮询阻塞写入。后续新读取仍重新核对权限，写入始终检查当前撤权。
- 事务/幂等/审计：复用 `employeeAccessTransaction`、`brandContentDigest`、
  `allrice_brand_content_requests` 与 `allrice_audit_events`。安装和业务写入
  共用 `brand-media:<requestId>` 命名空间；同 ID 不同输入拒绝，重放先核当前门卫，
  并重查输入和返回引用的当前 ACL，不由历史 user/workflow/scheduler 字段扩权。
- 资料：复用 `readReferenceSelection` 查当前 ACL 和固定 revision，额外核对
  source/revision 对；不自动跳到最新版本。
- 文件/图片：复用 `assertBrandContentFile/Images/Session`，精确校验
  object/version/checksum、不可变交付版本与当前员工会话范围；现有生成结果
  还需真实同范围 image operation。没有调用生图或文件删除。
- 选题来源：真实员工 Run、Run owner 和会话实例范围必须吻合；UUID 本身不授权。

业务仓储 `repository.ts` 只读写 P1 两表。列表按 100 条分页，保留 PG 创建时间
微秒作 `(createdAt,id)` 倒序游标；排期同样保留微秒，发布/纠正不会截断原时间。
完整月历使用 PostgreSQL `timestamp AT TIME ZONE` 计算当地月首/月末，
独立解析两个边界，覆盖 DST 月份，不经过列表页截断。

两个 Node HTTP 入口均复用真实 `requireRequestContext`：

- `/api/v1/employee-instances/:id/modules`：GET 读当前清单/绑定，POST 接
  `AddEmployeeModuleInput`；客户端只提目标工作区/实例、精确 release、requestId。
- `/api/v1/employee-instances/:id/brand-media`：GET 接 `BrandMediaReadInput`
  的查询字段（cursor 是 JSON），POST 接 `BrandMediaUserCommand`。路径实例
  必须与 body/查询一致；正文提交不属于 Browser 合同。响应 `private, no-store`。

错误区分未登录 401、越权/未安装 403、范围内不存在 404、修订/版本/来源冲突 409、
格式错误 422；未识别的程序或数据库异常沿现有错误处理返回 500。

DSH 写前对照见 MET-224 `a0a21ae4`：本片不改 DSH Run、工具执行、Skill、取消或
租约，沿用其原生语义。新增项仅是上述已批准的绑定门卫事实；没有 DSH 原生
语义差异，不另登记定制点。MET-252 后端具名端口、MET-253 唯一模块描述/装配与
绑定 ownership 将替换当前接线的消费者，业务 DTO、两表、CAS 和人工流转保留。
