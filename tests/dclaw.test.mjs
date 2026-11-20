import test from "node:test"
import assert from "node:assert/strict"

import {
  BASE,
  CLIENT_VERSION,
  MODELS,
  createDclawRuntime,
  fetchCatalog,
  fetchUserInfo,
  loginBySms,
  modelFromRow,
  modelsFromRows,
  normalizeModelId,
  sendSmsCode,
  staticModels,
  successAuth,
  usageFromUser,
} from "../src/dclaw.mjs"

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", ...headers },
})

const nativeBody = () => JSON.stringify({
  model: "dclaw/qwen/deepseek-v4.1-flash-1017",
  stream: true,
  max_tokens: 64,
  temperature: 0.2,
  system: "Caller system stays verbatim",
  messages: [
    { role: "user", content: "你好 DClaw，但这只是用户正文" },
  ],
  tools: [{ name: "lookup", input_schema: { type: "object", additionalProperties: false } }],
})

test("静态目录保留厂商实际上下文、输出、模态与倍率，不带客户端 prompt", () => {
  const models = staticModels()
  assert.equal(Object.keys(models).length, MODELS.length)
  assert.equal(models["qwen/deepseek-v4.1-flash-1017"].limit.context, 1_000_000)
  assert.equal(models["qwen/deepseek-v4.1-flash-1017"].limit.output, 384_000)
  assert.equal(models["qwen/kimi-k2.5"].limit.context, 256_000)
  assert.equal(models["qwen/glm-5.1"].capabilities.input.image, false)
  assert.equal(models["qwen/qwen3.8-flash"].capabilities.input.image, true)
  assert.equal(models["qwen/qwen3.8-flash"].rate, 0.32)
  assert.equal(models["qwen/qwen4-max"].rate, 1.6)
  assert.deepEqual(Object.fromEntries(Object.entries(models).map(([id, model]) => [id, model.rate])), {
    "qwen/qwen3.8-flash": 0.32,
    "qwen/qwen3.8-max-0902": 2.10,
    "qwen/qwen4-max": 1.60,
    "custom/deepseek^deepseek-v4.1-flash@default": 0.29,
    "qwen/deepseek-v4-flash-0731": 0.40,
    "qwen/deepseek-v4.1-flash-1017": 0.31,
    "qwen/glm-5.1": 1.23,
    "qwen/kimi-k2.5": 1.19,
    "qwen/glm-5.2": 1.36,
    "qwen/kimi-k2.7-code": 2.05,
    "qwen/glm-5.3": 1.36,
  })
  for (const model of Object.values(models)) {
    assert.equal(model.api.url, BASE)
    assert.equal(model.api.npm, "@ai-sdk/anthropic")
    assert.equal("prompt" in model, false)
    assert.equal("free" in model, false)
    assert.equal(model.capabilities.toolcall, true)
    assert.equal(model.capabilities.tool_call, true)
  }
})

test("模型行缺关键字段时跳过，不猜上下文", () => {
  assert.equal(modelFromRow({ id: "bad", name: "bad" }), null)
  assert.deepEqual(modelsFromRows([{ id: "bad" }, MODELS[0]]), { [MODELS[0].id]: modelFromRow(MODELS[0]) })
})

