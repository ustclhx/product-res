/** This offline slice supports USD only; never assume another currency uses cents. */
export function paypalCurrency(currency: string): 'USD' {
  if (currency.toUpperCase() !== 'USD') throw new Error('PayPal supports USD only in this slice')
  return 'USD'
}

export function toPayPalDecimal(amount: number, currency: string): string {
  paypalCurrency(currency)
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error('Amount must be a nonnegative safe integer in minor units')
  }
  const cents = BigInt(amount)
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`
}

export function fromPayPalDecimal(value: string, currency: string): number {
  paypalCurrency(currency)
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error('Invalid USD decimal amount')
  const [whole, fraction = ''] = value.split('.')
  const cents = BigInt(whole as string) * 100n + BigInt(fraction.padEnd(2, '0'))
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount exceeds safe minor units')
  return Number(cents)
}
