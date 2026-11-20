// src/dclaw-accounts.mjs —— 列出本机已登录的 DClaw 账号（只读 magpie 的凭据文件）
//
// 用途：邀请源要「最新账号 / 指定账号」，就必须能枚举已有账号及其稳定身份。
// 只读 `~/.config/magpie/plugin-auth.json`（magpie 的目录只读不写，规矩见 store.mjs）；
// 读不到、格式不对、单条缺凭据都只是少一个候选，绝不抛错。

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export function authFilePath() {
  return process.env.DCLAW_AUTH_FILE || join(homedir(), ".config", "magpie", "plugin-auth.json")
}

/**
 * @param {string} [file]
 * @returns {{key:string, identity:string, accountId:string, token:string}[]}
 */
export function readDclawAccounts(file = authFilePath()) {
  let store
  try {
    store = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return []
  }
  if (store === null || typeof store !== "object") return []
  const out = []
  for (const [key, value] of Object.entries(store)) {
    if (key !== "dclaw" && !key.startsWith("dclaw#")) continue
    if (value === null || typeof value !== "object") continue
    const token = String(value.access || value.key || "").trim()
    const identity = String(value.metadata?.userId || value.uid || "").trim()
    if (!token || !identity) continue
    out.push({ key, identity, accountId: String(value.accountId || ""), token })
  }
  return out
}