test("forward 只剥 provider 前缀，调用方 system/messages/tools 原样保留", async () => {
  const original = nativeBody()
  const originalMessages = JSON.parse(original).messages
  const originalTools = JSON.parse(original).tools
  const originalSystem = JSON.parse(original).system
  let captured
  const sse = new Response("data: {\"choices\":[]}\n\ndata: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
  const runtime = createDclawRuntime({ fetchImpl: async (url, init) => {
    captured = { url: String(url), init }
    return sse
  } })
  const auth = { access: "session-token", metadata: { modelApiKey: "native-key" } }
  const response = await runtime.forward(async () => auth, `${BASE}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer host-key", "user-agent": "magpie/0", "anthropic-version": "2023-06-01" },
    body: original,
  })
  assert.equal(response, sse, "SSE Response 必须原对象返回")
  const sent = JSON.parse(captured.init.body)
  assert.deepEqual(sent.messages, originalMessages)
  assert.deepEqual(sent.tools, originalTools)
  assert.equal(sent.system, originalSystem)
  assert.equal(sent.temperature, 0.2)
  assert.equal(sent.max_tokens, 64)
  assert.equal(sent.model, "qwen/deepseek-v4.1-flash-1017")
  assert.equal("stream_options" in sent, false)
  assert.equal(captured.init.headers.get("authorization"), "Bearer native-key")
  assert.equal(captured.init.headers.get("user-agent"), "claude-cli/2.1.177 (external, cli)")
  assert.equal(captured.init.headers.get("x-dashscope-wait-timeout"), "30")
  assert.equal(captured.init.headers.get("anthropic-version"), "2023-06-01")
  assert.equal(captured.init.redirect, "error")
  assert.doesNotMatch(captured.init.body, /你是DClaw客户端|杭州点壹下通讯科技有限公司|26899端口/)
})

test("Request 输入被克隆读取，stream:false 不擅加 stream_options", async () => {
  let sent
  const runtime = createDclawRuntime({ fetchImpl: async (_url, init) => {
    sent = init.body
    return json({ id: "ok", choices: [] })
  } })
  const auth = { access: "native-key", metadata: { kind: "model-key", modelApiKey: "native-key" } }
  const request = new Request(`${BASE}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "qwen/glm-5.1", stream: false, messages: [{ role: "user", content: "ping" }] }),
  })
  const response = await runtime.forward(async () => auth, request)
  assert.equal(response.status, 200)
  assert.equal(JSON.parse(sent).stream, false)
  assert.equal("stream_options" in JSON.parse(sent), false)
})

test("会话令牌只解析一次 model_api_key，后续请求直达网关", async () => {
  const calls = []
  const runtime = createDclawRuntime({ fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).includes("/api/v1/user/info")) {
      return json({ status: 1, data: { user: { id: "u1", model_api_key: "resolved-native-key" } } })
    }
    return json({ id: "ok" })
  } })
  const auth = { access: "session-token", uid: "u1" }
  for (let i = 0; i < 2; i++) {
    await runtime.forward(async () => auth, `${BASE}/messages`, { method: "POST", body: nativeBody() })
  }
  assert.equal(calls.filter((x) => x.url.includes("/api/v1/user/info")).length, 1)
  const native = calls.filter((x) => x.url.includes("/messages"))
  assert.equal(native.length, 2)
  for (const call of native) assert.equal(call.init.headers.get("authorization"), "Bearer resolved-native-key")
})

test("纯模型 API Key 模式不访问 DClaw 账户接口", async () => {
  const calls = []
  const runtime = createDclawRuntime({ fetchImpl: async (url) => {
    calls.push(String(url))
    return json({ id: "ok" })
  } })
  const auth = { access: "native-key", metadata: { kind: "model-key", modelApiKey: "native-key" } }
  const models = await runtime.models(auth)
  assert.equal(Object.keys(models).length, MODELS.length)
  await runtime.forward(async () => auth, `${BASE}/messages`, { method: "POST", body: nativeBody() })
  assert.deepEqual(calls, [`${BASE}/messages`])
  assert.equal(await runtime.usage(auth), undefined)
})

test("多账号并发解析按 uid 隔离", async () => {
  const nativeKeys = []
  const runtime = createDclawRuntime({ fetchImpl: async (url, init) => {
    if (String(url).includes("/api/v1/user/info")) {
      const token = init.headers.authorization
      return json({ status: 1, data: { user: { model_api_key: token === "Bearer token-a" ? "key-a" : "key-b" } } })
    }
    nativeKeys.push(init.headers.get("authorization"))
    return json({ id: "ok" })
  } })
  await Promise.all(["a", "b"].map((id) => runtime.forward(async () => ({ access: `token-${id}`, uid: `user-${id}` }), `${BASE}/messages`, { method: "POST", body: nativeBody() })))
  assert.deepEqual(nativeKeys.sort(), ["Bearer key-a", "Bearer key-b"])
})

