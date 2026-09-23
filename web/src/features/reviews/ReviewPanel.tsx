import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError, api, command } from '../../app/client';
import { useWorkspace } from '../../app/workspace';
import { workOwnerLabel } from '../../app/workItems';
import type { CandidateAggregate } from '../evidence/types';
import { displayTime, statusText } from '../evidence/types';

type Props = { data: CandidateAggregate; onChanged: () => Promise<void>; onShowEvidence: () => void };
type DecisionAction = 'APPROVE' | 'RETURN' | 'WATCH' | 'REJECT';
const actionText: Record<string,string> = {APPROVE:'批准进入验证',RETURN:'退回补充材料',WATCH:'继续观察',REJECT:'否决',REOPEN:'重新打开'};

type TimelineItem = {
  id:string; created_at?:string; kind:string; action?:string; reason?:string; questions?:string[];
  actor_id?:string; evaluation_id?:string | null; criteria_id?:string | null; submission_id?:string;
  reasons?:Array<{code?:string;[key:string]:unknown}>;
};

function timeline(data: CandidateAggregate): TimelineItem[] {
  return [
    ...data.submissions.map(item => ({...item,kind:'submission'})),
    ...data.decisions.map(item => ({...item,kind:'decision'})),
  ].sort((left,right) => `${left.created_at ?? ''}-${left.id}`.localeCompare(`${right.created_at ?? ''}-${right.id}`));
}

