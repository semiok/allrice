# M1 上的 AllRice 开发规则

2026-10-24 由 Claude 制定，用户确认。适用于在 M1（snow 的 MacBook Pro，Apple silicon）上开发、构建、部署 AllRice 的所有会话：Claude 的多个会话和 Codex 的多个会话都按这一份执行。完整开发规范见 Linear MET-220；迁移进度见 MET-216。

- **本文件放在仓库根目录**，每个 worktree 都自带：Codex 直接读 `AGENTS.md`，Claude 通过 `CLAUDE.md` 引用读到。M1 主目录的 `~/AGENTS.md` 只是指向这里的指针。（Codex 只从 Git 仓库根目录往下找 `AGENTS.md`，放在主目录它读不到，10-24 实测。）
- **适用范围**：在 M1 上开发 AllRice 的所有会话，包括从别的机器通过 `ssh m1` 操作 M1 的会话。在其他机器本机上开发时（例如 huihuimac 上收尾的 MET-195），忽略本文件，沿用那台机器自己的规则。
- 修改本文件要走 PR，同时同步 MET-220 第十章。

## 0. 必须遵守的底线

- **不要碰**：`~/.codex`、codex-runtimes、CodexOpenAIFailover、nvm 里的 Node 18（Codex 自己的环境）；微信、飞书数据，桌面「snow照片备份」；Clash Verge、Tailscale。
- **Prod 每次单独请示。** 共享 Dev 只由发布负责人部署（见第 9 节），部署后必须实际验证。
- **不要 sleep 轮询等资源。** 拿不到资源就把离线准备做完，然后结束本轮并说明在等什么，等待唤醒（见第 9 节）。
- **模型和推理强度**：Codex 默认用 `gpt-6.1-sol` 的 `max` 档，也可以用 `gpt-6-astra` 的 `max` 档（用户 10-24 指定）。Codex App 里的会话在 App 里选；`codex exec` 用参数指定（见第 9 节）。Claude 会话按用户在 App 里的设置，子 agent 用 Opus、high。省 token 靠不轮询、一个任务一个会话、做完就收尾，不靠降档。

## 1. 资源情况

- 内存 16G、10 核，磁盘约 565G 可用。**内存是瓶颈，磁盘很富裕。**
- 常驻占用：共享 Dev（Web + Worker）约 0.8G，沙箱虚拟机 `allrice-cloud-arm` 约 0.9G（上限 4G），Postgres 约 0.5G。
- 一个临时验收实例约 1G，**同时最多开 3 个**。内存紧张时，先停掉闲置的实例。

## 2. 目录与端口

| 用途                | 位置                                          | 说明                                                                                                                                                                                           |
| ------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 主仓库              | `~/allrice-repo`                              | 所有任务的 worktree 都从这里建，保证本地分支能被 `qa-instance --ref` 直接使用。**主仓库本身不切分支、不改文件、不构建**                                                                        |
| 任务代码            | `~/allrice-worktrees/<任务名>`                | 每个任务一个 worktree：`git -C ~/allrice-repo fetch && git -C ~/allrice-repo worktree add ~/allrice-worktrees/<任务名> -b <分支> origin/main`。**可以多个任务并行，各自构建，不需要排队。**    |
| 共享 Dev 发布       | `~/allrice-dev-releases/<版本名>`             | 只由发布负责人创建；保留最近 3 个                                                                                                                                                              |
| 共享 Dev 数据和配置 | `~/allrice-dev/.env`、`~/allrice-dev/.local/` | launchd：`ai.bplabs.allrice-dev-web` / `-worker`。端口：彩排期间 3011/3012，正式切换后改为 3001/3102（MET-216）                                                                                |
| 临时验收实例        | `~/allrice-qa/<任务名>/`                      | 每个任务一套：`release/`（构建目录）、`.env`、`.local/`、`logs/`、`creds.json`（测试账号）、`instance.json`                                                                                    |
| 验收实例端口        | 3200–3299                                     | 第 n 个实例：Web 用 3200+2n，Worker 用 3201+2n。用之前先检查端口是否空闲                                                                                                                       |
| 运维工具            | `~/allrice-dev/bin/`                          | `deploy-dev`、`qa-instance`、`smoke-test`、`deploy-lock`（见下文）；`with-env web\|worker <命令>`：带共享 Dev 的完整环境变量执行命令；`backup-daily`：每日备份；`qa-bootstrap.mjs`：初始化租户 |
| 备份                | `~/allrice-backups/`                          | 每天 04:00 自动备份，保留 7 天                                                                                                                                                                 |

