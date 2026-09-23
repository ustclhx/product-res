import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../app/client';
import { useWorkspace } from '../../app/workspace';
import { isMyWork, isOpenItem, useWorkItems } from '../../app/workItems';
import WorkItemList from '../../components/WorkItemList';

export default function WorkbenchPage() {
  const { actor, mode, session } = useWorkspace();
  const query = useWorkItems();
  const activity = useQuery({ queryKey: ['home-activity', mode, session?.workspace.id, query.dataUpdatedAt], queryFn: () => api<{ items: { id: string; action: string; created_at: string }[] }>('/activity'), retry: false });
  const projects = query.data?.projects ?? [];
  const openItems = (query.data?.items ?? []).filter(isOpenItem);
  const mine = openItems.filter(item => isMyWork(item, actor));
  const waiting = openItems.filter(item => !isMyWork(item, actor));
  const unassigned = waiting.filter(item => !item.owner_id && !item.assignment_owner_id);
  const others = waiting.filter(item => !unassigned.includes(item));
  return <div className="feature-page">
    <header className="page-heading"><div><h1>工作台</h1><p>先处理需要你的工作，再继续选品项目。</p></div><Link className="primary action-link" to="/projects?new=1">新建项目</Link></header>
    {query.isPending && <p role="status">正在读取你的工作…</p>}
    {query.isError && <div className="error" role="alert">工作台读取失败：{query.error.message}<button type="button" onClick={() => void query.refetch()}>重试</button></div>}
    {query.data && (projects.length === 0 ? <section className="panel first-project"><h2>从一个选品方向开始</h2><p>确定目标渠道与市场、研究方向和负责人，就可以建立第一轮选品项目。尚不确定的采购条件可在研究中补充。</p><Link className="primary action-link" to="/projects?new=1">创建第一个选品项目</Link>{mode === 'demo' && <p className="small"><Link to="/observations">也可以先载入示例体验流程</Link></p>}</section> : <>
      <section className="panel" aria-labelledby="my-work"><div className="card-heading"><h2 id="my-work">需要我处理 <span className="muted small">{mine.length} 项</span></h2><Link to={`/tasks?owner_id=${encodeURIComponent(actor)}`}>查看全部事项</Link></div><WorkItemList items={mine} emptyText="当前没有需要你处理的事项，可以继续下方的选品项目。" /></section>
      {unassigned.length > 0 && <section className="panel"><h2>等待分配负责人</h2><p className="muted">这些事项尚未指定负责人，进入项目设置完成分配。</p><WorkItemList items={unassigned} /></section>}
      {others.length > 0 && <details className="panel"><summary>等待他人处理 · {others.length} 项</summary><WorkItemList items={others} /></details>}
      <section className="panel" aria-labelledby="active-projects"><div className="card-heading"><h2 id="active-projects">进行中的项目</h2><Link to="/projects">查看所有项目</Link></div><ul className="project-worklist">{projects.slice(0, 6).map(project => <li key={project.id}><div><h3><Link to={`/projects/${project.id}`}>{project.name}</Link></h3><p className="muted">{{AMAZON:'Amazon', EBAY:'eBay', DTC:'独立站'}[project.channel] ?? project.channel} · {project.market} · {project.candidate_count} 个候选 · {project.open_item_count} 项待处理</p><p>{project.next_action}</p></div><Link className="secondary action-link" to={project.href}>继续项目</Link></li>)}</ul></section>
      <details><summary>最近动态</summary>{activity.isError ? <p className="muted">动态暂时不可用。<button type="button" onClick={() => void activity.refetch()}>重试</button></p> : <p className="muted">{activity.data?.items.length ? `最近一次更新：${new Date(activity.data.items[0]!.created_at).toLocaleString('zh-CN')}` : '还没有操作记录。'} <Link to="/observations">查看操作历史</Link></p>}</details>
    </>)}
  </div>;
}
