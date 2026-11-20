import os from "node:os"
import { randomBytes } from "node:crypto"

import { accountLabelOf } from "./account-name.mjs"
import { rawCredentialOf, uidOf } from "./credential.mjs"
import { CODES, OFFICIAL_UA, errorResponse, errorText, readBody } from "./http.mjs"
import { usage as buildUsage, usageWindow } from "./quota.mjs"
import { createUsageCache } from "./usage-cache.mjs"

export const PROVIDER = "dclaw"
export const PROVIDER_NAME = "DClaw 龙虾"
export const API_ROOT = "https://www.dianclaw.cn"
export const BASE = "https://model-router.edu-aliyun.com/v1"
export const SDK = "@ai-sdk/anthropic"
export const CLIENT_VERSION = "1.3.30"
export const CLIENT_UA = OFFICIAL_UA
export const MODEL_UA = "claude-cli/2.1.177 (external, cli)"
const DEFAULT_MODEL_HOST = "model-router.edu-aliyun.com"
const ALLOWED_MODEL_HOSTS = new Set([DEFAULT_MODEL_HOST])

// DClaw 1.3.30 /pages 1.3.231 的公开模型目录快照（2026-11-20）。
// 故意不收录每行 prompt：那是客户端注入链，不是模型元数据。
export const MODELS = Object.freeze([
  { id: "qwen/qwen3.8-flash", name: "Qwen3.8 Flash", contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text", "image"], level: "auto", price: "0.32x", isDefault: false },
  { id: "qwen/qwen3.8-max-0902", name: "Qwen3.8 Max", contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text", "image"], level: "auto", price: "2.10x", isDefault: false },
  { id: "qwen/qwen4-max", name: "Qwen4 Max", contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text", "image"], level: "auto", price: "1.60x", isDefault: false },
  { id: "custom/deepseek^deepseek-v4.1-flash@default", name: "Deepseek v4.1 flash 1017", contextWindow: 1000000, maxTokens: 384000, reasoning: true, input: ["text", "image"], level: "auto", price: "0.29x", isDefault: false },
  { id: "qwen/deepseek-v4-flash-0731", name: "Deepseek v4 flash 0731", contextWindow: 1000000, maxTokens: 384000, reasoning: true, input: ["text"], level: "max", price: "0.40x", isDefault: false },
  { id: "qwen/deepseek-v4.1-flash-1017", name: "Deepseek v4.1 flash 0810", contextWindow: 1000000, maxTokens: 384000, reasoning: true, input: ["text", "image"], level: "auto", price: "0.31x", isDefault: true },
  { id: "qwen/glm-5.1", name: "智谱 GLM5.1", contextWindow: 200000, maxTokens: 128000, reasoning: false, input: ["text"], level: "high", price: "1.23x", isDefault: false },
  { id: "qwen/kimi-k2.5", name: "Kimi 2.5", contextWindow: 256000, maxTokens: 16000, reasoning: true, input: ["text", "image"], level: "high", price: "1.19x", isDefault: false },
  { id: "qwen/glm-5.2", name: "智谱 GLM5.2", contextWindow: 1000000, maxTokens: 128000, reasoning: false, input: ["text"], level: "high", price: "1.36x", isDefault: false },
  { id: "qwen/kimi-k2.7-code", name: "kimi K2.7 code", contextWindow: 256000, maxTokens: 16000, reasoning: true, input: ["text", "image"], level: "high", price: "2.05x", isDefault: false },
  { id: "qwen/glm-5.3", name: "智谱 GLM5.3", contextWindow: 1000000, maxTokens: 128000, reasoning: false, input: ["text"], level: "high", price: "1.36x", isDefault: false },
])

export class DClawError extends Error {
  constructor(message, { status = 503, code = CODES.upstreamUnavailable, signIn } = {}) {
    super(String(message || "DClaw 上游没有返回错误说明"))
    this.name = "DClawError"
    this.status = status
    this.code = code
    if (signIn) this.signIn = signIn
  }
}

export function normalizePhone(value) {
  const phone = String(value || "").replace(/[\s-]/g, "").replace(/^\+86/, "")
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    throw new DClawError("请输入中国大陆 11 位手机号", { status: 400, code: CODES.invalidRequest })
  }
  return phone
}

export function computerInfo() {
  const cpus = os.cpus() || []
  return {
    System: process.platform === "win32" ? "windows" : process.platform,
    HostName: "magpie-dclaw",
    Platform: process.platform,
    Arch: process.arch,
    OSRelease: os.release(),
    OSVersion: typeof os.version === "function" ? os.version() : "",
    MemoryBytes: String(os.totalmem()),
    CPU: cpus[0]?.model || "",
    CPUCores: String(cpus.length || 1),
  }
}

function apiHeaders(token, extra = {}) {
  return {
    "user-agent": CLIENT_UA,
    accept: "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  }
}

async function requestApi(path, { token = "", method = "GET", body, fetchImpl = fetch, signal } = {}) {
  let response
  try {
    response = await fetchImpl(`${API_ROOT}${path}`, {
      method,
      headers: apiHeaders(token, body === undefined ? {} : { "content-type": "application/json" }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal || AbortSignal.timeout(15_000),
      redirect: "error",
    })
  } catch (error) {
    if (error?.name === "TimeoutError") {
      throw new DClawError(`DClaw 账户接口等待超时：${error.message}`, { status: 504, code: CODES.upstreamTimeout })
    }
    throw new DClawError(`DClaw 账户接口连接失败：${error?.message || error}`, { status: 503, code: CODES.upstreamUnavailable })
  }
  const data = await readBody(response)
  if (!response.ok) {
    const expired = response.status === 401
    const badRequest = response.status === 400 || response.status === 422
    const timeout = response.status === 408 || response.status === 504
    throw new DClawError(errorText(data) || `DClaw 账户接口 HTTP ${response.status}`, {
      status: expired ? 401 : badRequest ? response.status : timeout ? 504 : response.status === 429 ? 429 : 503,
      code: expired ? CODES.sessionExpired : badRequest ? CODES.invalidRequest : timeout ? CODES.upstreamTimeout : response.status === 429 ? CODES.rateLimited : CODES.upstreamUnavailable,
      ...(expired ? { signIn: "expired" } : {}),
    })
  }
  return data
}

export async function sendSmsCode(phone, { fetchImpl = fetch, udid = randomBytes(16).toString("hex") } = {}) {
  const normalized = normalizePhone(phone)
  const data = await requestApi("/api/auth/send-code", {
    method: "POST",
    fetchImpl,
    body: { phone: normalized, udid, computerInfo: computerInfo() },
  })
  if (data?.status !== 1) {
    throw new DClawError(data?.message || "DClaw 验证码发送失败", { status: 400, code: CODES.invalidRequest })
  }
  return { phone: normalized, udid, message: data?.message || "验证码已发送" }
}

export async function fetchUserInfo(token, { fetchImpl = fetch } = {}) {
  const data = await requestApi("/api/v1/user/info", { token, fetchImpl })
  if (data?.status !== 1 || !data?.data?.user) {
    const expired = Number(data?.code || data?.status) === 401
    throw new DClawError(data?.message || "DClaw 登录态无效", {
      status: expired ? 401 : 503,
      code: expired ? CODES.sessionExpired : CODES.upstreamUnavailable,
      ...(expired ? { signIn: "expired" } : {}),
    })
  }
  return data.data.user
}

export async function loginBySms({ phone, code, udid }, { fetchImpl = fetch } = {}) {
  const normalized = normalizePhone(phone)
  const smsCode = String(code || "").trim()
  if (!/^\d{6}$/.test(smsCode)) {
    throw new DClawError("请输入 6 位短信验证码", { status: 400, code: CODES.invalidRequest })
  }
  const data = await requestApi("/api/auth/login", {
    method: "POST",
    fetchImpl,
    body: {
      phone: normalized,
      code: smsCode,
      udid: String(udid || "").trim(),
      computerInfo: computerInfo(),
      packageName: {
        installerName: "DClaw_Setup_1.3.30.exe",
        installVersion: CLIENT_VERSION,
        version: CLIENT_VERSION,
        clientChannel: "default",
      },
      version: CLIENT_VERSION,
    },
  })
  const token = String(data?.data?.token || "").trim()
  if (data?.status !== 1 || !token) {
    throw new DClawError(data?.message || "DClaw 登录失败", { status: 400, code: CODES.invalidRequest })
  }
  const user = data.data.user?.model_api_key || data.data.user?.modelApiKey
    ? data.data.user
    : await fetchUserInfo(token, { fetchImpl })
  return { token, user, isNewUser: Boolean(data.data.isNewUser) }
}

function userIdOf(user) {
  return String(user?.id || user?._id || user?.userId || user?.uid || "").trim()
}

export function successAuth(token, user, { note = "", nativeKeyOnly = false } = {}) {
  const modelApiKey = String(user?.model_api_key || user?.modelApiKey || (nativeKeyOnly ? token : "") || "").trim()
  const uid = userIdOf(user)
  const accountId = String(note || "").trim() || accountLabelOf(user, {
    mobile: ["phone", "mobile", "telephone"],
    email: ["email"],
    id: ["nickname", "username", "name"],
  })
  return {
    type: "success",
    access: token,
    refresh: "",
    ...(accountId ? { accountId } : {}),
    ...(uid ? { uid } : {}),
    metadata: {
      kind: nativeKeyOnly ? "model-key" : "dclaw-session",
      ...(uid ? { userId: uid } : {}),
      modelApiKey,
    },
  }
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value || BASE).trim() || BASE)
  if (url.protocol !== "https:" || !ALLOWED_MODEL_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password) {
    throw new DClawError(`拒绝向未授权的模型网关发送密钥：${url.hostname || url.protocol}`, { status: 502, code: CODES.internalError })
  }
  const path = url.pathname.replace(/\/+$/, "")
  url.pathname = path.endsWith("/v1") ? path : `${path}/v1`
  return url.toString().replace(/\/$/, "")
}

export function normalizeModelId(value) {
  return String(value || "").trim().replace(/^custom-provider\//, "")
}

function rateOf(row) {
  const match = String(row?.price || "").match(/(\d+(?:\.\d+)?)\s*[x×]/i)
  return match ? Number(match[1]) : undefined
}

export function modelFromRow(row) {
  const id = normalizeModelId(row?.id)
  const context = Number(row?.contextWindow)
  const output = Number(row?.maxTokens)
  if (!id || !Number.isInteger(context) || context <= 0 || !Number.isInteger(output) || output <= 0) return null
  const inputs = Array.isArray(row.input) ? row.input.filter((x) => ["text", "image", "audio", "video", "pdf"].includes(x)) : ["text"]
  const modalities = inputs.length ? [...new Set(inputs)] : ["text"]
  const image = modalities.includes("image")
  const baseUrl = normalizeBaseUrl(row.request_url || row.baseUrl || row.raw?.request_url || row.raw?.baseUrl || BASE)
  const reasoning = Boolean(row.reasoning)
  const rate = rateOf(row)
  return {
    id,
    name: String(row.name || id),
    api: { id, url: baseUrl, npm: SDK },
    status: "active",
    ...(rate !== undefined ? { rate } : {}),
    cost: {
      input: Number(row.cost?.input) || 0,
      output: Number(row.cost?.output) || 0,
      cache: { read: Number(row.cost?.cacheRead) || 0, write: Number(row.cost?.cacheWrite) || 0 },
    },
    limit: { context, output },
    modalities: { input: modalities, output: ["text"] },
    capabilities: {
      temperature: true,
      reasoning,
      toolcall: true,
      tool_call: true,
      attachment: image,
      input: { text: true, image, audio: modalities.includes("audio"), video: modalities.includes("video"), pdf: modalities.includes("pdf") },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
  }
}

export function modelsFromRows(rows) {
  const out = {}
  for (const row of Array.isArray(rows) ? rows : []) {
    const model = modelFromRow(row)
    if (model) out[model.id] = model
  }
  return out
}

export function staticModels() {
  return modelsFromRows(MODELS)
}

export async function fetchCatalog(token, { fetchImpl = fetch } = {}) {
  const data = await requestApi(`/api/v1/modelRouter/open/models?from=cc&version=${CLIENT_VERSION}&lang=zh`, { token, fetchImpl })
  const rows = Array.isArray(data) ? data : data?.data?.models || data?.data || data?.models
  if (!Array.isArray(rows)) throw new DClawError("DClaw 模型目录响应缺少 models 数组", { status: 503, code: CODES.upstreamUnavailable })
  const models = modelsFromRows(rows)
  if (!Object.keys(models).length) throw new DClawError("DClaw 模型目录没有可用的聊天模型", { status: 503, code: CODES.upstreamUnavailable })
  return { rows, models }
}

function routeFromRow(row) {
  const raw = row?.raw && typeof row.raw === "object" ? row.raw : null
  return {
    baseUrl: normalizeBaseUrl(row?.request_url || row?.baseUrl || BASE),
    apiKey: String(row?.api_key || raw?.api_key || raw?.apiKey || (raw ? "" : row?.apiKey) || "").trim(),
    customHeaders: String(row?.custom_headers || raw?.custom_headers || raw?.customHeaders || (raw ? "" : row?.customHeaders) || "").trim(),
  }
}

export async function fetchSigninStatus(token, { fetchImpl = fetch } = {}) {
  const data = await requestApi("/api/v1/user/tencent-signin/status", { token, fetchImpl })
  if (data?.status !== 1 || !data?.data || typeof data.data !== "object") {
    throw new DClawError(data?.message || "DClaw 签到状态读取失败", { status: 400, code: CODES.invalidRequest })
  }
  return data.data
}

export async function claimSignin(token, { fetchImpl = fetch } = {}) {
  const data = await requestApi("/api/v1/user/tencent-signin/claim", {
    method: "POST",
    token,
    fetchImpl,
  })
  if (data?.status !== 1) {
    throw new DClawError(data?.message || "DClaw 签到失败", { status: 400, code: CODES.invalidRequest })
  }
  return data.data && typeof data.data === "object" ? data.data : {}
}

/**
 * 签到判定（纯函数，便于测试）：
 *   ① 账号不合格（eligible !== true）→ ineligible
 *   ② 今天已领取 → claimed（宿主只在 claimed 时盖当天时间戳，报 done 会让额度卡一直黄）
 *   ③ 可领取 → 由调用方发 claim，成功后 claimed
 *   ④ 其余（eligible 但今天不可领）→ done
 */
export function checkinOutcomeOf(status) {
  if (!status || typeof status !== "object") {
    return { outcome: "failed", message: "DClaw 签到状态响应为空" }
  }
  const reason = String(status.reason || "").trim()
  const claimCount = Number(status.claimCount)
  const streak = Number.isFinite(claimCount) && claimCount > 0 ? claimCount : undefined
  if (status.eligible !== true) {
    return { outcome: "ineligible", ...(streak ? { streak } : {}), message: reason || "该账号不参与 DClaw 每日签到" }
  }
  if (status.todayClaimed === true) {
    return { outcome: "claimed", credit: 0, ...(streak ? { streak } : {}), message: reason || "今天已签到" }
  }
  if (status.canClaim !== true) {
    return { outcome: "done", ...(streak ? { streak } : {}), message: reason || "今天暂不可签到" }
  }
  return null
}

export function usageFromUser(user) {
  const label = accountLabelOf(user, { mobile: ["phone", "mobile", "telephone"], email: ["email"], id: ["nickname", "username", "name"] })
  const plan = String(user?.modelMembership?.name || user?.model_membership_name || user?.model_membership_level || "普通用户")
  const rawBalance = user?.balance_amount_text ?? user?.balanceAmountText
  const rawPoints = user?.modelPoints ?? user?.model_points ?? user?.model_points_total
  const isYuan = rawBalance !== undefined && rawBalance !== null && String(rawBalance).trim() !== ""
  const raw = isYuan ? rawBalance : rawPoints
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined
  const balance = Number(String(raw).replace(/,/g, ""))
  if (!Number.isFinite(balance)) return undefined
  return buildUsage({
    plan,
    ...(label ? { user: label } : {}),
    windows: [usageWindow({ name: isYuan ? "账户余额" : "Token 余额", balance, unit: isYuan ? "元" : "Token" })],
  })
}

function classifyUpstream(status, body, { modelSpecificKey = false } = {}) {
  const message = errorText(body) || `模型网关 HTTP ${status}`
  if (status === 401 && modelSpecificKey) return { message: `模型专属 API Key 失效或无权访问：${message}`, status: 404, code: CODES.modelNotFound }
  if (status === 401) return { message, status: 401, code: CODES.sessionExpired, signIn: "expired" }
  if (status === 404) return { message, status: 404, code: CODES.modelNotFound }
  if (status === 400 || status === 422) {
    const audit = /audit|content.?filter|风控|敏感|暂时无法回答/i.test(message)
    return { message, status: 400, code: audit ? CODES.auditBlocked : CODES.invalidRequest }
  }
  if (status === 409) return { message, status: 409, code: CODES.concurrencyConflict }
  if (status === 429) return { message, status: 429, code: CODES.rateLimited }
  if (status === 408 || status === 504) return { message, status: 504, code: CODES.upstreamTimeout }
  if (status === 405 || status === 501) return { message, status: 501, code: CODES.notImplemented }
  if (status >= 500 || status === 403) return { message, status: 503, code: CODES.upstreamUnavailable }
  return { message, status: 502, code: CODES.upstreamError }
}

async function requestBody(input, init) {
  if (init?.body !== undefined && init?.body !== null) return init.body
  if (input instanceof Request) {
    try { return await input.clone().text() } catch { return null }
  }
  return null
}

function parseModelBody(raw) {
  if (typeof raw !== "string") return { body: raw, model: "" }
  let parsed
  try { parsed = JSON.parse(raw) } catch { return { body: raw, model: "" } }
  const original = typeof parsed?.model === "string" ? parsed.model : ""
  // 与官方一致去 custom-provider/；dclaw/ 只是 Magpie 自己的 provider 前缀。
  const model = normalizeModelId(original.replace(/^dclaw\//, ""))
  if (!original || original === model) return { body: raw, model }
  parsed.model = model
  return { body: JSON.stringify(parsed), model }
}

function requestUrl(input, baseUrl = BASE) {
  const original = typeof input === "string" ? new URL(input, BASE) : input instanceof URL ? input : new URL(input?.url || BASE, BASE)
  const selected = new URL(baseUrl)
  const basePath = selected.pathname.replace(/\/$/, "")
  const originalPath = original.pathname
  if (originalPath === basePath || originalPath.startsWith(`${basePath}/`)) {
    selected.pathname = originalPath
  } else {
    const suffix = originalPath.replace(/^\/v1(?=\/|$)/, "")
    selected.pathname = `${basePath}${suffix.startsWith("/") ? suffix : `/${suffix}`}`
  }
  selected.search = original.search
  return selected
}

function parseCustomHeaders(value) {
  const out = {}
  const forbidden = new Set(["authorization", "x-api-key", "host", "content-length", "content-encoding", "user-agent"])
  for (const line of String(value || "").split(/\r?\n/)) {
    const at = line.indexOf(":")
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    const val = line.slice(at + 1).trim()
    if (forbidden.has(key.toLowerCase())) continue
    if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) && val && !/[\r\n\0]/.test(val)) out[key] = val
  }
  return out
}

export function createDclawRuntime({ fetchImpl = fetch } = {}) {
  const credentialCache = new Map()
  const catalogCache = new Map()
  const usageCache = createUsageCache()

  function accountKey(auth) {
    return uidOf(auth) || "anonymous"
  }

  async function resolveCredential(auth) {
    const token = rawCredentialOf(auth)
    if (!token) throw new DClawError("请在 DClaw 插件中登录或粘贴模型 API Key", { status: 401, code: CODES.signInRequired, signIn: "expired" })
    const metadataKey = String(auth?.metadata?.modelApiKey || "").trim()
    if (metadataKey) return { token, key: metadataKey, user: null }
    if (auth?.metadata?.kind === "model-key") return { token, key: token, user: null }
    const id = accountKey(auth)
    const existing = credentialCache.get(id)
    if (existing && existing.expiresAt > Date.now()) return existing.promise
    const promise = fetchUserInfo(token, { fetchImpl }).then((user) => {
      const key = String(user?.model_api_key || user?.modelApiKey || "").trim()
      if (!key) throw new DClawError("DClaw 账号未返回 model_api_key，无法直连模型网关", { status: 503, code: CODES.upstreamUnavailable })
      return { token, key, user }
    })
    credentialCache.set(id, { promise, expiresAt: Date.now() + 300_000 })
    try { return await promise } catch (error) {
      credentialCache.delete(id)
      throw error
    }
  }

  async function models(auth) {
    const id = accountKey(auth)
    const cached = catalogCache.get(id)
    if (cached && Date.now() - cached.at < 300_000) return cached.models
    if (auth?.metadata?.kind === "model-key") {
      const local = { rows: MODELS, models: modelsFromRows(MODELS), at: Date.now() }
      catalogCache.set(id, local)
      return local.models
    }
    const token = rawCredentialOf(auth)
    try {
      const value = await fetchCatalog(token, { fetchImpl })
      catalogCache.set(id, { ...value, at: Date.now() })
      return value.models
    } catch (error) {
      if (error?.signIn === "expired") throw error
      if (cached) return cached.models
      const rows = MODELS
      const fallback = { rows, models: modelsFromRows(rows), at: Date.now() }
      catalogCache.set(id, fallback)
      return fallback.models
    }
  }

  function route(auth, model) {
    const cached = catalogCache.get(accountKey(auth))
    const row = cached?.rows?.find((item) => normalizeModelId(item?.id) === String(model || ""))
    return routeFromRow(row || {})
  }

  async function forward(getAuth, input, init = {}) {
    let auth
    try { auth = await getAuth() } catch (error) {
      return errorResponse(`读取 DClaw 登录态失败：${error?.message || error}`, 401, CODES.sessionExpired, { signIn: "expired" })
    }
    const raw = await requestBody(input, init)
    const { body, model } = parseModelBody(raw)
    const selected = route(auth, model)
    let credential
    try {
      credential = await resolveCredential(auth)
    } catch (error) {
      return errorResponse(error?.message || error, error?.status || 503, error?.code || CODES.upstreamUnavailable, {
        ...(error?.signIn ? { signIn: error.signIn } : {}),
      })
    }
    const key = selected.apiKey || credential.key
    const url = requestUrl(input, selected.baseUrl)
    const selectedOrigin = new URL(selected.baseUrl)
    const incoming = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
    for (const name of ["authorization", "x-api-key", "host", "content-length", "content-encoding", "user-agent"]) incoming.delete(name)
    if (body !== raw) { incoming.delete("content-length"); incoming.delete("content-encoding") }
    incoming.set("authorization", `Bearer ${key}`)
    incoming.set("user-agent", MODEL_UA)
    if (!incoming.has("content-type") && typeof body === "string") incoming.set("content-type", "application/json")
    const customHeaders = parseCustomHeaders(selected.customHeaders)
    for (const [name, value] of Object.entries(customHeaders)) incoming.set(name, value)
    if (!Object.keys(customHeaders).length && selectedOrigin.hostname === DEFAULT_MODEL_HOST && !incoming.has("x-dashscope-wait-timeout")) {
      incoming.set("x-dashscope-wait-timeout", "30")
    }
    try {
      const response = await fetchImpl(url, {
        method: init?.method || (input instanceof Request ? input.method : "POST"),
        headers: incoming,
        ...(body === null ? {} : { body }),
        signal: init?.signal || (input instanceof Request ? input.signal : undefined),
        redirect: "error",
      })
      if (response.ok) return response
      const data = await readBody(response.clone())
      const failure = classifyUpstream(response.status, data, { modelSpecificKey: Boolean(selected.apiKey) })
      return errorResponse(failure.message, failure.status, failure.code, {
        ...(failure.signIn ? { signIn: failure.signIn } : {}),
        ...(response.headers.get("retry-after") ? { "retry-after": response.headers.get("retry-after") } : {}),
      })
    } catch (error) {
      if (error?.name === "AbortError") throw error
      const timeout = error?.name === "TimeoutError"
      return errorResponse(`DClaw 模型网关${timeout ? "等待超时" : "连接失败"}：${error?.message || error}`, timeout ? 504 : 503, timeout ? CODES.upstreamTimeout : CODES.upstreamUnavailable)
    }
  }

  async function usage(auth) {
    if (!rawCredentialOf(auth) || auth?.metadata?.kind === "model-key") return undefined
    const token = rawCredentialOf(auth)
    return usageCache.readSWR(accountKey(auth), async () => usageFromUser(await fetchUserInfo(token, { fetchImpl })), { timeoutMs: 10_000 })
  }

  async function checkin(auth) {
    const token = rawCredentialOf(auth)
    if (!token) return { outcome: "failed", message: "未登录 DClaw" }
    if (auth?.metadata?.kind === "model-key") {
      return { outcome: "inactive", message: "仅模型 Key 模式无法签到；请用 DClaw 账号登录后再签到" }
    }
    try {
      const status = await fetchSigninStatus(token, { fetchImpl })
      const settled = checkinOutcomeOf(status)
      if (settled) return settled

      const reward = Number(status.claimable?.modelPoints)
      const yuan = String(status.claimable?.balance_amount_text ?? status.claimable?.balanceAmountText ?? "").trim()
      const claimed = await claimSignin(token, { fetchImpl })
      // claim 返回的是「新的总积分」，不是本次增量：用签到前后总分差，缺读数才退回 claimable。
      const before = Number(status.modelPoints)
      const after = Number(claimed.modelPoints)
      const credit = Number.isFinite(before) && Number.isFinite(after) && after > before
        ? after - before
        : Number.isFinite(reward) ? reward : 0
      const count = Number(status.claimCount)
      return {
        outcome: "claimed",
        credit,
        ...(Number.isFinite(count) ? { streak: count + 1 } : {}),
        message: yuan ? `签到成功，获得 ${yuan} 元额度` : "签到成功",
      }
    } catch (error) {
      return { outcome: "failed", message: String(error?.message || error) }
    }
  }

  return { models, forward, usage, checkin, resolveCredential, route, _caches: { credentialCache, catalogCache, usageCache } }
}
