import { createFileRoute } from '@tanstack/react-router'
import { MediaTasksPage } from '../../../../features/ai-media/tasks-page.tsx'
import { m } from '../../../../paraglide/messages.js'

export const Route = createFileRoute('/app/$slug/tasks/')({
  head: () => ({ meta: [{ title: m.media_tasks_title() }] }),
  component: TasksPage,
})

function TasksPage() {
  const { workspacePage } = Route.useRouteContext()
  return <MediaTasksPage key={workspacePage.workspace.id} page={workspacePage} />
}
