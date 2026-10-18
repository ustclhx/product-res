// 由目标入口显式注册，避免加载中立 handlers 时给关闭 AI 的 Node 项目安装处理器。
import { chatHoldSweeper, mediaTaskHoldSweeper } from '@product-res/ai'
import { registerHoldSweeper } from '@product-res/billing'
import templateConfig from '../../../template.config.ts'

export function registerAiHoldSweepers(features: { text: boolean; media: boolean }) {
  const dispose: (() => void)[] = []
  if (features.text)
    dispose.push(
      registerHoldSweeper(
        'ai_message',
        chatHoldSweeper({ overage: templateConfig.billing.overage }),
      ),
    )
  if (features.media) dispose.push(registerHoldSweeper('ai_task', mediaTaskHoldSweeper()))
  return () => {
    for (const unregister of dispose) unregister()
  }
}
