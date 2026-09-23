import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../app/client';
import { useWorkspace } from '../../app/workspace';
import { isOpenItem, useWorkItems, workOwnerLabel } from '../../app/workItems';
import EvidencePanel from '../evidence/EvidencePanel';
import type { CandidateAggregate } from '../evidence/types';
import { statusText } from '../evidence/types';
import EvaluationPanel from '../evaluations/EvaluationPanel';
import ReviewPanel from '../reviews/ReviewPanel';
import ModelUsagePanel from './ModelUsagePanel';
import ResearchPanel from '../outcomes/ResearchPanel';
import WorkItemList from '../../components/WorkItemList';
import './model-usage.css';

type Stage = 'evidence' | 'evaluation' | 'review';
const candidateStage = (value: string | null): Stage | null => value === 'evidence' || value === 'evaluation' || value === 'review' ? value : value === 'research' ? 'review' : null;
const statusDefaults: Record<string, Stage> = { PREPARING: 'evidence', RETURNED: 'evidence', IN_REVIEW: 'review', WATCHING: 'review', REJECTED: 'review', VALIDATING: 'review', OUTCOME_PENDING: 'review', REVIEWED: 'review' };

function hrefStage(href?: string): Stage | null {
  if (!href) return null;
  try { return candidateStage(new URL(href, window.location.origin).searchParams.get('stage')); }
  catch { return null; }
}

