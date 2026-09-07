# 监听地址、端口与公网入口

适用于 v0.2.0-dev.2 及之后的版本。v0.2.0-dev.1 不含新启动参数或配置向导，请先升级后使用。

## 最常用的启动命令

解压包并完成 setup 后，在含有 .env 的目录运行：

~~~sh
# 仅本机，换一个端口
node --env-file=.env oneapi.mjs --port 9090

# 局域网访问，自动列出本机私网 IP 对应的访问地址
node --env-file=.env oneapi.mjs --host 0.0.0.0 --port 9090 --lan

# 只监听指定网卡的 IPv4 地址
node --env-file=.env oneapi.mjs --host 192.168.1.10 --port 9090 --lan

# IPv6 私网示例：地址必须实际属于本机
node --env-file=.env oneapi.mjs --host fd00::10 --port 9090 --lan

# 查看参数说明，不打开业务数据库
node oneapi.mjs --help
~~~

源码目录先运行 npm run build:server，然后使用 npm start -- --host 0.0.0.0 --port 9090 --lan。参数优先于环境文件，只影响本次进程，不修改 .env；服务重启仍要传同样参数。systemd 用户可用 sudo systemctl edit oneapi 添加以下覆盖（实际路径按安装目录调整），随后重启：

~~~ini
[Service]
ExecStart=
ExecStart=/usr/bin/node /opt/oneapi/releases/current/server/oneapi.mjs --host 0.0.0.0 --port 9090 --lan
~~~

保存后运行 sudo systemctl daemon-reload 与 sudo systemctl restart oneapi。EnvironmentFile 和 DATA_DIR 继续由原服务配置提供，不要为改端口重新生成账号密钥。

监听地址是本机 IP，不是 CIDR 网段：127.0.0.1 仅本机，192.168.x.x 等具体地址仅该网卡，0.0.0.0 监听所有 IPv4 网卡，:: 为 IPv6 通配绑定（是否同时接受 IPv4 取决于系统）。在其他设备输入启动输出中的私网 IP URL，不能输入 0.0.0.0。

--lan 只生成当前本机 RFC1918 IPv4（10/8、172.16/12、192.168/16）或 ULA IPv6（fc00::/7）的精确访问 origin，并要求实际连接来自回环或私网地址。它不是来源 CIDR 防火墙。需要只允许某个客户端网段时在系统防火墙配置。DHCP 地址改变后重启重新发现；不会为了兼容任意域名而放开 Host 校验。 自动发现和手工 LAN_ORIGINS 均最多 32 项、总长 4096 字符；超过限制会在启动或保存前报错，配置向导保留原文件。网卡地址过多时可用 --host 指定某个实际私网 IP，或手工缩减 LAN_ORIGINS。

LAN 的 HTTP 会传输登录口令和 API key，仅用于可信网络；不可信网络使用下方 HTTPS 入口。防火墙也需允许所选局域网端口。不能以改端口的方式让两个进程同时打开同一 DATA_DIR。

## 保存网络默认值

~~~sh
# 独立包内
node configure.mjs

# 源码目录
npm run configure:server
~~~

向导提供本机、可信局域网和 HTTPS 反代/Tunnel 选择（Windows 使用系统自带 Windows PowerShell 复制原文件访问 ACL），只更新 HOST、PORT、LAN_ORIGINS、PUBLIC_ORIGIN，保留账号密钥、DATA_DIR 和其他配置。保存后手动重启服务，不需要重新登录 Codex。缺少 .env 时先运行 setup；配置文件或父目录是符号链接时请直接配置真实普通文件。向导遇到多行配置值或重复网络字段会拒绝保存并保留原文件；这类配置可手动编辑四个网络字段。高级用户也可手动设置 LAN_ORIGINS 为逗号分隔的精确私网 origin，例如 http://192.168.1.10:9090,http://[fd00::10]:9090。

## 三种公网安装方式

都支持，Cloudflare 是可选项。OneAPI 原生进程接收 HTTP，公网 HTTPS 由 Tunnel 或反向代理终止；不要把管理口令通过公网明文 HTTP 发送。

