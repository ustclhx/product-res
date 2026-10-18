import { validateMediaParams as validateServerMediaParams } from '@product-res/ai'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileUploadActions, type MediaFile, submitMediaTask, uploadMediaFile } from './client.ts'
import { MediaParameterFields } from './parameter-form.tsx'
import {
  initialMediaParams,
  type MediaParams,
  mediaCreditEstimate,
  parseMediaSchema,
  validateMediaParams,
} from './schema.ts'

const ready: MediaFile = {
  id: '00000000-0000-4000-8000-000000000001',
  mime: 'image/png',
  size: 12,
  status: 'ready',
}
const pending: MediaFile = {
  ...ready,
  id: '00000000-0000-4000-8000-000000000002',
  status: 'pending',
}
const schema = parseMediaSchema({
  type: 'object',
  properties: {
    resolution: { type: 'string', title: 'Resolution', enum: ['720p', '1080p'], default: '720p' },
    duration: {
      type: 'number',
      title: 'Duration',
      minimum: 1,
      maximum: 10,
      multipleOf: 0.5,
      default: 5,
    },
    input: { type: 'string', title: 'Input image', format: 'file' },
    prompt: { type: 'string', title: 'Prompt', minLength: 1, maxLength: 200 },
    sound: { type: 'boolean', title: 'Sound', default: false },
  },
  required: ['resolution', 'duration', 'input', 'prompt', 'sound'],
})
const params: MediaParams = { ...initialMediaParams(schema), input: ready.id, prompt: 'A forest' }
const render = (values = params) =>
  renderToString(
    <MediaParameterFields
      schema={schema}
      params={values}
      files={[ready, pending]}
      onChange={() => {}}
      onUpload={() => {}}
    />,
  )

afterEach(() => vi.unstubAllGlobals())

describe('媒体 schema 参数组件', () => {
  it('枚举显示 schema 选项及默认选中值，并拒绝不支持的分辨率', () => {
    const html = render()
    expect(html).toContain('<option value="0" selected="">720p</option>')
    expect(html).toContain('<option value="1">1080p</option>')
    expect(validateMediaParams(schema, { ...params, resolution: '4k' }, [ready]).success).toBe(
      false,
    )
  })

  it('数字字段显示范围与步长，校验上限、下限和间隔', () => {
    const numeric = render().match(/<input[^>]*type="number"[^>]*>/)?.[0]
    expect(numeric).toContain('min="1" max="10" step="0.5"')
    expect(numeric).toContain('name="duration" value="5"')
    expect(validateMediaParams(schema, params, [ready]).success).toBe(true)
    for (const duration of [0, 11, 5.2])
      expect(validateMediaParams(schema, { ...params, duration }, [ready]).success).toBe(false)
  })

  it('文件字段只列出 ready 文件，未确认和任意文件 ID 都不能提交', () => {
    const html = render()
    expect(html).toContain(`<option value="${ready.id}" selected="">`)
    expect(html).not.toContain(pending.id)
    expect(html).toContain('type="file"')
    expect(
      validateMediaParams(schema, { ...params, input: pending.id }, [ready, pending]).success,
    ).toBe(false)
    expect(validateMediaParams(schema, params, []).success).toBe(false)
    expect(
      validateMediaParams(schema, { ...params, input: 'https://external.example/image.png' }, [
        ready,
      ]).success,
    ).toBe(false)
  })

  it('文本约束和必填布尔 false 保留 schema 语义，清空数字不会变成零', () => {
    const html = render()
    expect(html).toContain('minLength="1" maxLength="200"')
    expect(html).toContain('type="checkbox"')
    expect(validateMediaParams(schema, params, [ready]).success).toBe(true)
    const { duration: _duration, ...cleared } = params
    const restored = validateMediaParams(schema, cleared, [ready])
    expect(restored.success).toBe(true)
    if (restored.success) expect(restored.data.duration).toBe(5)
    expect(validateMediaParams(schema, { ...params, prompt: '' }, [ready]).success).toBe(false)
  })

  it('表单与服务端对默认值、UUID、单位约束和未知参数保持一致', () => {
    const raw = {
      type: 'object',
      properties: {
        duration: { type: 'number', default: 5, minimum: 0, maximum: 10 },
        count: { type: 'number', default: 2 },
        prompt: { type: 'string', pattern: '^A', default: 'A forest' },
        input: { type: 'string', format: 'file' },
      },
      required: ['input'],
      'x-media': { unitsParam: 'count' },
    }
    const parsed = parseMediaSchema(raw)
    for (const candidate of [
      { input: ready.id },
      { input: ready.id, count: 2.5 },
      { input: ready.id, count: 0 },
      { input: ready.id, prompt: 'forest' },
      { input: ready.id, extra: true },
      { input: 'invalid' },
    ]) {
      const form = validateMediaParams(parsed, candidate, [ready], 'image')
      if (form.success)
        expect(form.data).toEqual(validateServerMediaParams(raw, candidate, 'image').params)
      else expect(() => validateServerMediaParams(raw, candidate, 'image')).toThrow()
    }
    expect(() => parseMediaSchema({ ...raw, 'x-media': { unitsParam: 'prompt' } })).toThrow()
  })

  it('切换模型时默认参数重新生成，文件默认值不能绕过确认', () => {
    expect(
      initialMediaParams(
        parseMediaSchema({
          type: 'object',
          properties: { input: { type: 'string', format: 'file', default: pending.id } },
        }),
      ),
    ).toEqual({})
    expect(
      initialMediaParams(
        parseMediaSchema({
          type: 'object',
          properties: { count: { type: 'integer', default: 2 } },
        }),
      ),
    ).toEqual({ count: 2 })
    expect(() =>
      parseMediaSchema({ type: 'object', properties: { nested: { type: 'object' } } }),
    ).toThrow()
  })
})

