# MET-281：资料与个人成果的业务 Port 首片

离完整迁入还差可信身份/模块资格与 4.0 执行载体装配、完整 MCP 工具注册、余下跨 owner 公开口、受影响运行验证及呈现。本片实现两个后端 Port 的具名子集，不表示 MET-281 ready。首片起点为 272 v1 `13c1b201da4f04acdf35359785f59b4f0cedd3f8`；固定交付 head/tree 由任务 QA 回执绑定。PR 目标仍为 `batch/4.0-n3`。

## DSH 对照与边界

DSH 保持 Loop、原生 MCP 发现/命名/调用、CallToolResult、取消及 slot 权威。272 的 `allrice-server.ts` 是唯一原生 server 接缝；本片不修改它、不设置 SDK handler、不复制 model permit。原生源码对照与版本依据沿 `allrice-4.0-mcp-seam.md` 的 `dsh-mcp-client@0.2.1-rc.2` / `syncTools` / `createMcpToolDefinition` 记录。

AllRice 只补已批准的现权门卫、资料/成果存储后端与业务幂等/出处账本。个人目录、收藏、全文搜索、资料处理、发布 CAS 直接复用既有 owner。没有新增 PG 表/状态字段、向量索引、Agent 状态机、限额、TTL 或自动重试。MET-225：本片业务 Port 不新增 DSH 差异，原 MCP 差异登记由 root 收口。

## 公开符号与版本

跨模块入口为迁移期 `@allrice/contracts` 与 `@allrice/database` barrel；只有下列具名符号属于本片 allowlist。其余旧 barrel 导出不因此获得跨模块许可。版本沿 API v1、ContractVersion 1、CompatibilityPolicy rolling [1]；host-only TS interface 不是 JSON wire validator。

| 入口      | 允许符号                                                                                                                             | 用途                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| contracts | `DeliverablesPort`, `AuthorizedDeliverableResource`                                                                                  | 本人业务查询、固定字节授权与当前操作合同                             |
| contracts | `DeliverableReadInputProjectionSchema`, `DeliverableReadMcpProjectionSchema`, `deliverableReadPolicy`                                | object/checksum 精确选择、原 UTF-8 文本页形状/范围                   |
| contracts | `DeliverableFavoriteCommandProjectionSchema`, `DeliverableFavoriteResultProjectionSchema`                                            | target.objectId + 原 desired-state body；结果 viewer/object/favorite |
| contracts | `DeliverableUploadResultProjectionSchema`, `DeliverableObjectQueryProjectionSchema`                                                  | 原上传结果、固定文件 locator                                         |
| contracts | `DeliverableArtifactQueryProjectionSchema`, `DeliverableArtifactIdentityProjectionSchema`, `DeliverableArtifactListProjectionSchema` | 本人会话固定工件/游标，原 WorkbenchArtifact 与 nullable nextCursor   |
| contracts | `EnterpriseMaterialsPort`, `MaterialsScopeQueryProjectionSchema`, `MaterialsCurrentListProjectionSchema`                             | 当前独立固定资料与选项，无文件历史选择器                             |
| contracts | `MaterialsSelectionQueryProjectionSchema`, `MaterialsSaveInputProjectionSchema`, `MaterialsUploadPublicationInputProjectionSchema`   | 当前选择、新增资料、现 upload publication 分支                       |
| contracts | `MaterialsPublicationCommandProjectionSchema`, `MaterialsActionCommandProjectionSchema`, `MaterialsActionResultProjectionSchema`     | 原配置 CAS/维护动作、真实 sourceId 回执                              |
| database  | `createDeliverablesPort`, `DeliverablesPortOptions`, `DeliverableReadError`                                                          | 真实 owner 实现和既有文件读取错误码                                  |
| database  | `createEnterpriseMaterialsPort`, `EnterpriseMaterialsPortOptions`                                                                    | 真实资料 owner 实现                                                  |

`readPersonalWorkbenchFile` 是原件 owner 内部原语；虽随现有 star barrel 可见，**不列为跨模块入口**。其他 owner 应调用 `DeliverablesPort.authorizedResource`，不能引用该 SQL helper 或读其表。

## 可信上下文

