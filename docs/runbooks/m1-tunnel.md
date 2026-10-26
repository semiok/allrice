# M1 处置手册 6：隧道断开

对应告警：`tunnel`（Cloudflare 隧道断开）、`public_entry`（公网入口不可达，M1 本机或 huihuimac 发出）、`public_entry:<域名>`（同一隧道的另外几个域名不可达，只由 M1 本机发出）、`restarts:ai.bplabs.allrice-m1-tunnel`。总览见 [m1-monitor.md](m1-monitor.md)。

## 影响

用户都通过公网地址（`ALLRICE_PUBLIC_URL`，现在是 a.bplabs.xyz）访问，隧道 `allrice-m1` 断了就谁都打不开，但 M1 上的服务本身可能是好的。只有 huihuimac 报 `public_entry`、M1 本机不报：多半是 DNS 或 Cloudflare 那一侧的问题，或 huihuimac 自己的网络。

隧道还承接员工入口 allrice.bplabs.xyz、管理后台 allrice-admin.bplabs.xyz 和 Rice Bridge 的配对服务器 allrice-dsh.bplabs.xyz（10-26 切换时从 huihuimac 迁来，MET-216），M1 本机每轮按同样标准各拨测一次（默认配置 `extraPublicUrls`）。allrice-dsh 是 Bridge 写死的地址（`apps/rice-bridge/macos/Info.plist` 的 `AllRicePairingServerURL`），它断了所有 Bridge 都连不上；它的根路径会跳到管理后台，所以拨测它自己的 `/api/health/ready`。只有某个域名报 `public_entry:<域名>`、`public_entry` 正常：隧道是好的，按下面第 4 步区分是 Web 对这个地址的应答不对，还是这个域名自己的 DNS 记录或 ingress 规则。

## 第一步

```bash
launchctl print gui/$(id -u)/ai.bplabs.allrice-m1-tunnel | grep -E "state|pid|runs|last exit"
tail -50 ~/Library/Logs/allrice-m1-tunnel.log
for p in 20241 20242 20243 20244 20245; do curl -s -m 2 http://127.0.0.1:$p/ready && echo " ($p)"; done
~/.local/bin/cloudflared tunnel info allrice-m1
curl -sS -o /dev/null -w '%{http_code}\n' https://a.bplabs.xyz/      # 应为 200 或跳转到 /login
for h in allrice allrice-admin; do curl -sS -o /dev/null -w "$h %{http_code} %{redirect_url}\n" https://$h.bplabs.xyz/; done  # 同上，跳转到本域名的 /login
curl -sS -o /dev/null -w '%{http_code}\n' https://allrice-dsh.bplabs.xyz/api/health/ready  # Bridge 配对服务器，应为 200
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3011/login  # 本机 Web 是否正常
```

## 处理

1. **进程不在**：`launchctl kickstart gui/$(id -u)/ai.bplabs.allrice-m1-tunnel`；plist 没加载时 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.bplabs.allrice-m1-tunnel.plist`。
2. **进程在但就绪连接为 0**：多半是网络（看日志里的 `failed to connect to edge`）。确认 M1 能上网，Clash Verge 是否在跑、规则有没有拦 Cloudflare；网络恢复后 cloudflared 会自己重连，几分钟不恢复再 `launchctl kickstart -k gui/$(id -u)/ai.bplabs.allrice-m1-tunnel`（手工重启一次不会触发“反复重启”告警，60 分钟内第二次才会）。
3. **隧道好但公网 502/530**：本机 Web 不正常（看 `web` 告警）或 ingress 配置（`~/.cloudflared/allrice-m1.yml`）指错了端口。改配置前先备份。
4. **只有某个域名失败**（`public_entry:<域名>`）：先看告警详情里的完整地址和返回码，在本机对同一路径带上这个域名再请求一次，例如 `curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: allrice-dsh.bplabs.xyz' http://127.0.0.1:3011/api/health/ready`。本机也不是 200（就绪接口会在正文的 `detail` 里说原因）：问题在 Web，看 `web` 告警和 [Worker 崩溃](m1-worker-crash.md)。本机正常：再看 `~/.cloudflared/allrice-m1.yml` 里这个域名的 ingress 规则还在不在（改了配置要重启隧道才生效）；规则在却仍不通，多半是这个域名的 DNS 记录没指向隧道 `allrice-m1`（例如还指向 huihuimac 的旧隧道）。代理中的记录用 `dig` 只能看到 Cloudflare 的地址，看不出指向哪个隧道，要用户在 Cloudflare 控制台查看和处理。
5. **只在 huihuimac 上失败**：在 huihuimac 和手机流量各试一次，区分是 huihuimac 网络还是 DNS/Cloudflare。DNS 记录要用户在 Cloudflare 控制台处理。

## 确认恢复

两边的 `public_entry` 和 M1 的 `public_entry:<域名>` 下一轮自动恢复。手动确认用告警详情里的完整地址（allrice-dsh 是 `/api/health/ready`，不是根路径：根路径会跳到管理后台，管理后台正常时总是 200）：`curl -sS -o /dev/null -w '%{http_code} %{time_total}\n' -L --max-time 15 <地址>`，15 秒内返回 200。

## 谁来做

重启隧道进程不改共享 Dev 的配置，值班的人可以做。改 `~/.cloudflared/` 下的配置或 DNS：告诉用户，由发布负责人或用户做。
