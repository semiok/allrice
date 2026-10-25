# M1 处置手册 6：隧道断开

对应告警：`tunnel`（Cloudflare 隧道断开）、`public_entry`（公网入口不可达，M1 本机或 huihuimac 发出）、`restarts:ai.bplabs.allrice-m1-tunnel`。总览见 [m1-monitor.md](m1-monitor.md)。

## 影响

用户都通过公网地址（`ALLRICE_PUBLIC_URL`，现在是 a.bplabs.xyz）访问，隧道 `allrice-m1` 断了就谁都打不开，但 M1 上的服务本身可能是好的。只有 huihuimac 报 `public_entry`、M1 本机不报：多半是 DNS 或 Cloudflare 那一侧的问题，或 huihuimac 自己的网络。

## 第一步

```bash
launchctl print gui/$(id -u)/ai.bplabs.allrice-m1-tunnel | grep -E "state|pid|runs|last exit"
tail -50 ~/Library/Logs/allrice-m1-tunnel.log
for p in 20241 20242 20243 20244 20245; do curl -s -m 2 http://127.0.0.1:$p/ready && echo " ($p)"; done
~/.local/bin/cloudflared tunnel info allrice-m1
curl -sS -o /dev/null -w '%{http_code}\n' https://a.bplabs.xyz/      # 应为 200 或跳转到 /login
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3011/login  # 本机 Web 是否正常
```

## 处理

1. **进程不在**：`launchctl kickstart gui/$(id -u)/ai.bplabs.allrice-m1-tunnel`；plist 没加载时 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.bplabs.allrice-m1-tunnel.plist`。
2. **进程在但就绪连接为 0**：多半是网络（看日志里的 `failed to connect to edge`）。确认 M1 能上网，Clash Verge 是否在跑、规则有没有拦 Cloudflare；网络恢复后 cloudflared 会自己重连，几分钟不恢复再 `launchctl kickstart -k gui/$(id -u)/ai.bplabs.allrice-m1-tunnel`（手工重启一次不会触发“反复重启”告警，60 分钟内第二次才会）。
3. **隧道好但公网 502/530**：本机 Web 不正常（看 `web` 告警）或 ingress 配置（`~/.cloudflared/allrice-m1.yml`）指错了端口。改配置前先备份。
4. **只在 huihuimac 上失败**：在 huihuimac 和手机流量各试一次，区分是 huihuimac 网络还是 DNS/Cloudflare。DNS 记录要用户在 Cloudflare 控制台处理。

## 确认恢复

两边的 `public_entry` 下一轮自动恢复；手动确认：`curl -sS -o /dev/null -w '%{http_code}\n' -L https://a.bplabs.xyz/` 返回 200。

## 谁来做

重启隧道进程不改共享 Dev 的配置，值班的人可以做。改 `~/.cloudflared/` 下的配置或 DNS：告诉用户，由发布负责人或用户做。