export default function ReviewPanel({ data, onChanged, onShowEvidence }: Props) {
  const { refresh, members } = useWorkspace();
  const { candidate, project } = data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [action, setAction] = useState<DecisionAction>('APPROVE');
  const [reason, setReason] = useState('');
  const [questions, setQuestions] = useState('');
  const [reopenReason, setReopenReason] = useState('');
  const timelineQuery = useQuery({queryKey:['decision-timeline',candidate.id,candidate.version],queryFn:() => api<{items:TimelineItem[]}>(`/candidates/${candidate.id}/decision-timeline`),retry:false});
  const items = timelineQuery.data?.items ?? timeline(data);
  const latestEvaluation = data.evaluations.at(-1);
  const latestReturn = [...data.decisions].reverse().find(item => item.action === 'RETURN');
  const canSubmit = ['PREPARING','RETURNED'].includes(candidate.business_status) && Boolean(latestEvaluation);
  const canDecide = candidate.business_status === 'IN_REVIEW';
  const canReopen = ['WATCHING','REJECTED'].includes(candidate.business_status);

  async function run(operation: () => Promise<unknown>, success: string) {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); refresh(); setNotice(success); await onChanged(); }
    catch (caught) {
      const message = caught instanceof ApiError || caught instanceof Error ? caught.message : '操作未完成';
      setError(message.includes('version') || message.includes('版本') ? `${message}。页面数据可能已被另一窗口更新，请刷新后重新判断。` : message);
      await onChanged();
    } finally { setBusy(false); }
  }

  function decide(event: FormEvent) {
    event.preventDefault();
    void run(() => command(`/candidates/${candidate.id}/decisions`, {
      expected_version:candidate.version, action, reason:reason.trim(),
      questions:action === 'RETURN' ? questions.split('\n').map(item => item.trim()).filter(Boolean) : [],
    }), `已记录决定：${actionText[action]}。`);
  }

  return <section className="stack" id="stage-review" aria-labelledby="review-title">
    <div className="page-heading"><div><h2 id="review-title">提交与人工决策</h2><p className="muted">当前状态：{statusText[candidate.business_status] ?? candidate.business_status} · 分析负责人 {workOwnerLabel(project.analyst_id,members)} · 决策负责人 {workOwnerLabel(project.decision_owner_id,members)}</p></div><Link to={`/candidates/${candidate.id}/outcomes`}>经营结果与复盘</Link></div>
    {error && <div className="error" role="alert">{error} <button type="button" onClick={() => void onChanged()}>刷新最新版本</button></div>}
    {notice && <div className="notice" role="status">{notice}</div>}

    {candidate.business_status === 'RETURNED' && latestReturn && <section className="notice"><div><strong>退回问题</strong><p>{latestReturn.reason}</p>{latestReturn.questions?.length ? <ul>{latestReturn.questions.map(question => <li key={question}>{question}</li>)}</ul> : <p>负责人尚未留下具体问题。</p>}<p><a href="#stage-evidence" onClick={event => {event.preventDefault(); onShowEvidence();}}>去补充证据</a>，完成后重新初筛并保存新评估，再回来提交。</p></div></section>}

    <section className="panel stack">
      <div className="toolbar"><div><h3>分析负责人提交</h3><p className="muted">提交冻结当前评估与标准；证据或标准变化后需要重新评估再提交。</p></div>{canSubmit && <button className="primary" type="button" disabled={busy} onClick={() => void run(() => command(`/candidates/${candidate.id}/submissions`, {expected_version:candidate.version,evaluation_id:latestEvaluation?.id}), '当前评估已提交给决策负责人。')}>提交当前评估</button>}</div>
      {latestEvaluation ? <p>待提交评估：v{latestEvaluation.version} · {latestEvaluation.id} · 标准 {latestEvaluation.criteria_id}</p> : <p className="empty">尚无可提交评估，请先完成评估整理。</p>}
      {!canSubmit && latestEvaluation && <p className="muted">当前业务状态不允许再次提交。</p>}
    </section>

    {canDecide ? <form className="panel stack" onSubmit={decide}>
      <h3>决策负责人处理</h3>
      <div className="form-grid" role="radiogroup" aria-label="决定类型">
        {(['APPROVE','RETURN','WATCH','REJECT'] as DecisionAction[]).map(value => <label className="field" key={value}><span><input type="radio" name="decision-action" value={value} checked={action === value} onChange={() => setAction(value)} /> <strong>{actionText[value]}</strong></span><small className="muted">{value === 'APPROVE' ? '创建结果跟进义务，不执行采购或投放' : value === 'RETURN' ? '要求补证、重评并重新提交' : value === 'WATCH' ? '保留材料，等待新信息' : '保留否决理由和历史'}</small></label>)}
      </div>
      <label className="field">决定理由<textarea required value={reason} onChange={event => setReason(event.target.value)} /></label>
      {action === 'RETURN' && <label className="field">退回问题（每行一个）<textarea required value={questions} onChange={event => setQuestions(event.target.value)} placeholder="例如：请补充有效期内的供应商 MOQ 报价" /></label>}
      <button className="primary" type="submit" disabled={busy || !canDecide || !reason.trim() || (action === 'RETURN' && !questions.trim())}>确认{actionText[action]}</button>
    </form> : <section className="panel"><h3>决策负责人处理</h3><p className="muted">候选进入“待决策”后，负责人可批准、退回、观察或否决。</p></section>}

    {canReopen && <details className="panel"><summary>因新证据重新打开候选</summary><form className="stack" onSubmit={event => {event.preventDefault(); void run(() => command(`/candidates/${candidate.id}/reopen`, {expected_version:candidate.version,reason:reopenReason.trim()}), '候选已重新打开，需要重新满足初筛与提交条件。');}}><label className="field">重新打开原因<textarea required value={reopenReason} onChange={event => setReopenReason(event.target.value)} /></label><button className="secondary" type="submit" disabled={busy || !reopenReason.trim()}>重新打开</button></form></details>}

    <section className="panel stack" aria-labelledby="history-title"><div className="toolbar"><h3 id="history-title">提交与决策历史</h3><span className="muted">追加记录，不覆盖旧版本</span></div>{timelineQuery.isError && <p className="error">完整时间线暂时不可用，以下显示候选聚合中的提交与决定。</p>}{items.length ? <ol className="timeline">{items.map(item => <li key={`${item.kind}-${item.id}`}><div className="toolbar"><strong>{item.kind === 'submission' ? '提交评估' : item.kind === 'submission_invalidation' ? '提交已失效' : actionText[item.action ?? ''] ?? item.action ?? item.kind}</strong><time>{displayTime(item.created_at)}</time></div>{item.kind === 'submission' && <p>评估 {item.evaluation_id} · 标准 {item.criteria_id}</p>}{item.kind === 'submission_invalidation' && <><p>提交后证据、标准或评估发生变化，需要重新评估并提交。</p><ul>{item.reasons?.map((value,index) => <li key={`${value.code ?? 'reason'}-${index}`}>{value.code ?? '材料版本变化'}</li>)}</ul></>}{item.kind !== 'submission' && item.kind !== 'submission_invalidation' && <><p>{item.reason}</p>{item.questions?.length ? <ul>{item.questions.map(question => <li key={question}>{question}</li>)}</ul> : null}<p className="muted">操作者 {item.actor_id ?? '未标注'} · 所审评估 {item.evaluation_id ?? '无'}</p></>}</li>)}</ol> : <p className="empty">尚无提交或决策记录。</p>}</section>
  </section>;
}
