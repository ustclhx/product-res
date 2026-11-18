import { useEffect, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { PreviewSection, Specimen } from './layout.tsx'

/** 与设计稿副本 share-cards/Card.dc.html 的变体一一对应：中文、英文、长标题与默认分享图 × 浅色、深色。 */
const PREVIEWS = [
  ['zh', 'light'],
  ['zh', 'dark'],
  ['en', 'light'],
  ['en', 'dark'],
  ['long', 'light'],
  ['long', 'dark'],
  ['default', 'light'],
  ['default', 'dark'],
] as const

/**
 * 分享卡片预览（openspec add-og-images 6.1）：图片由 /api/dev/share-card-preview 用真实渲染器生成。
 * 渲染器同一实例并发上限为 2，这里逐张加载，忙时稍后重试。
 */
export function ShareCardsSection() {
  // 水合后才开始加载：服务端输出的图片若在水合前加载完成，onLoad 不会触发，后续图片会一直等待。
  const [loaded, setLoaded] = useState(-1)
  useEffect(() => setLoaded(0), [])
  return (
    <PreviewSection
      id="share-cards"
      title="Share cards"
      description={m.ui_preview_share_cards_desc()}
    >
      {PREVIEWS.map(([variant, mode], index) => (
        <Specimen key={`${variant}-${mode}`} label={`${variant} · ${mode}`} className="block p-0">
          <PreviewImage
            variant={variant}
            mode={mode}
            active={index <= loaded}
            onLoad={() => setLoaded((count) => Math.max(count, index + 1))}
          />
        </Specimen>
      ))}
    </PreviewSection>
  )
}

function PreviewImage({
  variant,
  mode,
  active,
  onLoad,
}: {
  readonly variant: string
  readonly mode: string
  readonly active: boolean
  readonly onLoad: () => void
}) {
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!failed) return
    const timer = setTimeout(() => {
      setFailed(false)
      setAttempt((value) => value + 1)
    }, 1000)
    return () => clearTimeout(timer)
  }, [failed])
  const src = `/api/dev/share-card-preview?variant=${variant}&mode=${mode}${attempt ? `&attempt=${attempt}` : ''}`
  return (
    <img
      data-share-card-preview={`${variant}-${mode}`}
      src={active && !failed ? src : undefined}
      width={1200}
      height={630}
      alt={m.ui_preview_share_cards_alt({ variant, mode })}
      className="block h-auto w-full rounded-xl bg-muted"
      onLoad={onLoad}
      onError={() => {
        if (attempt < 5) setFailed(true)
      }}
    />
  )
}
