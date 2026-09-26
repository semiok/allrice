# 报告与交付

每名助手最终通过 `assistant.report` 返回结果。evidence 只放属于该子助手的已登记成果 `{id,digest}`；根候选、命令 operationId 或 review ID 不能冒充助手的成果引用。没有已登记成果时使用 `evidence=[]` 与 `output={name:"verification-result",content:"说明并引用真实候选、命令或审查记录"}`。仅在没有未完成事项时使用 completed / incomplete=[]。

建议报告四项：完成了什么、候选 artifactId/digest、实际测试或审查依据、仍未完成什么。主员工必须使用平台 `deliver` 回执作为正式交付证据，回复可下载的真实成果链接，不自行拼接或编造链接。

面向用户说明：修改内容与适用版本、测试命令和退出码、独立审查结论、未验证内容、是否实际应用到本地。保持简洁，提案完成和本地写入分开陈述。
