import { AppError } from '@product-res/shared'
import { AwsClient } from 'aws4fetch'

export interface StorageEnv {
  readonly FILES: R2Bucket
  readonly R2_ACCOUNT_ID?: string
  readonly R2_FILES_BUCKET?: string
  readonly R2_ACCESS_KEY_ID?: string
  readonly R2_SECRET_ACCESS_KEY?: string
}

export const UPLOAD_URL_TTL_SECONDS = 600
export const DOWNLOAD_URL_TTL_SECONDS = 300

/** 桶名只能来自部署绑定配置，不能让调用者对备份桶或任意端点签名。 */
function objectUrl(env: StorageEnv, key: string): URL {
  if (
    !env.FILES ||
    !env.R2_ACCOUNT_ID ||
    !/^[a-f0-9]{32}$/.test(env.R2_ACCOUNT_ID) ||
    !['product-res-files', 'product-res-files-staging', 'product-res-files-production'].includes(
      env.R2_FILES_BUCKET ?? '',
    ) ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY
  ) {
    throw new AppError('STORAGE_UNAVAILABLE', 'File storage is not configured', { status: 503 })
  }
  if (
    !/^ws\/[0-9a-f-]{36}\/.+/.test(key) ||
    key.split('/').some((part) => part === '..' || part === '.')
  )
    throw new AppError('INVALID_FILE_KEY', 'Invalid file key')
  return new URL(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_FILES_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`,
  )
}

async function presign(
  env: StorageEnv,
  key: string,
  method: 'GET' | 'PUT',
  expires: number,
  headers?: Record<string, string>,
  attachment = false,
) {
  const url = objectUrl(env, key)
  url.searchParams.set('X-Amz-Expires', String(expires))
  // 下载响应头必须参与签名；跨域重定向后浏览器不会采用链接上的 download 属性。
  if (attachment) url.searchParams.set('response-content-disposition', 'attachment')
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID as string,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY as string,
    service: 's3',
    region: 'auto',
  })
  const signed = await client.sign(url, {
    method,
    ...(headers ? { headers } : {}),
    aws: { signQuery: true, allHeaders: true },
  })
  return signed.url
}

export async function presignUpload(env: StorageEnv, key: string, mime: string) {
  // PUT 地址可重复使用；签入条件头使确认后的对象不可被覆盖，防止绕过配额。
  const headers = { 'Content-Type': mime, 'If-None-Match': '*' }
  return {
    uploadUrl: await presign(env, key, 'PUT', UPLOAD_URL_TTL_SECONDS, headers),
    headers,
    expiresIn: UPLOAD_URL_TTL_SECONDS,
  }
}

export function presignDownload(env: StorageEnv, key: string, attachment = false) {
  return presign(env, key, 'GET', DOWNLOAD_URL_TTL_SECONDS, undefined, attachment)
}
