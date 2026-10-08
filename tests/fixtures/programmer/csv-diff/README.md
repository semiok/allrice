# CSV 数据检查与差异对比：程序员参考项目

这些文件是合成验收输入与冻结的参考检查，csv.cjs 故意只提供待实现的公开接口。由普通隔离员工的实际模型完成实现、网页、服务和构建，不由验收脚本代写实现。不要直接把起始文件当作可用产品。

## 输入与接口

- `parseCsv(text)` 返回 `{headers: string[], rows: string[][]}`。保留字符串、前导零和引号内换行；支持 UTF-8 BOM、CRLF/LF/CR、逗号、双引号转义和末尾空字段。空输入、重复或空表头、字段数量不符、非法/未闭合引号必须明确报错。空白记录可以忽略。
- `compareCsv(left, right, keyColumn)` 使用相同表头和顺序。返回 `added`/`removed` 行对象，`changed` 中每项为 `{key,before,after,columns}`，以及 `unchanged` 数量、`issues` 和 `blocked`。所有字段保持字符串，不进行金额或编号自动转换。变更列按原表头顺序，不包含关键列。不得修改输入。
- 缺失键、重复键需保留每一条有问题的记录。`issues` 包含 `side: left|right`、`row`（含表头的逻辑记录序号，从2开始）、`type: missing-key|duplicate-key` 和 `key`；存在此类问题时 `blocked=true`，停止差异导出，不静默去重或覆盖。
- `exportDiffCsv(result)` 返回 UTF-8 CSV，表头为 `change,key,column,before,after`。新增/删除记录的非关键列各一行；变更记录只导出变化列。类型值为 added/removed/changed，未变化记录不导出。CSV转义保持原值，以 =、+、-、@、制表符或回车开头的单元格前加单引号，防止电子表格公式执行；blocked 时拒绝导出。

## 网页与交付

中文网页包含文件输入“原始 CSV”“新 CSV”、关键列选择“关键列”、按钮“对比数据”和“下载差异 CSV”，展示新增/删除/修改/未变数量、差异与数据异常。输入作为文本展示，不执行 HTML。未选择文件或文件不合法时提供明确提示。两个文件只在浏览器中处理，不发送远端。

补充 server.cjs（0.0.0.0:4173）、build.cjs（生成独立可用、不依赖远端资源的 dist/index.html）和 README。保留 package.json、pnpm-lock.yaml、reference-check.cjs、left.csv 和 right.csv 字节不变。执行 `node reference-check.cjs`、`node build.cjs`，收集真实 HTML 成果；启动有限租期私有预览，交付同一版本的源码 ZIP、真实测试与差异。

第二轮需求在同一项目增加“查找记录”输入框，对差异按关键键筛选，清空后恢复；保留原断言与旧版本交付。模型操作整体观察预算最多30分钟，每5分钟根据实际证据检查进展。

本项目只覆盖约定的 UTF-8 CSV 与小型 Node 项目，不代表 Excel/多编码/大型项目或任意框架通过。
