# M1 处置手册 3：镜像丢失

对应告警：`images`（钉死的镜像缺失）。总览见 [m1-monitor.md](m1-monitor.md)。

## 影响

Worker 只用 `packages/contracts/src/runtime-v2/cloud-platform.ts` 里按 ID 钉死的镜像（Node、Python 图表、Office、静态浏览器）。少一个，对应的云端功能直接失败（10-21 Office 和 Python 镜像丢失，两天后才被人发现，就是这一类）。告警里列出缺的是哪个。

## 第一步

```bash
export DOCKER_HOST=unix://$HOME/.colima/allrice-cloud-arm/docker.sock PATH=/opt/homebrew/bin:$PATH
docker images --no-trunc --format '{{.ID}} {{.Repository}}:{{.Tag}}'
```

和运行中版本要求的 ID 对比（监控就是这样取的）：

```bash
REL=$(/usr/bin/python3 -c 'import plistlib,os;print(plistlib.load(open(os.path.expanduser("~/Library/LaunchAgents/ai.bplabs.allrice-dev-worker.plist"),"rb"))["WorkingDirectory"])')
~/.local/opt/node-22.23.2/bin/node -e 'import(require("url").pathToFileURL(process.argv[1]).href).then(m=>console.log(m.cloudPlatform.images))' "$REL/packages/contracts/dist/runtime-v2/cloud-platform.js"
```

## 处理

先查是谁删的：`docker system prune`、`docker image prune -a`、重建 VM 都会删掉没有容器在用的镜像。**任何人都不要在沙箱 VM 里跑 prune。**

1. **有导出的镜像包**：`docker load -i <文件>`，再确认 ID 和上面一致。
2. **没有导出包**：按 [p15-cloud-runner.md](../architecture/allrice-2.0/p15-cloud-runner.md#apple-siliconarm64宿主) 的 arm64 一节在 VM 里重新构建（Python：`infra/docker/Dockerfile.python-charts`；Office：`infra/docker/Dockerfile.office-sandbox`；静态浏览器：`scripts/build-static-browser-runtime.mjs`，`ALLRICE_CHROMIUM_VERSION=156.0.8078.47`）。构建结果的 ID 和登记值一致才算恢复；**不一致**（基础镜像或软件源变了，见 MET-218“镜像不可复现”）说明不能原样恢复：不要改 Worker 的钉死值来凑，把新 ID 和差异报告给用户，按 PR 流程更新 `cloud-platform.ts` 后再部署。
3. Node 镜像是多架构 index，可以从官方源按摘要重新拉取。

## 确认恢复

```bash
~/allrice-dev/bin/monitor run --dry-run | grep images
~/allrice-dev/bin/smoke-test --dev --only office,csv,browser
```

## 后续

现在没有钉死镜像的导出备份，丢了只能重建、而且可能对不上 ID。把钉死镜像定期 `docker save` 到 `~/allrice-backups/images/` 记在 MET-222 后续事项里。