## 3. 工具链（版本固定）

- **Node 必须正好是 22.23.2**：`~/.local/opt/node-22.23.2/bin`。Homebrew 里的 Node 不要用来构建或运行 AllRice。
- pnpm 10.33.3；Postgres 17 + pgvector；colima + arm64 gVisor；cloudflared 在 `~/.local/bin/cloudflared`。
- gh 已登录，可以直接推送分支、开 PR。

## 4. 数据库

| 库                              | 用途                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `allrice_dev`                   | 共享 Dev。**不要在上面跑破坏性测试。只有发布负责人可以改数据**，改之前先备份并记到 MET        |
| `allrice_qa_<任务名>`           | 每个任务的验收库，用完删除                                                                    |
| `allrice_b2`（角色 `a123`）     | 只用于数据库集成测试（`ALLRICE_TEST_DATABASE_URL=postgres://a123@127.0.0.1:5432/allrice_b2`） |
| `allrice_dev_snapshot_20261024` | 迁移前 Dev 库的副本，留着测试旧数据迁移。只读                                                 |

## 5. 发布车（共享 Dev 怎么部署）

不再用"构建、部署、验收三个窗口加约定顺序"的交接方式。

1. **合并**：PR 的 CI 全部通过、独立审查通过后，各任务直接合并，不用排队等别的任务。
   - **独立审查由没参与开发的一方做，只给代码，不给结论。** Codex 会话开好 PR 后，在 MET 卡上写"请求审查"，由发布负责人（或用户指定的 Claude 会话）审查。Claude 写的，由一个新开的 Claude 子 agent 或 Codex（`codex exec -s read-only`）审查。
   - 用 `codex exec` 派出去的活，由派活的一方负责审查和合并。
2. **部署**：只由**发布负责人**（见第 9 节）用 `deploy-dev` 部署到共享 Dev。目标节奏是每天 12:00 和 18:00（北京时间）各一次，但**目前没有定时自动触发**：由用户唤醒发布负责人，或者发布负责人看到 MET 卡上有部署请求时部署。紧急修复可以随时单独部署。
   - `deploy-dev --release-manager [--ref <分支或提交>] [--force] [--skip-smoke]`（默认 `origin/main`）。不带 `--release-manager` 会直接拒绝（退出码 6）：这是给非负责人的提醒，不是发布负责人就不要加。
   - 流程：先在新目录构建（不加锁，Dev 不受影响）；执行包变了，就跑官方的切换前检查；加部署锁，停 Worker、迁移数据库、切换版本、依次启动 Worker 和 Web，并核对两个服务上报的版本号；释放锁；最后跑五项冒烟测试。实测全程约 6 分钟，Worker 停机约 17 秒。
   - 切换过程中任何一步失败，都会自动切回原版本。冒烟测试失败不会自动回滚（模型偶发失败也可能导致不通过），需要回滚时执行 `deploy-dev --release-manager --rollback`（约 25 秒，数据库迁移不回退）。`deploy-dev --status` 查看当前版本和最近的部署。
   - 冒烟测试也可以单独跑：`smoke-test --dev`，聊天、Office 导出、数据分析、云端浏览器、定时提醒五项，用真实模型，约 5 到 8 分钟；结果和截图在 `~/allrice-dev/qa/smoke/<时间>/`。
   - 中止或失败时，构建目录会被自动删除，日志保留在 `~/allrice-dev/qa/deploy-logs/`；部署记录在 `~/allrice-dev/qa/deploys.jsonl`；发布目录保留最近 3 个。
   - **已知限制：执行包 ID 变化时，部署会被拦下。** 只要数据库里还有会话或定时任务控制器绑定在旧执行包上，官方检查就不会通过（`REFERENCES_UNCOVERED`），脚本在停服务之前中止。改动原生适配层或依赖时执行包 ID 会变，例如 10-24 main 合入 #532 后就变了。要等 MET-195 的迁移机制，或者先退休这些上下文，才能部署。普通的业务代码改动不会改变执行包。
