# MET167 Dev 发布控制

PR5b1a 是控制面引导切片，并未实现独立发布监督或自动发布。

固定任务类型 `allrice.platform.dev.release` 预留给独立 supervisor。普通 enqueue 拒绝整个 `allrice.platform.dev.*` 命名空间；普通 Worker claim 跳过控制任务，start、heartbeat、事件写入、成功和失败回调也拒绝，即使调用者知道正确租约。当前发布 admission 始终关闭；无模型、浏览器、普通管理员或 Worker 路径可获得主机权限。维护与超时仍是 canonical queue 事实，不表示主机已恢复。

人工操作者在干净、准确版本的可信 Dev 目录构建后运行：

```sh
node scripts/dev-release/prepare-identity.mjs --root=/Users/a123/allrice-dev-releases/<release> --release-sha=<merged-main-sha>
```

准备器核对实际 Git HEAD/tree、Web BUILD_ID 与运行产物、Worker 编译产物及传递工作区运行依赖的实际解析目标与入口，再写入 `.local/dev-build-identity.json`。服务从自己的真实入口路径定位此文件，首次测量实际字节并验证每条工作区依赖链接仍指向本发布目录；Next 原生外部包别名须解析到本发布的 pnpm 目录，别名与 package.json 摘要也封存；开发模式不返回生产身份；ready 响应附加源码/tree、manifest/产物/依赖摘要及本进程 boot、PID、Node 版本。原健康字段和 SHA header 保留。未登记的旧服务没有 verified identity；存在但损坏、字节不符或 SHA 不一致时不能返回 ready。该文件是受信操作者登记的构建描述，并非平台用户提交的发布授权，也不是 CI、维护屏障或产品 QA 凭据。

身份记录是本次进程初始化时的观测，运行中的主机文件变动需由后续 supervisor 在物理阶段前后重新核对。后续 prepared manifest 必须冻结完整预期摘要，而不能只核对环境变量 header。两服务准确身份也不等于任务、页面或原问题验收已通过。

PR5b1 后续仍须：已安装监督身份、同一 canonical 控制 Run/Job、所有 producer/admission 的持久维护屏障与 ACK、统一人工入口、独立主机锁和阶段意图/回执、真实无迁移切换及兼容恢复。忙则退出；先封 claim 再等待 queued 排空会造成自锁。bootstrap 完成前不开放发布任务。PR5b2 再消费准确 merge generation/action/receipt，核对 A→T 集成范围、固定构建和迁移兼容，并补原 command-output QA。Prod、数据库降级、Bridge 自动升级不在范围内。

## PR5b1b: durable maintenance protocol, partial producer wiring

Canonical enqueue/claim/start and employee-test preview/queue/claim take the
Dev control row SHARE lock before business/root/job locks. A maintenance
request takes UPDATE, then checks durable busy facts after admissions commit.
Only the exact bound control Job is excluded; prefix-matched jobs, retries,
approvals, employee tests, unfinished producer permits, live runtime leases
and provider flows remain busy. A busy request leaves state/epoch unchanged.

`ALLRICE_DEV_MAINTENANCE_ENABLED=1` opts in the two Dev services. Other
environments and historical fixture checkpoints remain unchanged. Enabled
services fail closed when their row is missing. The ready response exposes
only state/epoch, disabled release admission and `producerCoverage=not_installed`.
Control requests require opt-in, exact installed-owner binding, current
canonical Job/attempt/lease, supervisor boot/build, non-cancellation and a
fresh DB-clock deadline after locks. No installation/control HTTP or model
interface exists. Tests use synthetic bindings in disposable schemas only.

Durable permits remain busy until the exact instance completes; time or
process death never implies success. ACK/withdrawals require the exact current
owner, attempt, epoch and build. Expired owners cannot reopen the barrier;
future recovery needs a separately authorized reconciliation action.

This slice does not install the complete 24-producer lifecycle. ACKs force
all uninstalled producer families into the unknown list even if a caller
supplies an empty list, so coverage cannot be declared idle. There is no
quiesced transition, host START, stop/start driver or release admission.
Other productive paths are not represented as gated. Full PR5b1 requires
actual instance/dispatch coverage, installed supervisor, shared manual
control, and physical no-migration switch/recovery. Health 200 or zero Jobs
are never authority to stop a service.

## PR5b1c root lifecycle slice (C1), partial coverage

Trusted production startup installs one lifecycle registry per actual
Web/Worker boot and sealed manifest. The custom Web server and Next health
bundle read the same `Symbol.for` registry. Dynamic Next requests first commit
a stable producer permit, then execute the handler; both its returned promise
and the response lifetime are awaited. Client close or response finish alone
does not complete a still-running handler. Only exact GET/HEAD live/ready
health paths bypass this request gate.

