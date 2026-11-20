// src/invite-policy.mjs —— 复刻百智云（magpie-monkeycode）的「邀请源」策略
//
// 与百智云的语义逐条对齐：
//   开关 invite_preferred「首选账号作为邀请源」
//     关闭 → 自动使用**最新注册账号**滚动邀请（latest）
//     开启 → 登录时选择「最新账号 / 指定账号 / 手动邀请码」，并记住选择（preferred / manual）
//   邀请码只从**被选中的那个账号**取，取不到就不带码（登录照常）
//   邀请只在注册时生效，已注册补不了
//
// 本文件是纯逻辑：账号数组、码表、存储全部由调用方注入，不读盘、不发请求。

export const INVITE_SOURCE_LATEST = "latest"
export const INVITE_SOURCE_MANUAL = "manual"
export const INVITE_SOURCE_KEY = "inviteSource"
export const INVITE_OPTION_KEY = "invite_preferred"

/** magpie auth.options 的布尔开关；文案与百智云一致。 */
export const INVITE_OPTION = Object.freeze({
  key: INVITE_OPTION_KEY,
  label: "首选账号作为邀请源",
  description: "关闭：自动使用最新注册账号滚动邀请；开启：登录时选择最新账号、指定账号或手动邀请码，并记住选择。",
  default: false,
  placement: "top",
})

/** DClaw 邀请码实测为 12 位十六进制；宽松区间只挡明显非法值（identity / URL / 空）。 */
const INVITE_CODE_RE = /^[A-Za-z0-9]{4,32}$/

export function inviteCodeOf(value) {
  const code = text(value)
  return INVITE_CODE_RE.test(code) ? code : ""
}

/** 实时读开关；缺失 API / 抛错 / 非 true 一律按关闭。 */
export function readInvitePreferred(ctx, provider) {
  try {
    return ctx?.magpie?.option?.(provider, INVITE_OPTION_KEY) === true
  } catch {
    return false
  }
}

const AUTO_LABEL = "最新注册账号（自动）"
const MANUAL_LABEL = "手动输入邀请码"

function text(value) {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (typeof value === "bigint") return String(value)
  return ""
}

function asked(inputs, key) {
  return inputs !== null && typeof inputs === "object" && Object.prototype.hasOwnProperty.call(inputs, key)
}

export function identityOf(account) {
  return text(account?.identity)
}

/** 账号列表：有 identity 且带凭据的才算。 */
export function usableAccounts(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.accounts) ? value.accounts : []
  return list.filter((account) => identityOf(account).length > 0 && text(account?.token).length > 0)
}

/** 最新 = 数值 identity 最大；一个数值都没有时取列表末尾（与百智云一致）。 */
export function findLatestAccount(accounts = []) {
  const list = usableAccounts(accounts)
  let picked
  let pickedNumber
  for (const account of list) {
    const identity = identityOf(account)
    if (!/^\d+$/.test(identity)) continue
    const number = BigInt(identity)
    if (picked === undefined || number > pickedNumber) {
      picked = account
      pickedNumber = number
    }
  }
  return picked ?? list.at(-1)
}

function optionOf(account) {
  const identity = identityOf(account)
  const label = text(account?.accountId) || `账号 ${identity.slice(-4)}`
  return { label, value: identity }
}

/** 选择框：无账号时降级为手动输入，绝不返回空 options。 */
export function buildSourcePrompt({
  accounts = [],
  preferredEnabled = false,
  selectedIdentity,
  savedIdentity,
  key = INVITE_SOURCE_KEY,
  message = "邀请来源",
} = {}) {
  const list = usableAccounts(accounts)
  if (list.length === 0) {
    return {
      type: "text",
      key,
      message: MANUAL_LABEL,
      placeholder: "暂无可选账号，请手动输入邀请码；已注册账号不能补邀。",
      placement: "top",
    }
  }
  const latest = findLatestAccount(list)
  const selection = text(selectedIdentity ?? savedIdentity) || (preferredEnabled ? INVITE_SOURCE_LATEST : identityOf(latest))
  const options = [
    { label: AUTO_LABEL, value: INVITE_SOURCE_LATEST },
    ...list.map(optionOf),
    { label: MANUAL_LABEL, value: INVITE_SOURCE_MANUAL },
  ]
  // 记住的选择排到前面，但不改变 value —— 只是让人一眼看到上次用的那个。
  const ordered = options.slice().sort((a, b) => (a.value === selection ? -1 : b.value === selection ? 1 : 0))
  return { type: "select", key, message, options: ordered, placement: "top" }
}

/**
 * 解析最终邀请源。
 * @returns {{mode:string, sourceIdentity:string, code:string, reason:string}}
 */
