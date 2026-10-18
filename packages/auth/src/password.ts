import { verifyPassword as verifyScrypt } from 'better-auth/crypto'

/**
 * 密码哈希（tasks.md 2.4，实测结论见 docs/04-auth-and-tenancy.md §1「密码哈希」）。
 *
 * Better Auth 默认的 scrypt（N=16384, r=16, p=1）在 workerd 中由 node:crypto 同步计算，
 * 修改密码要算两次，本地实测已超过 50ms 阈值，因此改用 Web Crypto 的 PBKDF2-HMAC-SHA256。
 * Workers 的 PBKDF2 最多 100,000 次迭代（再多 `deriveBits` 直接报错），取上限。
 *
 * 存储格式：`pbkdf2-sha256$<迭代次数>$<salt base64>$<hash base64>`，迭代次数随哈希保存，
 * 今后调整参数不影响已有哈希。校验时兼容 Better Auth 默认的 scrypt 格式（`<salt hex>:<key hex>`），
 * 切换前已写入的密码仍可登录。
 */

export const PBKDF2_ITERATIONS = 100_000
const PREFIX = 'pbkdf2-sha256'
const SALT_BYTES = 16
const KEY_BITS = 256

const encoder = new TextEncoder()

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    KEY_BITS,
  )
  return new Uint8Array(bits)
}

/** 常量时间比较，避免按字节提前返回泄露匹配长度 */
function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const hash = await derive(password, salt, PBKDF2_ITERATIONS)
  return `${PREFIX}$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`
}

export async function verifyPassword({
  hash,
  password,
}: {
  hash: string
  password: string
}): Promise<boolean> {
  if (!hash.startsWith(`${PREFIX}$`)) {
    // Better Auth 默认的 scrypt 哈希
    return verifyScrypt({ hash, password })
  }
  const [, iterations, salt, expected] = hash.split('$')
  const rounds = Number(iterations)
  if (!salt || !expected || !Number.isInteger(rounds) || rounds < 1) return false
  return equal(await derive(password, fromBase64(salt), rounds), fromBase64(expected))
}

/** `emailAndPassword.password` 选项 */
export const passwordHasher = { hash: hashPassword, verify: verifyPassword }