Port 方法的 `RequestContext` 仅在 host 参数位置；不能把模型/guest JSON parse 成可信身份。两个 factory 的 `requireCurrentAccess(context, signal)` 是待 271/273 正式绑定的可信宿主依赖。缺失时直接拒绝；它不提供默认启用、员工绑定继承或身份实现。测试明确使用 qualification substitute，仍运行真实会员/资源/维护权限检查，不能把该替身当生产绑定。

所有需要 workspace 的方法要求业务 workspace 与可信 context 一致，不填默认 workspace。资料 `query` 的既有 schema 没有 workspaceId，直接使用可信 context。执行前后重新查宿主资格；资源 owner 内核仍独立检查当前本人、租户、部门、资料受众与读写权。模块开启、schema parse、employee filter 或标题可见不授新权。

## 已实现的个人成果方法

| 方法                   | 输入/输出与原语                                                  | 真实业务边界                                                                              |
| ---------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `list`                 | WorkbenchDeliverablesFilter → Catalog；readWorkbenchDeliverables | 本人全部/员工交付/上传/收藏；收藏明确忽略员工过滤；游标逐次现权                           |
| `upload`               | 原 WorkbenchFileUpload → {objectId}                              | 原 quota mutex/request digest；每新请求独立对象、同名后缀，不覆盖                         |
| `favorite`             | target.objectId + WorkbenchFileFavorite → viewer/object/favorite | 原本人 eligible origins/现权与 insert-on-conflict/delete desired-state；非共享            |
| `listSessionArtifacts` | 原 workspace/session/before → artifacts/nextCursor               | 原会话读权，历史查询不启动 VM/模型；不枚举文件版链                                        |
| `getArtifact`          | workspace/session/artifact → WorkbenchArtifact                   | 原 exact artifact 身份/质量/出处；不伪造无 Run 的历史                                     |
| `authorizedResource`   | ArtifactSourceFile(objectId/checksum) → host-only resource       | 本人 eligible original、immutable、当前 workspace、精确 checksum；没有宿主 key/path/grant |
| `download`             | {objectId} → 同一当前受权 resource                               | 重新解析当前 checksum，并非永久下载许可                                                   |
| `readExact`            | objectId/checksum/offset/limit → 实际文本页                      | 沿 txt/md/json 与现 2 MB/4000字符限制；完整源 size/hash 验完再返回文本                    |

`AuthorizedDeliverableResource` 只有 source/fileName/mediaType/sizeBytes/open(signal)。打开前后及交付每一片前重核当前权，关闭/取消会等实际 upstream reader.cancel；没有 Promise.race 丢后台。流按 EOF 验完整 size/checksum，消费者必须完成验证后才能把它当固定复制件，不能把已收到的前缀说成完整校验成功。已发送到个人域的字节不能召回。元数据读取/SQL 尚无数据库级 AbortSignal，本片等待其真实 Promise 收敛后拒绝披露，不声称 SQL 已被取消。

同名分配沿既有 `availableWorkbenchFileName` 的完整规则（例如 `收入口径（2）.txt`）。原 upload request digest 仍绑定原始输入；旧请求先对账，返回原对象/原名称。pending 上传也参与占名，使用原 workspace storage-quota mutex；不新建名字预留表或过期规则。生成成果的旧 naming 与不可变版本数据保留。

## 已实现的企业资料方法

| 方法                | 输入/输出与原语                                      | 真实业务边界                                                                            |
| ------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `listCurrent`       | workspace → 当前 references + options                | 原 listReferenceRevisions 无 source 历史参数，每 source 当前固定文件；保留平台/兼容资料 |
| `options`           | workspace → 原 ReferenceLibraryOptions               | 平台维护/部门/当前 writable 沿旧权威                                                    |
| `query`             | ReferencePublicationQuery → 原 QueryResult           | 先现受众，复用全文/标题/用途、出处/offset/coverage，无向量                              |
| `captureSelection`  | workspace/revision → 原 InputSelectionResult         | 真实当前四 pin；选择不等于模型已读正文                                                  |
| `save`              | 新文件薄投影 → 原 SaveResult                         | 不含 sourceId/expectedRevision 替换输入；原 scope 限制/校验保留                         |
| `publishUpload`     | 原 ReferencePublishInput 的 upload 分支 → SaveResult | 个人/多部门/公司受众、当前发布资格与固定上传副本                                        |
| `changePublication` | source target + 原 PublicationAction → {sourceId}    | 原发布者本人、配置 expectedRevision CAS、用途/受众/撤销；不能替换 bytes                 |
| `changeSource`      | source target + 原 ReferenceAction → {sourceId}      | 原显式 retry/archive/restore 授权；publication 不获得额外生命周期                       |

