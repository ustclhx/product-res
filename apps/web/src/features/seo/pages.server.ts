import { allDocs, allLegalPages, allPosts } from 'content-collections'
import { publicPages } from './pages.ts'

export function getPublicPages() {
  return publicPages({ posts: allPosts, legal: allLegalPages, docs: allDocs })
}
