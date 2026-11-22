# 4.0 工作日验收 runner（MET280，L1 测试脚本）

离目标还差：此脚本能执行本地输入演练、既有原生入口 consumer fixture，以及已授权 Dev 的身份/4.0 discovery/封版只读页面检查；生产 Host/module/B/source/冷历史缺口仍逐项跳过。它不授予开验、部署、开开关、模型、VM或外发授权，不宣称完整工作日通过。真实 MET280 尚未开验。

`cases.json` 原字节保留准备清单的20项。`run.py` 将其拆为冷/暖、子会话、四面板读/写、定时、外发、空闲继续、关机历史和后台读等步骤。每步含 passed/skipped/failed、原因、owner、来源及截图/无截图原因。fixture 和 Dev 分列，fixture passed 不填 Dev passed；整体永远保留 `acceptanceGranted=false/completeWorkday=false`，本人认可须由人和发布负责人核原件。

## 一键离线演练

无需安装依赖、模型或服务：

```sh
python3 scripts/acceptance/workday/run.py --mode fixture --output /absolute/new-evidence-directory
```

实际写入并读回旧准备清单同一合成文本/CSV，记录SHA256，生成 `index.html` 和 `result.json`。若未配置既有native fixture源，协议项明确 skipped；不会伪造UI截图。**返回2表示不完整**，不是进程崩溃或工作日通过。输出目录必须全新，拒绝覆盖首败。没有任何模式自动install、开开关、启动VM或运行模型。

## 复用真实已有 consumer fixture

273公开可复用的固定源：`52daa9b5b0332ec7bf77cdc5a30f81aeefa9b49f` 的 `apps/worker/src/d-entry/native-entry.fixture.ts`，公开测试符号 `nativeEntryServer/nativeEntryFixture`。它注入合成身份、catalog、permit和RPC数据，没有VM、PG、native job、真实fence或模型。fixture driver 实际创建loopback HTTP server，调用现有HTTP handler读身份/子会话资源、拒子写、原root请求及缺DataPort拒绝，最后await既有HTTP/mux close。不会运行 `owner.native.integration.test.ts` 或启用 `ALLRICE_NATIVE_WEB_TEST_CLI`。

在根会话安排好本任务树已有锁定依赖后，用明确配置调用相同入口（不是安装依赖的指令）：

```json
{
  "fixtureSource": "/absolute/read-only/exact-source-worktree",
  "fixtureSha": "52daa9b5b0332ec7bf77cdc5a30f81aeefa9b49f",
  "nodeExecutable": "/absolute/approved/node",
  "driverTimeoutSeconds": 60,
  "cleanupTimeoutSeconds": 10
}
```

```sh
python3 scripts/acceptance/workday/run.py --mode fixture --config /absolute/fixture-config.json --output /absolute/new-fixture-evidence
```

数字是操作者为此QA进程显式选的预算示例，不是产品默认。源HEAD、干净tree、fixture原件与HEAD必须一致；正式并集头可以在owner映射后显式改pin。缺源/依赖 skipped，错pin/driver非零/收尾未确认 failed；没有忽略异常。driver只运行本目录一个测试文件、单worker、无DB/真实Host开关，Vite缓存落证据目录，不改只读source。`native-source.json`记录实际source SHA及fixture SHA256；fixture通过仍不能成为Dev/真实DSH通过。

## Dev 默认路径与真实截图

`--mode` 默认 `dev`，但**配置与前置缺失时不访问Dev**。必须另有真正开验授权，MET267和节点4通过、部署及本人员工开关已获批准；脚本不替代这些决定。提供操作者专用测试session到 `ALLRICE_ACCEPTANCE_SESSION` 环境变量（由既有授权测试入口获得），不读取用户浏览器Cookie、OAuth、密码、storageState或凭据文件，也不将session放配置/命令参数/报告。

显式配置必须包含：

- `baseUrl`：实际HTTPS Dev origin或本机loopback，不含用户名/密码、path/query/fragment。
- `personId/organizationId/workspaceId/employeeInstanceId/threadId`：已授权的本人和**同一员工实例**；不凭页面文字猜身份。
- `releaseSha`：操作者固定的部署预期SHA。此值不是自动证明部署成功，报告明确其来源；实际发布原件由发布负责人核对。
- `gates.met267/node4/deployment/personalRollout/readAuthorization`：相应真实批准/门禁原件引用。字符串只是证据引用，不创造批准。
- `requestTimeoutSeconds`：此次QA只读请求的显式预算；需要浏览器时另给 `driverTimeoutSeconds/cleanupTimeoutSeconds`。

只调用已核实的两个现有公开BFF：`GET /api/v1/d-entry/identity`、语义只读的 `POST /api/v1/d-entry/native-owner`。不跟随HTTP重定向，不保存响应头/任意错误体。实际服务器identity必须匹配配置，native-owner必须返回同identity的 `4.0` mount，3.x或缺源均不能填绿。controlReady仅是discovery，`editorReady/canSend`始终标not-verified；不会发送prompt或启动VM。

请求前已经明确缺失的来源、授权或门禁前置仍可 `Unavailable/skipped`，不发请求。实际发出请求后，所有HTTP错误均为 failed/退出1，记入对应身份/员工步骤并说明具体原因未确定；`503 + error.code=DEPENDENCY_UNAVAILABLE` 也不能证明生产缺源，因为现有BFF同样以此表示fetch、解析或未知上游异常。仅保存固定endpoint、status和白名单code，服务器message/header/body不入报告；不新增缺源豁免或产品接口。