export function resolveInviteSource({
  accounts = [],
  codes = new Map(),
  preferredEnabled = false,
  selectedIdentity,
  savedIdentity,
  manualCode = "",
  targetIdentity = "",
} = {}) {
  const list = usableAccounts(accounts)
  const codeFor = (account) => {
    const identity = identityOf(account)
    if (codes instanceof Map) return inviteCodeOf(codes.get(identity))
    return inviteCodeOf(codes?.[identity])
  }
  const resultFor = (account, mode, reason) => {
    const identity = identityOf(account)
    const code = codeFor(account)
    // 自邀：目标身份与邀请源相同 → 不带码（带上去也不会生效，还可能被风控）。
    if (identity && identity === text(targetIdentity)) {
      return { mode: "skip", sourceIdentity: identity, code: "", reason: `${reason}-self-invite` }
    }
    return { mode, sourceIdentity: identity, code, reason: code ? reason : `${reason}-no-code` }
  }

  if (list.length === 0) {
    const manual = inviteCodeOf(manualCode)
    return manual
      ? { mode: "manual", sourceIdentity: "", code: manual, reason: "no-accounts-manual" }
      : { mode: "skip", sourceIdentity: "", code: "", reason: "no-accounts-no-manual" }
  }

  if (preferredEnabled) {
    const choice = text(selectedIdentity ?? savedIdentity)
    if (choice === INVITE_SOURCE_MANUAL) {
      const manual = inviteCodeOf(manualCode)
      return manual
        ? { mode: "manual", sourceIdentity: INVITE_SOURCE_MANUAL, code: manual, reason: "selected-manual" }
        : { mode: "skip", sourceIdentity: INVITE_SOURCE_MANUAL, code: "", reason: "selected-manual-no-code" }
    }
    if (choice && choice !== INVITE_SOURCE_LATEST) {
      const exact = list.find((account) => identityOf(account) === choice)
      if (exact) return resultFor(exact, "preferred", selectedIdentity !== undefined ? "preferred-selected" : "preferred-saved")
    }
    const latest = findLatestAccount(list)
    return resultFor(latest, "latest", "preferred-latest")
  }

  return resultFor(findLatestAccount(list), "latest", "auto-latest")
}

/**
 * 把 ask → prepare → authorize 串起来。每次 authorize 重新读开关与账号，不在工厂缓存。
 */
export function createInvitePolicy({
  ctx = {},
  provider,
  readAccounts = () => [],
  readCode = async () => "",
  preferredStore,
  codeStore,
  manual = { key: "invite", message: "邀请码（可选）" },
} = {}) {
  let captured = new Map()

  function state(inputs = {}) {
    const preferredEnabled = readInvitePreferred(ctx, provider)
    const accounts = usableAccounts(readAccounts())
    const savedIdentity = text(preferredStore?.read())
    const selectedIdentity = asked(inputs, INVITE_SOURCE_KEY) ? text(inputs[INVITE_SOURCE_KEY]) : undefined
    const selection = text(selectedIdentity ?? savedIdentity)
    const sourcePrompt = buildSourcePrompt({ accounts, preferredEnabled, selectedIdentity, savedIdentity })
    const hasAccounts = sourcePrompt.type === "select"
    // 开关关闭时永不问邀请：有账号就滚动用最新的，没账号就不带（与百智云的 manual 兜底区别在此，
    // 因为我们的主登录是 API 短信，不能因为「本机还没账号」就逼用户填邀请码）。
    const manualMode = preferredEnabled && (!hasAccounts || selection === INVITE_SOURCE_MANUAL)
    return { preferredEnabled, accounts, savedIdentity, selectedIdentity, selection, sourcePrompt, hasAccounts, manualMode }
  }

  /** 取本次邀请源账号的码；永不抛错，拿不到就是空串。 */
  async function capture(current, inputs) {
    captured = new Map()
    if (current.manualMode || !current.hasAccounts) return
    const account = pickAccount(current)
    if (!account) return
    const identity = identityOf(account)
    let code = ""
    try { code = inviteCodeOf(await readCode(account)) } catch { code = "" }
    if (code) captured.set(identity, code)
  }

  function pickAccount(current) {
    const { accounts, preferredEnabled, selectedIdentity, savedIdentity } = current
    const choice = text(selectedIdentity ?? savedIdentity)
    if (preferredEnabled && choice && choice !== INVITE_SOURCE_MANUAL && choice !== INVITE_SOURCE_LATEST) {
      const exact = accounts.find((account) => identityOf(account) === choice)
      if (exact) return exact
    }
    return findLatestAccount(accounts)
  }

  function nextPrompt(inputs, current) {
    if (!current.preferredEnabled) return null
    if (current.hasAccounts && !asked(inputs, INVITE_SOURCE_KEY)) return current.sourcePrompt
    if (!current.manualMode) return null
    if (!asked(inputs, manual.key)) return { type: "text", ...manual, placement: "top" }
    return null
  }

  async function ask(inputs = {}) {
    const current = state(inputs)
    await capture(current, inputs)
    return nextPrompt(inputs, current)
  }

  function prompts() {
    const first = nextPrompt({}, state({}))
    return first === null ? [] : [first]
  }

  function prepare(inputs = {}) {
    const current = state(inputs)
    if (current.preferredEnabled && current.hasAccounts && asked(inputs, INVITE_SOURCE_KEY)) {
      const choice = text(inputs[INVITE_SOURCE_KEY])
      if (current.sourcePrompt.options.some((option) => option.value === choice)) {
        preferredStore?.write(choice, { source: "chosen" })
      }
    }
    let manualCode = ""
    if (current.manualMode) {
      const raw = asked(inputs, manual.key) ? text(inputs[manual.key]) : text(codeStore?.read())
      manualCode = inviteCodeOf(raw)
      if (manualCode) codeStore?.write(manualCode, { source: "chosen" })
    }
    const codes = new Map(captured)
    return (targetIdentity = "") => resolveInviteSource({
      accounts: current.accounts,
      codes,
      preferredEnabled: current.preferredEnabled,
      selectedIdentity: current.selectedIdentity,
      savedIdentity: current.savedIdentity,
      manualCode,
      targetIdentity,
    })
  }

  return { ask, prompts, prepare }
}
