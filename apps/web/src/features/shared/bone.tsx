import { cn } from '@product-res/ui'

/** 加载骨架块：定价页与账单页共用，尺寸由调用方的 token 工具类决定 */
export function Bone({ className }: { className: string }) {
  return <span className={cn('block animate-pulse rounded-md bg-active', className)} />
}
