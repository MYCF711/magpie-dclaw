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
  assert.equal(plugin.auth.methods.length, 3)
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

test("邀请开关复刻百智云：默认关闭、文案一致、prompts 恒非空", async () => {
  const plugin = await XxxAuthPlugin({ client: {} })
  const option = plugin.auth.options[0]
  assert.equal(option.key, "invite_preferred")
  assert.equal(option.label, "首选账号作为邀请源")
  assert.equal(option.placement, "top")
  assert.equal(option.default, false)
  assert.match(option.description, /最新注册账号滚动邀请/)
  // prompts 必须非空：为空时宿主不会把 ask 的结果交给 authorize，
  // 而「关闭开关也自动带最新账号的码」全靠 ask 阶段取码。
  const prompts = plugin.auth.methods[0].prompts
  assert.ok(Array.isArray(prompts) && prompts.length >= 1)
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

test("粘贴令牌：authorize 只启动流程，校验在 callback", async () => {
  const plugin = await XxxAuthPlugin({ client: {} })
  const flow = await plugin.auth.methods[1].authorize({ token: "secret-token" })
  assert.equal(flow.method, "auto")
  assert.equal(typeof flow.callback, "function")
  const empty = await plugin.auth.methods[1].authorize({})
  assert.equal(empty.type, "failed")
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
