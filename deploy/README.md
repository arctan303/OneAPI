# OneAPI Node 部署

本目录提供独立 Node 运行时的部署模板。发布管理员可用其中的 setup 脚本生成本机环境文件，并按本文路径安装 Node、systemd 与 Caddy。执行前请审查主机权限、发布版本和公网域名。

## v0.2.0-dev.1 首次安装

这是 private 仓库。请先在浏览器登录拥有仓库读取权限的 GitHub 账户，再从固定的 [v0.2.0-dev.1 Release](https://github.com/arctan303/OneAPI/releases/tag/v0.2.0-dev.1) 页面下载 tar.gz 和对应 `.sha256` 资产。也可以使用已认证的 GitHub CLI：

    gh auth login
    gh release download v0.2.0-dev.1 --repo arctan303/OneAPI --pattern 'oneapi-server-0.2.0-dev.1.tar.gz*'

没有该 private 仓库读取权限时，请联系仓库所有者转发 tar.gz 和 `.sha256` 文件。下载后校验：

    sha256sum -c oneapi-server-0.2.0-dev.1.tar.gz.sha256

macOS 可用：

    shasum -a 256 -c oneapi-server-0.2.0-dev.1.tar.gz.sha256

Windows PowerShell 可用 `Get-FileHash .\oneapi-server-0.2.0-dev.1.tar.gz -Algorithm SHA256`，再与 `.sha256` 文件中的值比较。确认一致后解压并进入包内 `server/` 目录；包内已经包含运行 bundle，不需要 `npm install`：

    tar -xzf oneapi-server-0.2.0-dev.1.tar.gz
    cd server
    node setup.mjs
    node --env-file=.env oneapi.mjs

setup 只在 `.env` 不存在时创建，输出不包含密钥值。请用编辑器读取 `.env` 中的 `ADMIN_API_KEY` 并在浏览器登录，不要在终端回显环境文件。本机浏览器访问 `http://localhost:8787/`；远程主机可用 `ssh -N -L 8787:127.0.0.1:8787 user@server` 建立隧道。首次登录后完成 Codex 设备码授权，加载官方当前模型目录，按需选择模型和思考程度并创建 API key；API Base URL 为 `http://localhost:8787/v1`，正式 HTTPS 时替换为公网 origin 加 `/v1`。

正式 HTTPS、Caddy、systemd、升级和旧账号迁移见固定版本 [安装教程](https://github.com/arctan303/OneAPI/blob/v0.2.0-dev.1/docs/INSTALL.md) 与 [部署说明](https://github.com/arctan303/OneAPI/blob/v0.2.0-dev.1/docs/DEPLOYMENT.md)。若官方未返回 5 小时额度窗口，应显示未知；遇到目录/额度错误时保留状态码和应用错误码，不循环发送请求。

## 运行时与发布包

生产环境使用 Node.js 24.x，要求 >=24.15.0 且 <25（与发布包 package.json 的 engines 一致）。发布包固定包含 `server/` 目录，解包后结构为：

- `/opt/oneapi/releases/<version>/server/oneapi.mjs`
- `/opt/oneapi/releases/<version>/server/public/`
- `/opt/oneapi/releases/<version>/server/setup.mjs`
- `/opt/oneapi/releases/<version>/server/.env.example`

将 `/opt/oneapi/releases/current` 指向选定的版本目录，因此 systemd 使用 `current/server/oneapi.mjs`。服务以无特权 `oneapi` 用户运行：

- `WorkingDirectory=/var/lib/oneapi`
- `EnvironmentFile=/etc/oneapi/oneapi.env`
- `DATA_DIR=./data`，实际目录为 `/var/lib/oneapi/data`
- 只有 `/var/lib/oneapi/data` 被声明为可写

应用默认只监听 `127.0.0.1:8787`，不要直接绑定公网地址。

## 构建发布包

在仓库根目录执行现有构建流程：

    npm ci
    npm run build:server



`npm run build:server` 会生成 `dist/server/`，其中包含 Node bundle、源 `public/` 静态资源、setup 脚本、环境示例和部署模板。需要打包时，把整个 `server` 目录放进归档：

    tar -C dist -czf oneapi-server.tar.gz server

发布前检查生成的 bundle 与 manifest；不要把仓库根目录的开发文件直接作为生产发布包。

## 准备 Linux 用户与目录

以下命令只作为 Linux 部署说明，本模板尚未在 Linux 主机实机验证；请由管理员在目标主机审查后执行。systemd 不应以 root 运行 OneAPI：

    getent group oneapi >/dev/null || groupadd --system oneapi
    id oneapi >/dev/null 2>&1 || useradd --system --gid oneapi --home-dir /var/lib/oneapi --create-home --shell /usr/sbin/nologin oneapi
    install -d -o oneapi -g oneapi -m 0750 /var/lib/oneapi/data
    install -d -o root -g oneapi -m 0750 /etc/oneapi

## 创建环境文件

systemd 读取的目标文件名是 `/etc/oneapi/oneapi.env`。使用发布包中的 setup 脚本直接写入该路径，不需要展示或读取内容：

    mkdir -p /etc/oneapi /var/lib/oneapi/data
    node /opt/oneapi/releases/current/server/setup.mjs --env-path /etc/oneapi/oneapi.env
    chown oneapi:oneapi /var/lib/oneapi/data
    chmod 0600 /etc/oneapi/oneapi.env

setup 使用独占创建：文件已存在时只报告 unchanged，绝不覆盖。它生成互相独立的 32 字节 base64url 格式 `ADMIN_API_KEY` 和 `GATEWAY_API_KEY`，以及 32 字节标准 base64 的 `TOKEN_ENCRYPTION_KEY`；不会打印任何凭据值。若曾在其他位置生成默认的 `.env`，应由管理员按主机策略安全安装或重命名到 `/etc/oneapi/oneapi.env`，不要把 `.env.example` 当作真实配置。使用 Caddy 时，将 `PUBLIC_ORIGIN` 设置为准确的公网 HTTPS origin。

## 安装 systemd unit

安装 unit 前检查路径：

    install -m 0644 /opt/oneapi/releases/current/server/oneapi.service /etc/systemd/system/oneapi.service
    systemctl daemon-reload
    systemctl enable --now oneapi.service

unit 明确使用 `User=oneapi`，并只授予 data 目录写权限。按主机策略让环境文件仅对 root 和服务账号可读。


## Caddy 与 HTTPS

复制 `/opt/oneapi/releases/current/server/Caddyfile.example`，把 `api.example.com` 换成公网主机名，并配置 DNS。模板保留 Host，移除客户端提交的 X-Forwarded-For/Host/Proto 后设置可信的 HTTPS scheme；没有配置 `trusted_proxies`，避免把客户端转发头当成可信来源。 `flush_interval -1` 使流式响应及时刷新。

应用用 `PUBLIC_ORIGIN` 做公网 origin 检查，TLS 在 Caddy 终止，Node 进程保持 loopback-only。

模板遵循 Caddy 当前 `reverse_proxy` 的 header 与 `flush_interval` 规则，依据见 https://caddyserver.com/docs/caddyfile/directives/reverse_proxy。Caddy 默认不信任 proxy ranges，见 https://caddyserver.com/docs/caddyfile/options#trusted-proxies。使用 hostname site address 时，自动 HTTPS 规则见 https://caddyserver.com/docs/automatic-https。

## Cloudflare Access 边界

如果主机名位于 Cloudflare Access 后面，沿用现有 TeamDomain/AUD 策略，只保护管理页面和 `/admin/*` 路由。`/v1` 不应被会触发交互式浏览器跳转的策略拦截，API 客户端必须得到应用响应。Access/WAF 在边缘拦截时请求不会到达 Node，应用兜底无法恢复；启用公网主机名之前应检查 Access 与 WAF 规则。

## 回滚与数据

升级独立 release 时先停止旧进程，备份 `.env` 和外置数据目录，再复用原 `.env` 启动新版本；将 `DATA_DIR` 设置为发布目录外的绝对路径（例如 `/var/lib/oneapi/data`），不要让新 release 的相对路径创建新的数据库。不要覆盖或并发打开旧 SQLite。

回滚时把 `current` 切回已审查的上一版本并重启 oneapi.service。将 `/var/lib/oneapi/data` 和环境文件置于发布目录之外；例行换版不要删除 data 目录。
