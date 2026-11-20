// src/web-login.mjs —— 隔离浏览器网页登录：让用户在官方网页里注册/登录，再从页面读回会话
//
// 为什么单独一条登录路，而不是「在插件里复刻短信登录」：
//   · 邀请码只在**注册那一刻**的 URL 上生效（`/inviteNew?ic=<code>`），客户端
//     `/api/auth/login` 的请求体里没有邀请字段，已注册账号也补不了；
//   · 网页注册还能走客户端没有的渠道（邀请落地页、活动页、Web 端风控流程）；
//   · 用户对自己的账号有完全控制权，插件只负责「把网页里已经产生的会话取回来」。
//
// 做法（与 magpie-monkeycode 的 session-login 同一模式，MIT）：
//   一次性 user-data-dir 起一个受控 Chromium → 打开带邀请码的官方页面 →
//   用户正常注册/登录 → 通过 CDP 读 `localStorage["dclaude.auth.session"]` →
//   交给调用方验证（换 model_api_key）。窗口用临时 profile，不碰用户日常浏览器。
//
// ⚠ 只读页面存储，不写浏览器数据；结束（成功/超时/取消）都关窗并删临时 profile。

import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { findBrowser } from "./browser-login.mjs"
import { API_ROOT } from "./dclaw.mjs"

/** 会话在网页 localStorage 里的键（DClaw 1.3.30 反出的常量）。 */
export const SESSION_KEY = "dclaude.auth.session"
/** 默认等用户完成注册/登录的上限。 */
export const WEB_LOGIN_TIMEOUT_MS = 240_000
/** 轮询间隔。 */
export const WEB_LOGIN_POLL_MS = 1_500

/** 邀请码：DClaw 是 12 位十六进制，留出宽松区间只挡明显非法值。 */
const INVITE_CODE_RE = /^[A-Za-z0-9]{4,32}$/

/** 空/非法 → 空串（不带邀请码），绝不把疑似身份 ID 拼进 URL。 */
export function normalizeInviteCode(raw) {
  const code = String(raw ?? "").trim()
  return INVITE_CODE_RE.test(code) ? code : ""
}

/** 有码走邀请落地页，没码走普通登录页。 */
export function webLoginUrl(code, base = API_ROOT) {
  const root = String(base).replace(/\/+$/, "")
  const invite = normalizeInviteCode(code)
  return invite ? `${root}/inviteNew?ic=${encodeURIComponent(invite)}` : `${root}/login`
}

/** 从 localStorage 原值解析 token；兼容 `{token}`、裸字符串、坏 JSON。 */
export function tokenFromSession(raw) {
  const text = String(raw ?? "").trim()
  if (!text) return ""
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === "string") return parsed.trim()
    return String(parsed?.token ?? "").trim()
  } catch {
    return ""
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_500) })
  if (!response.ok) throw new Error(`CDP HTTP ${response.status}`)
  return response.json()
}

function cdpSend(ws, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage)
      reject(new Error(`CDP ${method} 超时`))
    }, 10_000)
    const onMessage = (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id !== id) return
      clearTimeout(timer)
      ws.removeEventListener("message", onMessage)
      if (message.error) reject(new Error(message.error.message || "CDP error"))
      else resolve(message.result)
    }
    ws.addEventListener("message", onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

/** 连上页面，读一次 localStorage 里的会话原值。 */
async function readSessionOn(ws) {
  const result = await cdpSend(ws, 1, "Runtime.evaluate", {
    expression: `localStorage.getItem(${JSON.stringify(SESSION_KEY)})`,
    returnByValue: true,
    awaitPromise: false,
  })
  const value = result?.result?.value
  return typeof value === "string" ? value : ""
}

/**
 * 开一个隔离浏览器并等用户完成网页登录。
 *
 * @param {object} [options]
 * @param {string} [options.url]       要打开的官方页面
 * @param {(token: string) => Promise<boolean>} [options.validate]
 *        每次读到 token 调一次；返回 true 才算登录成立（挡掉匿名/半登录态）
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{token: string}>}
 */
export async function waitForWebLogin({ url, validate, timeoutMs = WEB_LOGIN_TIMEOUT_MS, signal } = {}) {
  if (typeof url !== "string" || !/^https:\/\//.test(url)) throw new Error("网页登录只接受 https 地址")
  const browser = findBrowser()
  if (!browser?.path) throw new Error("没有可用的 Chromium 浏览器（Chrome / Edge / 国产 Chromium 都行）")

  const port = await freePort()
  const profile = mkdtempSync(join(tmpdir(), "magpie-dclaw-web-"))
  const child = spawn(browser.path, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    url,
  ], { stdio: "ignore", detached: false })

  const deadline = Date.now() + Math.max(10_000, Number(timeoutMs) || WEB_LOGIN_TIMEOUT_MS)
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    try { child.kill() } catch {}
    try { rmSync(profile, { recursive: true, force: true }) } catch {}
  }

  const onAbort = () => { close() }
  signal?.addEventListener("abort", onAbort, { once: true })

  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("网页登录已取消")
      let target
      try {
        const targets = await listTargets(port)
        target = targets.find((t) => t?.type === "page" && typeof t.url === "string" && t.url.startsWith(API_ROOT))
      } catch {
        // 浏览器还没起好 / 已退出：下一轮再看
      }
      if (target?.webSocketDebuggerUrl) {
        let raw = ""
        try {
          const ws = new WebSocket(target.webSocketDebuggerUrl)
          await new Promise((resolve, reject) => {
            ws.addEventListener("open", resolve, { once: true })
            ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连不上")), { once: true })
          })
          try {
            raw = await readSessionOn(ws)
          } finally {
            try { ws.close() } catch {}
          }
        } catch {
          raw = ""
        }
        const token = tokenFromSession(raw)
        if (token) {
          const ok = typeof validate === "function" ? await validate(token) : true
          if (ok) return { token }
        }
      }
      if (child.exitCode !== null && child.exitCode !== undefined) {
        throw new Error("浏览器已关闭，网页登录未完成")
      }
      await new Promise((resolve) => setTimeout(resolve, WEB_LOGIN_POLL_MS))
    }
    throw new Error("网页登录等待超时（未检测到已登录的 DClaw 会话）")
  } finally {
    signal?.removeEventListener("abort", onAbort)
    close()
  }
}

export const _internal = { INVITE_CODE_RE, freePort, tokenFromSession, readSessionOn }
