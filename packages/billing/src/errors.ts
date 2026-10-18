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
