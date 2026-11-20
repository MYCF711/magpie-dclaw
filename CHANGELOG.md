# 更新记录

> 每个版本一节，**一条一行**，说用户能感知的变化。
> 格式与规矩见 [UPDATING.md](./UPDATING.md)。

## 0.2.0 — 2026-11-20

- **新增网页登录（隔离浏览器）**：一次性 Chromium 窗口打开官方页面，注册/登录完成后从 `localStorage["dclaude.auth.session"]` 读回会话，不需要手抄 token。
- **邀请码随网页走**：网页登录默认带上「已登录账号记住的邀请码」，走 `https://www.dianclaw.cn/inviteNew?ic=<code>`；插件选项「网页登录带我的邀请码」可关闭，或在登录时手填（填 `0` 表示不带）。邀请码只接受字母数字，绝不把账号 ID 拼进 URL。
- 登录成功后自动记住本账号邀请码（`GET /api/v1/user/invite-new`），供后续网页注册使用；缓存只写 `~/.cache/magpie/dclaw-invite.json`。
- 隔离浏览器使用临时 profile，成功/超时/取消都会关窗删档，不碰用户日常浏览器。

## 0.1.1 — 2026-11-20

- **新增每日签到**：`GET /api/v1/user/tencent-signin/status` → 需要时 `POST /api/v1/user/tencent-signin/claim`；账号不合格报「不符合条件」，今天已领报「已签到」，签到成功给出本次积分。
- 修正 0.1.0 的错误结论「DClaw 没有每日签到接口」——接口存在，只是当前账号 `eligible=false`（非活动用户）。
- 签到按账号单飞，不回放成功结果，避免宿主「立即签到」与自动签到撞车时重复领取。
- 纯模型 Key 模式不发起签到请求，直接提示需要 DClaw 账号登录。

## 0.1.0 — 2026-11-20

**初始版本**

- 基于 `magpie-plugin-scaffold` v0.3.14 的九钩结构，provider id = `dclaw`。
- 静态逆向 DClaw 1.3.30，接入短信登录、会话令牌和纯模型 API Key 三种方式。
- 聊天直连 Anthropic `/v1/messages`，不启动客户端或 Claude Code，不注入 DClaw 客户端系统提示词。
- 接入 11 个模型的初始快照与在线目录，保留下文、输出、模态、倍率和特殊模型 ID。
- 保留调用方 system/messages/tools，SSE 原样返回；多账号 Key 隔离，余额进入额度卡片。
- 加入网关白名单、重定向拒绝、敏感头保护和完整错误分类。
- 提供本地安装/移除、真实网关性能对照测试和逆向文档。
