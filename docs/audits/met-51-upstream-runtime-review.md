# MET-51 upstream conversation-runtime review

Reviewed on 2026-08-06 before changing AllRice's Rice conversation runtime.
The review used pinned upstream commits so future maintainers can reproduce the
comparison even after the upstream default branches move.

> Historical design review: MET-85/MET-81 later converged production execution
> onto one DSH Harness. The Codex app-server path described below is retained
> only as decision history; Codex subscription is now the DSH
> `openai-codex` Provider route.

## Sources

| Project      | Reviewed commit                            | License | Relevant source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------ | ------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenClaw     | `874c63318b590a3567a49d36066d79d211f8be08` | MIT     | [`queue-steering.md`](https://github.com/openclaw/openclaw/blob/874c63318b590a3567a49d36066d79d211f8be08/docs/concepts/queue-steering.md), [`attempt-steering.ts`](https://github.com/openclaw/openclaw/blob/874c63318b590a3567a49d36066d79d211f8be08/extensions/codex/src/app-server/attempt-steering.ts), and its tests                                                                                                                                                                         |
| Hermes Agent | `8f2712725af78c98c9ef7cdd447d14cb9348428d` | MIT     | [`codex_app_server_session.py`](https://github.com/NousResearch/hermes-agent/blob/8f2712725af78c98c9ef7cdd447d14cb9348428d/agent/transports/codex_app_server_session.py) and [`methods_session.py`](https://github.com/NousResearch/hermes-agent/blob/8f2712725af78c98c9ef7cdd447d14cb9348428d/tui_gateway/methods_session.py)                                                                                                                                                                    |
| DeerFlow     | `99c926b7bbcd0570870bc24ceb13ab934935f49c` | MIT     | [`manager.py`](https://github.com/bytedance/deer-flow/blob/99c926b7bbcd0570870bc24ceb13ab934935f49c/backend/packages/harness/deerflow/runtime/runs/manager.py), [`RUN_EVENT_STREAM.md`](https://github.com/bytedance/deer-flow/blob/99c926b7bbcd0570870bc24ceb13ab934935f49c/backend/docs/RUN_EVENT_STREAM.md), and [`test_multi_worker_run_ownership.py`](https://github.com/bytedance/deer-flow/blob/99c926b7bbcd0570870bc24ceb13ab934935f49c/backend/tests/test_multi_worker_run_ownership.py) |

## What AllRice adopts

- OpenClaw: an idle message starts a turn, a busy message is eventually steered
  with an expected turn ID, interrupt is a separate operation, and the client
  must confirm transcript consumption rather than treating the RPC response as
  completion.
- Hermes Agent: one application Session maps to one Codex thread; session RPCs
  expose steer, interrupt, compact, history and recovery without starting a new
  CLI process for every message.
- DeerFlow: Thread identity and Run identity are separate; PostgreSQL owns
  durable event order, active Worker ownership and cross-Worker cancellation.

For the first increment, AllRice implements the shared prerequisite: one
persistent Codex thread per ChatSession, a long-lived app-server client,
database-backed Run/Turn/Worker ownership, restart-safe resume, interrupt on
abort, and a frozen configuration checksum. Active-turn steering and delta
delivery remain follow-up increments on the same MET-51 issue.

## Copy decision

No upstream source file or code block was copied. The implementations are tied
to different runtimes (TypeScript single-user gateway or Python agent
harnesses) and do not enforce AllRice's organization/workspace/owner Tool
Broker boundary. AllRice independently implements the protocol and state
machine against the Codex CLI 0.144.6 generated app-server schema, while using
the upstream behavior and test scenarios as design references.

If a future change copies or modifies an upstream file, follow the repository's
Apache-2.0 audit policy: record the exact repository, commit, path, upstream
license, dependencies, modifications, tests and maintainer before merge.
