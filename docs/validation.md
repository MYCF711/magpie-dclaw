# DClaw 插件验收报告（2026-11-20）

## 结论

- 插件已安装到本机 Magpie，显示 **DClaw 龙虾 / 11 models / signed in**。
- 默认模型 `qwen/deepseek-v4.1-flash-1017` 的真实原生/插件热路径对照达到验收线。
- 完整 Magpie → SDK → 插件 → 上游 Messages 链路 smoke 通过，SSE 完整，路由 `known=true`。
- 精确抓取的上游请求 `system=null`，只有指定 user 消息，没有 DClaw 客户端提示词。
- 验收时 `DClaw.exe` 与 `claude.exe` 进程均为 0；全局 `proxy=direct`；本机 Magpie 网关 HTTP 200。

## 离线与装配

| 项目 | 结果 |
|---|---|
| 源码测试 | **427/427 通过**（含 5 条签到用例 + 1 条单飞契约） |
| 独立审查全量扫描（含 artifacts 副本） | 1257/1257 通过（0.1.0 时点） |
| `npm run check` | **45 通过 / 0 警告 / 0 失败** |
| `npm run check:ua` | **0 失败 / 0 警告** |
| 错误码检查 | 通过 |
| 隐私扫描 | 0 处 |
| 模型快照对账 | 11 个模型 × 9 个字段，0 差异 |
| tarball 独立解包 import | 通过 |
| 隔离安装 | 首次 / 幂等 / 锁拒绝 / 移除均通过 |
| 独立审查 | blocker 0，high 0；4 个 medium 已修复并复核 |

## 真实原生性能对照

脚本：`scripts/live-probe.mjs --rounds 3`。同一模型、同一 canary、交替顺序，每次 `max_tokens=128`。两侧使用相同 baseURL、账号原生 Key 和默认头。

| 中位数（3 轮） | 原生 `fetch` | 插件 `runtime.forward` | 差值 |
|---|---:|---:|---:|
| TTFB | 733.7ms | 587.4ms | **-146.3ms** |
| 完整流总耗时 | 838.8ms | 782.7ms | **-56.1ms（-6.69%）** |

- 验收线：插件中位总耗时 ≤ 原生 `1.20× + 100ms`。
- 结果：`nativeLike=true`，脚本退出码 0。
- 6 次调用均返回 `DCLAW_DIRECT_OK` 与 `stop_reason=end_turn`。
- 每次均有完整 Anthropic SSE 事件和 usage；不是只收到首段。
- 上游请求证据：`system=null`，`messages` 只有“只回复 DCLAW_DIRECT_OK…”这一条 user 消息，`clientPromptInjected=false`。

这是 **runtime.forward 热路径**性能对照，不把网络抖动解释为插件加速；差值为负只说明本次样本没有可测的额外性能损失。

## 完整 Magpie/SDK smoke

另经 `http://127.0.0.1:3425/v1/messages` 调用 `dclaw/custom/deepseek^deepseek-v4.1-flash@default`：

| 项目 | 结果 |
|---|---|
| HTTP / SSE | 200 / 14 个事件，含 message_start、delta、message_delta、message_stop |
| canary | `DCLAW_MAGPIE_OK` |
| stop reason | `end_turn` |
| input / output tokens | 32 / 8 |
| trace | `status=200`、`done=true`、`sentBy=plugin` |
| trace TTFT / 总耗时 | 733ms / 989ms |
| 路由 | `known=true`、账户余额窗口可见 |
| 本次上游 amount | `0.000064` |

完整 smoke 的 32 输入 tokens 是没有长客户端提示词的旁证；精确的 system/messages 零注入结论以上一节抓到的实际上游请求体为准。

## 每日签到

2026-11-20 用真实账号只读查询 `GET /api/v1/user/tencent-signin/status`：

