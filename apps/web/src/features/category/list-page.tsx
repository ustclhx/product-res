import { Button, Input, Tag } from '@product-res/ui'
import { Link, useNavigate } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { Section } from '../data-center/shared.tsx'
import {
  DIRECTION_MARKETPLACES,
  type DirectionMarketplace,
  MARKETPLACE_LABELS,
  marketplaceLabel,
  splitList,
} from '../follow/marketplaces.ts'
import {
  controlClass,
  EmptyState,
  ErrorText,
  Field,
  ReadOnlyNotice,
  useAction,
} from '../workbench/fields.tsx'
import {
  archiveCategoryStudy,
  createCategoryStudy,
  getCategoryStudies,
} from './category.functions.ts'
import type { StudyRow } from './category.server.ts'
import { fmtDateTime } from './format.ts'

export type StudiesData = Awaited<ReturnType<typeof getCategoryStudies>>

/** 品类研究列表与新建（tasks 3.1） */
export function CategoryListPage({ slug, initial }: { slug: string; initial: StudiesData }) {
  const [data, setData] = useState(initial)
  const [creating, setCreating] = useState(false)
  const reload = async () => setData(await getCategoryStudies({ data: { slug } }))
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="grid gap-1">
          <nav className="text-xs text-muted-foreground">
            <span>品牌选品</span>
            <span className="px-1">/</span>
            <span>品类洞察</span>
          </nav>
          <h1 className="text-lg font-semibold">品类洞察</h1>
          <p className="text-[13px] text-muted-foreground">
            按平台站点 +
            类目或关键词建立研究，汇总搜索趋势、新品、价格带、头部集中度、竞品矩阵与差评痛点。
            每次刷新保存一份快照，历史快照可切换查看。
          </p>
        </div>
        {data.canWrite && !creating ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            新建研究
          </Button>
        ) : null}
      </div>
      <ReadOnlyNotice show={!data.canWrite} />
      {creating ? <StudyForm slug={slug} onClose={() => setCreating(false)} /> : null}
      {data.active.length === 0 && !creating ? (
        <EmptyState title="还没有品类研究">
          {data.canWrite
            ? '新建一份研究，选择平台站点并填写类目 ID 或关键词，系统会用已有市场数据生成报告。'
            : '空间所有者或管理员新建研究后，这里会列出报告。'}
        </EmptyState>
      ) : null}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {data.active.map((s) => (
          <StudyCard key={s.id} slug={slug} study={s} />
        ))}
      </div>
      {data.archived.length > 0 ? (
        <Section title={`已归档（${data.archived.length}）`}>
          <ul className="grid gap-2">
            {data.archived.map((s) => (
              <ArchivedRow
                key={s.id}
                slug={slug}
                study={s}
                canWrite={data.canWrite}
                onChanged={reload}
              />
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  )
}

function Chips({ items }: { items: readonly string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {items.map((i) => (
        <span key={i} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {i}
        </span>
      ))}
    </span>
  )
}

function StudyCard({ slug, study }: { slug: string; study: StudyRow }) {
  return (
    <Link
      to="/app/$slug/category/$studyId"
      params={{ slug, studyId: study.id }}
      search={{}}
      data-testid="study-card"
      className="grid content-start gap-2 rounded-xl border bg-card p-4 shadow-xs transition-colors hover:border-primary"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{study.name}</span>
        <Tag tone="info">{marketplaceLabel(study.marketplace)}</Tag>
      </div>
      {study.categoryIds.length ? (
        <Chips items={study.categoryIds.map((c) => `类目 ${c}`)} />
      ) : null}
      {study.keywords.length ? <Chips items={study.keywords} /> : null}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {study.snapshotCount} 份快照 · 最近 {fmtDateTime(study.latestSnapshotAt)}
        </span>
        <span className="text-primary">查看报告 →</span>
      </div>
    </Link>
  )
}

function ArchivedRow({
  slug,
  study,
  canWrite,
  onChanged,
}: {
  slug: string
  study: StudyRow
  canWrite: boolean
  onChanged: () => Promise<void>
}) {
  const { busy, error, run } = useAction(onChanged)
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
      <Link
        to="/app/$slug/category/$studyId"
        params={{ slug, studyId: study.id }}
        search={{}}
        className="hover:text-primary"
      >
        {study.name}
        <span className="ml-2 text-xs text-muted-foreground">
          {marketplaceLabel(study.marketplace)} · {study.snapshotCount} 份快照
        </span>
      </Link>
      {canWrite ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            run(() => archiveCategoryStudy({ data: { slug, id: study.id, archived: false } }))
          }
        >
          取消归档
        </Button>
      ) : null}
      <ErrorText>{error}</ErrorText>
    </li>
  )
}