describe('媒体预计消耗', () => {
  it('复用快照定价，按次和按秒使用同一倍率与向上取整口径', () => {
    const base = { key: 'video', kind: 'video' as const, paramsSchema: null }
    expect(
      mediaCreditEstimate(
        {
          ...base,
          pricing: { mode: 'per_call', credits: 2.1, multipliers: { resolution: { '1080p': 2 } } },
        },
        schema,
        { ...params, resolution: '1080p' },
      ),
    ).toBe(5)
    expect(
      mediaCreditEstimate(
        {
          ...base,
          pricing: {
            mode: 'per_unit',
            unit: 'second',
            perUnit: 2.1,
            multipliers: { resolution: { '1080p': 2 } },
          },
        },
        schema,
        { ...params, resolution: '1080p' },
      ),
    ).toBe(21)
    const custom = parseMediaSchema({
      type: 'object',
      'x-media': { unitsParam: 'count' },
      properties: { count: { type: 'integer' } },
    })
    expect(
      mediaCreditEstimate(
        { ...base, kind: 'image', pricing: { mode: 'per_unit', unit: 'image', perUnit: 3 } },
        custom,
        { count: 2 },
      ),
    ).toBe(6)
  })
})

describe('上传素材', () => {
  it('声明、签名 PUT、确认按顺序执行，只有确认成功才返回可选文件', async () => {
    const events: string[] = []
    const declare = vi.fn(async () => {
      events.push('declare')
      return {
        fileId: ready.id,
        uploadUrl: 'https://upload.example/file',
        headers: { 'Content-Type': 'image/png', 'If-None-Match': '*' },
      }
    })
    const put = vi.fn(async () => {
      events.push('put')
      return new Response(null, { status: 200 })
    })
    const complete = vi.fn(async () => {
      events.push('complete')
      return ready
    })
    const file = new File(['image'], 'input.png', { type: 'image/png' })
    await expect(uploadMediaFile('workspace', file, { declare, put, complete })).resolves.toEqual(
      ready,
    )
    expect(events).toEqual(['declare', 'put', 'complete'])
    expect(put).toHaveBeenCalledWith('https://upload.example/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'If-None-Match': '*' },
      body: file,
    })
    expect(complete).toHaveBeenCalledWith({ workspaceId: 'workspace', fileId: ready.id })
  })

  it('PUT 失败不确认；确认失败或仍为 pending 时不返回文件', async () => {
    const declare = vi.fn(async () => ({
      fileId: ready.id,
      uploadUrl: 'https://upload.example/file',
      headers: {},
    }))
    const complete = vi.fn(async () => ready)
    const file = new File(['image'], 'input.png', { type: 'image/png' })
    await expect(
      uploadMediaFile('workspace', file, {
        declare,
        complete,
        put: async () => new Response(null, { status: 403 }),
      }),
    ).rejects.toThrow('MEDIA_UPLOAD_FAILED')
    expect(complete).not.toHaveBeenCalled()
    const put = async () => new Response(null, { status: 200 })
    await expect(
      uploadMediaFile('workspace', file, {
        declare,
        put,
        complete: async () => {
          throw new Error('UPLOAD_MISMATCH')
        },
      }),
    ).rejects.toThrow('UPLOAD_MISMATCH')
    await expect(
      uploadMediaFile('workspace', file, {
        declare,
        put,
        complete: async () => ({ ...ready, status: 'pending' }),
      }),
    ).rejects.toThrow('MEDIA_UPLOAD_FAILED')
  })
})

describe('客户端 HTTP 契约', () => {
  it('提交工作空间、模型 key 与类型保持不变的参数，并返回任务 ID', async () => {
    const taskId = '00000000-0000-4000-8000-000000000003'
    const request = vi.fn(async () => Response.json({ taskId }))
    vi.stubGlobal('fetch', request)
    await expect(
      submitMediaTask({ workspaceId: ready.id, modelKey: 'video-model', params }),
    ).resolves.toEqual({ taskId })
    expect(request).toHaveBeenCalledWith('/api/ai/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: ready.id, modelKey: 'video-model', params }),
    })
  })

  it('服务端拒绝时保留业务错误码，不接受畸形的成功响应', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: { code: 'INSUFFICIENT_CREDITS' } }, { status: 403 }),
      )
      .mockResolvedValueOnce(Response.json({ taskId: 'invalid' }))
    vi.stubGlobal('fetch', request)
    const input = { workspaceId: ready.id, modelKey: 'video-model', params }
    await expect(submitMediaTask(input)).rejects.toThrow('INSUFFICIENT_CREDITS')
    await expect(submitMediaTask(input)).rejects.toThrow('MEDIA_SUBMIT_FAILED')
  })

  it('使用既有文件 HTTP 入口，确认响应的额外元数据不进入表单', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          fileId: ready.id,
          uploadUrl: 'https://upload.example/file',
          headers: { 'Content-Type': ready.mime },
        }),
      )
      .mockResolvedValueOnce(Response.json({ ...ready, r2Key: 'private-key' }))
    vi.stubGlobal('fetch', request)
    await fileUploadActions.declare({ workspaceId: ready.id, mime: ready.mime, size: ready.size })
    await expect(
      fileUploadActions.complete({ workspaceId: ready.id, fileId: ready.id }),
    ).resolves.toEqual(ready)
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      '/api/files/uploads',
      `/api/files/${ready.id}/complete`,
    ])
  })
})
