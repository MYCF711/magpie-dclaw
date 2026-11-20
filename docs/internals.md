# DClaw 1.3.30 逆向与插件实现

## 1. 分析对象与版本

| 组件 | 版本 | 证据 |
|---|---|---|
| NSIS 安装包 | 1.3.30 | 文件版本资源；SHA-256 见工作区 `reverse/installer.sha256` |
| Electron 主包 `dclaude` | 1.3.30 | `app.asar/package.json` |
| 页面资源 | 1.3.231 | `resources/pages/package.json` |
| 内置 Claude Code | 2.1.177 | `resources/claude/claude-code-win32-x64/package.json` |
| Magpie 脚手架 | v0.3.14 / `d4c7a5014f64` | 2026-11-17 main |
| 本机 Magpie | 0.1.4342 | `magpie.exe --version` |

分析方式是 7-Zip 静态解包 NSIS → `app-64.7z` → Electron `app.asar`，未运行安装程序。前端 bundle 经 Prettier 格式化后审阅。

## 2. 官方请求链

```text
Vue 页面
  → ws://127.0.0.1:26899
  → resources/claude/web-service.js
  → claude.exe 2.1.177
  → https://model-router.edu-aliyun.com/v1/messages
```

页面从 `/api/v1/modelRouter/open/models?from=cc&version=1.3.30&lang=zh` 读取模型。关键映射：

| 目录 / 用户字段 | 客户端环境变量 | 插件处理 |
|---|---|---|
| `id`（去掉 `custom-provider/`） | `ANTHROPIC_MODEL` | 原样作为 Messages `model` |
| `request_url || baseUrl` | `ANTHROPIC_BASE_URL` | 规范为以 `/v1` 结尾；只允许官方 HTTPS host |
| 模型 `api_key`，否则 `user.model_api_key` | `ANTHROPIC_AUTH_TOKEN` | `Authorization: Bearer …` |
| `custom_headers` | `ANTHROPIC_CUSTOM_HEADERS` | 逐行解析，禁止覆盖鉴权/Host |
| `level` | `CLAUDE_CODE_EFFORT_LEVEL` | 保留在目录元数据，不擅自改请求 |
| `prompt` | 临时前置到项目 `CLAUDE.md` | **不进入插件请求** |

默认网关自定义头是 `X-DashScope-Wait-Timeout: 30`。一旦目录给出非空自定义头，客户端就不再自动补默认头，插件保持这个规则。

目录中的 `api: "openai-completions"` 没有被 DClaw 1.3.30 的规范化或协议选择代码读取。官方二进制与桥接层使用 Anthropic Messages，因此本插件也选择 `@ai-sdk/anthropic`，不根据这个未消费字段猜协议。

## 3. 被剥离的客户端提示词

| 来源 | 官方进入模型的路径 | 插件结果 |
|---|---|---|
| 模型目录每行 `prompt` | 页面 → WS → 临时项目 `CLAUDE.md` 前置 | 不读取到请求体 |
| 内置 `fQ` 身份句 | 模型 prompt 为空时回退 | 不使用 |
| 全局 `~/.dclaude/CLAUDE.md` | `CLAUDE_CONFIG_DIR` | 不启动 Claude Code，不加载 |
| 项目 / 员工 `CLAUDE.md` | 项目 cwd | 不创建、不改写 |
| `project/extensions/CLAUDE.md` | 手机远程项目 | 不加载 |
| Skills、附件和端口保护附加句 | 拼入用户 text block | 不添加 |
| Claude Code 自身系统提示与工具运行环境 | `claude.exe` | 不经过该进程 |

插件只执行两类请求变化：去掉模型名前的 Magpie `dclaw/` 前缀，以及设置必要的协议头。调用方自己的 `system`、消息、工具 schema、温度、最大输出等不被替换。

## 4. 认证

```http
POST https://www.dianclaw.cn/api/auth/send-code
{ phone, udid, computerInfo }

POST https://www.dianclaw.cn/api/auth/login
{ phone, code, udid, computerInfo, packageName, version }

GET https://www.dianclaw.cn/api/v1/user/info
Authorization: Bearer <session-token>
```

