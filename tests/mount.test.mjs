import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import * as entry from "../index.mjs"
import { _internal } from "../index.mjs"

const { XxxAuthPlugin } = entry

test("入口只导出一个插件工厂和一个对象", () => {
  assert.deepEqual(Object.entries(entry).filter(([, value]) => typeof value === "function").map(([key]) => key), ["XxxAuthPlugin"])
  assert.equal(typeof _internal, "object")
  assert.equal(_internal.PROVIDER, "dclaw")
  assert.ok(Array.isArray(_internal.MODELS))
})

test("九项钩子、三种独立登录和官方内嵌图标齐全", async () => {
  const plugin = await XxxAuthPlugin({ client: {} })
  assert.equal(typeof plugin.config, "function")
  assert.equal(plugin.auth.provider, "dclaw")
  assert.equal(plugin.auth.methods.length, 4)
  for (const method of plugin.auth.methods) assert.equal(method.authorize.constructor.name, "AsyncFunction")
  assert.equal(typeof plugin.auth.refresh, "function")
  assert.equal(typeof plugin.auth.loader, "function")
  assert.equal(typeof plugin.auth.usage, "function")
  assert.equal(typeof plugin.auth.checkin, "function")
  assert.equal(plugin.provider.id, "dclaw")
  assert.equal(typeof plugin.provider.models, "function")
  assert.equal(typeof plugin["chat.headers"], "function")
  assert.match(plugin.auth.icon, /^data:image\//)
  assert.ok(plugin.auth.maxConcurrency >= 1)
  assert.deepEqual((await plugin.auth.checkin()).outcome, "failed")
  assert.equal(await plugin.auth.refresh(), undefined)
})

test("网页登录的邀请开关默认开启，关闭时不问邀请码", async () => {
  const on = await XxxAuthPlugin({ client: {} })
  assert.equal(on.auth.options[0].key, "invite-source")
  assert.equal(on.auth.options[0].placement, "top")
  assert.equal(on.auth.options[0].default, true)
  const off = await XxxAuthPlugin({ client: {}, magpie: { option: (_p, key) => (key === "invite-source" ? false : true) } })
  assert.equal(await off.auth.methods[2].ask({}), null)
  const onPlugin = await XxxAuthPlugin({ client: {} })
  assert.equal(await onPlugin.auth.methods[2].ask({ invite: "" }), null)
  assert.ok(onPlugin.auth.methods[2].prompts.length >= 1)
})

test("auth.checkin 按账号单飞，且不回放成功", () => {
  const source = readFileSync(new URL("../index.mjs", import.meta.url), "utf8")
  assert.match(source, /const checkinLock = createRefreshLock\(\{ replayMs: 0 \}\)/)
  assert.match(source, /checkinLock\.run\(key, \(\) => runtime\.checkin\(auth\)\)/)
})

test("config 未登录也声明完整模型与显式模态能力", async () => {
  const plugin = await XxxAuthPlugin({ client: {} })
  const cfg = {}
  await plugin.config(cfg)
  const provider = cfg.provider.dclaw
  assert.equal(provider.api, _internal.BASE)
  assert.equal(provider.npm, "@ai-sdk/anthropic")
  const models = provider.models
  assert.equal(Object.keys(models).length, _internal.MODELS.length)
  for (const [id, model] of Object.entries(models)) {
    assert.ok(model.limit.context > 0)
    assert.ok(model.limit.output > 0)
    assert.equal(model.api.url, _internal.BASE)
    assert.deepEqual(model.modalities.output, ["text"])
    for (const key of ["text", "image", "audio", "video", "pdf"]) {
      assert.equal(typeof model.capabilities.input[key], "boolean", `${id}.capabilities.input.${key}`)
    }
    assert.equal(model.modalities.input.includes("image"), model.capabilities.input.image)
    assert.equal("prompt" in model, false)
  }
})

test("authorize 只启动流程，会话校验在 callback；SMS 用 ask 分步", async () => {
  const plugin = await XxxAuthPlugin({ client: {} })
  const sessionFlow = await plugin.auth.methods[1].authorize({ token: "secret-token" })
  assert.equal(sessionFlow.method, "auto")
  assert.equal(typeof sessionFlow.callback, "function")
  const sms = plugin.auth.methods[0]
  assert.deepEqual(await sms.ask({}), { type: "text", key: "phone", message: "DClaw 账号手机号", placeholder: "13800138000" })
  const missingCode = await sms.authorize({ phone: "13800138000", code: "123456" })
  assert.equal(missingCode.type, "failed")
  assert.equal(typeof sms.ask, "function")
})

test("loader 未登录禁用；已登录给原生 baseURL/key/fetch 且不预先发网络请求", async () => {
  const plugin = await XxxAuthPlugin({ client: {} })
  assert.deepEqual(await plugin.auth.loader(async () => null), {})
  const auth = { access: "session-token", metadata: { modelApiKey: "native-key" } }
  const loader = await plugin.auth.loader(async () => auth)
  assert.equal(loader.baseURL, _internal.BASE)
  assert.equal(loader.apiKey, "native-key")
  assert.equal(typeof loader.fetch, "function")
  assert.equal(loader.headers["user-agent"], "claude-cli/2.1.177 (external, cli)")
})

test("usage 无凭据不伪造额度；chat.headers 不污染其他供应商", async () => {
  const plugin = await XxxAuthPlugin({ client: {} })
  assert.equal(await plugin.auth.usage(async () => null), undefined)
  const output = { headers: { existing: "kept" } }
  await plugin["chat.headers"]({ model: { providerID: "other" }, sessionID: "s" }, output)
  assert.deepEqual(output, { headers: { existing: "kept" } })
})
