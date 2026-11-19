// 来源：fluid-functionalism utils（2026-11，https://www.fluidfunctionalism.com/r/utils.json，MIT）
// 适配：保留模板原有的 cn 签名；类型阶梯类名清单与上游一致。
import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// 类型阶梯工具类（text-body 等）是字号，但 tailwind-merge 默认把未知的 text-<词> 当作颜色，
// cn('text-body', 'text-muted-foreground') 会静默丢掉字号，因此登记为 font-size 组。
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        'text-display',
        'text-title',
        'text-subtitle',
        'text-body',
        'text-caption',
        'text-micro',
      ],
    },
  },
})

/** 合并类名，后出现的 Tailwind 类覆盖冲突的前者（shadcn/ui 约定） */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