- `udid` 是 16 字节随机数的小写 hex，短信发送与登录两次请求复用。
- 登录版本是 `1.3.30`，`packageName.clientChannel = default`。
- 设备信息只使用 OS/CPU 概括和固定产品名，不采集 MachineGuid、SID、BIOS/主板序列号、Windows 用户名或域。
- 登录后 `user.model_api_key` 才是模型网关密钥；会话令牌不会冒充原生 Key。
- DClaw 1.3.30 没有公开 refresh_token 端点，`auth.refresh()` 返回 `undefined`。

### 每日签到（腾讯签到）

客户端把签到叫「腾讯签到」，接口与语义：

| 请求 | 返回关键字段 | 客户端用法 |
|---|---|---|
| `GET /api/v1/user/tencent-signin/status` | `eligible`、`canClaim`、`todayClaimed`、`claimCount`、`maxClaims`、`reason`、`claimable.{modelPoints,balance_amount_text}` | 决定按钮可用性；`claimable` 是本次奖励 |
| `POST /api/v1/user/tencent-signin/claim` | `modelPoints`（领取后的总积分）、`balance_amount_text`、`claimCount` | 成功后把 user 的积分/余额写回本地缓存 |

映射到 Magpie 的 `auth.checkin`：

| 上游状态 | 插件结果 |
|---|---|
| `eligible !== true` | `ineligible` + `reason`（当前账号实测 `非活动用户`） |
| `todayClaimed === true` | `claimed`、`credit: 0`（宿主只在 claimed 时盖当天时间戳） |
| `canClaim === true` | `POST claim` → `claimed`，`credit` = 领取前后 `modelPoints` 差 |
| `eligible` 但今天不可领 | `done` |
| 请求失败 / claim 失败 | `failed` + 上游原文 |
| 纯模型 Key 模式 | `inactive`，不发请求 |

签到按账号 single-flight（`createRefreshLock({ replayMs: 0 })`，键 = provider + uid），避免宿主「立即签到」与自动签到同时触发时重复领取。

2026-11-20 实测当前账号：`eligible=false`、`canClaim=false`、`reason="非活动用户"`、`maxClaims=10`、`claimable=20000 积分 / 1.00 元`。

### 邀请机制（账户功能，插件不涉及）

| 请求 | 内容 |
|---|---|
| `GET /api/v1/user/invite-new` | `enable`、`inviteCode`、`inviteUrl`、`inviteRules[]`、`rewardRatePercent`、`activityExpireAt`、`stats` |
| `GET /api/v1/user/invite-new/stats` | 邀请明细分页（`page` / `pageSize`） |

规则（接口原文摘要）：被邀请人须是**从未注册过**的新用户，且在**从未安装过本产品的设备**上完成首次登录；被邀请人**每次充值**，邀请人得充值金额 **10%** 的 Token 奖励，经平台审核后发放；活动有效期至 **2026-12-31 23:59:59**；总量上限 9999、每日 100。当前接口同时返回 `enable: true` 与 `enableMessage: "拉新活动升级中，敬请期待！"`。

**绑定只发生在网页注册**：邀请链接是 `https://www.dianclaw.cn/inviteNew?ic=<code>`。客户端 `/api/auth/login` 的请求体只有 `phone / code / udid / computerInfo / packageName / version`，**没有邀请字段**，已注册账号也无法补绑。

因此 0.2.0 起插件改用「隔离浏览器网页登录」承接邀请（`src/web-login.mjs`）：

1. 一次性 Chromium（`--user-data-dir` 为临时目录）打开 `inviteNew?ic=<code>`，无码时打开 `/login`；
2. 用户在窗口里正常注册/登录，邀请关系由服务端在注册时绑定；
3. 插件通过 CDP 轮询 `localStorage["dclaude.auth.session"]`，解析出 `token` 后调 `/api/v1/user/info` 验证（挡匿名/半登录态）；
4. 成功后关窗、删临时 profile，并把本账号的邀请码写进 `~/.cache/magpie/dclaw-invite.json`（键值来自 `GET /api/v1/user/invite-new` 的 `data.inviteCode`）。

