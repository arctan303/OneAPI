# CONSOLE-NET-001：单服务器网关的 Cloudflare 网络选择

状态：官方资料核查（2026-09-07）。本记录没有部署、修改 DNS、启动 Tunnel，亦没有发送账号或上游请求。

## 结论

对本项目的单服务器 Node 网关，首选 **Cloudflare Tunnel**，条件是愿意在服务器运行 `cloudflared`：它由服务器主动建立到 Cloudflare 的连接，不要求 origin 有可路由的公网 IP；防火墙可以只允许该出站连接，从而不开放本机入站端口。[Cloudflare Tunnel 官方说明](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)

**公网 HTTPS + 橙云代理**也是有效的部署形态，适合已经有公网 VPS、Caddy 和证书运维流程的场景。它仍然需要 Cloudflare 能连接到的公网 origin；橙云隐藏 DNS 返回的 origin 地址，但不能代替 origin 防火墙。应只允许 Cloudflare IP 段到 443，并使用 `Full (strict)` 验证 origin 证书。[代理状态](https://developers.cloudflare.com/dns/proxy-status/)、[保护 origin](https://developers.cloudflare.com/fundamentals/security/protect-your-origin-server/)、[Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)

两种方式都只处理客户端到本项目服务器的入口。**Tunnel 不会把 Node 进程主动发往 ChatGPT 的请求改成 Worker 或 Cloudflare 出站请求**：Cloudflare 的架构资料明确说明，服务器自己发起的 Internet API 连接走服务器的默认网关；Tunnel 不是该连接的回程网关。[Cloudflare SASE 架构资料（PDF）](https://developers.cloudflare.com/reference-architecture/static/cloudflare-evolving-to-a-sase-architecture.pdf)

这意味着选择 Tunnel 或橙云不能证明 ChatGPT 上游会接受某个 VPS 地址，也不能承诺绕过 Worker 的上游限制。若目标是改变 Node 的出站地址或路由，需要另行验证专用 egress 方案；不能把 Tunnel 当成这种方案。

## 入口拓扑和配置差异

| 事项 | Cloudflare Tunnel | 公网 HTTPS + 橙云 |
| --- | --- | --- |
| origin 可见性 | 不需要可路由的公网 IP；`cloudflared` 发起 outbound-only 连接，建立后双向承载入口流量 | 需要公网可达的 origin（本项目拓扑为 VPS 公网地址）；橙云 DNS 通常返回 Cloudflare anycast 地址，但 origin 仍需防直连 |
| 本机入口 | 可让 Node 只监听 `127.0.0.1`，由 `cloudflared` 连接本机服务 | Caddy 对外监听 443，再反代 Node；公网端口和防火墙由运维负责 |
| Host / TLS | Tunnel origin 参数的 `httpHostHeader` 可设置发给本地服务的 HTTP `Host`；HTTPS origin 还涉及 `originServerName`，生产环境不要用 `noTLSVerify` 放弃证书校验。[Origin 参数](https://developers.cloudflare.com/tunnel/advanced/origin-parameters/) | Caddy 使用公开 HTTPS 主机名；Cloudflare `Full (strict)` 要求 origin 证书未过期、主机名匹配且由公共 CA 或 Cloudflare Origin CA 签发 |
| Access | 可按路径建立 Access application；更具体的路径规则优先 | 同样可按路径建立 Access application；管理页面和 `/admin/*` 使用交互式 Access，`/v1` 保留给 API 客户端的 Bearer 鉴权，是本项目的路径配置要求，不把整站 Access 门禁套在 `/v1` |
| 主要运维成本 | 多一个 `cloudflared` 服务和 Tunnel 配置；不需暴露 origin 入站 | 需要公网 IP、Caddy、证书、Cloudflare IP allowlist 和阻断直连的防火墙规则 |

Tunnel 的 Access origin 参数（`teamName`/`audTag`）是 cloudflared 到本地 origin 的可选 JWT 校验；它和边缘的按路径 Access application 是两个配置层，不应混为同一个鉴权门禁。[Tunnel origin 参数](https://developers.cloudflare.com/tunnel/advanced/origin-parameters/)、[Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)

## 长连接、SSE 和请求限制

Cloudflare 对代理入口的连接是客户端到 Cloudflare、Cloudflare 到 origin 的两段连接，各有独立限制。当前官方表列出：客户端 HTTP/1.1 keep-alive 和 HTTP/2 idle 均为 400 秒；到 origin 的 TCP 建连 19 秒、TCP ACK 90 秒、keep-alive 间隔 30 秒、Proxy Idle 900 秒、Proxy Read 125 秒（Enterprise 可调）、Proxy Write 30 秒。URL 上限 16 KB，请求头总量 128 KB，响应头总量 128 KB。[Connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)

官方页面没有在该表中给出一个适用于所有计划和响应的通用请求体或响应体上限，因此本项目仍必须在应用层限制输入和缓冲响应，不能从上述表格推导一个 body 字节数。SSE 也不能据此承诺无限期保持：长时间没有数据可能触发 idle/read 限制；应用应发送活动数据并实现重连。Tunnel 用户还应按 Tunnel 的 origin 参数检查其到本地服务的连接设置，不能直接把公网代理的每一个数值当成 Tunnel 的完整保证。

## 给本项目的实施建议

1. 默认路线用 Tunnel：Node 绑定 `127.0.0.1`，Tunnel ingress 指向本地端口；若 Node 依赖 `PUBLIC_ORIGIN` 做 Host 校验，用 Tunnel 的 `httpHostHeader` 设为公开 HTTPS 主机名。保持 origin TLS 校验开启。
2. 需要传统公网入口时用橙云：Caddy 提供 HTTPS，Cloudflare SSL/TLS 设为 `Full (strict)`；origin 防火墙只放行 Cloudflare IP 段到 443，并验证从公网直连 origin 被拒绝。Cloudflare 官方建议代理所有可能的 DNS 记录并限制 origin 来源，但这仍需在目标 VPS 上实际验证。
3. 两条路线都把 Access application 限在管理页面和 `/admin/*` 等管理路径；不要让 `/v1` 因边缘交互式登录而改变 API 客户端行为。路径优先级必须在 Cloudflare 控制台复核。
4. 对 OAuth 网关，分别记录入口请求能否到达 Node、Node→ChatGPT 的出站结果和上游诊断。更换入口代理不会自动改变第二段出站连接；不以入口方式推断某个上游 IP 一定可用。

本次核查后的可验证差异只有：Tunnel 是否能在无公网 origin 入站的情况下稳定到达本机 Node，以及橙云模式的公网 HTTPS、证书和防火墙是否正确。两者都不构成 Cloudflare Worker 上游出站问题的修复证据。
