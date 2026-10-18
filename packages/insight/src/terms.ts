/** 词云输入：差评中的高频词，每个词附出现它的评论 ID，界面可回看原文。 */
export interface ReviewTerm {
  term: string
  /** 出现该词的评论数（同一条评论只计一次） */
  count: number
  /** 最多 maxRefs 条评论 ID */
  reviewIds: string[]
}

// 英文停用词：只去掉常见虚词与评论套话，产品属性词保留
const STOPWORDS = new Set(
  (
    'the and for that this with was were are but not you your have has had they them its ' +
    "it's im i'm ive i've one all out get got just very really would could should will " +
    'from what when then than there their been being into also only even after before ' +
    "because about which while some any more most other over such too can cant can't " +
    "dont don't didnt didn't does doesnt doesn't did my me our we us him her his she he " +
    'who how why where much many again off down way well back use used using item product ' +
    'bought buy purchase purchased amazon star stars review like made make thing things ' +
    'first time times still now day days lol got gets'
  ).split(/\s+/),
)

const LATIN = /[a-z][a-z'-]{2,}/g
// 中日文没有空格分词，取 2–6 字的连续片段作为候选词，避免把整句当一个词
const CJK = /[一-鿿぀-ヿ]{2,6}/g

/** 统计差评标题与正文中的高频词。纯词频，不做语义归纳（语义主题由 AI 完成）。 */
export function reviewTerms(
  reviews: readonly { id: string; title?: string | null; body?: string | null }[],
  opts: { limit?: number; minCount?: number; maxRefs?: number } = {},
): ReviewTerm[] {
  const limit = opts.limit ?? 40
  const minCount = opts.minCount ?? 2
  const maxRefs = opts.maxRefs ?? 5
  const byTerm = new Map<string, string[]>()
  for (const r of reviews) {
    const text = `${r.title ?? ''} ${r.body ?? ''}`.toLowerCase()
    const seen = new Set<string>()
    for (const m of text.matchAll(LATIN)) {
      const word = m[0].replace(/^['-]+|['-]+$/g, '')
      if (word.length >= 3 && !STOPWORDS.has(word)) seen.add(word)
    }
    for (const m of text.matchAll(CJK)) seen.add(m[0])
    for (const term of seen) {
      const ids = byTerm.get(term) ?? []
      ids.push(r.id)
      byTerm.set(term, ids)
    }
  }
  return [...byTerm.entries()]
    .filter(([, ids]) => ids.length >= minCount)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term, ids]) => ({ term, count: ids.length, reviewIds: ids.slice(0, maxRefs) }))
}
