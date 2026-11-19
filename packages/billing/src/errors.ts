/** Error/audit text may originate in a provider SDK; keep payment credentials out of persisted diagnostics. */
export function billingErrorMessage(error: unknown, fallback = 'Billing processing failed') {
  return (error instanceof Error ? error.message : fallback)
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\b(?:sk_(?:live|test)|rk_(?:live|test)|whsec)_[A-Za-z0-9_*-]+/g, '[redacted]')
    .replace(
      /(bearer\s+|(?:authorization|password|secret|token|api[_-]?key)\s*[:=]\s*)\S+/gi,
      '$1[redacted]',
    )
    .replace(/https?:\/\/\S+/gi, '[url]')
    .slice(0, 500)
}

/**
 * 重投无法修复、需要人工处理的计费错误码。webhook 记录失败并告警后按已接收应答，
 * 避免服务商反复重投同一条通知；人工核实后可在后台重放。
 */
export const NON_RETRYABLE_BILLING_ERRORS: readonly string[] = ['BILLING_CURRENCY_MISMATCH']

export function isRetryableBillingError(error: unknown) {
  const code =
    error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : null
  return !(typeof code === 'string' && NON_RETRYABLE_BILLING_ERRORS.includes(code))
}
