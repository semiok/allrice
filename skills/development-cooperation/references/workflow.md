# 共同流程

主员工先读取本次沙箱会用到的完整有限文件集，包括不能修改的测试文件及运行依赖。以 `workspace.export.create`（kind=changeset、format=json）发布 Changeset 基线，content 是 `{"files":[{"path":"真实相对路径","before":"读取到的原文","after":"同一原文"}]}` 的 JSON 字符串。基线必须包括全部测试输入，未修改文件保持 before=after；这不代表允许编辑测试文件。before/after 是文本，不是带 text/checksum 的对象。不要把“只允许修改一个文件”理解为“基线只放一个文件”。

保留返回的 `artifactId` 与完整 `sha256:` digest，通过 `assistant.development` 的 `command` JSON 字符串调用 `initialize`，seed 必须是该真实版本引用。先 inspect 核对 baselineFiles 覆盖验收所需全部文件，再委派编辑。`objectId`、路径和自造哈希都不能代替候选引用。

通过 `assistant.delegate` 的 `development` JSON 字符串分工：`expectedHead={artifactId,digest}`、`role=edit|test|review`。编辑还需明确 `paths`；测试和审查不传 paths。每次委派保留 `assistant.development` 与 `assistant.report`；测试另需 `local.process.execute`。不要让子助手写宿主工作区。

编辑返回自己的提案后，主员工 merge。采用后形成新候选，旧批准、测试和审查不继承。测试助手在 Bridge 的 Linux 副本验证此候选。收到同版真实终态测试 operationId 后，再委派不同于编写和执行测试的审查助手。没有实际测试回执时报告阻碍，不要求审查助手生成缺少 operationId 的 review。失败时先修正产生新版本，再对新版本验证。不要停止或重复派发已经完成的编辑来“修复”参数错误。

`assistant.development` 的 command 是 JSON 字符串；其他工具遵循各自 schema。工具返回参数错误时纠正格式。权限拒绝、撤销、取消和未知执行结果不能当参数错误重试。候选、归属、独立性、路径冲突和交付条件由平台校验，模型自报不能替代。