test("在线目录使用返回行元数据，不把 prompt 暴露成模型配置", async () => {
  const row = { ...MODELS[0], prompt: "客户端注入提示词", request_url: "https://model-router.edu-aliyun.com" }
  const { models } = await fetchCatalog("session", { fetchImpl: async () => json([row]) })
  assert.equal(models[row.id].limit.context, 1_000_000)
  assert.equal(models[row.id].api.url, BASE)
  assert.equal("prompt" in models[row.id], false)
})

test("目录失败回退静态快照，登录失效不吞掉", async () => {
  const runtime = createDclawRuntime({ fetchImpl: async () => { throw new Error("offline") } })
  const models = await runtime.models({ access: "session" })
  assert.equal(Object.keys(models).length, MODELS.length)
  await assert.rejects(
    fetchUserInfo("bad", { fetchImpl: async () => json({ message: "token expired" }, 401) }),
    (error) => error.status === 401 && error.signIn === "expired",
  )
})

test("短信发送与登录请求复刻 1.3.30 字段，并保存原生 key", async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    if (String(url).endsWith("/api/auth/send-code")) return json({ status: 1, message: "ok" })
    return json({ status: 1, data: { token: "session-token", user: { id: "u1", phone: "13800138000", model_api_key: "native-key" } } })
  }
  const pending = await sendSmsCode("13800138000", { fetchImpl, udid: "0123456789abcdef0123456789abcdef" })
  const { token, user } = await loginBySms({ phone: pending.phone, code: "123456", udid: pending.udid }, { fetchImpl })
  const auth = successAuth(token, user)
  assert.equal(calls[0].body.udid, pending.udid)
  assert.equal(calls[1].body.code, "123456")
  assert.equal(calls[1].body.udid, pending.udid)
  assert.equal(calls[1].body.version, CLIENT_VERSION)
  assert.equal(calls[1].body.packageName.clientChannel, "default")
  assert.equal(calls[1].body.packageName.installerName, "DClaw_Setup_1.3.30.exe")
  assert.equal(auth.accountId, "138****8000")
  assert.equal(auth.uid, "u1")
  assert.equal(auth.metadata.modelApiKey, "native-key")
})

test("登录响应缺 model_api_key 时补读 user/info，不把 session 当原生 key", async () => {
  const calls = []
  const { user } = await loginBySms({ phone: "13800138000", code: "123456", udid: "u" }, { fetchImpl: async (url) => {
    calls.push(String(url))
    if (String(url).endsWith("/api/auth/login")) return json({ status: 1, data: { token: "session-token", user: { id: "u1" } } })
    return json({ status: 1, data: { user: { id: "u1", model_api_key: "native-key" } } })
  } })
  assert.equal(user.model_api_key, "native-key")
  assert.ok(calls.some((x) => x.endsWith("/api/v1/user/info")))
  assert.equal(successAuth("session-token", {}).metadata.modelApiKey, "")
  assert.equal(successAuth("native-key", {}, { nativeKeyOnly: true }).metadata.modelApiKey, "native-key")
})

test("余额使用钱包窗口，缺读数不伪造 0", () => {
  const usage = usageFromUser({ balance_amount_text: "12.50", modelMembership: { name: "Pro" } })
  assert.equal(usage.plan, "Pro")
  assert.equal(usage.windows[0].balance, 12.5)
  assert.equal(usage.windows[0].unit, "元")
  assert.equal(usageFromUser({}), undefined)
})

const errorCases = [
  [400, { error: { message: "bad schema" } }, 400, "invalid_request"],
  [422, { error: { message: "bad schema" } }, 400, "invalid_request"],
  [400, { error: { message: "content filter triggered" } }, 400, "audit_blocked"],
  [401, { error: { message: "invalid api key" } }, 401, "session_expired"],
  [404, { error: { message: "model not found" } }, 404, "model_not_found"],
  [405, { error: { message: "method unsupported" } }, 501, "not_implemented"],
  [409, { error: { message: "already running" } }, 409, "concurrency_conflict"],
  [429, { error: { message: "slow down" } }, 429, "rate_limited"],
  [408, { error: { message: "timed out" } }, 504, "upstream_timeout"],
  [500, { error: { message: "upstream crashed" } }, 503, "upstream_unavailable"],
  [403, { error: { message: "account has no balance" } }, 503, "upstream_unavailable"],
  [418, { error: { message: "vendor business error" } }, 502, "upstream_error"],
]

