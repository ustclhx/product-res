import { Button, DataTable, Input, Label } from '@product-res/ui'
import { createFileRoute, notFound, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { createKey, editKey, listKeys } from '../../../features/api-keys/functions.ts'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/app/$slug/api-keys')({
  validateSearch: (search: Record<string, unknown>) => ({
    page: Math.max(0, Math.floor(Number(search.page) || 0)),
  }),
  beforeLoad: () => {
    if (!templateConfig.billing.enabled || !templateConfig.features.publicApi) throw notFound()
  },
  loaderDeps: ({ search }) => ({ page: search.page }),
  loader: ({ params, deps }) => listKeys({ data: { slug: params.slug, page: deps.page } }),
  component: ApiKeysPage,
})

function ApiKeysPage() {
  const { slug } = Route.useParams()
  const { page } = Route.useSearch()
  const data = Route.useLoaderData()
  const navigate = Route.useNavigate()
  const router = useRouter()
  const [secret, setSecret] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  async function action(run: () => Promise<unknown>) {
    setPending(true)
    setError('')
    try {
      await run()
      await router.invalidate()
    } catch (error) {
      setError(error instanceof Error ? error.message : '操作失败')
    } finally {
      setPending(false)
    }
  }
  return (
    <section className="grid gap-6">
      <h2 className="text-xl font-semibold">API Keys</h2>
      <p>密钥仅在创建时显示完整值，请妥善保存。调用将使用当前空间的积分。</p>
      {error ? <p role="alert">{error}</p> : null}
      {secret ? (
        <div role="status" className="grid gap-2 rounded border p-4">
          <p>请立即保存，关闭后无法再次查看：</p>
          <code className="break-all">{secret}</code>
          <Button onClick={() => setSecret(null)}>已保存，关闭</Button>
        </div>
      ) : null}
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          const form = event.currentTarget
          const values = new FormData(form)
          const expires = String(values.get('expires') ?? '')
          setSecret(null)
          void action(async () => {
            const key = await createKey({
              data: {
                slug,
                name: String(values.get('name') ?? ''),
                ...(expires ? { expiresAt: new Date(expires).toISOString() } : {}),
              },
            })
            setSecret(key.key)
            form.reset()
          })
        }}
      >
        <Label htmlFor="key-name">名称</Label>
        <Input id="key-name" name="name" required maxLength={80} />
        <Label htmlFor="key-expires">过期时间（可选，本地时间）</Label>
        <Input id="key-expires" name="expires" type="datetime-local" />
        <Button disabled={pending} type="submit">
          创建密钥
        </Button>
      </form>
      <DataTable
        label="API Keys"
        rows={data.rows}
        getRowId={(row) => row.id}
        page={{ pageIndex: page, pageSize: 20, hasMore: data.hasMore }}
        onPageChange={(page) => {
          void navigate({ search: { page } })
        }}
        columns={[
          {
            id: 'name',
            header: '名称',
            cell: (row) => (
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  const name = String(new FormData(event.currentTarget).get('name') ?? '')
                  void action(() => editKey({ data: { slug, id: row.id, name } }))
                }}
              >
                <Input
                  name="name"
                  aria-label="密钥名称"
                  defaultValue={row.name ?? ''}
                  required
                  maxLength={80}
                />
                <Button disabled={pending} type="submit">
                  保存
                </Button>
              </form>
            ),
          },
          { id: 'prefix', header: '前缀', cell: (row) => <code>{row.start}…</code> },
          {
            id: 'expiry',
            header: '过期',
            cell: (row) => (row.expiresAt ? new Date(row.expiresAt).toLocaleString() : '永不过期'),
          },
          {
            id: 'status',
            header: '状态',
            cell: (row) =>
              !row.enabled
                ? '已撤销'
                : row.expiresAt && new Date(row.expiresAt) <= new Date()
                  ? '已过期'
                  : '有效',
          },
          {
            id: 'revoke',
            header: '操作',
            cell: (row) => (
              <Button
                disabled={pending || !row.enabled}
                variant="destructive"
                onClick={() => {
                  void action(() => editKey({ data: { slug, id: row.id, revoke: true } }))
                }}
              >
                撤销
              </Button>
            ),
          },
        ]}
      />
    </section>
  )
}
