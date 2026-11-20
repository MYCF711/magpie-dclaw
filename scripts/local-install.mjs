#!/usr/bin/env node
// 本地目录安装：只改 plugins.json，支持幂等移除；不重启 Magpie、不改代理。
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, openSync, closeSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

const args = process.argv.slice(2)
const remove = args.includes("--remove")
const at = args.indexOf("--config")
const configDir = resolve(at >= 0 ? args[at + 1] : join(homedir(), ".config", "magpie"))
const pluginDir = resolve(fileURLToPath(new URL("..", import.meta.url)))
const file = join(configDir, "plugins.json")
const now = new Date().toISOString().replace(/[:.]/g, "-")
const backupDir = join(configDir, "backups", "magpie-dclaw", `${now}-${process.pid}`)
const lockFile = join(configDir, ".magpie-dclaw-install.lock")
const temp = join(configDir, `.plugins.json.magpie-dclaw-${process.pid}.tmp`)

function normalizeSpec(spec) {
  const value = String(spec || "").trim()
  if (!value || /^(?:github:|git\+|https?:|@|[a-z][a-z0-9._~-]*@)/i.test(value)) return ""
  try { return resolve(value) } catch { return "" }
}

mkdirSync(configDir, { recursive: true })
let lockFd
try {
  lockFd = openSync(lockFile, "wx")
} catch {
  throw new Error(`另一个 DClaw 安装流程正在运行（锁：${lockFile}）；本次未修改配置`)
}

try {
  const beforeRaw = existsSync(file) ? readFileSync(file, "utf8") : null
  const before = beforeRaw === null ? { plugins: [] } : JSON.parse(beforeRaw)
  if (!Array.isArray(before.plugins)) throw new TypeError(`${file} 的 plugins 不是数组`)
  const after = { ...before, plugins: [...before.plugins] }
  const existing = after.plugins.filter((item) => normalizeSpec(item?.spec) === pluginDir)

  if (remove) {
    after.plugins = after.plugins.filter((item) => normalizeSpec(item?.spec) !== pluginDir)
  } else if (!existing.length) {
    after.plugins.push({ spec: pluginDir })
  }

  const changed = JSON.stringify(before) !== JSON.stringify(after)
  mkdirSync(backupDir, { recursive: true })
  writeFileSync(join(backupDir, "plugins.json"), beforeRaw ?? `${JSON.stringify({ plugins: [] }, null, 2)}\n`)
  writeFileSync(join(backupDir, "after.json"), `${JSON.stringify(after, null, 2)}\n`)

  if (changed) {
    // 原子 rename 只防半个文件；这里再防“读取后被宿主改了”的 lost update。
    const currentRaw = existsSync(file) ? readFileSync(file, "utf8") : null
    if (currentRaw !== beforeRaw) {
      throw new Error(`${file} 在安装期间发生变化；未覆盖新内容。备份在 ${backupDir}，请在 Magpie 不做插件变更时重试`)
    }
    try {
      writeFileSync(temp, `${JSON.stringify(after, null, 2)}\n`, { mode: 0o600 })
      renameSync(temp, file)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
  }

  console.log(JSON.stringify({
    ok: true,
    action: remove ? "removed" : existing.length ? "already-installed" : "installed",
    pluginDir,
    configFile: file,
    backup: join(backupDir, "plugins.json"),
    changed,
    restartPerformed: false,
    hostReload: "请用 magpie plugin list 和本机网关确认热加载状态；本脚本未重启宿主",
  }, null, 2))
} finally {
  if (lockFd !== undefined) closeSync(lockFd)
  rmSync(lockFile, { force: true })
}
