/** 预览页的中性示例数据（项目协作领域），只用于展示组件，不与业务数据关联 */
export interface SampleProject {
  readonly id: string
  readonly name: string
  readonly owner: string
  readonly status: 'active' | 'paused' | 'archived'
  readonly updated: string
}

export const SAMPLE_PROJECTS: readonly SampleProject[] = [
  { id: 'p1', name: 'Atlas', owner: 'Ada Lovelace', status: 'active', updated: '2026-11-08' },
  { id: 'p2', name: 'Beacon', owner: 'Grace Hopper', status: 'paused', updated: '2026-11-02' },
  { id: 'p3', name: 'Cobalt', owner: 'Alan Turing', status: 'active', updated: '2026-10-28' },
  {
    id: 'p4',
    name: 'Delta',
    owner: 'Katherine Johnson',
    status: 'archived',
    updated: '2026-10-15',
  },
  { id: 'p5', name: 'Ember', owner: 'Edsger Dijkstra', status: 'active', updated: '2026-10-09' },
  { id: 'p6', name: 'Fjord', owner: 'Barbara Liskov', status: 'active', updated: '2026-09-30' },
  { id: 'p7', name: 'Garnet', owner: 'Donald Knuth', status: 'paused', updated: '2026-09-21' },
]

export const SAMPLE_PEOPLE = [
  'Ada Lovelace',
  'Alan Turing',
  'Barbara Liskov',
  'Donald Knuth',
  'Edsger Dijkstra',
  'Grace Hopper',
  'Katherine Johnson',
  'Margaret Hamilton',
] as const
