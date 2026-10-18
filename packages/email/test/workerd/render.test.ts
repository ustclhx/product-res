import { pretty } from 'react-email'
import { describe, expect, it } from 'vitest'
import { renderEmail } from '../../src/index.ts'
import { APP_NAME, fixtures, LOCALES, snapshotPath } from '../fixtures.ts'

// 在 workerd 中渲染（@react-email/render 走 workerd 导出条件，即 react-dom/server.edge），
// 结果与 Node 下生成的快照逐字节比对：队列消费者（apps/jobs）在 Worker 中渲染的邮件与快照一致。
describe.each(LOCALES)('templates in workerd (%s)', (locale) => {
  it.each(fixtures)('$template', async ({ template, props, recipientName }) => {
    const email = await renderEmail(template, props, { locale, appName: APP_NAME, recipientName })
    await expect(await pretty(email.html)).toMatchFileSnapshot(
      `.${snapshotPath(template, locale, 'html')}`,
    )
    await expect(email.text).toMatchFileSnapshot(`.${snapshotPath(template, locale, 'txt')}`)
  })
})
