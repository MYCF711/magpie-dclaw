import test from "node:test"
import assert from "node:assert/strict"

import {
  INVITE_OPTION,
  INVITE_SOURCE_MANUAL,
  buildSourcePrompt,
  createInvitePolicy,
  inviteCodeOf,
  readInvitePreferred,
  resolveInviteSource,
} from "../src/invite-policy.mjs"

const accounts = [
  { identity: "1001", accountId: "138****0001", token: "t1" },
  { identity: "2002", accountId: "138****0002", token: "t2" },
]
const codes = new Map([["1001", "aaaaaaaaaaaa"], ["2002", "bbbbbbbbbbbb"]])

test("邀请码只收字母数字，identity/URL/空值一律空串", () => {
  assert.equal(inviteCodeOf("019574ee24af"), "019574ee24af")
  assert.equal(inviteCodeOf("user/../x"), "")
  assert.equal(inviteCodeOf(""), "")
  assert.equal(inviteCodeOf(null), "")
})

test("关闭开关：自动用最新注册账号（数值最大）的码", () => {
  const result = resolveInviteSource({ accounts, codes, preferredEnabled: false })
  assert.equal(result.mode, "latest")
  assert.equal(result.sourceIdentity, "2002")
  assert.equal(result.code, "bbbbbbbbbbbb")
})

test("开启开关：选中哪个账号就用哪个账号的码", () => {
  const result = resolveInviteSource({ accounts, codes, preferredEnabled: true, selectedIdentity: "1001" })
  assert.equal(result.mode, "preferred")
  assert.equal(result.sourceIdentity, "1001")
  assert.equal(result.code, "aaaaaaaaaaaa")
})

test("开启开关 + 手动码：用手动码，不看账号", () => {
  const result = resolveInviteSource({ accounts, codes, preferredEnabled: true, selectedIdentity: INVITE_SOURCE_MANUAL, manualCode: "cccccccccccc" })
  assert.equal(result.mode, "manual")
  assert.equal(result.code, "cccccccccccc")
})

test("自邀跳过、拿不到码就空着，绝不带错码", () => {
  const self = resolveInviteSource({ accounts, codes, preferredEnabled: false, targetIdentity: "2002" })
  assert.equal(self.mode, "skip")
  assert.equal(self.code, "")
  const noCode = resolveInviteSource({ accounts, codes: new Map(), preferredEnabled: false })
  assert.equal(noCode.code, "")
  assert.match(noCode.reason, /no-code/)
})

test("选择框：有账号给三个选项，没账号降级为手动输入", () => {
  const withAccounts = buildSourcePrompt({ accounts, preferredEnabled: true })
  assert.equal(withAccounts.type, "select")
  assert.deepEqual(withAccounts.options.map((o) => o.value), ["latest", "1001", "2002", "manual"])
  assert.equal(withAccounts.placement, "top")
  const none = buildSourcePrompt({ accounts: [] })
  assert.equal(none.type, "text")
})

test("ask 顺序：关闭直接 null；开启先选来源，再按需问手动码", async () => {
  const off = createInvitePolicy({ ctx: {}, provider: "dclaw", readAccounts: () => accounts, readCode: async (a) => codes.get(a.identity) })
  assert.equal(await off.ask({}), null)

  const on = createInvitePolicy({
    ctx: { magpie: { option: (_p, key) => key === "invite_preferred" } },
    provider: "dclaw",
    readAccounts: () => accounts,
    readCode: async (a) => codes.get(a.identity),
  })
  const first = await on.ask({})
  assert.equal(first.type, "select")
  const manual = await on.ask({ inviteSource: INVITE_SOURCE_MANUAL })
  assert.equal(manual.type, "text")
  assert.equal(await on.ask({ inviteSource: INVITE_SOURCE_MANUAL, invite: "cccccccccccc" }), null)
})

test("prepare 记住选择，并把选中账号的码解析出来", async () => {
  const written = []
  const policy = createInvitePolicy({
    ctx: { magpie: { option: () => true } },
    provider: "dclaw",
    readAccounts: () => accounts,
    readCode: async (a) => codes.get(a.identity),
    preferredStore: { read: () => "", write: (v) => written.push(v) },
    codeStore: { read: () => "", write: () => {} },
  })
  await policy.ask({})
  await policy.ask({ inviteSource: "1001" }) // 真实流程里 ask 会带着已答内容再来一次
  const resolve = policy.prepare({ inviteSource: "1001" })
  assert.equal(resolve("").code, "aaaaaaaaaaaa")
  assert.deepEqual(written, ["1001"])
})

test("开关缺失 / 抛错按关闭处理", () => {
  assert.equal(readInvitePreferred({}, "dclaw"), false)
  assert.equal(readInvitePreferred({ magpie: { option: () => { throw new Error("x") } } }, "dclaw"), false)
  assert.equal(INVITE_OPTION.description.includes("最新注册账号滚动邀请"), true)
})
