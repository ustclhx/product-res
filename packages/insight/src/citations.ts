export interface Cited {
  citations: readonly string[]
}

export interface CitationFilterResult<T extends Cited> {
  /** 至少保留一条有效引用的建议，引用只保留有效 ID */
  kept: (Omit<T, 'citations'> & { citations: string[] })[]
  dropped: T[]
}

/** 丢弃没有任何有效引用的 AI 建议；有效引用 = 在可引用 ID 集合内（评论 ID 或竞品 ID）。 */
export function keepCitedSuggestions<T extends Cited>(
  suggestions: readonly T[],
  validIds: ReadonlySet<string>,
): CitationFilterResult<T> {
  const kept: CitationFilterResult<T>['kept'] = []
  const dropped: T[] = []
  for (const s of suggestions) {
    const valid = [...new Set(s.citations.filter((c) => validIds.has(c)))]
    if (valid.length === 0) dropped.push(s)
    else kept.push({ ...s, citations: valid })
  }
  return { kept, dropped }
}
