import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import { useWorkspace } from './workspace';
import { memberLabel } from './members';
import type { WorkspaceMember } from './workspaceContext';

export type WorkItem = {
  id: string; kind: string; title: string;
  project_id: string; project_name: string;
  candidate_id: string | null; candidate_title: string | null;
  owner_id: string | null; assignment_owner_id: string | null;
  state: 'TODO' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE' | 'CANCELLED';
  due_at: string | null; overdue: boolean; reason: string;
  action_label: string; href: string; task_id: string | null; field: string | null;
};
export type WorkProject = {
  id: string; name: string; channel: string; market: string; direction: string;
  analyst_id: string | null; decision_owner_id: string | null; current_criteria_id: string | null;
  candidate_count: number; open_item_count: number; next_action: string; href: string; updated_at: string;
};
export type WorkItemsResponse = { items: WorkItem[]; projects: WorkProject[]; clock: string };
export const workStateLabels: Record<WorkItem['state'], string> = {
  TODO: '待处理', IN_PROGRESS: '进行中', BLOCKED: '受阻', DONE: '已完成', CANCELLED: '已取消',
};
export function isOpenItem(item: WorkItem) { return item.state !== 'DONE' && item.state !== 'CANCELLED'; }
export function workOwnerLabel(id: string | null | undefined, members: WorkspaceMember[] = []): string {
  if (!id) return '待分配';
  const member = members.find(item => item.id === id);
  return member ? memberLabel(member) : ({ analyst: '分析负责人', owner: '决策负责人', contributor: '采购协作' }[id] ?? '项目成员');
}
export function isMyWork(item: WorkItem, actor: string) {
  return item.owner_id === actor || (!item.owner_id && item.assignment_owner_id === actor);
}
export function useWorkItems() {
  const { mode, session, refreshToken } = useWorkspace();
  return useQuery({
    queryKey: ['work-items', mode, session?.workspace.id, refreshToken],
    queryFn: () => api<WorkItemsResponse>('/work-items'),
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[2] === session?.workspace.id ? previous : undefined,
    retry: false,
    refetchInterval: mode === 'pilot' ? 15000 : false,
  });
}