只读UI需要 `browserExecutable` 指向已有锁定Chromium以及 `ui` 映射。允许的步骤只有：SUBAGENT.read、REFERENCES.read、DELIVERABLES.read、MEMORY.read、CAPABILITIES.read、APPROVAL.review、RECOVERY.cold-history、ADMIN.runtime/usage/approvals。每项须由D/模块owner给 `ownerSource`（固定source/symbol）、`path`、`locator`、`scopeLocator` 和 `scopeAttribute`；后两者必须对应**实际已有**DOM属性，值等于employeeInstanceId。没有封版locator就保持该项skipped，不自行造data-testid。可选 `text` 做精确可见文本核验，不拿显示文字当权限。

```json
{
  "ui": {
    "MEMORY.read": {
      "ownerSource": "owner must supply exact SHA and public UI symbol",
      "path": "/owner-supplied-existing-route",
      "locator": "owner-supplied-existing-visible-locator",
      "scopeLocator": "owner-supplied-existing-scope-locator",
      "scopeAttribute": "owner-supplied-existing-employee-instance-attribute"
    }
  }
}
```

这些是配置字段说明，**不是已存在的产品路由/locator**。当且仅当owner补齐真实值后才能执行。浏览器复用既有Worker `playwright-core`（与browser-qa.fixture.ts同一依赖），仅新建临时context，不接用户浏览器。阻断跨origin、所有页面POST/其他写、opaque WS、service worker与下载；只读页面可以失败，不能因此放开写。每步前后用相同两个只读BFF复查当前身份、4.0代际、原bindingRef及页面员工scope；只用实际 `page.screenshot` 生成PNG。没有截图则给具体原因，不生成占位图、不把rev2示意/旧截图替代。单张只读截图不关闭VISUAL全矩阵。

失败保留阶段、有限错误分类/类型和受控HTTP状态，截图失败另记 `captureFailure` 与无截图原因，不覆盖原首败。Playwright任意message/call log可能含selector、URL query、页面正文或凭据，因此只保存安全投影；不将这些原文放进JSON/HTML。`browser-diagnostics.mjs` 复用同一单页读取路径，注入page回归只证明诊断组合，不生成截图或宣称实际浏览器通过。

Dev写入、定时执行、审批/发送、VM开关/破坏、真实模型、空闲20分钟、恢复与性能压测目前没有在本runner装配生产入口，明确skipped到owner。本工具不调用3.x API冒4.0，也不提供任意shell/HTTP/模型adapter。四面板的读/写状态分别记录；不能将只读截图当业务写验收。

## 结果与退出码

- `1`：真实执行/配置来源/driver/收尾失败，首败原件保留。
- `2`：不完整（含skipped、fixture或本人工作日待核），HTML明确原因；不能在CI里用 `|| true` 变成通过。
- 本工具不自动返回“完整工作日通过”。应由本人和发布负责人核对真实原件，另记MET280验收。

`result.json`含步骤、原20项、来源/预期版本与汇总，HTML无外部脚本/图片请求，所有文字escape，已知session及敏感字段脱敏。`driver.log`只有脱敏诊断。异常/信号先结束并join本次owned进程组；超过操作者明确cleanup预算才杀本次owned组并保留失败，绝不关闭用户VM/Dev会话。native fixture/browse正常也必须有实际close回执。无权限/缺源与执行失败分开，不自动重试。

## 作者轻量回归 / 根会话门禁

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/acceptance/workday/run.test.py -v
node --check scripts/acceptance/workday/browser.mjs
node --check scripts/acceptance/workday/browser-diagnostics.mjs
node --check scripts/acceptance/workday/fixture.config.mjs
```

`runner.test.ts` 由既有默认Vitest自动收集，不依赖开关，调用完整Python标准库回归并测试单页诊断组合。Python的CLI缺源负向显式指定不存在的source路径，因此不会因组合树恰有fixture而误跑driver；另有错pin仍失败且不dispatch的回归。HTTP回归使用自建loopback BFF合成响应和真实HTTP请求，不连Dev。

`native-entry.fixture.test.ts` 是独立手工项，原生tag `manual:WORKDAY_FIXTURE_SOURCE` 在 `scripts/ci-manual-environments.yml` 精确登记。缺source时仍可见skip；显式提供source而缺receipt/cache属于配置失败，不再成为未登记的条件skip。必须先通过本runner的精确source/pin校验，另提供新receipt/cache路径，才用本目录fixture config实跑。自动Python/诊断通过不能替代该HTTP driver实跑。单文件检查示例（由根安排依赖与资源）：

```sh
pnpm exec vitest run scripts/acceptance/workday/runner.test.ts --maxWorkers=1
```

作者只运行标准库离线小测试/语法检查；实际native fixture driver与浏览器由根会话按资源/授权统一安排。负向覆盖escape/脱敏、skip非pass、3.x/错本人、缺生产来源、异常/cleanup、非零exit和首败不覆盖。不为了过门禁修改产品或放宽任何旧断言。

冻结依据：原MET280准备清单20项、FREEZE-ACCEPTANCE-ADDENDUM、AllRice4.0 BOUNDARY-CONTRACT v1.0/MODULE-TEMPLATE v1.0；271 `3dcde507`和273 `52daa9b5`为已核源码参考。缺口来自allrice40-n3-assembly/PRODUCERS，281/283属n4、285属n5，fixture不补这些生产来源。

DSH对照：直接复用原生入口的公开协议和既有consumer/browser fixture；不改变Agent Loop、会话、子智能体、定时/审批或生命周期。SaaS新增自补无；本片只有验收编排和单向证据呈现，不新增产品状态或MET225定制。
