// 首页 SEO 文案（标题、描述）：staticPage('/') 与分享卡片默认分享图副标题共用。
// 独立成小模块，分享卡片版式只依赖这里，不把 metadata.ts 拉进分享卡片的服务端模块图。
export function homePageCopy(locale: string): [title: string, description: string] {
  return locale === 'zh'
    ? ['AI 工作空间', '在一个工作空间中使用 AI 对话、创作与团队协作。']
    : ['Your AI workspace', 'AI conversations, creation and team collaboration in one workspace.']
}
