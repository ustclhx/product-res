// 底部升级入口的显示条件（tasks 8.3 评审 #88）：开启计费、当前生效的是免费套餐，
// 且当前用户能为空间购买（所有者 / 管理员，空间不是只读）。已订阅或普通成员不显示。
export function showUpgradeEntry({
  billingEnabled,
  planKey,
  role,
  readOnly,
}: {
  billingEnabled: boolean
  planKey: string | null
  role: string
  readOnly: boolean
}) {
  return billingEnabled && planKey === 'free' && !readOnly && (role === 'owner' || role === 'admin')
}
