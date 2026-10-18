import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readLocalAdminCredentials } from '../e2e/staging-acceptance/local-admin.ts'

const directories: string[] = []

function localEnv(contents: string) {
  const directory = mkdtempSync(join(tmpdir(), 'acceptance-local-admin-'))
  directories.push(directory)
  const file = join(directory, '.env.local')
  writeFileSync(file, contents)
  return file
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true })
})

describe('本地验收管理员凭据', () => {
  it('优先进程凭据，齐全时不需要主 checkout 文件', () => {
    expect(
      readLocalAdminCredentials(
        { LOCAL_ADMIN_EMAIL: 'process@example.com', LOCAL_ADMIN_PASSWORD: 'process-password' },
        '/missing/acceptance-local-admin/.env.local',
      ),
    ).toEqual({ email: 'process@example.com', password: 'process-password' })
  })

  it('从主 dotenv 只返回两个本地键，不导入远程目标或其他键', () => {
    const env = {}
    const remoteTarget = process.env.STAGING_URL
    const file = localEnv(
      'LOCAL_ADMIN_EMAIL="file@example.com"\nLOCAL_ADMIN_PASSWORD="file password # quoted"\nSTAGING_URL=https://remote.example.com\nNEON_READONLY_URL=remote-fixture\n',
    )
    expect(readLocalAdminCredentials(env, file)).toEqual({
      email: 'file@example.com',
      password: 'file password # quoted',
    })
    expect(env).toEqual({})
    expect(process.env.STAGING_URL).toBe(remoteTarget)
  })

  it('进程缺失的键从 dotenv 补齐，已有键不被覆盖', () => {
    const file = localEnv(
      'LOCAL_ADMIN_EMAIL=file@example.com\nLOCAL_ADMIN_PASSWORD=file-password\n',
    )
    expect(readLocalAdminCredentials({ LOCAL_ADMIN_EMAIL: 'process@example.com' }, file)).toEqual({
      email: 'process@example.com',
      password: 'file-password',
    })
  })

  it('任一键缺失或为空时不提供固定凭据，保留随机账号 fallback', () => {
    const complete = localEnv(
      'LOCAL_ADMIN_EMAIL=file@example.com\nLOCAL_ADMIN_PASSWORD=file-password\n',
    )
    expect(readLocalAdminCredentials({ LOCAL_ADMIN_EMAIL: '' }, complete)).toBeUndefined()
    expect(readLocalAdminCredentials({ LOCAL_ADMIN_PASSWORD: '' }, complete)).toBeUndefined()
    expect(
      readLocalAdminCredentials({}, localEnv('LOCAL_ADMIN_EMAIL=file@example.com\n')),
    ).toBeUndefined()
    expect(
      readLocalAdminCredentials(
        {},
        localEnv('LOCAL_ADMIN_EMAIL=\nLOCAL_ADMIN_PASSWORD=file-password\n'),
      ),
    ).toBeUndefined()
    expect(
      readLocalAdminCredentials({}, '/missing/acceptance-local-admin/.env.local'),
    ).toBeUndefined()
  })
})