3. **验收**：各任务在自己的 MET 卡上写清楚"本票要在 Dev 上验什么"。部署完成后，各任务在共享 Dev 上验收自己的那部分。**验收不独占 Dev，也不重启服务**；需要重启的，告诉发布负责人。
4. **部署锁**：`deploy-dev` 自己会加锁，**不要再套 `deploy-lock run`**（会因为锁已被占用而失败）。`deploy-lock` 只给发布负责人做部署以外、需要停服务的操作，例如手工重启共享 Dev：`deploy-lock run <任务> [分钟] -- <命令>` 会自动加锁、执行、释放；也可以分开用 `acquire` / `release`。其他会话只用 `deploy-lock status` 看状态。不要手工操作锁目录。**锁只在部署和重启那几分钟持有，最长 30 分钟，过期自动作废，可以被接管。** 拿不到锁（退出码 3）就停下来说明，不要循环重试。
5. 临时验收实例上能验的，尽量在实例上验完，再交给发布车。

## 6. 临时验收实例（`qa-instance`）

- 用途：在合并之前，用自己的改动完整跑一遍页面和功能，不占共享 Dev。
- `qa-instance up <任务名> [--ref <分支或提交>]`：从 `~/allrice-repo` 取代码（默认 `origin/main`；`--ref` 可以是分支或提交，分支在本地和 origin 上都有时取较新的那个，两边分叉就报错，这时改传提交号；**只构建已提交的内容**，没提交的改动先 commit，不必 push），然后自动完成全部准备：构建、生成执行包、建库、生成配置、启动服务、初始化租户（公司 `QA-<任务名>`、账号 `qa-<任务名>`、发布 Rice 并配发）。约 1.5 分钟。
- 多个会话同时 `up` 是安全的：数实例、分端口那一步用内核文件锁（`lockf`），持锁进程退出或被杀都会自动释放（10-24 实测 6 个同时开，正好 3 个成功、端口各不相同）。名额满了直接报错，不排队：先停自己不用的实例；别人的实例只有闲置时才能停（见第 7 节）。
- `up` 失败后实例仍占一个名额，脚本会提示；先 `qa-instance down <任务名>` 再重试。
- `qa-instance list`：列出实例的端口、版本和健康状态。`qa-instance down <任务名>`：停服务，删库、删目录、删 worktree，一个命令清干净。
- 访问：在 M1 本机打开 `http://localhost:<Web 端口>`，或者用 SSH 端口转发；账号密码在 `~/allrice-qa/<任务名>/creds.json`。
- **实例默认关闭云端执行**，发布的是去掉云端工具的 Rice：没有 Office 导出、数据分析和对账这类沙箱能力。这类改动在共享 Dev 上验。实例不共用沙箱虚拟机，因为 Worker 启动时会清理它不认识的容器，可能误伤共享 Dev 的任务。
- 模型订阅：不复制凭证，`ALLRICE_DSH_PLATFORM_HOME` 指向共享 Dev 的凭证目录，订阅槽位与共享 Dev 保持一致。
- `smoke-test --instance <任务名>`：默认跑聊天、浏览器、提醒三项；可以用 `--only` 指定。
- 实例不需要构建身份：开发维护功能是关闭的。

## 7. 清理

- **PR 合并后立刻 `qa-instance down` 自己的实例**（之后在共享 Dev 上验收，用不到实例）。Dev 验收通过后，再用 `git -C ~/allrice-repo worktree remove` 删掉任务 worktree。由该任务的会话自己清理。
- **闲置实例**：`~/allrice-qa/<任务名>/instance.json` 里的 `updatedAt`（实例就绪的时间）超过 24 小时，就算闲置。名额满了时，任何会话都可以 `down` 闲置实例，并在该任务的 MET 卡上留一句。
- 暂停的任务在 worktree 根目录放一个 `.KEEP`，说明原因。
- 共享 Dev 发布目录保留最近 3 个；备份保留 7 天。
- 磁盘可用空间低于 100G 时先清理。删除前先确认没有进程在用；不要批量 `rm -rf ~/allrice-*`。

