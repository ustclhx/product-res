import { createElement } from 'react'
import { templateConfig } from '../../server/template-config.ts'

/** 构建卡片直接使用内容标题，完整字体不进入 Worker 包。 */
export function OgCard({ title }: { title: string }) {
  return createElement(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        width: '100%',
        height: '100%',
        padding: 72,
        color: '#f8fafc',
        background: 'linear-gradient(135deg, #0f172a, #312e81)',
        fontFamily: 'Noto Sans SC',
      },
    },
    createElement('div', { style: { display: 'flex', fontSize: 36 } }, templateConfig.app.name),
    createElement(
      'div',
      { style: { display: 'flex', fontSize: 64, lineHeight: 1.25, overflow: 'hidden' } },
      title,
    ),
    createElement(
      'div',
      { style: { display: 'flex', fontSize: 24, color: '#c7d2fe' } },
      `${templateConfig.app.name} · AI workspace`,
    ),
  )
}