for (const [upstream, body, expectedStatus, expectedCode] of errorCases) {
  test(`上游 ${upstream} 正确映射为 ${expectedStatus}/${expectedCode}`, async () => {
    const runtime = createDclawRuntime({ fetchImpl: async () => json(body, upstream, { "retry-after": "7" }) })
    const auth = { access: "native-key", metadata: { kind: "model-key", modelApiKey: "native-key" } }
    const response = await runtime.forward(async () => auth, `${BASE}/messages`, { method: "POST", body: nativeBody() })
    const payload = await response.json()
    assert.equal(response.status, expectedStatus)
    assert.equal(payload.error.code, expectedCode)
    assert.equal(payload.error.status, expectedStatus)
    assert.equal(response.headers.get("retry-after"), "7")
    assert.equal(response.headers.get("x-magpie-sign-in"), expectedCode === "session_expired" ? "expired" : null)
    assert.match(payload.error.message, /.+/)
  })
}

test("网络错误与超时分别落 503/504，调用方 AbortError 原样抛出", async () => {
  const auth = { access: "native-key", metadata: { kind: "model-key", modelApiKey: "native-key" } }
  const offline = createDclawRuntime({ fetchImpl: async () => { throw new Error("ECONNRESET") } })
  const a = await offline.forward(async () => auth, `${BASE}/messages`, { method: "POST", body: nativeBody() })
  assert.equal(a.status, 503)
  const timeout = createDclawRuntime({ fetchImpl: async () => { throw new DOMException("timed out", "TimeoutError") } })
  const b = await timeout.forward(async () => auth, `${BASE}/messages`, { method: "POST", body: nativeBody() })
  assert.equal(b.status, 504)
  const aborted = createDclawRuntime({ fetchImpl: async () => { throw new DOMException("aborted", "AbortError") } })
  await assert.rejects(aborted.forward(async () => auth, `${BASE}/messages`, { method: "POST", body: nativeBody() }), { name: "AbortError" })
})

test("模型 ID 只去 custom-provider 前缀，/ ^ @ 原样保留", () => {
  assert.equal(normalizeModelId("custom-provider/qwen/model"), "qwen/model")
  assert.equal(normalizeModelId("custom/deepseek^deepseek-v4.1-flash@default"), "custom/deepseek^deepseek-v4.1-flash@default")
  assert.equal(modelFromRow({ ...MODELS[0], id: "custom-provider/qwen/model" }).id, "qwen/model")
})

test("非白名单模型网关在发请求前被拒绝", async () => {
  assert.throws(
    () => modelFromRow({ ...MODELS[0], request_url: "https://evil.example/v1" }),
    (error) => error.status === 502 && error.code === "internal_error",
  )
  assert.throws(
    () => modelFromRow({ ...MODELS[0], request_url: "http://model-router.edu-aliyun.com/v1" }),
    (error) => error.code === "internal_error",
  )
})

