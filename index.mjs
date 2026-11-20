// DClaw 1.3.30 → magpie 原生模型网关插件。
//
// 官方客户端链路：页面 → 26899 WebSocket → Claude Code → CLAUDE.md + 模型网关。
// 本插件链路：magpie → /v1/messages → 模型网关。
// 不启动/读取客户端，不写 CLAUDE.md，不注入 DClaw prompt，不改调用方消息。

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
  loginBySms,
  normalizePhone,
  sendSmsCode,
  staticModels,
  successAuth,
  MODEL_UA,
} from "./src/dclaw.mjs"
import { rawCredentialOf, uidOf } from "./src/credential.mjs"
import { createRefreshLock } from "./src/refresh-lock.mjs"
import { createInviteStore } from "./src/invite.mjs"
import { createInvitePolicy, INVITE_OPTION, readInvitePreferred } from "./src/invite-policy.mjs"
import { readDclawAccounts } from "./src/dclaw-accounts.mjs"
import { waitForWebLogin, webLoginUrl } from "./src/web-login.mjs"
import { ICON } from "./src/icon.mjs"

const SMS_PHONE_PROMPT = { type: "text", key: "phone", message: "DClaw 账号手机号", placeholder: "13800138000" }
const SMS_CODE_PROMPT = { type: "text", key: "code", message: "短信验证码（6 位数字）", placeholder: "123456" }
const hasOwn = (inputs, key) => Object.prototype.hasOwnProperty.call(inputs || {}, key)

export async function XxxAuthPlugin(input = {}) {
  const runtime = createDclawRuntime()
  const smsPending = new Map()
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
  // 真实开关：邀请只在「开启」时参与手机验证码登录；关闭就是纯 API 短信，不走浏览器。
  const inviteOn = () => readInvitePreferred(input, PROVIDER)
  const inviteOf = (inputs) => {
    try { return invitePolicy.prepare(inputs)("") } catch { return { mode: "skip", code: "" } }
  }
  const adoptInviteCode = async (token) => {
    try {
      const code = await fetchInviteCode(token)
      if (code) inviteStore.write(code, { source: "account" })
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
          label: "手机号 + 短信验证码（推荐）",
          get prompts() {
            const first = invitePolicy.prompts()
            return first.length ? first : [SMS_PHONE_PROMPT]
          },
          async ask(inputs) {
            // 开关开启时先问「邀请来源」（最新账号 / 指定账号 / 手动码）。
            const invitePrompt = await invitePolicy.ask(inputs)
            if (invitePrompt) return invitePrompt
            // 选中了邀请源：这次注册必须走网页（API 登录不带邀请字段），不再问手机号。
            if (inviteOn() && inviteOf(inputs).code) return null
            if (!hasOwn(inputs, "phone")) return SMS_PHONE_PROMPT
            if (!hasOwn(inputs, "code")) {
              const phone = normalizePhone(inputs.phone)
              let pending = smsPending.get(phone)
              if (!pending || Date.now() - pending.at >= 60_000) {
                const sent = await sendSmsCode(phone)
                pending = { ...sent, at: Date.now() }
                smsPending.set(phone, pending)
              }
              return {
                ...SMS_CODE_PROMPT,
                message: `验证码已发送至 ${phone.slice(0, 3)}****${phone.slice(-4)}，请输入 6 位数字`,
              }
            }
            return null
          },
          async authorize(inputs) {
            // ① 带邀请码：走隔离浏览器网页注册（邀请只在注册 URL 上生效）。
            if (inviteOn()) {
              const invite = inviteOf(inputs)
              if (invite.code) {
                const url = webLoginUrl(invite.code)
                const pendingWeb = waitForWebLogin({
                  url,
                  validate: async (token) => {
                    try { await fetchUserInfo(token); return true } catch { return false }
                  },
                })
                pendingWeb.catch(() => {})
                return {
                  url,
                  method: "auto",
                  opened: true,
                  instructions: `已在隔离浏览器打开带邀请码（${invite.code}）的注册页。请在新窗口完成手机号验证；完成后回到这里即可。`,
                  async callback() {
                    try {
                      const { token } = await pendingWeb
                      const user = await fetchUserInfo(token)
                      await adoptInviteCode(token)
                      return successAuth(token, user)
                    } catch (error) {
                      return { type: "failed", error: String(error?.message ?? error) }
                    }
                  },
                }
              }
            }

            // ② 不带邀请：原生 API 短信验证码。
            let phone
            try { phone = normalizePhone(inputs?.phone) } catch (error) {
              return { type: "failed", error: error?.message || String(error) }
            }
            const pending = smsPending.get(phone)
            const code = String(inputs?.code || "").trim()
            if (!pending || !/^\d{6}$/.test(code)) return { type: "failed", error: "请先获取并输入 6 位短信验证码" }
            return {
              url: "",
              method: "auto",
              instructions: "正在验证 DClaw 短信验证码。",
              async callback() {
                try {
                  const { token, user } = await loginBySms({ phone, code, udid: pending.udid })
                  smsPending.delete(phone)
                  await adoptInviteCode(token)
                  return successAuth(token, user)
                } catch (error) {
                  return { type: "failed", error: error?.message || String(error) }
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
      // 客户端把它叫「腾讯签到」；奖励是积分/元额度，账号不合格时如实报 ineligible。
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