## 8. 记录

- 进展写在 Linear 的 MET 卡上，卡片顶部写"当前状态"。同一批问题合在一张卡里。
- 部署相关的问题记到 MET-218；写死的限制和过小的权限记到 MET-219；新的开发规范补到 MET-220。

## 9. 多个会话一起干活（Claude、Codex 都一样）

1. **一个任务对应一个会话、一张 MET 卡、一个 worktree、一个分支。** worktree 和验收实例用任务名命名（建议用 MET 编号，例如 `met-221`）。不碰别的任务的 worktree、验收实例和数据库（第 7 节的闲置实例除外）。
2. **发布负责人只有一个，由用户明确指定。** 用户没有指定你，你就不是发布负责人：不管你是 Claude 还是 Codex，也不管你是不是负责 AllRice 的主力会话。用户会在那个会话里明确说明，没有被明确告知的会话都不是，不要按自己的运行环境去对号入座。只有发布负责人可以：
   - 运行 `deploy-dev`（包括 `--rollback`），以及重启共享 Dev；
   - 修改共享 Dev 的 `.env`、launchd plist；
   - 修改 `allrice_dev` 里的数据。

   其他会话（其他 Claude 会话、所有 Codex 会话）需要部署或回滚时，在自己的 MET 卡上写明"请求部署：哪个 PR，部署后要验什么"，再结束本轮；紧急情况直接告诉用户。部署锁只能防止同时部署，防不了谁都去部署，这一条靠大家遵守。

3. **开工或恢复时先看状态，再动手**：`deploy-dev --status`（Dev 当前版本和最近的部署）、`deploy-lock status`、`qa-instance list`，以及自己 MET 卡上的最新进展。不要循环查询。老 worktree 先 `git fetch` 并 rebase 到最新的 `origin/main`，否则读到的是旧版规则。
4. **等待与唤醒**：要等别人（部署、验收、别的 PR），就结束本轮，在 MET 卡上写明在等什么。
   - **Claude 会话**：和发布负责人在同一个 App 里的，发布负责人可以直接发消息唤醒；不在同一个 App 里的，和 Codex 一样由用户唤醒。
   - **Codex App 里的会话**：Claude 叫不醒，由用户去点一下。发布负责人部署后，会在相关 MET 卡上写明"已部署到哪个版本、请验什么"。
   - **发布负责人用 `codex exec` 派出去的活**：派活的一方负责收结果，不存在等待。
5. **用 `codex exec` 派活必须带 `-m`。** M1 的 `~/.codex/config.toml` 默认模型是 `gpt-5.4`，用 ChatGPT 账号登录时不能用，不带 `-m` 会直接报 `model_not_found`（10-24 实测）。按第 0 节，默认用 `gpt-6.1-sol` 的 `max` 档：

   ```bash
   mkdir -p ~/allrice-dev/qa/codex
   ~/.local/bin/codex exec -C ~/allrice-worktrees/<任务名> -m gpt-6.1-sol -c model_reasoning_effort=max -s danger-full-access -o ~/allrice-dev/qa/codex/<任务名>.md "<任务说明>" </dev/null
   ```

   - 也可以把 `-m` 换成 `gpt-6-astra`。
   - **开发任务要用 `-s danger-full-access`。** `workspace-write` 沙箱连不上本机 Postgres、写不了 worktree 的 git 元数据（在 `~/allrice-repo/.git` 里）、也上不了网，所以测试、commit、push 都会失败（10-24 实测）。M1 是专用开发机，约束靠本文件，不靠沙箱。只做审查的任务用 `-s read-only`。
   - 任务说明里写清楚：对应的 MET 卡、要改哪里、怎样算完成；做完提交到任务分支、推送并开 PR，**但不要合并，也不要部署**。
