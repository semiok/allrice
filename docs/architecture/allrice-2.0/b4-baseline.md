# B4-F：待提交增量基线（MET-127）

2026-09-08，执行总表 v1.14。本 PR 仅收口已有增量，不增加 P13/P15/P16/P18/P19 功能。
基于 main `03ba9de30ef4ca0b864605a8feb5368aefcc38db`，三个独立 commit：

1. Gemini 密钥接受 opaque `AQ.` 格式；仍拒绝控制字符、换行、命令/转义文本，不回显密钥，不变更保存权限。
2. ARM Runner、平台绑定、沙箱显式 opt-in、Dev 分发和便携测试；仍不开放宿主 Shell，不自动启用真实租户权限。
3. 审批采用 PostgreSQL 接收时间；精确身份/内容/撤销/过期校验不变，重试不延长审批。

原始 M5 证据保留于私有 `.local/m5-remaining.6U4YjO/`：按最新用例合并 164 通过 / 1 未执行，
不是一次全绿全量命令；历史失败未删除。M5 系统 npm Fake-IP 仍被拒绝，固定真实公网 DNS 的 TLS/SRI 测试
不代表代理环境已修好。实际 Bridge 配对与 AI-what 工作区不变。

本批起点回归：常规测试 1124 通过 / 239 环境门禁跳过；全仓类型、lint、格式检查通过。
真实数据库组合 121 通过 / 4 显式环境门禁跳过；全仓构建通过。首次 DB 运行误用了 Dev 服务角色，
无法创建测试 schema，未执行用例，不计通过。已改用原测试库所有者，不提升 Dev 账号权限。
原始报告保留 `.local/b4-execution.u9W4Zo/baseline-regression.json`、`baseline-db.json` 与 `baseline-db-v2.json`。
上述固定源码测试之后仍须通过 PR CI、整批集成与最终 main/Dev 验收。

## 部署与回退边界

当前 Dev 是此前 ARM/Gemini 未提交快照 `bridge-arm-20260908-cc64ce92e0`，不是仅 base SHA 的版本。
审批时钟修复仍未部署。B4-F 无迁移；按本批统一固定 main SHA 部署时才改变运行版本。
不替换真实设备二进制、不删配对/目录/journal/outbox；菜单栏包另属 P13，可信签名公证另属 P14/B6。
Prod 不随本批变更，Gemini 不作为开发期门禁。