邀请码只接受 `^[A-Za-z0-9]{4,32}$`，其余（含把账号 ID 当码粘贴）一律按空处理 —— 不带码比带错码安全。

### 没有「每日任务」

前端 bundle 的全部接口中没有任务中心或每日任务端点。与「任务/奖励」沾边的只有：

- `/api/v1/client/reminder/reward/status|claim`：提醒红包，需微信授权并按 `rewardRecordId` 领取，不是每日任务；
- `/api/v1/client/uninstall/retention-claim`：卸载挽留奖励；
- `/api/v1/user/invite-new`：邀请统计。

客户端的「定时任务」是本地 Claude Code 工具能力（提示词里要求使用 DClawScheduler），不经过账户 API，插件不涉及。

## 5. 热路径与性能边界

短信 / 会话登录后的 auth metadata 已带原生 Key。聊天时：

1. `loader.fetch` 只读当前账号 metadata，不调用 DClaw 账户接口。
2. 解析一次 JSON，仅去掉 `dclaw/` 模型前缀；没有改动时保留原字符串引用。
3. 设置 Bearer、官方 Claude Code UA 和 DashScope 头。
4. 直接调用官方 Messages 端点。
5. 200 响应（包括 SSE）原对象返回，不 clone、不读取、不重新编码。

纯 Key 模式不访问任何 DClaw 站点，模型目录使用随包快照。`scripts/live-probe.mjs` 复用同一 runtime/catalog，用相同的 baseURL、Key 和默认头对比裸 `fetch` 与 `runtime.forward` 热路径，并报告 TTFB、首事件与总耗时中位数；性能验收线为 `1.20× + 100ms`，超过时报告 `ok:false` 且进程退出非零。该脚本不是完整 Magpie/SDK 测量；安装后另用本机 Magpie 网关做完整链路 smoke。含自定义头的模型不做不对等性能对比。

## 6. 安全边界

- 模型 host 仅允许 `model-router.edu-aliyun.com`，只允许 HTTPS，禁止 URL userinfo。
- 原生与账户请求均 `redirect: "error"`，避免重定向带钥匙跳转。
- `Authorization`、`x-api-key`、Host、实体长度等敏感头不接受模型目录覆盖。
- 多账号缓存键使用 uid 或凭据 SHA-256 指纹，不把原始 token 当缓存键或卡片名。
- 错误只读非 2xx 响应 clone；成功 SSE 不读干。
- live 报告不含 token、Key、手机号或完整账号信息。

## 7. 错误映射

| 上游 | 插件输出 |
|---|---|
| 未登录 / 账号 Key 401 | 401 `sign_in_required` / `session_expired` + `X-Magpie-Sign-In: expired` |
| 模型专属 Key 401 | 404 `model_not_found`，只搁置当前模型，不标账号过期 |
| 400 / 422 | 400 `invalid_request`；明确内容风控为 `audit_blocked` |
| 模型 404 | 404 `model_not_found`，只搁置当前模型 |
| 405 / 501 | 501 `not_implemented` |
| 409 | 409 `concurrency_conflict` |
| 429 | 429 `rate_limited`，保留 Retry-After |
| 408 / 504 / 网络超时 | 504 `upstream_timeout` |
| 403 / 5xx / 连接失败 | 503 `upstream_unavailable`，不误标登录失效 |
| 其他明确上游错误 | 502 `upstream_error` |

## 8. 证据边界

- 匿名模型目录实测返回 HTTP 200、11 个模型及上下文/输出/模态元数据；这不等于聊天已认证成功。
- 对 `/v1/messages` 使用无效探针密钥返回 401，仅证明路由存在，不作为有效模型调用证据。
- 单元与集成 mock 验证请求形状、提示词零注入、SSE 透传、多账号、错误映射和安全边界。
- 真实 SMS、余额、模型流式输出与性能数字只能由 `scripts/live-probe.mjs` 的真实账号结果证明；本次结果见 [`validation.md`](./validation.md)。