| 入口 | 适用场景 | OneAPI 监听 |
| --- | --- | --- |
| Cloudflare Tunnel | 没有公网 IP，或不想开放公网入站端口 | 同机 cloudflared 时为 127.0.0.1 |
| 公网 Caddy/Nginx 直接 HTTPS | 有公网服务器，不依赖 Cloudflare | 同机代理时为 127.0.0.1 |
| 公网 HTTPS + Cloudflare 橙云代理 | 已有公网反代，希望使用 CF 代理和 Access | 同机代理时为 127.0.0.1 |

这三个入口均先声明最终用户访问的 HTTPS origin：

~~~sh
node --env-file=.env oneapi.mjs --host 127.0.0.1 --port 8787 --public-origin https://api.example.com
~~~

该域名须换成你实际拥有且配置好的域名，不含路径。Base URL 为 https://api.example.com/v1。PUBLIC_ORIGIN 是 Host/Origin 校验配置，不会自动申请证书、创建 DNS 或安装代理。

### Cloudflare Tunnel

由 cloudflared 同机连接 http://127.0.0.1:8787，在 Tunnel 的公开主机名中填写 api.example.com。将 origin 的 HTTP Host Header 设置为 api.example.com，与 PUBLIC_ORIGIN 一致。cloudflared 的本地配置 ingress 示例：

~~~yaml
ingress:
  - hostname: api.example.com
    service: http://127.0.0.1:8787
    originRequest:
      httpHostHeader: api.example.com
  - service: http_status:404
~~~

Tunnel 本身仍需按 Cloudflare 安装向导创建并安装连接器凭据；上面只是 ingress 片段。连接器与 Node 同机时不必开放公网 8787 端口。[Tunnel 文档](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)、[origin 参数](https://developers.cloudflare.com/tunnel/advanced/origin-parameters/)。

### 公网 HTTPS 与橙云代理

包内 Caddyfile.example 提供同机反代模板，将域名替换成自己的域名并开放证书签发/HTTPS 所需端口；反代向 Node 保留公开域名 Host。没有 Cloudflare 也可以用 Caddy 的 HTTPS 直接提供服务。

若启用橙云，把 Cloudflare SSL/TLS 设置为 Full (strict)，源站证书必须有效；为避免绕开 CF 门禁直接访问 origin，应在防火墙仅允许 Cloudflare IP 段访问源站 HTTPS。代理状态不能代替这个限制。[Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)、[保护源站](https://developers.cloudflare.com/fundamentals/security/protect-your-origin-server/)。

### Access 与 API 客户端

Access 配置保留在后台“设置”。dev.3根路径固定整页跳转/admin/login，登录后进入/admin/。Cloudflare应用保护/admin/*即可让登录页先经过CF认证，普通口令页不再提供额外CF按钮；无CF保护时直接使用口令。应用Access开关只控制JWT验签，不会同步改变CF策略，启用/关闭时需保持两侧一致。只在管理路径要求浏览器交互登录，/v1 和 /v1/* 应通过更具体的路径策略保留 Bearer API key 调用；不要把整站门禁直接套到 API。后台管理员 key 始终保留，但边缘已拦截的请求必须先在 Cloudflare 控制台关闭或收窄门禁才可到达应用。[路径策略优先级](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)。

如果 dev.2 在完成 Access 登录后返回 /admin/access/login 并显示 site_not_allowed，可先在地址栏直接打开站点根路径；已有 Access cookie 有效时可恢复进入。此问题属于登录返回导航兼容，修复状态见 [ACCESS-RETURN-001](https://github.com/arctan303/OneAPI/blob/main/docs/maintenance/ACCESS-RETURN-001.md)。不要通过删除 Sec-Fetch-Site 或关闭所有管理接口同源检查来处理。

SSE 是长连接，反代需避免缓冲并适配超时。Cloudflare 有独立代理连接限制，长时间无响应可能超时，不承诺无限长流；断流应由客户端明确处理，不应盲目重放已生成的请求。[连接限制](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)。

Tunnel、公网反代只改变用户到 OneAPI 的入口，Node 请求 Codex 仍使用服务器的出站网络。选择入口不能证明任何 VPS IP 都能通过上游，也不能修复此前纯 Worker 的 403。当前教程未代表上述公网拓扑已在新服务器实际部署验收。
