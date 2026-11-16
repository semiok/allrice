# QA 实例租期与等待提醒

本工具只管理 M1 的三个 QA 名额。M5 QA 和授权同步是另案，不能据本文启用。

```bash
qa-instance up met220-check --owner 打野线 --card MET-220 --ref <sha> --ttl 6h
qa-instance list
qa-instance renew met220-check --ttl 6h
qa-instance down met220-check
```

`up` 必填 owner/card；租期从分配成功开始，构建/初始化失败仍保留现场和名额。`renew` 从现在续期，单次最长 24 小时；不会把 createdAt 改成续租时间。没有租期的旧实例显示 legacy，不自动删除。旧 ref 缺少 Rice 模板时直接失败，不回退工具目录里的旧模板。

满额时只有已经过期、Web/Worker launchd 均不存在、端口无监听、实例目录下没有残留工作进程且没有其他 up/down/renew 持锁的实例才会回收。进程检查失败、仅 loaded 的 launchd、端口探测超时均保守视为不能回收。先保存 `instance.json` 的已知非凭据字段和 `logs/**/*.log` 普通文件（不跟软链接），再用原 down 流程；数据库操作失败保留文件。归档不含 creds、环境文件、plist、数据/授权目录。

归档目录 `~/allrice-dev/qa/codex/qa-reclaimed/<task>-<随机id>/`，目录700、文件600。只允许普通日志：不要把凭据内容打印到应用日志；此工具不把任意JSON/凭据文件打包，也不声称能识别所有日志中的秘密。

## 等待者催办

`up ... --wait` 满额后每15秒重查，最多24小时，Ctrl-C可退出。等待期间不持有分配锁，其他任务可以 down/renew；没有新实例就没有占新QA名额。等待者向占用实例的卡片写入一条提醒，内容包含两条线、两张卡、实例年龄和等待时间。

安装前由发布负责人安排给该调用进程注入 `LINEAR_API_KEY`，只用于 [Linear 官方 GraphQL API](https://linear.app/developers/graphql) 的卡片查询和评论。不要写在命令行、仓库、公开日志、M5或Dev .env，也不要让代理读取用户凭据文件。此PR不创建/安装认证，不利用Codex连接器的会话凭据。没有注入时，满额 `--wait` 明确失败；不带 `--wait` 的回收/报错和所有其他命令不需要Linear认证。

`.reminders/<task>.json` 保存该实例代际的最近attempt和 `pending/sent/failed` 状态，跨并发等待者加锁限频。HTTP 200但GraphQL报错不算成功；超时可能发生在远端已提交之后，因此失败也30分钟才可再试。终端明确显示失败，看护可以读取该状态；不声称本PR已改造规划线看护或Dot。Dot现有固定入口MET-244只负责转发，不能管理机器锁或任意卡片；其权限/任务不在本PR修改。

## 安装及回滚

合并和安装等用户批准。按既有 `scripts/m1/install` 切换版本，发布负责人须先确认**没有旧版本 qa-instance 命令仍在执行**；服务本身可继续跑。这是每任务锁可安全删除的前提：新版本所有任务锁的打开/尝试/删除都受固定 `.alloc.lock` 保护，旧版不遵守该协议。公共锁永远不删除。旧历史任务锁在只读盘点后由原任务安全收尾，不能扫目录批量删。

回滚到之前工具版本前，同样排空正在执行的命令；已有租期字段可被旧版忽略，但回滚后不会自动回收/续租/提醒，要由owner手动 down。新版本不更改MAX_INSTANCES=3，不改共享Dev、不运行真实模型。临时HOME的合同测试用伪造Git/launchd/数据库/Linear请求，不占机器实例。
