import { Link } from 'react-router-dom';
import { useWorkspace } from '../app/workspace';
import { isOpenItem, workOwnerLabel, workStateLabels, type WorkItem } from '../app/workItems';

export default function WorkItemList({ items, emptyText = '暂无需要处理的事项。' }: { items: WorkItem[]; emptyText?: string }) {
  const { members } = useWorkspace();
  if (!items.length) return <p className="work-empty">{emptyText}</p>;
  return <ul className="work-items">{items.map(item => <li key={item.id} data-work-id={item.id}>
    <div className="work-item-content">
      <div className="work-item-title"><strong>{item.title}</strong>{item.overdue && <span className="badge warning">已逾期</span>}{item.state !== 'TODO' && <span className="badge">{workStateLabels[item.state]}</span>}</div>
      <p className="work-item-context"><Link to={`/projects/${item.project_id}`}>{item.project_name}</Link>{item.candidate_id && <> · <Link className="work-item-product" to={`/candidates/${item.candidate_id}`} title={item.candidate_title ?? undefined}>{item.candidate_title}</Link></>}</p>
      <p>{item.reason}</p>
      <p className="small">负责人：{workOwnerLabel(item.owner_id, members)}{!item.owner_id && item.assignment_owner_id && ` · 由${workOwnerLabel(item.assignment_owner_id, members)}协调`}{item.due_at && <> · 截止 {new Date(item.due_at).toLocaleDateString('zh-CN')}</>}</p>
    </div>
    <div className="work-item-actions"><Link className="secondary action-link" to={item.href}>{isOpenItem(item) ? item.action_label : '查看记录'}</Link>{isOpenItem(item) && item.kind === 'EVIDENCE' && !item.owner_id && item.field && item.candidate_id && <Link to={`/candidates/${item.candidate_id}?stage=evidence&field=${encodeURIComponent(item.field)}&assign=1`}>分配负责人</Link>}{isOpenItem(item) && item.task_id && !item.href.startsWith('/tasks') && <Link to={`/tasks?candidate_id=${item.candidate_id}&task_id=${item.task_id}`}>更新进度</Link>}</div>
  </li>)}</ul>;
}
