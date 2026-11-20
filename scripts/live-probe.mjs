#!/usr/bin/env node
// 真实原生网关验收：node scripts/live-probe.mjs --rounds 3
// 凭据来源（优先级）：DCLAW_MODEL_API_KEY → DCLAW_SESSION_TOKEN → Magpie plugin-auth.json。
// 输出与报告只含耗时、模型 ID、canary 和脱敏请求形状，不含 token/key/手机号。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { performance } from "node:perf_hooks"
import assert from "node:assert/strict"

import { BASE, CLIENT_VERSION, MODEL_UA, createDclawRuntime } from "../src/dclaw.mjs"
import { readSseEvents } from "../src/openai-sse.mjs"

const args = process.argv.slice(2)
const valueOf = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : fallback
}
const rounds = Math.max(1, Math.min(9, Number(valueOf("--rounds", "3")) || 3))
const model = valueOf("--model", "qwen/deepseek-v4.1-flash-1017")
const canary = "DCLAW_DIRECT_OK"

function fromMagpie() {
  const file = process.env.DCLAW_AUTH_FILE || join(homedir(), ".config", "magpie", "plugin-auth.json")
  const data = JSON.parse(readFileSync(file, "utf8"))
  const slots = Object.keys(data).filter((key) => key === "dclaw" || key.startsWith("dclaw#"))
  const slot = process.env.DCLAW_AUTH_SLOT || slots.sort()[0]
  if (!slot || !data[slot]) throw new Error(`没有找到 DClaw 登录槽；请先在 Magpie 的 DClaw 插件里登录（${slots.length} 个槽）`)
  return data[slot]
}

const auth = process.env.DCLAW_MODEL_API_KEY
  ? { access: process.env.DCLAW_MODEL_API_KEY, metadata: { kind: "model-key", modelApiKey: process.env.DCLAW_MODEL_API_KEY } }
  : process.env.DCLAW_SESSION_TOKEN
    ? { access: process.env.DCLAW_SESSION_TOKEN }
    : fromMagpie()

let observedBody
const runtime = createDclawRuntime({ fetchImpl: (url, init) => {
  if (String(url).includes("/messages") && typeof init?.body === "string") observedBody = JSON.parse(init.body)
  return fetch(url, init)
} })
const resolved = await runtime.resolveCredential(auth)
const nativeAuth = { ...auth, metadata: { ...(auth.metadata || {}), modelApiKey: resolved.key } }
const models = await runtime.models(nativeAuth)
assert.ok(models[model], `在线目录没有 ${model}`)
const selectedRoute = runtime.route(nativeAuth, model)
assert.equal(selectedRoute.customHeaders, "", "性能对照要求两侧请求头完全一致，当前模型含自定义头，请换默认模型")
const directKey = selectedRoute.apiKey || resolved.key
const directUrl = `${selectedRoute.baseUrl}/messages`

const body = {
  model,
  stream: true,
  max_tokens: 128,
  messages: [{ role: "user", content: `只回复 ${canary}，不要解释，不要添加任何其他文字。` }],
}

function nativeFetch(requestBody) {
  return fetch(directUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${directKey}`,
      "user-agent": MODEL_UA,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-dashscope-wait-timeout": "30",
    },
    body: JSON.stringify(requestBody),
    redirect: "error",
  })
}

async function collect(response, started) {
  const ttfbMs = performance.now() - started
  if (!response.ok) throw new Error(`模型网关 HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
  let firstEventMs
  let text = ""
  let usage
  let eventCount = 0
  for await (const event of readSseEvents(response.body)) {
    if (firstEventMs === undefined) firstEventMs = performance.now() - started
    eventCount++
    if (!event.data || event.data === "[DONE]") continue
    const data = JSON.parse(event.data)
    if (data.type === "error" || data.error) throw new Error(`SSE error: ${JSON.stringify(data.error || data).slice(0, 500)}`)
    if (data.type === "content_block_delta" && data.delta?.type === "text_delta") text += data.delta.text || ""
    if (data.type === "message_start") usage = { ...(usage || {}), input: data.message?.usage }
    if (data.type === "message_delta") usage = { ...(usage || {}), output: data.usage, stopReason: data.delta?.stop_reason }
  }
  return {
    ttfbMs: Number(ttfbMs.toFixed(1)),
    firstEventMs: Number((firstEventMs ?? ttfbMs).toFixed(1)),
    totalMs: Number((performance.now() - started).toFixed(1)),
    eventCount,
    text,
    usage,
  }
}

async function direct() {
  const started = performance.now()
  return collect(await nativeFetch(body), started)
}

async function plugin() {
  const started = performance.now()
  const response = await runtime.forward(async () => nativeAuth, `${BASE}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  })
  return collect(response, started)
}

const samples = []
for (let round = 0; round < rounds; round++) {
  const order = round % 2 === 0 ? [["direct", direct], ["plugin", plugin]] : [["plugin", plugin], ["direct", direct]]
  const row = { round: round + 1 }
  for (const [name, run] of order) row[name] = await run()
  for (const name of ["direct", "plugin"]) assert.ok(row[name].text.includes(canary), `${name} 未返回 canary：${row[name].text}`)
  samples.push(row)
  console.log(`round ${round + 1}: direct=${row.direct.totalMs}ms plugin=${row.plugin.totalMs}ms`)
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const directMedian = median(samples.map((x) => x.direct.totalMs))
const pluginMedian = median(samples.map((x) => x.plugin.totalMs))
const directTtfbMedian = median(samples.map((x) => x.direct.ttfbMs))
const pluginTtfbMedian = median(samples.map((x) => x.plugin.ttfbMs))

assert.deepEqual(observedBody.messages, body.messages)
assert.equal(observedBody.system, undefined)
assert.equal(observedBody.model, model)
assert.doesNotMatch(JSON.stringify(observedBody), /你是DClaw客户端|杭州点壹下通讯科技有限公司|26899端口|技能商店/)

const nativeLike = pluginMedian <= directMedian * 1.2 + 100
const report = {
  ok: nativeLike,
  testedAt: new Date().toISOString(),
  clientVersion: CLIENT_VERSION,
  protocol: "anthropic-messages",
  scope: "runtime.forward 热路径；完整 Magpie/SDK 链路另做网关 smoke",
  route: { url: directUrl, modelSpecificKey: Boolean(selectedRoute.apiKey) },
  model,
  rounds,
  samples,
  median: {
    direct: { ttfbMs: directTtfbMedian, totalMs: directMedian },
    plugin: { ttfbMs: pluginTtfbMedian, totalMs: pluginMedian },
    overhead: {
      ttfbMs: Number((pluginTtfbMedian - directTtfbMedian).toFixed(1)),
      totalMs: Number((pluginMedian - directMedian).toFixed(1)),
      totalPercent: Number(((pluginMedian / directMedian - 1) * 100).toFixed(2)),
    },
  },
  nativeLike,
  requestEvidence: {
    system: observedBody.system ?? null,
    messages: observedBody.messages,
    clientPromptInjected: false,
  },
  secretsIncluded: false,
}
mkdirSync("artifacts", { recursive: true })
const file = join("artifacts", `live-native-${report.testedAt.replace(/[:.]/g, "-")}.json`)
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify({ ...report, samples: undefined, report: file }, null, 2))
if (!nativeLike) process.exitCode = 1
