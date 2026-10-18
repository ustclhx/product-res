import { createFileRoute } from '@tanstack/react-router'
import { MediaTaskDetailPage } from '../../../../features/ai-media/tasks-page.tsx'
import { m } from '../../../../paraglide/messages.js'

export const Route = createFileRoute('/app/$slug/tasks/$taskId')({
  head: () => ({ meta: [{ title: m.media_tasks_detail() }] }),
  component: TaskDetail,
})

function TaskDetail() {
  const { workspacePage } = Route.useRouteContext()
  const { taskId } = Route.useParams()
  return (
    <MediaTaskDetailPage
      key={`${workspacePage.workspace.id}:${taskId}`}
      page={workspacePage}
      taskId={taskId}
    />
  )
}
