import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  type ShapeVariant,
  UI_DENSITIES,
  UI_PRESETS,
  UI_SHAPES,
  type UiDensity,
  type UiPreset,
  UiRoot,
} from '@product-res/ui'
import { lazy, Suspense, useEffect, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { templateConfig } from '../../server/template-config.ts'
import { ThemeToggle } from '../theme/theme-toggle.tsx'
import { MarketingSection } from './section-marketing.tsx'
import { ShareCardsSection } from './section-share-cards.tsx'
import {
  BadgeTooltipSection,
  ButtonSection,
  ChoiceSection,
  DataTableSection,
  DialogSection,
  FieldsSection,
  FormSection,
  SelectSection,
  SurfaceSection,
} from './sections-basic.tsx'
import { AiChatComponentsSection, CreditsComponentsSection } from './sections-business.tsx'
import {
  ComboboxSection,
  CommandMenuSection,
  DropdownSection,
  SidebarSection,
  TabsSection,
  ToastSection,
} from './sections-overlay.tsx'

// 阅读器依赖 react-markdown 等较重的库，按文档约定的方式懒加载（@product-res/ui/reader 子路径形成独立分包）
const ReaderSection = lazy(() =>
  import('./section-reader.tsx').then((module) => ({ default: module.ReaderSection })),
)
// 对话组件同理：@product-res/ui/chat 含回复 Markdown（react-markdown），懒加载形成独立分包
const ChatComponentsSection = lazy(() =>
  import('./section-chat.tsx').then((module) => ({ default: module.ChatComponentsSection })),
)

/** 目录顺序与页面各节一致（锚点 id → 标题） */
const SECTIONS = [
  ['button', 'Button'],
  ['fields', 'Input'],
  ['select', 'Select'],
  ['combobox', 'Combobox'],
  ['choice', 'Checkbox · Switch'],
  ['badge', 'Badge · Tooltip'],
  ['tabs', 'Tabs'],
  ['dropdown', 'Dropdown'],
  ['command-menu', 'Command Menu'],
  ['dialog', 'Dialog · Popover · Sheet'],
  ['toast', 'Toast'],
  ['sidebar', 'Sidebar'],
  ['surface', 'Card · Alert'],
  ['data-table', 'DataTable'],
  ['form', 'Form'],
  ['reader', 'Reader'],
  ['chat', 'ChatMessage · ThinkingSteps · ToolCall · InputMessage · ChatMarkdown'],
  ['business-chat', 'SuggestionChips · MessageFeedback · EmbeddedChat'],
  [
    'business-credits',
    'InsufficientCreditsDialog · CreditEstimate · LockedFeature · DailyClaimNotice',
  ],
  ['marketing', 'Marketing blocks'],
  ['share-cards', 'Share cards'],
] as const

/**
 * 组件预览页（openspec add-ui-design-system design D6）：按组件分节展示 `@product-res/ui` 全部共享组件的变体与状态，
 * 顶部运行时切换预设、明暗、shape 与 density。预设写在 `<html data-preset>`（离开页面时还原为模板配置），
 * shape / density 用嵌套的受控 `UiRoot` 只作用于本页内容；明暗沿用全站的 ThemeToggle。
 */
export function UiPreviewPage() {
  const [preset, setPreset] = useState<UiPreset>(templateConfig.ui.preset)
  const [shape, setShape] = useState<ShapeVariant>(templateConfig.ui.shape)
  const [density, setDensity] = useState<UiDensity>(templateConfig.ui.density)

  // 先记下 SSR 写入的预设，离开页面时还原；再随选择写入 <html data-preset>
  useEffect(() => {
    const root = document.documentElement
    const initial = root.dataset.preset
    return () => {
      if (initial) root.dataset.preset = initial
    }
  }, [])
  useEffect(() => {
    document.documentElement.dataset.preset = preset
  }, [preset])

  return (
    <UiRoot shape={shape} density={density}>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-8 sm:px-6">
        <header className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="font-semibold text-title">{m.ui_preview_title()}</h1>
            <p className="max-w-prose text-body text-muted-foreground">{m.ui_preview_intro()}</p>
          </div>
          <fieldset className="m-0 flex flex-wrap items-end gap-3 border-0 p-0">
            <legend className="sr-only">{m.ui_preview_controls()}</legend>
            <PreviewOption
              label={m.ui_preview_preset()}
              value={preset}
              options={UI_PRESETS}
              onChange={setPreset}
            />
            <PreviewOption
              label={m.ui_preview_shape()}
              value={shape}
              options={UI_SHAPES}
              onChange={setShape}
            />
            <PreviewOption
              label={m.ui_preview_density()}
              value={density}
              options={UI_DENSITIES}
              onChange={setDensity}
            />
            <div className="flex flex-col gap-1.5">
              <span className="text-caption text-muted-foreground">{m.ui_preview_mode()}</span>
              <ThemeToggle />
            </div>
          </fieldset>
          <nav aria-label={m.ui_preview_contents()}>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-body">
              {SECTIONS.map(([id, title]) => (
                <li key={id}>
                  <a
                    href={`#${id}`}
                    className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  >
                    {title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </header>
        <ButtonSection />
        <FieldsSection />
        <SelectSection />
        <ComboboxSection />
        <ChoiceSection />
        <BadgeTooltipSection />
        <TabsSection />
        <DropdownSection />
        <CommandMenuSection />
        <DialogSection />
        <ToastSection />
        <SidebarSection />
        <SurfaceSection />
        <DataTableSection />
        <FormSection />
        <Suspense fallback={null}>
          <ReaderSection />
        </Suspense>
        <Suspense fallback={null}>
          <ChatComponentsSection />
        </Suspense>
        <AiChatComponentsSection />
        <CreditsComponentsSection />
        <MarketingSection />
        <ShareCardsSection />
      </div>
    </UiRoot>
  )
}

function PreviewOption<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string
  readonly value: T
  readonly options: readonly T[]
  readonly onChange: (value: T) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-caption text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={(next) => onChange(next as T)}>
        <SelectTrigger className="w-36" aria-label={label} placeholder={label} />
        <SelectContent>
          {options.map((option, index) => (
            <SelectItem key={option} index={index} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