test("模型专属 key 与 custom_headers 按官方优先级使用，敏感头不能覆盖鉴权", async () => {
  const row = {
    ...MODELS[0],
    api_key: "model-key",
    apiKey: "ignored-top-level",
    custom_headers: "X-Test: accepted\nAuthorization: Bearer attacker\nX-Api-Key: attacker\nX-Empty:",
    raw: { apiKey: "raw-key", customHeaders: "X-Raw: ignored-because-custom-headers-wins" },
  }
  let captured
  const runtime = createDclawRuntime({ fetchImpl: async (url, init) => {
    if (String(url).includes("/api/v1/modelRouter/open/models")) return json([row])
    captured = init
    return json({ id: "ok" })
  } })
  const auth = { access: "session-token", metadata: { modelApiKey: "public-key" } }
  await runtime.models(auth)
  await runtime.forward(async () => auth, `${BASE}/messages`, {
    method: "POST",
    body: JSON.stringify({ ...JSON.parse(nativeBody()), model: row.id }),
  })
  assert.equal(captured.headers.get("authorization"), "Bearer model-key")
  assert.equal(captured.headers.get("x-api-key"), null)
  assert.equal(captured.headers.get("x-test"), "accepted")
  assert.equal(captured.headers.get("x-empty"), null)
  assert.equal(captured.headers.get("x-raw"), null)
  assert.equal(captured.headers.has("x-dashscope-wait-timeout"), false)
})

test("模型专属 Key 的 401 只搁置模型，不标整个账号过期", async () => {
  const row = { ...MODELS[0], api_key: "expired-model-key" }
  const runtime = createDclawRuntime({ fetchImpl: async (url) => {
    if (String(url).includes("/api/v1/modelRouter/open/models")) return json([row])
    return json({ error: { message: "model key expired" } }, 401)
  } })
  const auth = { access: "session-token", metadata: { modelApiKey: "valid-account-key" } }
  await runtime.models(auth)
  const response = await runtime.forward(async () => auth, `${BASE}/messages`, { method: "POST", body: JSON.stringify({ ...JSON.parse(nativeBody()), model: row.id }) })
  const payload = await response.json()
  assert.equal(response.status, 404)
  assert.equal(payload.error.code, "model_not_found")
  assert.equal(response.headers.get("x-magpie-sign-in"), null)
})

test("签到：非活动用户报 ineligible，不误发 claim", async () => {
  const calls = []
  const runtime = createDclawRuntime({ fetchImpl: async (url) => {
    calls.push(String(url))
    return json({ status: 1, data: { eligible: false, claimCount: 0, maxClaims: 10, todayClaimed: false, canClaim: false, reason: "非活动用户", claimable: { modelPoints: 20000, balance_amount_text: "1.00" } } })
  } })
  const result = await runtime.checkin({ access: "session-token", uid: "u1" })
  assert.equal(result.outcome, "ineligible")
  assert.equal(result.message, "非活动用户")
  assert.equal(calls.filter((x) => x.includes("/claim")).length, 0)
})

test("签到：今天已领报 claimed 且 credit=0（宿主才会盖当天时间戳）", async () => {
  const runtime = createDclawRuntime({ fetchImpl: async () => json({ status: 1, data: { eligible: true, claimCount: 3, todayClaimed: true, canClaim: false, reason: "今天已领取", claimable: { modelPoints: 20000, balance_amount_text: "1.00" } } }) })
  const result = await runtime.checkin({ access: "session-token", uid: "u1" })
  assert.equal(result.outcome, "claimed")
  assert.equal(result.credit, 0)
  assert.equal(result.streak, 3)
})

test("签到：可领时用 claimable 作为 credit，并记录连续天数", async () => {
  const calls = []
  const runtime = createDclawRuntime({ fetchImpl: async (url) => {
    calls.push(String(url))
    if (String(url).endsWith("/claim")) return json({ status: 1, message: "签到成功", data: { modelPoints: 120000, balance_amount_text: "6.00", claimCount: 4 } })
    return json({ status: 1, data: { eligible: true, claimCount: 3, todayClaimed: false, canClaim: true, reason: "", modelPoints: 100000, claimable: { modelPoints: 20000, balance_amount_text: "1.00" } } })
  } })
  const result = await runtime.checkin({ access: "session-token", uid: "u1" })
  assert.equal(result.outcome, "claimed")
  assert.equal(result.credit, 20000)
  assert.equal(result.streak, 4)
  assert.match(result.message, /1\.00 元/)
  assert.equal(calls.filter((x) => x.endsWith("/claim")).length, 1)
})

