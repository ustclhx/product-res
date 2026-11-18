import { AsyncLocalStorage } from 'node:async_hooks'

const nonces = new AsyncLocalStorage<string>()
export const securityNonce = () => nonces.getStore()
export function withSecurityNonce<T>(nonce: string, handle: () => T): T {
  return nonces.run(nonce, handle)
}
