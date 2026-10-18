import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from 'react-email'
import type { EmailLocale } from './locale.ts'
import type { EmailCopy } from './messages.ts'

/**
 * 所有认证 / 邀请邮件共用的布局。只用内联样式（不用 Tailwind 组件），
 * 保证各邮件客户端显示一致，也避免把 tailwindcss 打进 Worker 包。
 */
export function EmailLayout({
  copy,
  locale,
  appName,
}: {
  copy: EmailCopy
  locale: EmailLocale
  appName: string
}) {
  const lang = locale === 'zh' ? 'zh-CN' : 'en'
  return (
    <Html lang={lang}>
      <Head>
        <title>{copy.subject}</title>
      </Head>
      <Preview useTitleTag={false}>{copy.preview}</Preview>
      <Body lang={lang} style={styles.body}>
        <Container style={styles.container}>
          <Text style={styles.brand}>{appName}</Text>
          <Heading as="h1" style={styles.heading}>
            {copy.heading}
          </Heading>
          <Text style={styles.text}>{copy.greeting}</Text>
          {copy.paragraphs.map((paragraph) => (
            <Text key={paragraph} style={styles.text}>
              {paragraph}
            </Text>
          ))}
          {copy.code === undefined ? null : (
            <Section style={styles.codeBox}>
              <Text style={styles.code}>{copy.code}</Text>
            </Section>
          )}
          {copy.action === undefined ? null : (
            <>
              <Section style={styles.actionBox}>
                <Button href={copy.action.url} style={styles.button}>
                  {copy.action.label}
                </Button>
              </Section>
              <Text style={styles.muted}>{copy.linkHint}</Text>
              <Link href={copy.action.url} style={styles.link}>
                {copy.action.url}
              </Link>
            </>
          )}
          <Hr style={styles.hr} />
          <Text style={styles.muted}>{copy.footer}</Text>
        </Container>
      </Body>
    </Html>
  )
}

const fontFamily =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif'

const styles = {
  body: { backgroundColor: '#f4f4f5', fontFamily, margin: 0, padding: '24px 0' },
  container: {
    backgroundColor: '#ffffff',
    borderRadius: '8px',
    margin: '0 auto',
    maxWidth: '480px',
    padding: '32px',
  },
  brand: { color: '#18181b', fontSize: '16px', fontWeight: 600, margin: '0 0 24px' },
  heading: { color: '#18181b', fontSize: '22px', fontWeight: 600, margin: '0 0 16px' },
  text: { color: '#3f3f46', fontSize: '15px', lineHeight: '24px', margin: '0 0 12px' },
  codeBox: { backgroundColor: '#f4f4f5', borderRadius: '6px', margin: '16px 0', padding: '12px' },
  code: {
    color: '#18181b',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '28px',
    fontWeight: 600,
    letterSpacing: '6px',
    margin: 0,
    textAlign: 'center' as const,
  },
  actionBox: { margin: '24px 0' },
  button: {
    backgroundColor: '#18181b',
    borderRadius: '6px',
    color: '#ffffff',
    fontSize: '15px',
    fontWeight: 600,
    padding: '12px 20px',
    textDecoration: 'none',
  },
  link: { color: '#2563eb', fontSize: '13px', wordBreak: 'break-all' as const },
  hr: { borderColor: '#e4e4e7', margin: '24px 0' },
  muted: { color: '#71717a', fontSize: '13px', lineHeight: '20px', margin: '0 0 8px' },
}
