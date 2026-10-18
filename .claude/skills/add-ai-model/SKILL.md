---
name: add-ai-model
description: 在本模板配置文本、图片或视频模型的参数、定价和套餐授权；优先使用后台模型管理，只有新增 Provider 能力时扩展源码。
---

# 添加 AI 模型

定位含 `package.json` 与 `template.config.ts` 的项目根，路径均相对根目录。先读 `AGENTS.md`、`docs/06-ai.md` §1–3；媒体模型再读 §4–5，跨平台修改读 `docs/platform-capabilities.md`。执行命令前读取包 manifest，生成项目用自己的 scope 替换示例 `@saas`。

## 1. 区分模型配置与新 Provider

确认种类、模型 key、provider、服务商真实 `providerModelId`、参数、定价、允许套餐、部署目标和验收环境。运行时模型数据在 `packages/db/src/schema/ai.ts` 的 `ai_model`，后台入口是 `/admin/models`，实现见 `apps/web/src/routes/admin/models.tsx`、`apps/web/src/features/ai/admin-models.functions.ts`。

已有 Provider 的新模型优先在后台新建/复制，复用现有 schema 编辑器与保存校验；无需改源码或迁移。当前文本入口 `packages/ai/src/text/model.ts` 支持 openai、anthropic、google、deepseek；媒体注册见 `packages/ai/src/media/registry.ts`。OpenAI 兼容服务也可使用管理员配置的 openai 直连入口。核对具体模型的官方协议/参数后再配置，不能把同 Provider 模板视为通用协议。

`template.config.ts` 控制文本/媒体开关、媒体 Provider 列表和默认定价模式；AI 要求 billing 与 credits 同时启用。模型记录保存 schema/价格/标签，端点与 key 属于部署配置，不放进模型记录。保存后台模型是目标环境写入，遵守用户指定环境；用户只要求准备方案时交付字段清单而不操作后台。

完成标准：确认已有 Provider 能否支持，并将工作限定为后台配置或必要的 Provider 扩展。

## 2. 配置参数、定价与权限

后台先用「Insert reference template」，核对覆盖原 JSON 的影响，再填写模型实际参数。参考与保存校验在 `apps/web/src/features/ai/admin-model-params.ts`。

- 文本 `params_schema` 可为 `{}`；`x-text` 只允许 `tokensPerChar`（正数）、`maxOutputTokens`（正整数）、可选 `thinking`（boolean）与 `continuation`（native/none）。默认系数 1、输出 4096、continuation none。thinking/续写还须 `packages/ai/src/text/capabilities.ts` 的 adapter 支持，设置 schema 不会创造新能力。
- 媒体 `params_schema` 使用 `packages/ai/src/media/params.ts` 的 `parseMediaSchema`；现有表单支持平面 string/number/integer/boolean、枚举与范围，嵌套对象需另行设计。参数名、默认值和边界与服务商协议一致。
- `pricing` 由 `packages/ai/src/pricing.ts` 校验：token、per_call、per_unit。按次文本必填 `limits.maxInputTokens` 和 `limits.maxOutputTokens`；按单位媒体需要真实可获得的 image/second 用量，不能把任务运行时间当作视频秒数。积分计算向上取整，复用现有预算与定价快照。
- 模型 key 或标签（数据库 `min_plan_features`）必须匹配套餐 `features.models` 的授权；核对 `/admin/billing/plans` 与 `packages/entitlements/src/index.ts`。启用模型不等于所有用户可用；提交还检查空间权益、积分余额、并发和限流。通过既有 billing/credits 流程解决授权与余额，不直接改账本。

先保存停用记录，复核 schema、价格和目标 Provider 配置后启用。保存服务会做管理员校验、审计并调用 `packages/ai/src/models.ts` 的缓存失效；列表存在缓存，提交前会直接读库复核。已提交调用继续用自己的参数与定价快照。

完成标准：schema/定价保存校验通过；允许与不允许的套餐、目标能力和余额条件都已列明。

## 3. 凭据与目标能力

Cloudflare 文本默认 Gateway/BYOK，Node 默认 OpenAI 兼容直连；选择依据是 `AI_TEXT_EGRESS`，细节见 `docs/06-ai.md` 的「Gateway 与密钥」和 `packages/config/src/node-schema.ts`。Gateway 的 account/id 是公开配置，token/Provider key 是 secret。直连使用部署管理员配置的 `OPENAI_BASE_URL` 与 key，普通聊天请求不能选择端点；DeepSeek 的 direct 分支与缺 key 时的 Gateway 路径按现有实现处理。

本地 AI 密钥放 app 的已忽略 `.dev.vars` 或 Node 配置支持的 secret 文件；根 `.env.local` 的 dev 支付同步只加载支付项。输出配置键名和缺项，不输出值。取得/填写 key 按 `docs/07-infrastructure.md` §4；本技能不替用户申请账号或默认写云端 secrets。

