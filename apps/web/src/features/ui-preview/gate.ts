/**
 * 组件预览页 /dev/ui 的开关（openspec add-ui-design-system design D6）：读取非密钥变量 `UI_PREVIEW`，
 * 只有字符串 `true` 才开放。wrangler 顶层（开发）与 env.staging 设为 `true`，env.production 不设，
 * 由 scripts/production/check-wrangler-envs.mjs 拦截；自托管未传入该变量时同样关闭。
 */
export const UI_PREVIEW_PATH = '/dev/ui'

export function isUiPreviewEnabled(config: { readonly UI_PREVIEW?: string | undefined }): boolean {
  return config.UI_PREVIEW === 'true'
}
