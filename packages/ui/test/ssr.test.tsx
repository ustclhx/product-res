// @vitest-environment node
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Separator,
  useAppForm,
} from '../src/index.ts'

// 组件在服务端渲染（TanStack Start 的 SSR）时输出带 Tailwind 类名的 HTML，不依赖浏览器 API
describe('SSR', () => {
  it('Button 按变体输出类名，asChild 时渲染子元素', () => {
    const html = renderToString(
      <>
        <Button>Save</Button>
        <Button variant="outline" size="sm">
          Cancel
        </Button>
        <Button asChild variant="link">
          <a href="/login">Sign in</a>
        </Button>
      </>,
    )
    expect(html).toContain('<button data-slot="button" class="')
    expect(html).toMatch(/<button[^>]*class="[^"]*bg-primary[^"]*"[^>]*>Save<\/button>/)
    expect(html).toMatch(/<button[^>]*class="[^"]*border[^"]*h-8[^"]*"[^>]*>Cancel<\/button>/)
    expect(html).toMatch(/<a href="\/login"[^>]*class="[^"]*underline-offset-4/)
  })

  it('Card / Alert / Input / Label / Separator 输出语义化标签与类名', () => {
    const html = renderToString(
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Title</h2>
          </CardTitle>
          <CardDescription>Description</CardDescription>
        </CardHeader>
        <CardContent>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" />
          <Separator />
          <Alert variant="destructive">
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>Something went wrong</AlertDescription>
          </Alert>
        </CardContent>
        <CardFooter>Footer</CardFooter>
      </Card>,
    )
    expect(html).toMatch(/<div data-slot="card" class="[^"]*rounded-xl[^"]*bg-card/)
    expect(html).toMatch(
      /<div data-slot="card-title" class="[^"]*font-semibold[^"]*"><h2>Title<\/h2>/,
    )
    expect(html).toMatch(/<label[^>]*class="[^"]*text-sm[^"]*"[^>]*for="email"/)
    expect(html).toMatch(/<input[^>]*type="email"[^>]*class="[^"]*border-input/)
    expect(html).toMatch(/data-slot="separator"[^>]*class="[^"]*bg-border/)
    expect(html).toMatch(/<div data-slot="alert" role="alert" class="[^"]*text-destructive/)
  })

  it('表单封装在 SSR 下渲染字段与提交按钮，初始不显示错误', () => {
    function Example() {
      const form = useAppForm({
        defaultValues: { email: '' },
        validators: { onSubmit: z.object({ email: z.email('Enter a valid email') }) },
      })
      return (
        <form.AppForm>
          <form.Form>
            <form.AppField name="email">
              {(field) => <field.TextField label="Email" type="email" />}
            </form.AppField>
            <form.SubmitButton>Continue</form.SubmitButton>
          </form.Form>
        </form.AppForm>
      )
    }
    const html = renderToString(<Example />)
    expect(html).toMatch(/<form novalidate="" class="grid gap-4">/i)
    expect(html).toMatch(/<input[^>]*name="email"[^>]*value=""/)
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Continue<\/button>/)
    expect(html).not.toContain('Enter a valid email')
  })
})
