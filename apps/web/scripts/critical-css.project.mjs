// 项目自有（template-sync 不覆盖）：criticalCss 'used' 裁剪关键样式时额外保留的规则。
// beasties 求不了值或判断有误、导致首屏样式与完整样式不一致的选择器，在这里补充（字符串或 RegExp，匹配选择器文本）。
// 用 node scripts/check-critical-css.mjs 做视觉核对；默认规则见 marketing-html.mjs 的 DEFAULT_ALLOW_RULES。
/**
 * @param {readonly (string | RegExp)[]} defaults 模板默认保留规则
 * @returns {readonly (string | RegExp)[]}
 */
export function projectCriticalCssAllowRules(defaults) {
  return defaults
}
