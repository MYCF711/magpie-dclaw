// DClaw 1.3.30 → magpie 原生模型网关插件。
//
// 官方客户端链路：页面 → 26899 WebSocket → Claude Code → CLAUDE.md + 模型网关。
// 本插件链路：magpie → /v1/messages → 模型网关。
// 不启动/读取客户端，不写 CLAUDE.md，不注入 DClaw prompt，不改调用方消息。
//
// 登录只有网页一条主路：邀请码只能在注册 URL 上生效（客户端 /api/auth/login 没有邀请字段），
// 所以不在插件里复刻短信 API 登录 —— 那样带不了邀请，等于把邀请功能做废。

import {
  API_ROOT,
  BASE,
  CLIENT_VERSION,
  MODELS,
  PROVIDER,
  PROVIDER_NAME,
  SDK,
  createDclawRuntime,
  fetchInviteCode,
  fetchUserInfo,
  staticModels,
  successAuth,
  MODEL_UA,
} from "./src/dclaw.mjs"
import { rawCredentialOf, uidOf } from "./src/credential.mjs"
import { createRefreshLock } from "./src/refresh-lock.mjs"
import { createInviteStore } from "./src/invite.mjs"
import { createInvitePolicy, INVITE_OPTION } from "./src/invite-policy.mjs"
import { readDclawAccounts } from "./src/dclaw-accounts.mjs"
import { waitForWebLogin, webLoginUrl } from "./src/web-login.mjs"
import { ICON } from "./src/icon.mjs"

