# AllRice Workflow 开发规范

Workflow 是你发起的一套固定步骤，员工按步骤做；普通 Skill 是员工会的本事，由员工按需判断要不要用。

本文件是 AllRice Workflow 的编写、格式、版本、限额和交付方式的唯一规范入口。
每节标明“现在可用”或“U1 后才可用”。“现在可用”指当前仓库已有实现，
不代表某个部署环境已经发布，也不代表某份业务 Workflow 已通过真实模型验收。
U1 是尚未实施的网页安装与展示改版；本规范本身不启用这些功能。

## 先看现在能用什么

| 规则                        | 现在可用                                                                    | U1 后才可用                                              |
| --------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| Workflow 的 `SKILL.md` 字段 | 当前打包工具只收 `name`、`description`                                      | 本文的五字段模板                                         |
| 发起 Workflow               | 实际命令是 `/allrice-scene-<UUID>`                                          | 以作者 `name` 调用，例如 `/weekly-brief`                 |
| 正文上限                    | Workflow 为 8,000 字符                                                      | 256 KB，超限拒绝、不截断                                 |
| 包内资源                    | 最多 32 个，每个 128 KB，合计 512 KB                                        | 两种 Skill 共用同一组安全上限                            |
| Workflow 安装               | 本地 CLI 打包 JSON，再在本人员工详情导入、确认                              | 网页读取公开 GitHub 链接或 zip，预览并确认安装           |
| Workflow 更新和恢复         | 文件差异预览、确认保存、修改记录及预览恢复                                  | 场景详情点“更新”；隐藏修改记录和恢复界面，底层保留       |
| 模型加载与审计              | 原生 Provider、普通加载、命令调用、准确资源读取和实际读取／注入审计已有实现 | 新场景详情的易读展示；底层审计保留                       |
| 插件安装                    | 用户不能上传安装插件；包内脚本只存不执行                                    | 如以后采用插件，由平台在管理后台安装；当前不做，另行排期 |

这里对 Workflow CLI 的限制不等于普通 Skill 的现状：当前个人 Skill 入口已有
DSH 原生字段解析和部分上传限额；不能据此说 Workflow CLI 已支持五字段或 zip。

## 选 Skill 还是插件

**现在可用（选型与权限边界）：** 说明型能力用 Skill：写清楚要做什么、按什么步骤做、
参考哪些资料、交付什么。读取资源和使用业务工具仍受员工现有权限约束；
Skill 文本、依赖声明、来源地址和审查标签都不会增加工具权限。
`scripts/` 中的文件只保存，不执行，也不安装它声明的依赖。

**U1 后才可用（交付规划）：** 需要自己的代码、页面或后台能力的场景用插件。
用户只能上传 Skill；如果以后 Workflow 采用插件形式，由平台在管理后台安装，
用户在工作场景里选择，不能自己安装。插件后台上传和安装功能当前不做，
更大的场景也按插件方案另行安排，不通过放宽 Skill 限额解决。
插件引入的来源、许可、权限和复核要求仍按仓库 [AGENTS.md](../../AGENTS.md) 执行。

## 文件夹怎么放

**现在可用（目录约定，U1 继续沿用）：** 复用 DSH 的 Skill 文件夹与 YAML frontmatter，
不另造格式：

```text
weekly-brief/
  SKILL.md
  references/   # 给模型看的约定和资料
  assets/       # 模板和数据
  scripts/      # 只存，不执行
```

