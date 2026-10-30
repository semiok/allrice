# completed-turn 收尾切片

`final-relay-closure.jsonl` 来自 2026-10-31 02:33:23 CST 捕获的真实 Dev 失败，固定版本 DSH 0.2.1-rc.2，AllRice `675e039d`。它是 turn/start 加 seq 54–73 的最小事件切片，不是完整可恢复 journal：保留原事件顺序、seq/time、turn/step、surfaceOp、输入来源 kind/form、原公开正文与空正文；Session/消息/child ID 和 cwd 替换为稳定占位值，输入正文简化为计算结果，reasoning、provider replayState、usage/stream 省略或脱敏。没有供应商凭证或真实模型请求。

原始轨迹是正文 54 → 乙 notice 58 → 正文 60 → 甲 relay 64 → 空正文 66 → 甲 notice 70 → 空正文 71 → completed 73。失败版本选择空 71，本次回归要求精确选择原事件 60，不造正文、不拼接消息。来源单测只验证只读选择与锚定；生产 Host 测试另通过公开子级消息/结算、wait、candidate、finish 验证 message ID/seq/digest 和一次性 capability。它不宣称验证了 Dev 成功、用量结算或 UI 分支可用性。

原证据与未删历史：`qa/codex/pr679-680-dev-accept-20261030/facts-astra-report.md`、`facts-astra-offline-origin.json`；旧 #678 现场样本正文后没有静默尾步，不能代替该切片。核定来源 MET-231 评论 `95301355`（服务器 2026-10-31 02:43:18 CST）。
