# NOTICE

本项目的部分**通用协议原语与工程模式**提炼自以下以 MIT 许可发布的项目。
DClaw 专用的域名、认证字段、模型目录与提示词注入结论来自对用户提供的 DClaw 1.3.30 安装包的静态逆向；这些专用结论与通用模块分开维护。

## magpie-community/plugins

- 仓库：https://github.com/magpie-community/plugins
- 许可：MIT
- 版权：Copyright (c) 2026 magpie-community contributors；`packages/codearts` 包内 LICENSE 另列
  Copyright (c) 2026 yuweihao17 / Sakura-Natsu，`packages/zen-free` 包内 LICENSE 另列
  Copyright (c) 2026 xiaozhou26。
- 吸收内容：
  - `packages/codearts`（https://github.com/magpie-community/plugins/tree/main/packages/codearts）：
    `parseSseEvents` / `completionFromChunks` / `foldAnswer` 的 SSE 折叠与 tool_calls 合并思路；
    `peekAnswer` 的 200 内嵌错误窥探与 replay 思路（`src/openai-sse.mjs`）；
    `createConcurrencyGate` 的并发闸参考（未直接采用）
  - `packages/zen-free`（https://github.com/magpie-community/plugins/tree/main/packages/zen-free）：
    `stream.mjs` 的 Chat accumulator、`tool-response.mjs` 的 `framesFrom` 帧解析、
    `TextDecoder(fatal, ignoreBOM)` 与 32 MiB 上限（`src/openai-sse.mjs`）
  - `packages/raccoon`（https://github.com/magpie-community/plugins/tree/main/packages/raccoon）：
    loopback OAuth 的 state 单值校验、Host 校验、单次回调与 CSP 处理（`src/oauth-pkce.mjs`）；
    refresh 单飞 + 60 秒回放（`src/refresh-lock.mjs`）
  - `packages/workbuddy`（https://github.com/magpie-community/plugins/tree/main/packages/workbuddy）：
    refresh 单飞 / 短回放结构（`src/refresh-lock.mjs`）
  - `packages/qoder`：参数先于名字到达的 tool_call 缓冲，以及流末无名调用不向外发送的边界（`src/openai-sse.mjs`）
  - `packages/raccoon`：签到前后账单按稳定 ID 求差、一次性奖励防双计（`src/checkin.mjs`）

## sabercomo/magpie-workbuddy-plus

- 仓库：https://github.com/sabercomo/magpie-workbuddy-plus
- 许可：MIT
- 吸收内容：Retry-After 秒数 / HTTP-date / 有界退避（`src/http.mjs`）；独立临时名、权限位与 `Intl` 时区日键（`src/store.mjs`）

## MYCF711/magpie-plugin-scaffold

- 仓库：https://github.com/MYCF711/magpie-plugin-scaffold
- 版本：v0.3.14
- 许可：MIT
- 吸收内容：九钩插件结构、`src/` 通用模块、检查/测试/发布脚本及文档骨架。

## DClaw 1.3.30

- 来源：用户提供的 `DClaw_Setup_1.3.30.exe`，杭州点壹下通讯科技有限公司。
- 使用范围：认证与模型协议结论、模型元数据快照、官方应用图标；未复制其专有业务代码到插件实现。
- DClaw 名称、图标和服务权利归原厂商所有，本插件为非官方适配层。

## MYCF711/magpie-monkeycode

- 仓库：https://github.com/MYCF711/magpie-monkeycode
- 许可：MIT
- 吸收内容：`src/session-login.mjs` 的「一次性 Chromium + CDP 轮询本地会话」模式与 `src/invite-policy.mjs` 的邀请源开关形态（本仓库改写为 `src/web-login.mjs`，只读 `localStorage`，不含厂商专用码表）。

## MYCF711 自有 MIT 插件

- `magpie-magicrew-auth` — https://github.com/MYCF711/magpie-magicrew-auth
  - `src/model-context.mjs`：查 `~/.cache/magpie/models.json` 的递归索引与 TTL 缓存模式（`src/model-context.mjs`）
  - `src/hooks/loader.mjs`：工具 schema 兼容改写（`walkSchema` 只走 schema 位置、非布尔 `additionalProperties` → `true`、删 `items:{}`、`items` 子树 union 摊平且不留空 schema）的思路与边界（`src/tool-schema.mjs`）
  - `src/key-store.mjs`：`renewOnce` 按 siteId + account 的并发去重（`src/refresh-lock.mjs`）
- `magpie-officeace` — https://github.com/MYCF711/magpie-officeace
  - `src/login.mjs`：`refreshOnce` 按 refreshToken 键控（`src/refresh-lock.mjs`）
- `magpie-trustoken-auth` — https://github.com/MYCF711/magpie-trustoken-auth
  - `src/oauth.mjs`：`beginOAuth` / PKCE S256 / 127.0.0.1 随机端口回调（`src/oauth-pkce.mjs`）
- `magpie-loomy-auth` — https://github.com/MYCF711/magpie-loomy-auth
  - `tests/mount.test.mjs`：入口唯一函数导出 / 九钩子 / config / loader / usage 的挂载测试结构（`tests/mount.test.mjs`）
  - live models 按相同 id 继承静态能力、未知模型不套用第一条的边界（`src/models.mjs`）
- `magpie-cnb-auth` / `magpie-opc-auth`
  - 公共 HTTP 外壳、异构错误文本与保守 401/403 判定（`src/http.mjs`）；凭据读取、指纹与种类优先级（`src/credential.mjs`）
  - CNB 的 RFC 8628 设备码申请、轮询、slow_down 与刷新语义（`src/oauth-device.mjs`）
- `magpie-trustoken-auth` — https://github.com/MYCF711/magpie-trustoken-auth
  - 只读 400/422 clone 的错误分类与 Response 改写、响应头失效处理（`src/status.mjs`）
- `magpie-intern-ai` — https://github.com/MYCF711/magpie-intern-ai
  - 无 zone 的厂商时间按显式 offset 解析（`src/quota.mjs`）
- `magpie-alysis-auth` — https://github.com/MYCF711/magpie-alysis-auth
  - live models 的已知 / 未知条目分支与能力继承边界（`src/models.mjs`）
- `magpie-wps-lingxi` — https://github.com/providers-aaaa/magpie-wps-lingxi（MIT，KevinFX-code and contributors）
  - 空闲超时只摘除等待者、在飞数据块进入队列且 done/error 可重放（`src/stream-reader.mjs`）；usage 旧值立即返回并后台单飞刷新（`src/usage-cache.mjs`）

以上项目的版权归各自作者所有，按 MIT 许可使用。本项目自身同样以 MIT 许可发布，完整许可正文见 `LICENSE`。