资料 owner 的 prepareReferenceUpload/publishReference 仅增加 host-only `namePolicy: independent-material` 选项，只有新 Port 选择它。原调用未传时语义保留，平台旧更新仍走原渠道。新 Port 不提供文件更新；原请求账本查找在名字分配之前，持原 quota mutex 将 pending/ready 自有资料名视为占用。保存、索引 ready 和真实读取分开。

取消/失权发生在保存提交后，调用可能拒绝但业务已提交；按原 requestId/对象/动作账本对账，不能换新键重放。新 Port 未另造事务/处理状态。

## 五面与未完成范围

| 面               | 本期状态                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| 后端/私有数据    | 两个具名 Port 的 16 方法及原件独立命名/固定受权文本与流已写；无 DB 迁移；运行未验证                                 |
| MCP              | 只读消费 272 v1 公开合同。完整 business adapter、额外工具注册及 4.0 receipt/publisher 载体未装配；没有第二个 server |
| 员工 UI          | present 需求归 282；本片未改 apps/web 或原生 slot                                                                   |
| 后台             | present 需求归 288 等；既有明确授权 inspection/公司规矩范本保留，新公开子 Port 与 route 仍待接                      |
| 企业/员工/资源权 | 资源权限复用现 owner，资格依赖未绑定 fail closed；真实 271/273 配置/撤权装配未验                                    |

仍待：资料 text/image/archive 实际读取 receipt 与下载流的公开口；成果 create/readDocument/原生 preview；origin=file 通过公开 authorizedResource 复制；公司规矩范本公开子 Port；成果 feedback/admin inspection 的公开投影；共享 policy/binding/Run/audit/身份/存储依赖的唯一物理 owner 拆封。旧内部跨 owner 联查仍存在，本片具名包装不证明它们已经退出。没有删旧数据或旧业务通道；新版 history/compare/sync/archive/sharing 管理方法未加入 allowlist。

272 v1 只有 referenceRead/memoryRead/deliverableCreate；还缺 reference_search/read_image/archive_list/archive_read 与 deliverable_read/document_read 的 callback/注册。由 272 owner 在同一原生服务补具名公开口，281 不改封版文件。create 的技术出处/changeset 与已退版链管理需分别无损映射，不能一概拒绝或吞字段。

现 origin=file canonical 只复用同一 immutable object 的 active 出版件，同用途/归一受众的新请求可复用；不同用途/受众拒绝并走 CAS。revoke 后原请求仍回原 ID，新请求可新 source。0237 索引与这段行为本期均未改。r2 新保存独立是否要求破除此同原件防重复，交 root 结合 PLAN 与既有测试核定，不预认必须迁移。

## 验证与恢复

本阶段只做轻量静态，不启用 PG/M5/VM/QA/浏览器/模型/服务。新增用户行为断言位于 workbench-files.integration.test.ts，覆盖独立同名/pending并发/原键幂等、本人全员工收藏、固定 hash 文本、无宿主路径、损坏字节、撤权、实际取消等待、资料独立新增与分级全文出处/CAS。仅有测试源码不表示已通过。

交 root 固定头执行受影响完整文件：workbench-files、reference-library、reference-artifacts、reference-search、reference-processing、artifact-publication-concurrency；HTTP/publication 与现有 caller 的全文件另见 QA 测试计划。CI 的原数据库环境为 ALLRICE_RUN_DB_INTEGRATION=1，现 discover 规则覆盖 packages/database，新断言在已收集文件，无新增资源分支。首次失败和原 timeout 不放宽。

本片无 instructions 修改，未做实际父/子请求/tokenizer 计数，不声称 ≤2048 token 已验。恢复集合继续包含原对象/checksum、不可变资料与成果、请求/CAS/收藏、当前受众与撤销、真实 receipt、配置与原生日志；无新表/状态需要额外恢复程序。新功能错误通过既有业务错误/owner 账本与显式读取校验发现，未安装新巡检或告警。
