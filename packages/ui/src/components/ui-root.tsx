// 来源：fluid-functionalism fluid-provider（2026-11，https://www.fluidfunctionalism.com/r/fluid-provider.json，MIT）
// 适配：改名 UiRoot，取值来自 template.config.ts 的 `ui` 段（openspec add-ui-design-system design D3）；
// 主题预设由根布局在 SSR 时写到 <html data-preset>，明暗切换沿用 theme.tsx，均不经过本组件。
import { MotionConfig } from 'motion/react'
import type { ReactNode } from 'react'
import { type IconComponent, type IconName, IconProvider } from '../lib/icon-context.tsx'
import { ShapeProvider, type ShapeVariant } from '../lib/shape-context.tsx'
import { SizeProvider, type SizeVariant } from '../lib/size-context.tsx'

export const UI_PRESETS = ['neutral', 'blue', 'violet', 'green'] as const
export type UiPreset = (typeof UI_PRESETS)[number]
export const UI_SHAPES = ['sharp', 'rounded', 'pill'] as const satisfies readonly ShapeVariant[]
export const UI_DENSITIES = ['default', 'compact'] as const satisfies readonly SizeVariant[]
export type UiDensity = (typeof UI_DENSITIES)[number]

export type UiRootProps = {
  children: ReactNode
  /** 所有组件的圆角形状，默认 rounded */
  shape?: ShapeVariant | undefined
  /** 控件尺寸阶梯：default 36px，compact 28px */
  density?: UiDensity | undefined
  /** 按槽位替换图标，省略的槽位保留 Lucide；请传模块级常量，避免每次渲染重建 */
  icons?: Partial<Record<IconName, IconComponent>> | undefined
}

/**
 * UI 根组件：在根布局中包裹一次，统一动效偏好、形状、尺寸与图标。
 * 系统开启「减少动态效果」时 MotionConfig 去掉位移与布局动画，只保留淡入淡出。
 */
export function UiRoot({ children, shape = 'rounded', density = 'default', icons }: UiRootProps) {
  return (
    <MotionConfig reducedMotion="user">
      {/* 受控：shape / density 变化立即生效（预览页运行时切换用） */}
      <ShapeProvider shape={shape}>
        <SizeProvider size={density}>
          <IconProvider {...(icons && { icons })}>{children}</IconProvider>
        </SizeProvider>
      </ShapeProvider>
    </MotionConfig>
  )
}