Cloudflare Workers AI 图片要求真实 `AI` binding；Node 不提供 Workers AI，后台和模型列表会过滤并在提交端复核。fal 与媒体持久任务依赖当前运行时装配的 workflow、storage 等能力，检查 `apps/web/src/server/runtime.ts`，能力不可用时应在 task/hold 副作用前报告。不要用模板启用状态替代能力检查。

完成标准：选择的模型、Provider 与实际部署目标能力相符；缺凭据或外部环境时首次真实调用明确记为未验收。

## 4. 仅在新 Provider 时扩展

先读 `docs/01-architecture.md`、`docs/02-project-structure.md`，确定变更范围：

- 文本在 `packages/ai/src/text/model.ts` 接入已有 LanguageModelFactory；有 thinking/续写能力才扩展 `text/capabilities.ts`。key/env 增项同步对应 Cloudflare/Node 配置和 composition，保持 SDK 运行时兼容；协议逻辑不放页面。
- 媒体实现 `packages/ai/src/media/provider.ts` 的 MediaProvider 或 SyncMediaProvider，并在 `media/registry.ts` 注册 supportedKinds、配置判定、同步/幂等能力和精确 outputHosts。异步提交保持 provider_request_key、原始请求验签、先回调落库后唤醒、超时查询和结算边界；不确定的非幂等提交不能盲重试。
- 新媒体 Provider 同步更新 `packages/config/src/template.ts` 的 `MediaProviderId` 与默认配置，并在 `template.config.ts` 启用所需 Provider；更新 `scripts/create-project.mjs` 的允许列表、密钥/资源清单和关闭功能时的裁剪，扩展 `scripts/create-project.test.mjs` 的相关生成器回归用例。按需补 web/jobs Wrangler bindings 与 `packages/config/src/node-schema.ts`、`apps/web/src/node/runtime.ts`、`apps/jobs/src/node/runtime.ts` 的 env/composition；配置、生成项目与运行时装配必须一致，只有受支持目标才提供能力。
- 下载复用 `packages/storage/src/media-validation.ts`，按 Provider 精确主机白名单限制重定向、大小和 MIME；不要增加通配域名绕过 SSRF 边界。
- 后台 Provider 可用性校验见 `apps/web/src/features/ai/admin-model-provider.ts`；新增配置或能力同时覆盖这里及注册表可见性。平台调用经 platform 中立入口，业务包不直接导入 cloudflare:workers。

完成标准：新增能力沿用现有接口，核心成功/失败、未知 usage、幂等与目标能力缺失分支通过相关现有测试或必要的精简回归测试。

## 5. 验收与故障处置

源码变更时在根目录执行：

```sh
pnpm check
pnpm check:deps
pnpm check:singletons
pnpm --filter @product-res/ai test
pnpm --filter @product-res/web test --project unit src/features/ai/admin-model-params.test.ts src/features/ai/admin-model-provider.test.ts
pnpm typecheck
git diff --check
```

按目标完成 build 或 build:node；新增媒体服务再运行受影响的 storage/jobs 测试，范围以对应 manifest 为准。仅配置后台模型时无需为未改源码增加测试，复用编辑器校验并核对保存/列表/权限行为。
修改生成器时执行 `pnpm test:create-project`；有新增配置组合时在一次性副本验证生成结果及目标构建，使用现有 `pnpm test:create-project:verify` 承载需要真实生成/安装的验收。

用户已授权真实服务调用时，以允许套餐且有足够积分的本地/测试空间发起一次调用：文本检查流式输出、最终状态、定价快照与 hold 结算；媒体检查提交、终态、文件落存储和预扣释放/扣款。复核禁止套餐或余额不足在外部调用前拒绝。真实调用会消耗服务商额度，配置准备本身不代表调用授权。测试 fixture 和假 fetch 仅证明离线行为。

- `PARAMS_SCHEMA_INVALID`：检查 JSON 对象、x-text 类型/未知键或媒体平面 schema，按具体模型模板修正。
- `MISSING_TOKEN_LIMITS`：补齐按次文本的两项 token 上限。
- `MODEL_UNAVAILABLE` / `UPGRADE_REQUIRED`：检查启用、目标能力、pricing 与套餐 key/标签。
- `AI_PROVIDER_NOT_CONFIGURED` / 能力不可用：报告缺少的配置名称/能力；补配置后重验，保留未验收状态。
- 余额不足：通过既有积分流程准备测试空间；有失败产出时按现有退款规则核对账本，避免额外扣费或伪造成功。

交付配置字段或修改文件、实际命令及结果、目标能力与套餐/余额检查，以及未执行的外部调用和部署。
