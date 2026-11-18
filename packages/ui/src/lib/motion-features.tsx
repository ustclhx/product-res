// 模板新增（openspec add-ui-design-system design「Risks」：motion 按需导入）：组件用 `m.*` 代替 `motion.*`，
// 动画能力由这里的 LazyMotion 按 domAnimation（动画、退场、手势，不含 layout 与拖拽）提供。
// 每个用到动效的组件在自己的根节点包一层，而不是放进根布局的 UiRoot：这样 domAnimation 只随交互组件
// 进入 app/admin 页面的包，首页不加载。嵌套的 LazyMotion 开销可忽略。
// 组件文件从 motion/react 导入 `m as motion`，JSX 仍写 `<motion.div>`，与上游源码的差异只在导入行。
import { domAnimation, LazyMotion } from 'motion/react'
import type { ReactNode } from 'react'

export function MotionFeatures({ children }: { children: ReactNode }) {
  return <LazyMotion features={domAnimation}>{children}</LazyMotion>
}
