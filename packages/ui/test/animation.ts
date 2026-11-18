import { act, waitFor } from '@testing-library/react'

export const frame = () =>
  act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))))

// 逐帧刷新 React 更新并重试断言，避免 CI 调度延迟让固定帧数或时长的采样失效。
export const waitForAnimation = (assertion: () => void) =>
  waitFor(
    async () => {
      await frame()
      assertion()
    },
    { timeout: 2000 },
  )
