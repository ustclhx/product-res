/**
 * 流转 Workflow 的跨应用约定（tasks 4.1）：web 投递、jobs 执行，两边共享名称、参数与内部鉴权。
 * 实例 id 为流转 id；“重试续跑”另起实例时用 `<流转 id>-<新 uuid>`（引擎步骤幂等，并发实例安全）。
 */

/** Node 引擎中的注册名；步骤顺序变化时升版本号，旧实例按原版本 handler 完成 */
export const WORKSPACE_TRANSFER_WORKFLOW = 'workspace-transfer-v1'

export type WorkspaceTransferWorkflowParams = { transferId: string; requestId?: string }

const encoder = new TextEncoder()

/**
 * Node 目标中 web → jobs 内部接口的 Bearer：由两边都已配置的 BETTER_AUTH_SECRET 经 HMAC 派生，
 * 不新增部署密钥，也不在内网明文传输认证主密钥。
 */
export async function transferWorkflowToken(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode('workflow:workspace-transfer'),
  )
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
