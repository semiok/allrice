# 员工 Provider 与推理档位修正

2026-10-27：MET-226 删除退役供应商配置与说明；平台模型设置见 [MET-163](./met163-platform-models.md)。

## 配置与兼容边界

- 员工新配置只提供 Codex 订阅。DeepSeek / OpenAI Compatible 从新配置入口移除；这些供应商的既有兼容行为不变。
- 非 Gemini 的旧 Provider 员工仍可读取；编辑器明确标为历史配置，不静默切换。新保存和重新编译需选择受支持的 Provider / 模型 / 档位。Gemini 数据按 0224 的明确模型字段清理，发现共享引用时迁移中止。
- 切换 Provider 是用户显式编辑草稿：重置模型、凭证引用、Base URL、旧 Provider 的 fallback；仅当旧档位不兼容时改为新模型默认档位。不会直接改变已发布员工。

## 当前版本实际接通的档位

| 路线 / 模型                                      | 员工编辑器档位              | 出站参数                            |
| ------------------------------------------------ | --------------------------- | ----------------------------------- |
| Codex，GPT-5.6 Luna / Sol / Terra 等当前接入模型 | low / medium / high / xhigh | pi-ai profile `reasoning`，保持原值 |

这是 AllRice 当前连接能力的子集，不宣称是所有厂商 API 档位。当前持久化契约尚未接通 `minimal` / `max`；不可只在前端增加这些值。未知模型不猜测档位，保留原记录可读并提示先核验。

## 依据与测试

以下保留当时的设计依据和验收原文；版本、测试数量及 Gemini 结果均为历史记录，不代表 MET-226 的当前能力或本轮验证。

原实现把 none→off、medium→high、xhigh→max 写进 `DSH_REASONING_EFFORT`，但仅 DeepSeek 插件读取它；Codex/Google 路由没有绑定该设置。此次保留 DeepSeek 历史映射，新增独立 `DSH_CODEX_REASONING_EFFORT` 与 `DSH_GEMINI_REASONING_EFFORT`；Google 显式声明经过核验的模型档位，避免未内置的 3.8 Flash 被视为不支持思考。

读取与写入规则分离：历史 Definition / Runtime Profile / Snapshot 的 schema 不收紧；新保存与 compile 使用同一规则。Gemini 执行入口再次校验，在解析凭证前拒绝不支持的模型或档位。

- [Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)：推理设置依赖模型，不能把一套档位套给所有 Provider。
- [Google GenerateContent Thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking)：3.8 / 3.7 Flash 不接受 minimal，支持 low / medium / high；Gemini 2.5 用预算而非 thinkingLevel。
- 本仓库固定依赖 `@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2`、`@earendil-works/pi-ai@0.82.1` 的配置 schema、模型声明及 Google wire 转换源码。
- 契约测试：Provider 选项、切换隔离、拒绝非法写入、历史记录可读。
- Worker 测试：冻结档位原值进入对应子进程；Gemini 默认关闭且不泄露凭证。
- 实际 Cordis + DSH + pi-ai + Google SDK 离线测试：拦截全部 fetch，不连接真实模型，验证每个档位最终生成的 `thinkingLevel`；检查 Codex profile 的默认推理档位。

没有真实 Gemini 模型调用，不把离线测试称为账号可用或真实生成验收。

验收记录：全仓 876 项普通测试通过（126 项默认跳过，未计为通过）；临时独立 PostgreSQL 中 4 项 Gemini 兼容测试通过，测试数据库随后清除。Production build、类型检查、ESLint、Prettier 和 DSH distribution 检查通过。真实 Chrome 隔离上下文访问本地预览，验证两种 Provider、Flash 三档、Pro 两档、切换及刷新；三个非法 PUT 均返回 400，员工草稿 revision 未变。未触发保存、发布或真实模型预览。
