import { SubjectChat } from '../../src/features/ai/subject-chat.tsx'

// 嵌入式对话 e2e（add-ai-chat-components 5.2）专用：替换临时上下文页使用的组件，在页面中嵌入真实的 SubjectChat。
// 地址 `/app/$slug/chat/context?token=panel` 为 panel 变体，其余为默认的 inline。
export function TemporarySubjectChat({ slug, token }: { slug: string; token: string }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-semibold text-title">Quarterly operating report</h2>
      <p className="text-muted-foreground">
        New-customer growth slowed, retention improved and model costs rose as a share of revenue.
      </p>
      <SubjectChat
        slug={slug}
        subjectType="e2e-note"
        subjectId="report-1"
        variant={token === 'panel' ? 'panel' : 'inline'}
      />
      {/* 宿主页面比视口高：嵌入式对话挂载或切换历史时不能滚动宿主页面 */}
      <div aria-hidden style={{ height: '150vh' }} />
    </section>
  )
}
