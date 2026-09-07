# ACCESS-ENTRY-001：独立管理员登录与后台路由

日期：2026-09-07。产品变更，短任务，R2：新增/admin/login与/admin/静态页面路由需要与管理数据接口鉴权区分；仅页面外壳允许导航，不能放宽数据接口。关联AUTH-001 / REQ-19。

## 用户有效决定

用户明确要求：“把登陆界面收纳到/admin/login，访问/定向到登陆，启用cf自动定向cf，没启用正常密钥界面，不新增按钮提示”。这替代此前主会话建议的CF优先+密钥折叠布局，该旧方案不实施。

## 预期行为与边界

- GET /（及兼容HEAD）固定重定向/admin/login，不在公开首页先fetch /admin/session；可保留客户端hash导航，不接受任意redirect目标。
- /admin/login加载居中登录页；/admin/作为后台地址。已认证用户访问登录页进入/admin/；未认证访问/admin/进入/admin/login；成功登录、退出按此固定路由切换，保留已有合法hash导航。
- CF部署按用户现有/admin/*保护，浏览器整页访问/admin/login自然先经过Cloudflare身份验证。CF认证后进入同一应用登录地址，通过既有JWT身份自动进入后台。未启用CF保护时显示普通密钥表单。页面不增加CF按钮、密钥折叠提示或自动重试环。
- 应用Access开关只控制JWT验证，不会创建或移除CF边缘策略；部署时两侧状态须一致。此说明写入部署文档，不增加到正常登录表单。
- /admin/login与/admin/只提供无用户数据的页面外壳；静态资源保留既有/app.js、/styles.css。其GET导航可以跨站到达，但所有/admin/session、/admin/status、key、日志、配置等数据接口继续鉴权及同源校验。
- 已批准的旧GET /admin/access/login返回兼容修复保留，仍完整JWT验证、固定根跳转，无session写入；不能把/admin/*通配设为CSRF例外。
- API/v1、账号、密钥、日志存储不变；不自动部署或改变CF策略。管理员密钥兜底仍要求请求可到达应用，公网CF门禁不会被本地密钥绕过。

## 验证与状态

按用户分批：ACCESS-RETURN-001冻结后先修Spark目录，再实施此路由改动。Node/Worker验证根重定向、两页面外壳、管理API未放宽；隔离浏览器验证未认证/已认证/成功登录/退出、刷新和hash、无跳转循环及390px布局。CF跨域导航由隔离浏览器与合成签名JWT模拟；本轮不声称已在用户远端实机通过。

状态：实现、本地浏览器与针对性验证完成，RELEASE-004 fresh独立审查通过，待dev.3发布。最终fresh R2 reviewer核验整个相关diff；不新增数据库迁移。

实施冻结证据：根路径修复前Worker200/Node query404，预期302；修复后auth+access16/16、Node network+runtime15/15、gateway19/19、JS语法/typecheck/diff检查通过。隔离Chromium（合成账号、无真实上游）验证root/login/admin固定导航、匿名访问带hash后台、登录/退出、刷新hash、已登录再访问login、非法hash回落、390px布局且无pageerror，截图已目视检查。首个命令行传递多行浏览器脚本出现语法错误，改为CLI文档支持的--filename后实际行为检查通过。Edge用户浏览器仍未读取，本轮不声称远端CF实机通过。
