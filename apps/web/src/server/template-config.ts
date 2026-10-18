// 仓库根目录的 template.config.ts（docs/02-project-structure.md §3）。
// apps/web 中一律从这里读取模板配置，不直接引用根目录文件。
import templateConfig from '../../../../template.config.ts'

export { templateConfig }