export default function CandidatePage() {
  const { id = '' } = useParams();
  const { mode, actor, session, members, refreshToken } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const query = useQuery({queryKey:['candidate',id,refreshToken],queryFn:() => id ? api<CandidateAggregate>(`/candidates/${id}`) : Promise.reject(new Error('候选标识缺失。')),placeholderData:(previous,previousQuery) => previousQuery?.queryKey[1] === id ? previous : undefined,retry:false,refetchInterval:mode === 'pilot' ? 15000 : false});
  const workItemsQuery = useWorkItems();
  const data = query.data;
  const load = async () => { await query.refetch(); };
  const error = query.error instanceof Error ? query.error.message : query.error ? '候选加载失败' : '';
  const requestedTaskId = params.get('task_id');
  const candidateItems = workItemsQuery.data?.items.filter(item => item.candidate_id === id && isOpenItem(item)) ?? [];
  const currentItem = candidateItems.find(item => requestedTaskId && item.task_id === requestedTaskId) ?? candidateItems.find(item => params.get('field') && item.field === params.get('field')) ?? candidateItems[0];
  const requestedStage = candidateStage(params.get('stage'));
  const stage = requestedStage ?? hrefStage(currentItem?.href) ?? (data ? statusDefaults[data.candidate.business_status] : null) ?? 'evidence';
  const activePhase = requestedStage ? (requestedStage === 'evidence' ? 'evidence' : 'decision') : data && ['OUTCOME_PENDING','REVIEWED'].includes(data.candidate.business_status) ? 'outcome' : data?.candidate.business_status === 'VALIDATING' ? 'validation' : stage === 'evidence' ? 'evidence' : 'decision';
  const showFollowUp = !requestedStage && (activePhase === 'validation' || activePhase === 'outcome');
  const legacyResearch = params.get('stage') === 'research';
  function selectStage(next: Stage) {
    const nextParams = new URLSearchParams(params);
    nextParams.set('stage', next);
    ['field','task_id','assign','mode'].forEach(key => nextParams.delete(key));
    setParams(nextParams);
  }
  function showEvidence(evidenceId?: string) {
    selectStage('evidence');
    if (evidenceId) window.setTimeout(() => { const raw = document.getElementById('raw-evidence'); if (raw instanceof HTMLDetailsElement) raw.open = true; document.getElementById(`evidence-${evidenceId}`)?.scrollIntoView({block:'center'}); }, 0);
    else window.setTimeout(() => document.getElementById('stage-evidence')?.scrollIntoView({block:'start'}), 0);
  }

  if (query.isPending && !data) return <main className="main-content"><p role="status">正在加载候选资料…</p></main>;
  if (error && !data) return <main className="main-content"><div className="error" role="alert"><strong>无法打开候选</strong><p>{error}</p><button type="button" onClick={() => void load()}>重试</button></div></main>;
  if (!data) return null;

  const { candidate, project, criteria } = data;
  const fallbackOwnerId = stage === 'evidence' || stage === 'evaluation' ? project.analyst_id : project.decision_owner_id;
  return <main className="main-content candidate-page">
    <header className="page-heading">
      <div>
        <nav aria-label="面包屑"><Link to="/projects">选品项目</Link> / <Link to={`/projects/${project.id}`}>{project.name}</Link> / 候选</nav>
        <h1>{candidate.title}</h1>
        <p className="muted">{project.channel} · {candidate.market ?? project.market} · {candidate.external_id ?? candidate.sku ?? candidate.id}</p>
      </div>
      <div className="stack">
        <span className="badge">{candidate.is_demo ? '示例数据' : mode === 'pilot' ? '试点业务数据' : '用户录入'}</span>
        <span className="badge">{statusText[candidate.business_status] ?? candidate.business_status}</span>
        <span className="muted">当前成员：{mode === 'pilot' ? session?.user.display_name ?? session?.user.name ?? session?.user.username ?? actor : ({analyst:'分析负责人',owner:'决策负责人',contributor:'采购协作'}[actor] ?? actor)}</span>
      </div>
    </header>

    <details><summary>候选来源与进入记录</summary><ul className="timeline">{data.sources.map(source => <li key={source.id}><strong>{{DISCOVERY:'方向发现',MANUAL:'手工录入',CSV:'CSV 导入'}[source.entry_kind] ?? source.entry_kind}</strong> · {source.is_demo ? '样例' : mode === 'pilot' ? '真实来源或团队录入' : '用户录入'}<p>{source.source_ref}</p>{source.source_url && <a href={source.source_url} target="_blank" rel="noreferrer">原始来源</a>}<span className="muted"> · {new Date(source.collected_at).toLocaleString('zh-CN')}</span></li>)}</ul></details>
    <div className="notice" role="status">
      <strong>当前初筛：{statusText[candidate.screening_status] ?? candidate.screening_status}</strong>
      <span>标准版本 {criteria ? `v${data.criteria_versions.findIndex(item => item.id === criteria.id) + 1}` : '尚未确认'}</span>
      <span>{mode === 'pilot' ? '当前操作写入所选工作区；系统不会代替团队采购、上架或投放。' : '页面操作只保存本地演示记录，不会采购、上架或投放。'}</span>
    </div>

    <section className="candidate-current-work" aria-labelledby="candidate-current-work-title">
      <div><span className="muted">当前工作</span><h2 id="candidate-current-work-title">{currentItem?.title ?? (candidate.approval_id ? '跟进验证与经营结果' : statusText[candidate.business_status] ?? '继续处理候选')}</h2><p>{currentItem?.reason ?? (candidate.approval_id ? '候选已获批，按验证计划完成任务并回填实际结果。' : '按当前业务状态继续准备材料、评估或提交决策。')}</p></div>
      <div className="candidate-current-action"><span>负责人：{currentItem ? `${workOwnerLabel(currentItem.owner_id, members)}${!currentItem.owner_id && currentItem.assignment_owner_id ? ` · ${workOwnerLabel(currentItem.assignment_owner_id, members)}协调` : ''}` : workOwnerLabel(fallbackOwnerId, members)}</span>{currentItem ? <Link className="primary" to={currentItem.href}>{currentItem.action_label}</Link> : <button className="primary" type="button" onClick={() => selectStage(stage)}>继续当前步骤</button>}</div>
    </section>

    <nav className="stage-tabs" aria-label="候选处理阶段">
      <button type="button" aria-current={activePhase === 'evidence' ? 'step' : undefined} className={activePhase === 'evidence' ? 'stage-tab stage-tab--active' : 'stage-tab'} onClick={() => selectStage('evidence')}><strong>1. 收集资料</strong><span>补齐并核验关键材料</span></button>
      <button type="button" aria-current={activePhase === 'decision' ? 'step' : undefined} className={activePhase === 'decision' ? 'stage-tab stage-tab--active' : 'stage-tab'} onClick={() => selectStage(stage === 'review' ? 'review' : 'evaluation')}><strong>2. 评估与决策</strong><span>整理评估并由负责人决定</span></button>
      {candidate.approval_id ? <Link aria-current={activePhase === 'validation' ? 'step' : undefined} className={activePhase === 'validation' ? 'stage-tab stage-tab--active' : 'stage-tab'} to={`/tasks?candidate_id=${candidate.id}`}><strong>3. 获批验证</strong><span>执行询价、样品或小测</span></Link> : <span className="stage-tab stage-tab--disabled"><strong>3. 获批验证</strong><span>批准后开放</span></span>}
      {candidate.approval_id ? <Link aria-current={activePhase === 'outcome' ? 'step' : undefined} className={activePhase === 'outcome' ? 'stage-tab stage-tab--active' : 'stage-tab'} to={`/candidates/${candidate.id}/outcomes`}><strong>4. 结果复盘</strong><span>回填真实结果与偏差</span></Link> : <span className="stage-tab stage-tab--disabled"><strong>4. 结果复盘</strong><span>批准后开放</span></span>}
    </nav>

    {(stage === 'evaluation' || stage === 'review') && <div className="toolbar candidate-decision-nav"><span className="muted">评估与决策</span><div><button type="button" className={stage === 'evaluation' ? 'primary' : 'secondary'} onClick={() => selectStage('evaluation')}>评估整理</button> <button type="button" className={stage === 'review' ? 'primary' : 'secondary'} onClick={() => selectStage('review')}>提交与决策</button></div></div>}

    {error && <div className="error" role="alert">刷新未完成：{error} <button type="button" onClick={() => void load()}>重试</button></div>}
    {showFollowUp && <section className="panel"><h2>{activePhase === 'validation' ? '验证执行' : '结果复盘'}</h2><WorkItemList items={candidateItems} emptyText="当前没有待处理事项，可查看既有记录或安排后续工作。" /><Link to={activePhase === 'validation' ? `/tasks?candidate_id=${candidate.id}` : `/candidates/${candidate.id}/outcomes`}>{activePhase === 'validation' ? '查看验证事项' : '查看结果与复盘'}</Link></section>}
    {!showFollowUp && stage === 'evidence' && <EvidencePanel key={`${candidate.id}:${params.get('field') ?? ''}:${params.get('task_id') ?? ''}:${params.get('assign') ?? ''}:${params.get('mode') ?? ''}`} data={data} onChanged={load} field={params.get('field')} taskId={params.get('task_id')} assign={params.get('assign') === '1'} reviewMode={params.get('mode') === 'review'} />}
    {!showFollowUp && stage === 'evaluation' && <EvaluationPanel data={data} onChanged={load} onShowEvidence={showEvidence} />}
    {!showFollowUp && stage === 'review' && <><ReviewPanel data={data} onChanged={load} onShowEvidence={() => showEvidence()} /><details className="panel" open={legacyResearch}><summary>观察、停止与研究反馈</summary><p className="muted">继续观察或否决是本轮决策分支；这里记录原因和可供下一轮采用的启示。</p><ResearchPanel candidateId={candidate.id} /></details></>}
    {mode === 'pilot' && <details className="panel"><summary>模型整理与用量</summary><ModelUsagePanel candidateId={candidate.id} projectId={project.id} /></details>}
  </main>;
}