test("签到：claim 失败报 failed，且不伪造 claimed", async () => {
  const runtime = createDclawRuntime({ fetchImpl: async (url) => {
    if (String(url).endsWith("/claim")) return json({ status: 0, message: "签到失败" })
    return json({ status: 1, data: { eligible: true, claimCount: 0, todayClaimed: false, canClaim: true, claimable: { modelPoints: 20000 } } })
  } })
  const result = await runtime.checkin({ access: "session-token", uid: "u1" })
  assert.equal(result.outcome, "failed")
  assert.match(result.message, /签到失败/)
})

test("签到：纯模型 Key 模式不发任何请求", async () => {
  const calls = []
  const runtime = createDclawRuntime({ fetchImpl: async (url) => { calls.push(String(url)); return json({ status: 1, data: {} }) } })
  const result = await runtime.checkin({ access: "native-key", metadata: { kind: "model-key", modelApiKey: "native-key" } })
  assert.equal(result.outcome, "inactive")
  assert.equal(calls.length, 0)
})

test("per-model baseUrl 同时替换 host 与完整 /v1 路径", async () => {
  const row = { ...MODELS[0], request_url: "https://model-router.edu-aliyun.com/tenant" }
  let capturedUrl = ""
  const runtime = createDclawRuntime({ fetchImpl: async (url, init) => {
    if (String(url).includes("/api/v1/modelRouter/open/models")) return json([row])
    capturedUrl = String(url)
    return json({ id: "ok" })
  } })
  const auth = { access: "session-token", metadata: { modelApiKey: "public-key" } }
  await runtime.models(auth)
  await runtime.forward(async () => auth, `${BASE}/messages?trace=1`, { method: "POST", body: JSON.stringify({ ...JSON.parse(nativeBody()), model: row.id }) })
  assert.equal(capturedUrl, "https://model-router.edu-aliyun.com/tenant/v1/messages?trace=1")
})

test("合法 Messages 请求只 JSON.parse 一次，并规范化 custom-provider", async () => {
  const raw = JSON.stringify({ ...JSON.parse(nativeBody()), model: "dclaw/custom-provider/qwen/model" })
  const originalParse = JSON.parse
  let parses = 0
  let sent
  JSON.parse = function (...args) { parses++; return originalParse.apply(this, args) }
  try {
    const runtime = createDclawRuntime({ fetchImpl: async (_url, init) => { sent = init.body; return json({ id: "ok" }) } })
    const auth = { access: "native-key", metadata: { kind: "model-key", modelApiKey: "native-key" } }
    await runtime.forward(async () => auth, `${BASE}/messages`, { method: "POST", body: raw })
  } finally {
    JSON.parse = originalParse
  }
  assert.equal(parses, 1)
  assert.equal(originalParse(sent).model, "qwen/model")
})

test("目录兼容 data.models；账户 400 保持 invalid_request", async () => {
  const { models } = await fetchCatalog("", { fetchImpl: async () => json({ data: { models: [MODELS[0]] } }) })
  assert.deepEqual(Object.keys(models), [MODELS[0].id])
  await assert.rejects(
    sendSmsCode("13800138000", { fetchImpl: async () => json({ message: "bad request" }, 400) }),
    (error) => error.status === 400 && error.code === "invalid_request",
  )
})

test("自定义头全部无效时仍补 DashScope 默认头", async () => {
  const row = { ...MODELS[0], custom_headers: "Authorization: Bearer attacker\nX-Empty:" }
  let captured
  const runtime = createDclawRuntime({ fetchImpl: async (url, init) => {
    if (String(url).includes("/api/v1/modelRouter/open/models")) return json([row])
    captured = init
    return json({ id: "ok" })
  } })
  const auth = { access: "session-token", metadata: { modelApiKey: "public-key" } }
  await runtime.models(auth)
  await runtime.forward(async () => auth, `${BASE}/messages`, { method: "POST", body: JSON.stringify({ ...JSON.parse(nativeBody()), model: row.id }) })
  assert.equal(captured.headers.get("authorization"), "Bearer public-key")
  assert.equal(captured.headers.get("x-dashscope-wait-timeout"), "30")
})