function StudyForm({ slug, onClose }: { slug: string; onClose: () => void }) {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [marketplace, setMarketplace] = useState<DirectionMarketplace>('amazon-us')
  const [categories, setCategories] = useState('')
  const [keywords, setKeywords] = useState('')
  const [topN, setTopN] = useState('20')
  const [createdId, setCreatedId] = useState('')
  const { busy, error, setError, run } = useAction(async () => {})

  async function submit(e: FormEvent) {
    e.preventDefault()
    const categoryIds = splitList(categories)
    const keywordList = splitList(keywords)
    const n = Number(topN)
    if (!name.trim()) return setError('请填写研究名称')
    if (categoryIds.length === 0 && keywordList.length === 0)
      return setError('至少填写一个类目 ID 或关键词')
    if (!Number.isInteger(n) || n < 1 || n > 100) return setError('头部 N 取 1–100')
    let id = ''
    const ok = await run(async () => {
      id = (
        await createCategoryStudy({
          data: {
            slug,
            study: { name, marketplace, categoryIds, keywords: keywordList, topN: n },
          },
        })
      ).id
    })
    if (ok) {
      setCreatedId(id)
      await navigate({
        to: '/app/$slug/category/$studyId',
        params: { slug, studyId: id },
        search: {},
      })
    }
  }

  return (
    <Section title="新建品类研究">
      <form className="grid gap-3" onSubmit={submit} aria-label="品类研究">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="研究名称">
            {(id) => (
              <Input
                id={id}
                className="h-8 text-[13px]"
                value={name}
                maxLength={64}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field label="平台站点">
            {(id) => (
              <select
                id={id}
                className={controlClass}
                value={marketplace}
                onChange={(e) => setMarketplace(e.target.value as DirectionMarketplace)}
              >
                {DIRECTION_MARKETPLACES.map((m) => (
                  <option key={m} value={m}>
                    {MARKETPLACE_LABELS[m]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="头部 N" hint="竞品矩阵展示的商品数">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                max={100}
                className="h-8 text-[13px]"
                value={topN}
                onChange={(e) => setTopN(e.target.value)}
              />
            )}
          </Field>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="类目 ID" hint="平台类目 ID，多个用逗号分隔">
            {(id) => (
              <Input
                id={id}
                className="h-8 text-[13px]"
                value={categories}
                onChange={(e) => setCategories(e.target.value)}
              />
            )}
          </Field>
          <Field label="关键词" hint="每行一个或逗号分隔；用于搜索量与标题匹配">
            {(id) => (
              <textarea
                id={id}
                rows={2}
                className={`${controlClass} h-auto py-1.5`}
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
              />
            )}
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">
          创建后立即生成第一份报告：只读取已有市场数据，不发起外部采集；有差评数据且配置了文本模型时会调用
          AI 归纳痛点，计入积分用量。
        </p>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" size="sm" disabled={busy || Boolean(createdId)}>
            {busy ? '生成报告中…' : '创建并生成报告'}
          </Button>
        </div>
      </form>
    </Section>
  )
}
