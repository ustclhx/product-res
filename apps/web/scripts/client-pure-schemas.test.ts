import { describe, expect, it } from 'vitest'
import { clientPureSchemas } from './client-pure-schemas.ts'

describe('clientPureSchemas', () => {
  it('只给 client 环境加 zod 纯函数标注', () => {
    const hook = clientPureSchemas().configEnvironment as (name: string) => unknown
    expect(hook('client')).toEqual({
      build: { rolldownOptions: { treeshake: { manualPureFunctions: ['z'] } } },
    })
    expect(hook('ssr')).toBeUndefined()
  })
})
