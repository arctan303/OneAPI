# OneAPI v0.2.0-dev.2 首次安装

> v0.2.0-dev.2 新增启动参数、可选配置向导、分区后台与居中登录页。网络配置与 Tunnel / 公网 HTTPS / 反代安装见 [网络配置教程](NETWORK.md)。

本教程适用于从 GitHub 预发布包首次安装 OneAPI 的用户。当前预发布版的生产上游验证仍有限；模型目录以官方当前返回为准，若官方未返回 5 小时额度窗口则显示未知，不应把未知解释为安装失败。

## 1. 准备 Node.js 24.x

安装 Node.js 24.x，版本必须满足 `>=24.15.0 <25`。不要直接假设操作系统 `apt` 默认提供符合要求的版本；安装后先检查：

```sh
node --version
```

输出应为 `v24.15.x` 或同一 24.x 系列中的更高版本，且低于 25。预发布包已经包含运行所需的 bundle，不需要在解压目录执行 `npm install`。

## 2. 下载并解压预发布包

这是 private 仓库。请先在浏览器登录拥有仓库读取权限的 GitHub 账户，再从固定的 [v0.2.0-dev.2 Release](https://github.com/arctan303/OneAPI/releases/tag/v0.2.0-dev.2) 页面下载对应的 tar.gz 和 `.sha256` 资产。

有权限的 GitHub CLI 用户也可以运行：

```sh
gh auth login
gh release download v0.2.0-dev.2 --repo arctan303/OneAPI --pattern 'oneapi-server-0.2.0-dev.2.tar.gz*'
```

如果账户没有该 private 仓库的读取权限，请联系仓库所有者转发 tar.gz 和对应 `.sha256` 文件。下载后先校验归档：

Linux：

```sh
sha256sum -c oneapi-server-0.2.0-dev.2.tar.gz.sha256
```

macOS：

```sh
shasum -a 256 -c oneapi-server-0.2.0-dev.2.tar.gz.sha256
```

Windows PowerShell：

```powershell
(Get-FileHash .\oneapi-server-0.2.0-dev.2.tar.gz -Algorithm SHA256).Hash
Get-Content .\oneapi-server-0.2.0-dev.2.tar.gz.sha256
```

确认两个 SHA-256 值一致后再解压。Linux：

```sh
tar -xzf oneapi-server-0.2.0-dev.2.tar.gz
cd server
```

Windows PowerShell：

```powershell
tar -xzf oneapi-server-0.2.0-dev.2.tar.gz
Set-Location server
```

解压后的 `server/` 目录应包含 `oneapi.mjs`、`migrate.mjs`、`configure.mjs`、`setup.mjs`、`NETWORK.md`、`.env.example`、`public/` 和包内 README。不要把 `.env`、SQLite 文件或日志放进发布归档。
## 3. 生成并编辑环境文件

在 `server/` 目录运行：

```sh
node setup.mjs
```

setup 只在 `.env` 不存在时创建它；已有文件保持不变。命令输出状态和路径，不输出任何密钥值。请用本地编辑器打开 `.env`，读取其中的 `ADMIN_API_KEY`，稍后在浏览器登录页面输入；不要使用 `cat`、日志或终端回显来复制密钥。按需设置 `PUBLIC_ORIGIN`，公网反代时必须是准确的 HTTPS origin。

## 4. 启动并完成首次账号设置

直接运行包内入口：

```sh
node --env-file=.env oneapi.mjs
```

本机浏览器打开 [http://localhost:8787/](http://localhost:8787/)，用 `.env` 中的 `ADMIN_API_KEY` 登录。首次使用时：

1. 打开“账号连接”页面，点击连接 Codex，按页面提示完成官方设备码授权。
2. 打开“模型测试”页面，加载模型目录，选择要测试的模型和思考程度。
3. 在 API key 页面创建供客户端使用的 key，不要把管理员 key 交给第三方。
4. 本地 API Base URL 使用 `http://localhost:8787/v1`；正式 HTTPS 反代则使用你的公网 HTTPS origin 加 `/v1`。

预发布验证覆盖有限；模型目录以官方当前返回为准，若官方未返回 5 小时额度窗口则显示未知。遇到目录或额度异常时保留 HTTP 状态和应用错误码，先不要循环发送生成请求。

### 更换监听地址和端口

停止旧进程后，可直接用启动参数运行，参数仅影响本次进程：

```sh
node --env-file=.env oneapi.mjs --host 0.0.0.0 --port 9090 --lan
```

启动日志会列出当前主机可访问的私网地址。要保存默认值，运行 `node configure.mjs`，完成后手动重启服务。公网 HTTPS、Cloudflare Tunnel 与反代均支持，具体配置见随包的 [网络教程](NETWORK.md)。

## 5. 远程 SSH 访问

如果 Node 只监听远程主机的 loopback，可在本机建立 SSH 隧道：

```sh
ssh -N -L 8787:127.0.0.1:8787 user@server
```

隧道保持运行时，在本机浏览器打开 [http://localhost:8787/](http://localhost:8787/)。这里的 `user@server` 是占位符，请替换为目标主机的 SSH 登录信息；不要把 SSH 凭据写入 OneAPI 环境文件。

## 6. 正式 HTTPS

正式公网使用 Caddy 终止 TLS、Node loopback 监听，并由 systemd 以无特权用户运行。完整的 release 目录、环境文件、Linux 用户、Caddy、Cloudflare Access 和回滚说明见仓库固定版本的 [部署文档](https://github.com/arctan303/OneAPI/blob/v0.2.0-dev.2/docs/DEPLOYMENT.md) 和 [部署模板](https://github.com/arctan303/OneAPI/blob/v0.2.0-dev.2/deploy/README.md)。本教程不代替目标主机管理员实际部署检查。

Access 只保护管理页面和 `/admin/*`。不要给 `/v1` 设置交互式登录跳转；若 Cloudflare 门禁在边缘拦截，必须先在 Cloudflare 控制台关闭或收窄门禁，请求才会到达 OneAPI。

## 7. 升级与旧账号迁移

升级前停止当前 OneAPI 进程或 systemd 服务，备份 `.env` 和 `data/`，再把新版本解压到独立 release 目录；不要覆盖当前 release、环境文件或 SQLite 文件。新版本必须复用原 `.env`，并将 `DATA_DIR` 明确设置为发布目录外的绝对路径（例如 `/var/lib/oneapi/data`），否则换目录后相对路径会指向新的 `data/`，看起来像账号连接丢失。切换 release 前确认旧进程已停止且没有并发打开旧库，再启动新版本。

已有旧 Wrangler/SQLite Durable Object 账号时，先停止旧服务并沿用原来的 `ADMIN_API_KEY`、`GATEWAY_API_KEY`、`TOKEN_ENCRYPTION_KEY`。不要先运行 setup 生成新环境。构建迁移工具后，在目标不存在时运行：

```sh
node --env-file=.dev.vars dist/server/migrate.mjs \
  --legacy-root .wrangler/state/v3 \
  --target data/oneapi.sqlite
```

迁移源库只读且不修改，目标必须不存在；旧 Worker 实验状态保留。迁移完成后把原三个 secret 安全安装到新服务器环境文件，再启动新版本。详细边界和回滚路径见上述 [部署文档](https://github.com/arctan303/OneAPI/blob/v0.2.0-dev.2/docs/DEPLOYMENT.md)。

## 常见错误

- `env_setup_failed` 或 `env_exists`：确认目录权限和目标路径。已有 `.env` 不会被覆盖，不要为了重试删除唯一环境文件。
- Node 版本不满足或入口无法加载：安装 Node 24.x 且满足 `>=24.15.0 <25`，从解压后的 `server/` 目录直接运行入口。
- 端口已占用：先停止旧的 Node/Wrangler 进程，确认实际监听者后再启动；不要只改端口绕过同一 SQLite 存储锁。
- `PUBLIC_ORIGIN` 校验失败：公网反代时填写完整 HTTPS origin，不要填路径、带尾斜杠的变体或 HTTP 地址。
- API 返回交互式登录页面：缩小 Cloudflare Access 到管理页面和 `/admin/*`，保持 `/v1` 使用 API key；边缘已拦截时先在 Cloudflare 控制台处理门禁。
- 模型目录或额度为空：以官方当前目录为准；官方未返回 5 小时额度窗口时显示未知。保存一次脱敏状态和错误码，按当前验证计划处理。
- 迁移报告目标已存在或旧 runtime 活跃：停止旧进程，确认目标没有可保留数据后再选择新的空目标；迁移工具不会覆盖目标或修改源库。

历史 Worker 命令、上游 403/出站诊断和归档链接保留在 [部署文档的历史章节](https://github.com/arctan303/OneAPI/blob/v0.2.0-dev.2/docs/DEPLOYMENT.md)。