Worker startup authorization recovery/probes, queue ticks, automation/folder
preparation, employee tests, MCP discovery/recovery, cloud recovery/managed
preparation and authorization broker promises use the same root wrapper.
Claimed executions retain a child reference before detaching from a tick;
the root permit cannot finish when the tick returns first. Broker tick now
returns its real active promise. A known maintenance refusal skips new work
without declaring the database offline. Role/identity unknown fails startup
closed when the Dev opt-in is enabled; unmanaged environments use the original
callbacks without extra database writes.

Shutdown is checked again inside the admitted Worker thunk: an authorization
or other producer queued before SIGTERM cannot start after its owner begins
closing. Worker shutdown waits for current roots, pending admission and retained
children before closing the database. This wait does not clear uncertainty or
claim that native clients, sockets or detached resources have stopped.

Pending admission is counted before its database await. Lost start/finish
receipts and rejected business lifetimes preserve unknown outcomes, without
repeating the business thunk or expiring unfinished permits. Completed
internal metadata older than one hour is compacted in bounded batches after
256 successful root completions, using migration 0149's completed-row index.
Unfinished/unknown permits and all business/audit ledgers remain untouched.

The health observer reports actual root/child counts and uncertainty;
`scopeCoverage=partial`. All 24 catalog families remain unknown: WebSocket
frames, preview/relay and service lifetime, driver/native close proof, durable
external work and complete observer classification are not inferred from a
root promise. No ACK coverage is relaxed, no quiesced/host START transition is
added, and release admission remains disabled. C2/C3/C4 explicit resource
wiring precedes the independently installed supervisor and shared manual
release path; this slice cannot authorize an automatic or fallback stop.

## PR5b1c Web-local closure slice (C2)

Cloud Unix preview channels, public HTTP/bootstrap/upgrade owners, Bridge
admissions/connections and virtual preview channels reserve ownership before
their first asynchronous authorization/open boundary. Closing is a synchronous
stop signal plus one cached completion promise. Routing removal does not retire
lifetime ownership. Accepted queues, send callbacks, pending authorization and
late openers are joined; current/renew queries that lose a decision timeout
remain owned until they actually settle. A final connection release follows
that work exactly once. Required cleanup rejection stays a failed close result,
while bounded admission records can retire without clearing that uncertainty.

An endpoint/callback signals stop without awaiting the drain containing itself.
Channel close is initiated before draining blocked forwarding, including on a
normal browser disconnect. Late returned channels are closed and joined.
Normal terminal preview delivery is preserved; closing one virtual channel
does not close its shared Bridge connection or become a remote cancellation
receipt. Backpressure and private target/session/origin checks remain in force.

The Web close coordinator latches every gateway before waiting for any of them.
Already-started Bridge loopback HTTP can finish while HTTP/Next/database remain
available. It then closes the HTTP listener, waits for C1 roots including late
handlers, and closes Next/database only after successful gateway cleanup.
Repeated closes return the same result; one failure does not abandon other
gateway drains.

These are local completion proofs only. Unix socket close is not Worker or
container termination, and a Bridge send callback is not a peer ACK. Native
drivers, Worker relays, full productive frame admission and external work
classification remain C3/C4 work. All 24 catalog families remain unknown,
scope coverage remains partial and release admission remains disabled.
No installed supervisor, quiesced transition, host START or automatic/manual
fallback release authority is added by C2.

## PR5b1c Worker private preview IPC slice (C3a)

Worker shutdown synchronously fences private preview admission before waiting
for commands or service shutdown. Repeated signals reuse one shutdown result.
The transport retains disconnected owners until already-started authorization,
reauthorization, frame queues and actual IPC send callbacks settle. Stop checks
after each awaited authorization stage prevent late results from starting input
reads, container checks, relay dispatch or status publication. Callback errors
cannot skip cleanup; cleanup failures remain failures on repeated close.

Raw Unix HTTP connections, incomplete upgrades, WebSocket close events and the
listener are also joined. Node automatically unlinks its bound Unix path on
close. A private owned binding with a hard link exposes the same socket inode;
close leaves the public stale socket name so no stat/unlink race can remove a
replacement. Legacy startup probe and inode checks handle stale names under serialized
publication. They are not an atomic multi-process ownership fence; concurrent
startup/publication stays unknown for shared supervisor ownership work. Neither
ECONNREFUSED nor an inode check grants release/START authority.
Startup failure closes the private owned listener and binding directory. No preview protocol, shared runtime or Bridge input changes.

This completes the IPC ownership boundary only. Shared relay `receive/close`
still return void and hide Docker request, fetch, upgrade and helper lifetimes.
Guard process/stdio, remote lease and container exit, service recovery and other
native resources remain C3b/C3c work. IPC drain is not proof of those resources
stopping. All 24 producer families remain unknown/partial; producer ACK,
supervisor, host START and release admission remain disabled.
