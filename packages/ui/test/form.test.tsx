import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { errorMessages, useAppForm } from '../src/index.ts'

afterEach(cleanup)

const schema = z.object({
  email: z.email('Enter a valid email'),
  password: z.string().min(8, 'At least 8 characters'),
})

function SignInForm({ onSubmit }: { onSubmit: (value: z.infer<typeof schema>) => Promise<void> }) {
  const form = useAppForm({
    defaultValues: { email: '', password: '' },
    validators: { onBlur: schema, onSubmit: schema },
    onSubmit: ({ value }) => onSubmit(value),
  })
  return (
    <form.AppForm>
      <form.Form aria-label="sign in">
        <form.AppField name="email">
          {(field) => <field.TextField label="Email" type="email" />}
        </form.AppField>
        <form.AppField name="password">
          {(field) => <field.TextField label="Password" type="password" />}
        </form.AppField>
        <form.SubmitButton pendingLabel="Signing in…">Sign in</form.SubmitButton>
      </form.Form>
    </form.AppForm>
  )
}

describe('表单封装（TanStack Form + Zod）', () => {
  it('提交非法值时按字段显示 Zod 错误，且不调用 onSubmit', async () => {
    const onSubmit = vi.fn(async () => {})
    render(<SignInForm onSubmit={onSubmit} />)
    await act(async () => {
      fireEvent.submit(screen.getByRole('form', { name: 'sign in' }))
    })
    expect(await screen.findByText('Enter a valid email')).toBeTruthy()
    expect(screen.getByText('At least 8 characters')).toBeTruthy()
    const email = screen.getByLabelText('Email')
    expect(email.getAttribute('aria-invalid')).toBe('true')
    // 错误通过 aria-describedby 与输入框关联
    const describedBy = email.getAttribute('aria-describedby') ?? ''
    expect(document.getElementById(describedBy)?.textContent).toBe('Enter a valid email')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('合法值提交时调用 onSubmit，提交中按钮禁用并显示 pendingLabel', async () => {
    let resolve: () => void = () => {}
    const onSubmit = vi.fn(() => new Promise<void>((r) => (resolve = r)))
    render(<SignInForm onSubmit={onSubmit} />)
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } })
    await act(async () => {
      fireEvent.submit(screen.getByRole('form', { name: 'sign in' }))
    })
    expect(onSubmit).toHaveBeenCalledWith({ email: 'a@example.com', password: 'password123' })
    const button = screen.getByRole('button')
    expect(button.textContent).toBe('Signing in…')
    expect((button as HTMLButtonElement).disabled).toBe(true)
    await act(async () => resolve())
    expect(button.textContent).toBe('Sign in')
    expect((button as HTMLButtonElement).disabled).toBe(false)
  })

  it('失焦时校验已触碰的字段，未触碰的字段不显示错误', async () => {
    render(<SignInForm onSubmit={async () => {}} />)
    const email = screen.getByLabelText('Email')
    fireEvent.change(email, { target: { value: 'not-an-email' } })
    await act(async () => {
      fireEvent.blur(email)
    })
    expect(await screen.findByText('Enter a valid email')).toBeTruthy()
    expect(screen.queryByText('At least 8 characters')).toBeNull()
  })

  it('其他字段失焦后，正在输入、尚未失焦的字段不提前显示错误', async () => {
    render(<SignInForm onSubmit={async () => {}} />)
    const email = screen.getByLabelText('Email')
    fireEvent.change(email, { target: { value: 'a@example.com' } })
    await act(async () => {
      fireEvent.blur(email)
    })
    // 表单级失焦校验已为 password 写入错误，但 password 尚未失焦
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } })
    expect(screen.queryByText('At least 8 characters')).toBeNull()
  })

  it('已显示的错误在输入修正后立即消失，不等到失焦', async () => {
    render(<SignInForm onSubmit={async () => {}} />)
    const password = screen.getByLabelText('Password')
    fireEvent.change(password, { target: { value: 'short' } })
    await act(async () => {
      fireEvent.blur(password)
    })
    expect(screen.getByText('At least 8 characters')).toBeTruthy()
    await act(async () => {
      fireEvent.change(password, { target: { value: 'password123' } })
    })
    expect(screen.queryByText('At least 8 characters')).toBeNull()
  })

  it('按下提交按钮引起的失焦不做失焦校验，交给提交统一校验', async () => {
    const onSubmit = vi.fn(async () => {})
    render(<SignInForm onSubmit={onSubmit} />)
    const password = screen.getByLabelText('Password')
    fireEvent.change(password, { target: { value: 'short' } })
    fireEvent.pointerDown(screen.getByRole('button'))
    await act(async () => {
      fireEvent.blur(password)
    })
    expect(screen.queryByText('At least 8 characters')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button'))
    })
    expect(await screen.findByText('At least 8 characters')).toBeTruthy()
    expect(screen.getByText('Enter a valid email')).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('聚焦字段带着过期的失焦错误时，一次提交即按当前值校验并提交', async () => {
    const onSubmit = vi.fn(async () => {})
    render(<SignInForm onSubmit={onSubmit} />)
    const email = screen.getByLabelText('Email')
    const password = screen.getByLabelText('Password')
    fireEvent.change(email, { target: { value: 'a@example.com' } })
    // email 失焦时表单级校验为空的 password 写入错误；随后修正 password 并直接按下提交
    await act(async () => {
      fireEvent.blur(email)
    })
    fireEvent.change(password, { target: { value: 'password123' } })
    fireEvent.pointerDown(screen.getByRole('button'))
    await act(async () => {
      fireEvent.blur(password)
      fireEvent.click(screen.getByRole('button'))
    })
    expect(onSubmit).toHaveBeenCalledWith({ email: 'a@example.com', password: 'password123' })
  })

  it('errorMessages 取 issue 的 message 并去重', () => {
    expect(errorMessages(['a', { message: 'b' }, { message: 'a' }, null, { message: 1 }])).toEqual([
      'a',
      'b',
    ])
  })
})
