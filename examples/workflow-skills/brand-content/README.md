# 品牌内容 Workflow 样例

**现在可用：** 这是当前 CLI 可打包的完整文档样例。入口为 `SKILL.md`，只用
`name`、`description` 两个 frontmatter 字段；`bundle.json` 显式列出四份参考约定和一份合成品牌资料。
虚构品牌“纸间小岛”只在用户明确要求合成演练时使用，不是真实客户资料。

选题由用户决定，稿件由用户确认，发布由用户完成。样例只交付聊天文本，
唯一工具依赖是 `workspace.skill.read`，只读取本包资源。
没有脚本、发布、消息发送、业务写入或新增工具授权，也没有 QA Run 和凭据。
放进仓库不等于加入平台 Skill catalog、发布或通过真实模型验收。

**U1 后才可用：** 五字段模板、按标题展示和作者 `/name` 调用见
[AllRice Workflow 开发规范](../../../docs/development/workflow-skills.md)。
不要为了采用新模板给本样例补 `whenToUse` 或 `metadata`，当前 CLI 会拒绝。
打包命令、现有导入与读取审计的操作说明也统一见该规范。

来源与许可保留在 `bundle.json` 的 `sourceRef`、`license` 及本目录 `LICENSE` 中。
`reviewedBy` 保留源包作者标签，只是元数据，不授予工具权限，也不代替本次仓库 PR 的独立复核。