`SKILL.md` 放主要说明，详细资料尽量放 `references/`；`assets/` 放模板和数据。
资源按需读取，不因放进文件夹就一次全部进入模型上下文。
当前打包还需要 `bundle.json`，受控资料可附 `sources.json`，
具体见[现在怎么写打包输入](#现在怎么写打包输入)。
这两个文件属于当前 AllRice 打包输入，不是另加的 DSH Skill 格式要求。

## U1 的 SKILL.md 模板

**U1 后才可用：以下五字段模板不能直接交给当前 CLI。**
当前 CLI 会拒绝 `whenToUse` 和 `metadata`；现在要打包，请用
[品牌内容完整样例](../../examples/workflow-skills/brand-content)中的两字段版本。

```markdown
---
name: weekly-brief
description: 把本周资料整理成周报草稿
whenToUse: 每周五写周报，或者要汇总项目进展时
metadata:
  displayName: 写周报
  version: 1.2.0
---

## 工作步骤

按顺序写清楚这份工作怎么做，需要用户确认的地方也写出来。

## 交付内容

写清楚用户会拿到什么。

## 执行细节

写给模型的具体处理要求，以及何时读取 references/ 和 assets/。
```

**U1 后才可用（字段和展示规则）：**

| 字段或正文             | 写什么、怎么用                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `name`                 | 稳定的作者名称，也是未来的 `/名字`；使用小写英文和连字符，如 `weekly-brief`，命名与调用沿用 DSH |
| `description`          | 这份 Workflow 做什么                                                                            |
| `whenToUse`            | 什么时候适合发起                                                                                |
| `metadata.displayName` | 给用户看的名字，作为工作场景名                                                                  |
| `metadata.version`     | 作者填写的版本，如 `1.2.0`                                                                      |
| `## 工作步骤`          | 写给人看的步骤，页面展示                                                                        |
| `## 交付内容`          | 写给人看的交付结果，页面展示                                                                    |
| `## 执行细节`          | 只给模型的执行要求，页面不展示这一节                                                            |

“怎么用”由系统生成，不要求作者另写一套字段。
按这些标题切分正文是格式处理，不是用关键词判断用户意图。
步骤和交付内容用大白话写，不把后台 ID、hash 或内部工具名塞进给用户看的说明。

## 名称与版本

**U1 后才可用（安装与更新规则）：** 普通技能接受合法 DSH Skill；工作场景必须符合本 Workflow 规范。
新安装时，同名 Workflow 拒绝，提示去现有场景更新。
更新包的 `name` 必须与当前相同；不同名是另一份 Workflow，不能当作更新。
完全相同的内容不必重复更新。不符合 Workflow 规范时提示：
“该技能不符合 workflow 规范。”

`metadata.version` 是作者版本；它不代替服务端修订，也不定义一套新的版本递增策略。

**现在可用（现有元数据）：** 当前 CLI 的作者版本放在 `bundle.json` 的 `version`，
即输出里的 `bundle.version`。既有合同要求数字三段，例如 `1.0.0`；
它不是服务端的 `revision`。保存后的准确内容仍由服务端修订、`contentRef` 和 checksum 标识。
U1 模板的 `metadata.version` 尚未由当前 Workflow CLI 接收，不能把它写进去代替 `bundle.version`，
也不能据作者版本号推断某次 Run 用了哪份内容。

## 大小和资源上限

**U1 后才可用（两种 Skill 共用的 SaaS 安全上限）：**

| 内容            | 上限   |
| --------------- | ------ |
| `SKILL.md` 正文 | 256 KB |
| 资源数量        | 32 个  |
| 单个资源        | 128 KB |
| 资源合计        | 512 KB |
| 压缩包          | 8 MB   |

这是 AllRice 面对网页上传不受信任内容时的安全上限，**不是 DSH 的限制；DSH 本身没有 Skill 大小上限**。
正文超限时安装失败，不截断。正文尽量短，把详细约定和资料放进 `references/`；
放进资源后仍要遵守资源限额。

上表采用 2026-11-05 最新定稿：8 MB 覆盖旧 50 MB 方案。
旧方案中的放大资源、迁到大文件存储和分段读取安排，不再作为本轮目标。
超过这组上限的场景规划走插件；插件功能当前不做。

**现在可用（各入口的真实限制）：** Workflow 的 packaged procedure 正文最多 8,000 字符，
不是 256 KB。当前 C1 资源已限 32 个、单个 131,072 字节、合计 524,288 字节，
即上表沿用的 128 KB／512 KB；资源以 Base64 保存在 bundle 内。
当前个人 Skill 入口检查 `SKILL.md` 源文件不超过 `256 × 1024` 字节
（包含 frontmatter），压缩包不超过 `8,000,000` 字节。
这些已有检查不代表两种 Skill 的统一正文和网页上传规则已经实现；
当前 Workflow CLI 读取目录并输出 JSON，不接收 zip。

## 完整样例：品牌内容

**现在可用（文档样例与离线打包）：** [brand-content](../../examples/workflow-skills/brand-content)
包含一份完整的两字段 `SKILL.md`、`bundle.json`、四份 `references/` 资料、
`assets/synthetic-brand.md` 和 `LICENSE`。虚构品牌“纸间小岛”仅在用户明确要求合成演练时使用，
不含真实客户资料、凭据或 QA Run 记录。

正文已使用“工作步骤／交付内容／执行细节”三节，但当前页面尚不按 U1 规则拆分展示。
它只准备聊天中的品牌资料摘要、选题、稿件、发布交接清单和复盘，
由用户选方向、确认稿件并自行发布。
唯一工具依赖是 `workspace.skill.read`，用于按需读取本包资源；
没有脚本、发布、消息、业务写入或新增工具授权。
资源来源与许可保留在包中；样例不加入平台 Skill catalog，也不代表已经上线的业务 Workflow。

## 现在怎么写打包输入

**现在可用（当前 CLI 格式）：** 本节只说明现有两字段输入，不适用于上面的 U1 五字段模板。

可从 [brand-content 完整样例](../../examples/workflow-skills/brand-content)或
[weekly-brief 样例](../../examples/workflow-skills/weekly-brief)开始。以下展示当前 CLI 的输入结构，
`sources.json` 和脚本不是必需文件：

```text
weekly-brief/
  SKILL.md
  bundle.json
  sources.json                  # 可选：受控资料的准确引用
  references/output-contract.md
  assets/example-input.json
  scripts/check-example.mjs      # 仅作为文件资源，不执行
```

`SKILL.md` 是原生 YAML frontmatter 加 Markdown 正文。本版仅支持 `name`、`description`。
名称与正文由当前 rc.2 的公开 `FileSystemSkillProvider.list/get` 解析。
原生支持而 C1 暂不能保存的 `whenToUse`、`metadata`、`disable-model-invocation`、
`user-invocable` 等字段会明确报错，未知字段也不静默丢弃。
支持 YAML 引号、多行 description 和 CRLF；正文采用原生 get 返回的内容，随后不另改空白。

`bundle.json` 复用现有 SkillBundle 元数据：`schemaVersion: 1`、三段版本号、
来源 URL `sourceRef`、`license`、`reviewedBy`、`dependencies` 和 `resources`。
资源显式列出 `path` 和 `mediaType`；命令只读取列出的资源，目录里其他文件不打包。
不要把凭证或用户私有数据列入包。资源的 `byteLength/checksum`、顶层 `contentChecksum/checksum`
可省略，由工具生成；提供时必须与本次输入一致，否则失败，不自动修掉错误声明。
这是一份作者输入文件，最终输出的 `procedure.skillPackage.bundle` 才是含 Base64 字节的完整 C1 bundle。

资源路径与大小沿用 C1：`references/`、`assets/`、`scripts/` 下的受限相对路径，
最多 32 项，每项 128 KiB，总计 512 KiB。大小写重复路径、目录穿越、符号链接与特殊文件拒绝。
正文最多 8,000 字符。不要在打包过程中改动输入目录。
脚本与其他资源一样只读成字节；声明 Node 依赖也不会执行它或安装 npm/pip。

工具依赖用当前 manifest 的 canonical name，例如 `workspace.skill.read`；报告列出对应 wire name、
capability 和 risk。验证只证明工具在本仓库存在，不证明员工获权、运行时已接通或业务接口可用。
旧 `workspace.brand_content.step` 仍依赖旧引擎，不能用作新 Workflow 普通调用；新写入合同归 C3。
第一版应以文字、资源和已授权业务工具为基础。C1 包脚本直接执行未实现，不绕过这一边界。

## 现在怎么打包

**现在可用（过渡说明）：本节旧 CLI 说明在 U1 上线后删除。**
当前 Workflow 导入接收 CLI 生成的 JSON，不直接接收 zip 或 GitHub 链接。

命令从仓库根目录运行。在独立 checkout/worktree 中使用仓库固定的 Node 22.23.2、pnpm 10.33.3。
先准备依赖和 contracts；打包命令本身离线运行，不连接数据库、模型或网络，
不登录、不发布、不执行包内脚本，也不安装包声明的依赖：

```bash
pnpm install --frozen-lockfile
pnpm --filter @allrice/contracts build
node --import tsx scripts/workflow-skill-pack.mjs \
  examples/workflow-skills/brand-content \
  --scene-id 10000000-0000-4000-8000-000000000001 \
  --scene-name '品牌内容草稿' \
  --title '品牌内容工作方法' > /tmp/brand-content.c1.json
```

这里的 UUID 仅是合成示例。实际目标 scene ID、显示名、procedure 标题由本人明确选择；
工具不猜测组织、员工、权限或发布目标，不生成内容操作 ID。
输出文件不要指向输入包里的文件；失败时检查退出码和 stderr，stdout 不输出半成品 JSON。
仅需说明时运行 `node --import tsx scripts/workflow-skill-pack.mjs --help`。

输出包含：

- `scene`：目标 id、显示名、description 对应的 appliesWhen、`allrice-scene-<UUID>` 名称。
- `procedure`：现有 `EmployeeContentTextSchema` 的 packaged procedure，可作为后续 textEdit 的内容字段。
- `references`：需要加入目标 scene/内容集合并由服务端重新授权的准确来源引用。
- `report`：作者名、实际 `/allrice-scene-<UUID>`、源文件/正文/完整包 checksum、依赖与脚本清单；`published` 和 `scriptsExecuted` 均为 false。

相同输入、参数和工具版本产生相同 JSON；没有时间戳、随机 ID、绝对路径或临时目录。
正文 checksum 不等于源 SKILL.md checksum；bundle.version 是作者元数据，不是服务端 revision。
保存后的准确内容由服务端修订、contentRef 和 checksum 标识；bundle.version 不能代替服务端修订。

受控资料必须保留来源。可选 `sources.json` 示例：

```json
{
  "references": [
    {
      "sourceKind": "knowledge",
      "contentId": "20000000-0000-4000-8000-000000000001",
      "revisionId": "20000000-0000-4000-8000-000000000002",
      "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ],
  "resourceSources": [
    {
      "path": "references/output-contract.md",
      "references": [
        {
          "sourceKind": "knowledge",
          "contentId": "20000000-0000-4000-8000-000000000001",
          "revisionId": "20000000-0000-4000-8000-000000000002",
          "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
      ]
    }
  ]
}
```

这些合成 ID/hash 不可用于真实发布。用现有受权读取回执的准确引用；每个 resourceSources 引用
必须同时出现在 references 中，并指向已打包资源。完全自写资源可不提供 sources.json。
离线工具无法判断文件是否来自受控资料，不能替人补造来源、核实身份或授权；
`sourceRef` URL、`reviewedBy` 和 checksum 都不授予权限。

## 现在怎么排错

**现在可用（离线检查与验收边界）：**

先重复运行离线命令。错误会指出 `SKILL.md`、`bundle.json` 的字段或具体资源路径；
原生拒绝解析时另有 Provider warning。可用以下失败示例检查边界：

| 改动                                   | 预期                        |
| -------------------------------------- | --------------------------- |
| frontmatter 加 `user-invocable: false` | 不支持的 C1 字段，拒绝      |
| 资源 path 写 `../secret`               | 路径校验失败                |
| 为资源填错误 checksum                  | 指明该资源 checksum 不匹配  |
| 声明不存在的工具依赖                   | `skill_bundle_unknown_tool` |
| 受控资源引用未列入 references          | 来源声明失败                |
| scripts 中放有副作用代码               | 仅编码字节，不执行          |

真正试跑使用 [独立开发环境说明](README.md) 配置自己的 PostgreSQL、storage/native journal、
账号和模型凭据，使用合成数据。不要复制共享 Dev 的 `.env`、数据或凭据。
内部 qa-instance 会借用共享测试订阅，不把它当作完全独立的本人环境。
重测试遵守仓库 m5-test 规则；离线打包不运行真实模型。

离线工具只证明“文件 → 原生解析 → C1 合同”链路，报告不是模型实际加载记录。
当前 Provider、普通加载、原生命令和准确资源读取已有实现，实际调用名是
`/allrice-scene-<UUID>`，不是源文件中的 `/brand-content`；下面的读取与注入审计也已有实现，
不再属于尚待 C2、A5 接通的功能。离线打包成功仍不能当作会话内或真实模型验收通过。

## 现在怎么导入、更新与恢复

**现在可用：** 当前文件导入、修改记录和预览恢复入口仍保留。

打包命令只生成文件，不自动保存。登录后打开本人创建的 AI 员工详情，展开
“本人 Workflow · 文件与修改记录”，选择完整 JSON 文件。页面显示员工名、目标场景、
当前修订和文件中的准确正文、资源、来源及元数据差异。目标来自当前员工与文件场景，
不需要填写 owner、集合或发布 ID，也不需要导出 cookie。

填写本次修改说明，核对后点击“确认修改并生效”。服务端重新核验本人、实例、包、来源、
集合 CAS 和确切旧引用；只有保存成功并取得准确回执才显示“已保存并生效”，没有第二发布步骤。
其他场景、旧修订和旧资源保留。工具依赖声明不授予工具权限，脚本不会执行或安装依赖。

修改本地文件后重新打包并导入。若内容已被另一处修改，页面停止保存，需主动重新预览并核对，
不会自动覆盖。若网络中断而保存结果不明确，页面保留原 requestId 和原参数，
点击“重试同一次保存”取得同一次操作回执，不自动换 ID 重发。
关闭并重新打开员工详情后，同一查看者、工作区和员工仍可重试原请求。

“修改记录”展示本人该实例的历史修订、准确内容地址和当前可读性；来源撤销后不返回旧正文。
当前旧包不可读时，文件预览仍显示准确替换目标，允许用无失效来源的新文件替换。
要恢复旧版本，在“修改记录”中选择该场景的“预览恢复”，核对旧版本与当前正文、资源、
元数据和全部来源引用，再点“确认恢复并生效”。恢复在同一保存事务内重验旧包、
来源当前资格及目标 CAS，追加新的当前修订；旧记录和其他场景不变。
恢复保留旧来源引用，不能通过复制旧字节绕过撤权；来源已撤销的记录不能恢复。
恢复遇冲突须主动重新预览，结果不明确时沿用原请求重试。
后台既有内容管理沿原路径，见[员工内容说明](../features/employee-content.md)。
旧 Workflow 的历史删除属于 A6，不由此工具处理。

## 现在怎么核对实际读取

**现在可用：** 读取、注入与照做是不同事实，按准确回执核对。

展开“本人 Workflow · 目录与读取记录”，先看“当前可用目录”，再查看当前包及资源文件。
目录只代表当前可用；本人在页面查看或下载文件不会增加模型读取回执。
正文、完整包和各资源的准确哈希可在同一入口核对，文件中的脚本仅作文本展示或下载，不执行。

“模型实际读取记录”来自既有 Run 的个人读取账本，分别显示正文与资源读取。
点击“查看这次读取的包”按该次准确内容地址打开历史版本，不会改成当前新版；
来源撤销后仍可看本人的审计元数据，但不可借历史重开正文或资源。
入口只显示安全错误，可沿“回到原工作记录”回到原会话消息。
本人仅有只读资格时仍可查看；员工归档或配发撤回后，可从历史员工的“详情”进入读取审计，
正文、资源与文件修改继续按当前权限拒绝。刷新确认登录或读取权限失效后，页面会清掉旧私有预览并取消在途内容读取。

读取记录分别展示“已读取正文”“已读取资源”和“已注入”。只有实际原生指令载入，或成功
skill 工具结果经完整渲染后持久化的注入事件，才会展示“已注入”及其准确版本。
技术详情可核对原生会话、调用/指令、事件序号、内容地址和双哈希；不会按同 Run 中工具成功的时间猜关联。
目录和 get 不代表注入，“暂无注入记录”也不能证明没有读取。这些事实均不证明模型已照做。
来源撤销、归档或配发撤回不抹去本人既有注入审计，正文和资源仍按当前资格拒绝重开。

离线打包本身没有数据库或部署状态；删除离线产物不会撤销已经确认保存的内容。

## U1 后怎么安装与更新

**U1 后才可用：** 公开 GitHub 链接读取或 zip 上传后，先展示内容，再由本人确认安装；
更新从现有场景详情发起，带入原来源，预览后确认。
确认页不能省，不自动检查新版本。`SKILL.md` 应位于包或所选来源目录的根层，
不能因套了一层文件夹就读错包。

更新确认页补充：“已有对话保留已加载内容，再次调用会读取新版。”
新界面不提供历史版本入口，装错时重新装旧包；
现有修改记录、恢复界面届时隐藏，底层修订与每次 Run 使用准确内容的审计保留。
这是 U1 目标，不表示当前的导入、恢复或读取审计已经删除，也不授予插件上传安装能力。

## 依据与核对入口

**现在可用（依据）：** 产品目标以 MET-249 的 2026-11-05 最新定稿
`f5bbd495-54a9-42e3-af89-c3498092f5b5` 为准，覆盖早先冲突；
未改动的框架来自 `4065a73a-5f62-4743-864b-ea6cd2d67363`。
新目标的状态按各节“U1 后才可用”理解，不因写入规范就视为实施完成。

当前行为可从这些源码核对：
[离线 CLI](../../scripts/workflow-skill-pack.mjs)、
[正文合同](../../packages/contracts/src/employee-content.ts)、
[资源合同](../../packages/contracts/src/skill-bundle.ts)、
[个人 Skill 限额](../../packages/contracts/src/personal-skills.ts)、
[场景 Provider](../../apps/worker/dsh/allrice-scene-provider.mjs)、
[导入与恢复](../../apps/web/app/chatflow/personal-scene-files.tsx)、
[读取审计](../../apps/web/app/chatflow/personal-scene-reads.tsx)。
DSH 原生格式与按需读取的依据是当前依赖
`@deepseek-ai/dsh-skill-filesystem`、`@deepseek-ai/dsh-skill` 的公开 README；
SaaS 的归属、授权、撤销与准确内容审计继续由 AllRice 负责。
