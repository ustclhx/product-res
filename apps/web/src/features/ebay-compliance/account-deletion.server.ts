import { createEbayPublicKeyStore, type EbayPublicKeyStore } from '@product-res/connectors'
import { deleteEbayUserData } from '@product-res/follow'
import { getWebRuntime } from '../../server/runtime.ts'
import { webSecrets } from '../data-center/registry.server.ts'
import type { EbayAccountDeletionDeps } from './account-deletion.ts'

/** 进程内公钥缓存（按 kid，1 小时）；跨请求复用，避免每条通知都调用 getPublicKey */
let publicKeys: EbayPublicKeyStore | undefined

/**
 * 组装端点依赖。密钥经 createDataSourceSecrets 读取（NAME → NAME_FILE → OPTIONAL_SECRETS_DIR/NAME），
 * 结果按名称缓存，新写入的 secret 需重启 web 生效；非 Node 目标读取失败时按未配置处理。
 */
export async function ebayAccountDeletionDeps(): Promise<EbayAccountDeletionDeps> {
  const runtime = getWebRuntime()
  let secret: (name: string) => string | undefined
  try {
    secret = await webSecrets()
  } catch {
    secret = () => undefined
  }
  publicKeys ??= createEbayPublicKeyStore({ fetch: (input, init) => fetch(input, init), secret })
  return {
    appUrl: runtime.config.APP_URL,
    secret,
    publicKeys,
    deleteUserData: (input) => deleteEbayUserData(runtime.db, input),
  }
}
