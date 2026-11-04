# 本人开发 Workflow skill

D0 把本地原生 skill 目录转换成 C1 可保存的 procedure、SkillBundle 和资源来源字段。
使用自己的编辑器、Git 和命令行即可。该命令离线运行，不连接数据库、模型或网络，
不登录、不发布、不执行包里的脚本，也不安装包声明的依赖。
样例不加入平台 skill catalog；它不是已经上线的业务 Workflow。

## 写一个包

复制 [weekly-brief 样例](../../examples/workflow-skills/weekly-brief)，修改自己的内容：

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

## 打包与检查

在独立 checkout/worktree 中使用仓库固定的 Node 22.23.2、pnpm 10.33.3：

```bash
pnpm install --frozen-lockfile
pnpm --filter @allrice/contracts build
node --import tsx scripts/workflow-skill-pack.mjs \
  examples/workflow-skills/weekly-brief \
  --scene-id 10000000-0000-4000-8000-000000000001 \
  --scene-name '我的周报草稿' \
  --title '周报整理方法' > /tmp/weekly-brief.c1.json
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

## 排错和隔离试跑

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

确定性回归（无需模型或数据库）：

```bash
pnpm exec vitest run --maxWorkers=2 scripts/workflow-skill-pack.test.mjs \
  packages/database/src/skill-bundles.test.ts \
  packages/database/src/employees/employee-scene-skill-package.test.ts
```

真正试跑使用 [独立开发环境说明](README.md) 配置自己的 PostgreSQL、storage/native journal、
账号和模型凭据，使用合成数据。不要复制共享 Dev 的 `.env`、数据或凭据。
内部 qa-instance 会借用共享测试订阅，不把它当作完全独立的本人环境。
重测试遵守仓库 m5-test 规则；本 D0 不运行真实模型。

本版只证明“文件 → 原生解析 → C1 合同”链路，报告不是模型实际加载记录。
C2 将接 Provider、普通加载、`/name` 和准确资源；A5 将展示实际加载版本与错误。
在这些功能就绪前，不把离线打包成功当作会话内验收通过。

## 在本人员工详情导入与更新

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

## 在本人员工详情核对实际读取

展开“本人 Workflow · 目录与读取记录”，先看“当前可用目录”，再查看当前包及资源文件。
目录只代表当前可用；本人在页面查看或下载文件不会增加模型读取回执。
正文、完整包和各资源的准确哈希可在同一入口核对，文件中的脚本仅作文本展示或下载，不执行。

“模型实际读取记录”来自既有 Run 的个人读取账本，分别显示正文与资源读取。
点击“查看这次读取的包”按该次准确内容地址打开历史版本，不会改成当前新版；
来源撤销后仍可看本人的审计元数据，但不可借历史重开正文或资源。
入口只显示安全错误，可沿“回到原工作记录”回到原会话消息。

读取账本当前没有准确原生调用、事件与包地址的注入绑定，页面明确标为未提供关联；
目录可用、正文已读、资源已读均不证明已注入或已遵循。该关联等待 Workflow 运行时合同补齐。

D0 本身没有数据库或部署状态；出现问题可单独 revert 本功能 PR，删除离线产物即可。
