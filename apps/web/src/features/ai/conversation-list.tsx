import { Button, Input, Label } from '@product-res/ui'
import { Link, useNavigate, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { FormAlert } from '../auth/auth-layout.tsx'
import { HydratedControls } from '../workspace/components.tsx'
import { CONVERSATION_TITLE_LENGTH, conversationTitle } from './conversation.ts'
import {
  createConversation,
  type listConversations,
  renameConversation,
  setConversationArchived,
} from './conversations.functions.ts'

type ConversationListPage = Awaited<ReturnType<typeof listConversations>>
type ConversationItem = ConversationListPage['active'][number]

const LIST_ERRORS: Record<string, () => string> = {
  WORKSPACE_READ_ONLY: () => m.conversation_error_workspace_read_only(),
  NOT_FOUND: () => m.conversation_error_not_found(),
}
const listError = (code: string) => LIST_ERRORS[code]?.() ?? m.conversation_error_unknown()

/** 对话列表（tasks.md 3.1）：新建、重命名、归档 / 取消归档；只列出当前用户自己的对话 */
export function ConversationList({ slug, page }: { slug: string; page: ConversationListPage }) {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function create() {
    setPending(true)
    setError(null)
    const result = await createConversation({ data: { slug } })
    if (!result.ok) {
      setError(listError(result.error))
      setPending(false)
      return
    }
    await navigate({
      to: '/app/$slug/chat/$conversationId',
      params: { slug, conversationId: result.result.id },
    })
  }

  return (
    <HydratedControls>
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-2xl font-semibold">Chats</h2>
        <Button disabled={pending || page.readOnly} onClick={() => void create()}>
          New chat
        </Button>
      </div>
      <FormAlert message={error} />
      <section className="grid gap-3" aria-label="Conversations">
        {page.active.length === 0 ? <p>No conversations yet.</p> : null}
        <ul className="grid gap-2">
          {page.active.map((item) => (
            <ConversationRow
              key={item.id}
              slug={slug}
              item={item}
              readOnly={page.readOnly}
              onError={setError}
            />
          ))}
        </ul>
      </section>
      {page.archived.length > 0 ? (
        <section className="grid gap-3" aria-label="Archived conversations">
          <h3 className="font-semibold">Archived</h3>
          <ul className="grid gap-2">
            {page.archived.map((item) => (
              <ConversationRow
                key={item.id}
                slug={slug}
                item={item}
                readOnly={page.readOnly}
                onError={setError}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </HydratedControls>
  )
}

function ConversationRow({
  slug,
  item,
  readOnly,
  onError,
}: {
  slug: string
  item: ConversationItem
  readOnly: boolean
  onError: (message: string | null) => void
}) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(item.title)
  const [pending, setPending] = useState(false)
  const name = conversationTitle(item.title)

  async function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setPending(true)
    onError(null)
    const result = await action()
    if (result.ok) {
      setEditing(false)
      await router.invalidate()
    } else onError(listError(result.error))
    setPending(false)
  }

  if (editing)
    return (
      <li>
        <form
          aria-label={`Rename ${name}`}
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            const next = title.trim()
            if (!next) return
            void run(() =>
              renameConversation({ data: { slug, conversationId: item.id, title: next } }),
            )
          }}
        >
          <p className="grid gap-1">
            <Label htmlFor={`title-${item.id}`}>Conversation title</Label>
            <Input
              id={`title-${item.id}`}
              value={title}
              maxLength={CONVERSATION_TITLE_LENGTH}
              onChange={(event) => setTitle(event.target.value)}
            />
          </p>
          <Button type="submit" disabled={pending || !title.trim()}>
            Save
          </Button>
          <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      </li>
    )

  return (
    <li className="flex flex-wrap items-center gap-2" aria-label={name}>
      <Link
        to="/app/$slug/chat/$conversationId"
        params={{ slug, conversationId: item.id }}
        className="mr-auto underline"
      >
        {name}
      </Link>
      {item.archived ? null : (
        <Button
          variant="outline"
          size="sm"
          disabled={pending || readOnly}
          onClick={() => {
            setTitle(item.title)
            setEditing(true)
          }}
        >
          Rename
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={pending || readOnly}
        onClick={() =>
          void run(() =>
            setConversationArchived({
              data: { slug, conversationId: item.id, archived: !item.archived },
            }),
          )
        }
      >
        {item.archived ? 'Unarchive' : 'Archive'}
      </Button>
    </li>
  )
}