```json
{"status":1,"data":{"eligible":false,"claimCount":0,"maxClaims":10,"todayClaimed":false,
"canClaim":false,"reason":"非活动用户","modelPoints":100000,"nextClaimDate":null,
"claimable":{"modelPoints":20000,"balance_amount_text":"1.00"}}}
```

结论：

- 接口存在（0.1.0 曾误判为「没有签到接口」，0.1.1 已修正）。
- 当前账号 `eligible=false`、`reason="非活动用户"`，因此插件报 `ineligible`，卡片显示「该账号不符合条件」。
- 没有发起 `claim`——账号不合格，发起也只会拿到错误；这既不浪费一次尝试，也不产生误解。
- 签到钩子已按契约实现并用 5 条离线用例覆盖：不合格、今天已领、可领并领到、claim 失败、纯 Key 模式零请求；另有单飞源码契约测试。
- 因为本账号不合格，「真实领取成功」这条路径只有 mock 证据，没有实网 `claimed` 证据。

### 关于「每日任务」

前端全部接口中没有每日任务端点。可查到的相关能力是提醒红包（需微信授权 + `rewardRecordId`）、卸载挽留奖励与邀请统计，都不属于每日任务，插件未接入。客户端的「定时任务」是本地工具能力，不经账户 API。

## 额度模型（每日额度）

DClaw 是**预充值余额制**，不是每日重置的额度池：

| 项 | 当前账号实测 |
|---|---|
| 余额 | 5.0000 元（`balance_amount_text`） |
| 积分 | 100,000（`model_points` / `model_points_total`） |
| 会员 | `modelMembership: {level:0, name:"尊享版", isValid:false}` —— 默认档，不是付费会员 |
| 充值档位 | `recharge_level: 0`、`total_recharge_amount: 0`（从未充值） |
| 模型调用 | 按上游 usage 扣余额/积分，**没有每日重置的用量上限** |

**每日赠送余额**来自客户端钱包页文案 `每日赠送余额` + `单用户累计上限10元`，对应签到接口：

- 每次奖励 `claimable = 1.00 元 / 20,000 积分`；
- `maxClaims: 10` ⇒ 累计上限正好 10 元 / 10 次；
- 当前账号 `/tencent-signin/status` 返回 `eligible:false`、`reason:"非活动用户"`，所以**实际每天到账 0 元**，直到账号符合活动资格。

另有 `tencentActivity`（首充活动）：`eligible:true`、`expiresAt:2026-11-20 23:59:59`、`hidePlansBelowAmount:50`，属于充值加赠，不是每日额度。

## 证据文件

> 以下 JSON/日志是本机 `artifacts/` 下的验收证据，已随 `.gitignore` 排除，**不随仓库分发**；仓库里只保留本报告与 `docs/internals.md` 的结论。

- `artifacts/live-native-2026-11-20T10-10-03-110Z.json`
- `artifacts/live-probe.log`
- `artifacts/magpie-smoke-evidence.json`
- `artifacts/magpie-smoke.sse`
- `artifacts/magpie-route-evidence.json`
- `artifacts/model-snapshot-audit.json`
- `artifacts/magpie-install-evidence.json`
- `artifacts/auth-evidence.json`
- `artifacts/client-process-evidence.txt`
- `artifacts/npm-test-source.tap`
- `artifacts/check.log`、`check-ua.log`、`check-errors.log`、`privacy-scan.log`

完整账号清单和实际安装回执含本机或其他账号显示信息，已移到工作区 `reverse/` 私有证据区，不进入公开发布面。

## 边界

- 只对默认 DeepSeek 模型做了真实性能对照；其余 10 个模型已验证目录元数据与 mock 行为，未逐一付费实测。
- 未对长上下文、图片输入和所有工具调用组合逐一做真实模型测试。
- 真实 SMS 登录已由用户在 Magpie UI 完成；未在命令行输出手机号、验证码、会话令牌或模型 Key。
- 未重启 DSH 或 Magpie，未修改全局代理，未运行 DClaw 客户端。