export async function XxxAuthPlugin(input = {}) {
  const runtime = createDclawRuntime()
  // 签到按账号单飞：宿主重复点「立即签到」与自动签到撞车时只发一次 claim。
  const checkinLock = createRefreshLock({ replayMs: 0 })
  const preferredStore = createInviteStore("dclaw-preferred")
  const codeStore = createInviteStore("dclaw-invite")
  const invitePolicy = createInvitePolicy({
    ctx: input,
    provider: PROVIDER,
    readAccounts: () => readDclawAccounts(),
    readCode: (account) => fetchInviteCode(account.token),
    preferredStore,
    codeStore,
  })
  const inviteOf = (inputs) => {
    try { return invitePolicy.prepare(inputs)("") } catch { return { mode: "skip", sourceIdentity: "", code: "", reason: "prepare-failed" } }
  }
  /** 登录成功后把本账号的邀请码记下来，供以后邀请新号时自动使用。 */
  const adoptInviteCode = async (token) => {
    try {
      const code = await fetchInviteCode(token)
      if (code) codeStore.write(code, { source: "account" })
    } catch {}
  }

  return {
    config(cfg) {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: PROVIDER_NAME,
        npm: SDK,
        api: BASE,
        models: staticModels(),
      }
    },

    auth: {
      provider: PROVIDER,
      icon: ICON,
      maxConcurrency: 4,
      options: [INVITE_OPTION],

      methods: [
        {
          type: "oauth",
          label: "网页登录（隔离浏览器，自动带邀请码）",
          // ⚠ 必须非空：prompts 为空时宿主不把 ask 问到的东西传给 authorize，
          // 而「关闭开关自动用最新账号的码」正靠 ask 阶段去取码。
          get prompts() {
            const first = invitePolicy.prompts()
            return first.length
              ? first
              : [{
                  type: "text",
                  key: "invite",
                  message: "邀请码（可选）",
                  placeholder: "留空 = 自动用最新账号的邀请码",
                  placement: "top",
                }]
          },
          async ask(inputs) {
            return invitePolicy.ask(inputs)
          },
          async authorize(inputs) {
            const invite = inviteOf(inputs)
            const url = webLoginUrl(invite.code)
            // 浏览器立刻起在后台；authorize 本身不等待用户操作。
            const pending = waitForWebLogin({
              url,
              validate: async (token) => {
                try { await fetchUserInfo(token); return true } catch { return false }
              },
            })
            pending.catch(() => {})
            return {
              url,
              method: "auto",
              opened: true,
              instructions: invite.code
                ? `已在隔离浏览器打开带邀请码（${invite.code}）的注册页。请在新窗口完成注册/登录，完成后回到这里。`
                : "已在隔离浏览器打开 DClaw 登录页。请在新窗口完成注册/登录，完成后回到这里。",
              async callback() {
                try {
                  const { token } = await pending
                  const user = await fetchUserInfo(token)
                  await adoptInviteCode(token)
                  return successAuth(token, user)
                } catch (error) {
                  return { type: "failed", error: String(error?.message ?? error) }
                }
              },
            }
          },
        },
        {
          type: "oauth",
          label: "粘贴 DClaw 会话令牌",
          prompts: [
            { type: "password", key: "token", message: "DClaw 会话令牌（不是模型 API Key）", placeholder: "粘贴 dclaude.auth.session 中的 token" },
            { type: "text", key: "note", message: "备注名（可选）", placeholder: "例如：我的 DClaw" },
          ],
          async authorize(inputs) {
            const token = String(inputs?.token || "").trim()
            if (!token) return { type: "failed", error: "请粘贴 DClaw 会话令牌" }
            const note = String(inputs?.note || "")
            return {
              url: "",
              method: "auto",
              instructions: "正在验证 DClaw 会话令牌。",
              async callback() {
                try {
                  const user = await fetchUserInfo(token)
                  await adoptInviteCode(token)
                  return successAuth(token, user, { note })
                } catch (error) {
                  return { type: "failed", error: error?.message || String(error) }
                }
              },
            }
          },
        },
        {
          type: "oauth",
          label: "仅模型 API Key（完全跳过 DClaw 站点）",
          prompts: [
            { type: "password", key: "key", message: "model-router 原生 API Key", placeholder: "粘贴 model_api_key" },
            { type: "text", key: "note", message: "备注名（可选）", placeholder: "例如：DClaw 原生 Key" },
          ],
          async authorize(inputs) {
            const key = String(inputs?.key || "").trim()
            if (!key) return { type: "failed", error: "请粘贴模型 API Key" }
            return successAuth(key, {}, { note: inputs?.note, nativeKeyOnly: true })
          },
        },
      ],

      // DClaw 1.3.30 没有 refresh_token 端点；过期时如实要求重新登录。
      async refresh() {
        return undefined
      },

      async loader(getAuth) {
        const auth = await getAuth()
        if (!rawCredentialOf(auth)) return {}
        return {
          baseURL: BASE,
          // 真正的 key 在 forward 中按账号解析；这里不用会话 token 直接打模型网关。
          apiKey: String(auth?.metadata?.modelApiKey || rawCredentialOf(auth)),
          headers: { "user-agent": MODEL_UA },
          fetch(input, init) {
            return runtime.forward(getAuth, input, init)
          },
        }
      },

      async usage(getAuth) {
        return runtime.usage(await getAuth())
      },

      // 每日签到：GET /api/v1/user/tencent-signin/status → 需要时 POST /claim。
      async checkin(getAuth, provider) {
        let auth
        try { auth = await getAuth() } catch { return { outcome: "failed", message: "未登录 DClaw" } }
        if (!auth) return { outcome: "failed", message: "未登录 DClaw" }
        const key = `${provider?.id || PROVIDER}\n${uidOf(auth)}`
        return checkinLock.run(key, () => runtime.checkin(auth))
      },
    },

    provider: {
      id: PROVIDER,
      async models(_provider, { auth } = {}) {
        return runtime.models(auth)
      },
    },

    // 原生 Anthropic Messages 不需要本地 WS 会话头；保留九钩形状但不加额外字段。
    "chat.headers": async () => {},
  }
}

export const _internal = {
  API_ROOT,
  BASE,
  CLIENT_VERSION,
  MODELS,
  PROVIDER,
  staticModels,
}
