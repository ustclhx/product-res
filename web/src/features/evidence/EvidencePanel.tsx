import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, command } from '../../app/client';
import { useWorkspace } from '../../app/workspace';
import { memberLabel } from '../../app/members';
import { JobStatus } from '../pilot/JobStatus';
import { useDurableJob, type PilotJob } from '../pilot/jobs';
import type { CandidateAggregate, Evidence, RuleResult } from './types';
import { displayTime, evidenceFieldLabel, statusText } from './types';
import SourcingPanel from './SourcingPanel';

type Props = { data: CandidateAggregate; onChanged: () => Promise<void>; field?: string | null; taskId?: string | null; assign?: boolean; reviewMode?: boolean };
const sourcingFields = new Set(['procurement_cost','procurement_reference_price','moq','moq_reference','price','selling_price','target_price','currency','vehicle_fitment','fitment_desk_review','vehicle_configuration']);

function toIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function evidenceQuality(item: Evidence, current: Evidence[], clock: string): string[] {
  const labels: string[] = [];
  if (item.value === null || item.value === '') labels.push('缺失');
  if (item.valid_until && new Date(item.valid_until).getTime() < new Date(clock).getTime()) labels.push('已过期');
  if (item.verification === 'CONFLICT' || current.some(other => other.id !== item.id && other.field === item.field && other.value !== item.value)) labels.push('有冲突');
  if (item.verification === 'UNVERIFIED') labels.push('未核验');
  if (item.epistemic_kind !== 'FACT') labels.push(statusText[item.epistemic_kind] ?? item.epistemic_kind);
  return labels.length ? labels : ['可用于复核'];
}

function EvidenceTable({ items, current, clock }: { items: Evidence[]; current: Evidence[]; clock:string }) {
  if (!items.length) return <p className="empty">暂无证据。</p>;
  return <div className="data-table"><table><thead><tr><th>字段与值</th><th>质量</th><th>来源</th><th>时间</th><th>版本</th></tr></thead><tbody>{items.map(item => <tr id={`evidence-${item.id}`} key={item.id}>
    <td><strong>{evidenceFieldLabel(item.field)}</strong><div>{item.value ?? '未知'}{item.unit ? ` ${item.unit}` : ''}{item.currency ? ` · ${item.currency}` : ''}</div>{item.window && <small className="muted">窗口：{item.window}</small>}</td>
    <td>{evidenceQuality(item,current,clock).map(label => <span className="badge" key={label}>{label}</span>)}<div className="muted">{statusText[item.epistemic_kind] ?? item.epistemic_kind} · {statusText[item.verification] ?? item.verification}{item.is_demo ? ' · 示例' : ''}</div></td>
    <td>{item.source_locator || '未提供'}</td>
    <td>观察 {displayTime(item.observed_at)}<div className="muted">有效至 {displayTime(item.valid_until)}</div></td>
    <td>v{item.version}<div className="muted">{item.supersedes_id ? <>替代 <a href={`#evidence-${item.supersedes_id}`}>{item.supersedes_id}</a></> : '独立观察'}</div></td>
  </tr>)}</tbody></table></div>;
}

function RuleRow({ rule }: { rule: RuleResult }) {
  return <tr>
    <td><strong>{evidenceFieldLabel(rule.field)}</strong><div className="muted">规则 {rule.rule_key}</div></td>
    <td>{statusText[rule.status] ?? rule.status}{rule.overridden ? ' · 已例外恢复' : ''}</td>
    <td>{rule.observed ?? '未知'} {rule.unit ?? ''}</td>
    <td>{rule.operator ?? '—'} {rule.threshold ?? '—'} {rule.unit ?? ''}</td>
    <td>{rule.reason}{rule.evidence_ids?.map(id => <div key={id}><a href={`#evidence-${id}`}>查看证据 {id}</a></div>)}</td>
  </tr>;
}

export default function EvidencePanel({ data, onChanged, field, taskId, assign = false, reviewMode = false }: Props) {
  const { mode, members, refresh } = useWorkspace();
  const checklistJob = useDurableJob<{node_run?:{id?:string};output?:Record<string,unknown>}>(`evidence-checklist:${data.candidate.id}`);
  const { candidate } = data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selectedRuleKeys, setSelectedRuleKeys] = useState<string[]>([]);
  const [overrideReason, setOverrideReason] = useState('');
  const latestScreening = data.screenings.at(-1);
  const superseded = useMemo(() => new Set(data.evidence.flatMap(item => item.supersedes_id ? [item.supersedes_id] : [])), [data.evidence]);
  const current = data.evidence.filter(item => !superseded.has(item.id));
  const historical = data.evidence.filter(item => superseded.has(item.id));
  const initialField = field ?? latestScreening?.missing_fields[0] ?? data.criteria?.required_evidence[0] ?? '';
  const initialRule = data.criteria?.rules.find(rule => rule.field === initialField);
  const reviewEvidence = reviewMode ? [...current].reverse().find(item => item.field === initialField) : undefined;
  const generalReview = Boolean(reviewEvidence && !reviewEvidence.sourcing_record_id);
  function localTime(value?: string | null) { if (!value) return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0,16); }
  const [evidenceForm, setEvidenceForm] = useState({
    field: initialField, value: reviewEvidence?.value ?? '', unit: reviewEvidence?.unit ?? initialRule?.unit ?? (initialField === 'moq' ? 'unit' : ''), currency: reviewEvidence?.currency ?? initialRule?.currency ?? '', window: reviewEvidence?.window ?? '', source_locator: reviewEvidence?.source_locator ?? '',
    observed_at: localTime(reviewEvidence?.observed_at), valid_until: localTime(reviewEvidence?.valid_until), epistemic_kind: String(reviewEvidence?.epistemic_kind ?? 'FACT'), verification: String(reviewEvidence?.verification ?? 'UNVERIFIED'), verification_note: '', supersedes_id: reviewEvidence?.id ?? '',
  });
  const [taskForm, setTaskForm] = useState({field: field ?? latestScreening?.missing_fields[0] ?? '', owner_id: 'contributor', due_at: '', question: field ? `补充${evidenceFieldLabel(field)}的可追溯材料` : '', completion_criteria: '录入当前、已核验且可追溯的证据'});
  const taskOwnerId = mode === 'pilot' && !members.some(member => member.id === taskForm.owner_id) ? members[0]?.id ?? '' : taskForm.owner_id;

  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await action(); refresh(); await onChanged(); }
    catch (caught) { setError(caught instanceof ApiError || caught instanceof Error ? caught.message : '操作未完成'); }
    finally { setBusy(false); }
  }

  function submitEvidence(event: FormEvent) {
    event.preventDefault();
    void run(() => command(`/candidates/${candidate.id}/evidence`, {
      expected_version: candidate.version,
      field: evidenceForm.field.trim(), value: evidenceForm.value.trim() || null, unit: evidenceForm.unit.trim(),
      currency: evidenceForm.currency.trim() || null, window: evidenceForm.window.trim() || null,
      source_locator: evidenceForm.source_locator.trim(), observed_at: toIso(evidenceForm.observed_at), valid_until: toIso(evidenceForm.valid_until),
      epistemic_kind: evidenceForm.epistemic_kind, verification: evidenceForm.verification,
      verification_note: mode === 'pilot' && evidenceForm.verification === 'VERIFIED' ? evidenceForm.verification_note.trim() : null,
      supersedes_id: evidenceForm.supersedes_id || null,
      ...(mode === 'demo' ? {is_demo: true} : {}),
    }));
  }

  function submitTask(event: FormEvent) {
    event.preventDefault();
    void run(() => command(`/candidates/${candidate.id}/tasks`, {
      expected_version: candidate.version, type: 'EVIDENCE', field: taskForm.field,
      question: taskForm.question.trim() || `补充 ${taskForm.field} 的有效证据`, owner_id: taskOwnerId,
      due_at: toIso(taskForm.due_at), completion_criteria: taskForm.completion_criteria.trim(), expected_metrics: {},
    }));
  }

  function toggleRule(key: string) {
    setSelectedRuleKeys(values => values.includes(key) ? values.filter(value => value !== key) : [...values, key]);
  }

  return <section className="stack" id="stage-evidence" aria-labelledby="evidence-title">
    <div className="page-heading"><div><h2 id="evidence-title">证据与初筛</h2></div><div><span className="badge">{statusText[candidate.screening_status] ?? candidate.screening_status}</span> <Link to={`/tasks?candidate_id=${candidate.id}`}>查看全部补证任务</Link></div></div>
    <p className="muted">先按本阶段补齐材料，再由负责人回填任务结果。正式初筛只采用符合项目标准的有效事实。</p>
    {error && <div className="error" role="alert">{error} <button type="button" onClick={() => void onChanged()}>刷新最新版本</button></div>}

    {(field || taskId) && <div className="notice sourcing-deep-link" role="status"><strong>{reviewMode ? `核验${evidenceFieldLabel(field ?? '')}` : field ? `处理${evidenceFieldLabel(field)}` : '处理补证事项'}</strong><span>{reviewMode ? '已定位到现有材料，请核对来源并保存核验版本；无需重复新建同一份报价。' : assign ? '已展开任务分配，并预选对应资料。' : '已打开对应资料表单。录入材料后，任务仍需在事项页确认结果。'}</span>{taskId && <Link to={`/tasks?candidate_id=${encodeURIComponent(candidate.id)}&task_id=${encodeURIComponent(taskId)}`}>更新事项进度</Link>}</div>}

    <SourcingPanel data={data} onChanged={onChanged} field={assign || generalReview ? null : field} reviewMode={reviewMode} onAssign={(field, label) => {
      setTaskForm({...taskForm, field, question:`补充${label}的可追溯材料`});
      const element = document.getElementById('evidence-task-assignment');
      if (element instanceof HTMLDetailsElement) { element.open = true; element.scrollIntoView({block:'start'}); }
    }} />

    {mode === 'pilot' && <details className="panel"><summary>AI 辅助整理（可选）</summary><div className="toolbar"><div><h3>整理补证清单</h3><p className="muted">按当前标准与材料整理缺口，不会自动核验事实或推进状态。</p></div><button type="button" className="secondary" disabled={busy || ['QUEUED','RUNNING'].includes(checklistJob.job?.state ?? '')} onClick={() => void run(async () => { const response = await command<{job:PilotJob<{node_run?:{id?:string};output?:Record<string,unknown>}>}>(`/candidates/${candidate.id}/assistant-runs`, {expected_version:candidate.version,node_kind:'EVIDENCE_CHECKLIST'}); checklistJob.remember(response.job); })}>生成补证建议</button></div><JobStatus job={checklistJob.job} error={checklistJob.error} title="补证清单整理">{result => { const output = result.output; const recommendations = Array.isArray(output?.recommendations) ? output.recommendations.filter((item): item is string => typeof item === 'string') : []; return <div><p>{typeof output?.summary === 'string' ? output.summary : '整理已完成，请结合当前证据检查。'}</p>{recommendations.length > 0 && <ul>{recommendations.map(item => <li key={item}>{item}</li>)}</ul>}<p className="muted">以上内容是待人工处理的建议，不会替代来源材料。</p></div>; }}</JobStatus></details>}

    <details className="panel" id="raw-evidence" open={Boolean(reviewMode && field)}><summary>原始证据与历史</summary><div className="toolbar"><h3>当前证据</h3><span className="muted">{current.length} 项</span></div><EvidenceTable items={current} current={current} clock={data.clock} /><details><summary>历史证据（{historical.length}）</summary><EvidenceTable items={historical} current={current} clock={data.clock} /></details></details>

    <details className="panel" id="legacy-evidence-form" open={generalReview || Boolean(field && !assign && !sourcingFields.has(field))}><summary>补充证据</summary><form className="stack" onSubmit={submitEvidence}>
        <h3>追加证据版本</h3>
        <div className="form-grid">
          <label className="field">资料类型<select required value={evidenceForm.field} onChange={event => { const field = event.target.value; const rule = data.criteria?.rules.find(item => item.field === field); setEvidenceForm({...evidenceForm,field,unit:rule?.unit ?? (field === 'moq' ? 'unit' : ''),currency:rule?.currency ?? ''}); }}><option value="">请选择</option>{[...new Set([...(data.criteria?.required_evidence ?? []), ...(latestScreening?.missing_fields ?? []), ...data.evidence.map(item => item.field), ...(evidenceForm.field ? [evidenceForm.field] : [])])].map(value => <option key={value} value={value}>{evidenceFieldLabel(value)}</option>)}</select></label>
          <label className="field">值<input value={evidenceForm.value} onChange={event => setEvidenceForm({...evidenceForm, value:event.target.value})} placeholder="留空表示未知，不能当作 0" /></label>
          <label className="field">单位<input required value={evidenceForm.unit} onChange={event => setEvidenceForm({...evidenceForm, unit:event.target.value})} placeholder="例如 unit" /></label>
          <label className="field">币种<input maxLength={3} value={evidenceForm.currency} onChange={event => setEvidenceForm({...evidenceForm, currency:event.target.value.toUpperCase()})} placeholder="CNY / USD" /></label>
          <label className="field">口径窗口<input value={evidenceForm.window} onChange={event => setEvidenceForm({...evidenceForm, window:event.target.value})} placeholder="例如 30 天" /></label>
          <label className="field">来源定位<input required value={evidenceForm.source_locator} onChange={event => setEvidenceForm({...evidenceForm, source_locator:event.target.value})} placeholder="报价单文件名、行号或链接说明" /></label>
          <label className="field">观察时间<input required type="datetime-local" value={evidenceForm.observed_at} onChange={event => setEvidenceForm({...evidenceForm, observed_at:event.target.value})} /></label>
          <label className="field">有效至<input type="datetime-local" value={evidenceForm.valid_until} onChange={event => setEvidenceForm({...evidenceForm, valid_until:event.target.value})} /></label>
          <label className="field">认知类型<select value={evidenceForm.epistemic_kind} onChange={event => setEvidenceForm({...evidenceForm, epistemic_kind:event.target.value})}><option value="FACT">事实</option><option value="ESTIMATE">估算</option><option value="ASSUMPTION">假设</option></select></label>
          <label className="field">核验状态<select value={evidenceForm.verification} onChange={event => setEvidenceForm({...evidenceForm, verification:event.target.value})}><option value="VERIFIED">已核验</option><option value="UNVERIFIED">未核验</option><option value="CONFLICT">有冲突</option></select></label>
          {mode === 'pilot' && evidenceForm.verification === 'VERIFIED' && <label className="field field-wide">核验依据<textarea required value={evidenceForm.verification_note} onChange={event => setEvidenceForm({...evidenceForm, verification_note:event.target.value})} placeholder="说明由谁、依据哪份原始材料核验，及关键口径" /></label>}
          <label className="field">明确替代旧版本<select value={evidenceForm.supersedes_id} onChange={event => setEvidenceForm({...evidenceForm, supersedes_id:event.target.value})}><option value="">不替代，作为独立观察</option>{current.filter(item => item.field === evidenceForm.field).map(item => <option value={item.id} key={item.id}>{item.id} · {item.value ?? '未知'}</option>)}</select></label>
        </div>
        <p className="muted">{mode === 'demo' ? '本演示录入的数据始终带“样例”标记。' : '试点录入保存为业务材料；标记“已核验”时必须写明核验依据。'}独立观察不会按时间自动覆盖，值不一致会显示冲突。</p>
        <button className="secondary" type="submit" disabled={busy}>保存证据版本</button>
      </form></details>

    <section className="panel stack" aria-labelledby="screening-title">
      <div className="toolbar"><div><h3 id="screening-title">初筛原因</h3><p className="muted">根据项目已确认标准检查；准备阶段不会修改标准。</p></div><button className="primary" type="button" disabled={busy} onClick={() => void run(() => command(`/candidates/${candidate.id}/screenings`, {expected_version:candidate.version}))}>按当前证据重新初筛</button></div>
      <details><summary>查看正式初筛结果与规则</summary>{latestScreening ? <><div className="notice"><strong>结论：{statusText[latestScreening.status] ?? latestScreening.status}</strong><span>缺口：{latestScreening.missing_fields.join('、') || '无'}</span></div><div className="data-table"><table><thead><tr><th>规则</th><th>结果</th><th>观测</th><th>阈值</th><th>原因与证据</th></tr></thead><tbody>{latestScreening.rule_results.map(rule => <RuleRow rule={rule} key={rule.rule_key} />)}</tbody></table></div></> : <p className="empty">尚未运行初筛。</p>}</details>
    </section>

    <div className="split-view">
      <details className="panel" id="evidence-task-assignment" open={assign}><summary>分配补证负责人和期限</summary><form className="stack" onSubmit={submitTask}>
        <h3>分配补证任务</h3>
        <label className="field">待补资料<select required value={taskForm.field} onChange={event => setTaskForm({...taskForm, field:event.target.value})}><option value="">请选择</option>{[...new Set([...(latestScreening?.missing_fields ?? data.criteria?.required_evidence ?? []), ...(taskForm.field ? [taskForm.field] : [])])].map(field => <option value={field} key={field}>{evidenceFieldLabel(field)}</option>)}</select></label>
        <label className="field">负责人<select value={taskOwnerId} onChange={event => setTaskForm({...taskForm, owner_id:event.target.value})}>{mode === 'demo' ? <><option value="contributor">补证协作者</option><option value="analyst">分析负责人</option><option value="owner">决策负责人</option></> : members.map(member => <option value={member.id} key={member.id}>{memberLabel(member)}</option>)}</select></label>
        <label className="field">截止时间<input required type="datetime-local" value={taskForm.due_at} onChange={event => setTaskForm({...taskForm, due_at:event.target.value})} /></label>
        <label className="field">问题<input value={taskForm.question} onChange={event => setTaskForm({...taskForm, question:event.target.value})} placeholder="需要向供应商确认什么？" /></label>
        <label className="field">完成条件<textarea required value={taskForm.completion_criteria} onChange={event => setTaskForm({...taskForm, completion_criteria:event.target.value})} /></label>
        <button className="secondary" type="submit" disabled={busy || !taskForm.field}>创建补证任务</button>
      </form></details>

      <details className="panel"><summary>记录人工例外恢复</summary><form className="stack" onSubmit={event => {event.preventDefault(); void run(() => command(`/candidates/${candidate.id}/screening-overrides`, {expected_version:candidate.version, reason:overrideReason.trim(), rule_keys:selectedRuleKeys.length ? selectedRuleKeys : undefined}));}}>
        <h3>人工例外恢复</h3><p className="muted">仅决策负责人可操作。恢复保留原失败结果，也不会豁免缺失、不可靠或冲突证据。</p>
        {(latestScreening?.rule_results.filter(rule => rule.status === 'FAIL' && !rule.overridden) ?? []).map(rule => <label className="field" key={rule.rule_key}><span><input type="checkbox" checked={selectedRuleKeys.includes(rule.rule_key)} onChange={() => toggleRule(rule.rule_key)} /> {evidenceFieldLabel(rule.field)}：{rule.reason}</span></label>)}
        <label className="field">恢复原因<textarea required value={overrideReason} onChange={event => setOverrideReason(event.target.value)} /></label>
        <button className="secondary" type="submit" disabled={busy || !overrideReason.trim()}>记录例外恢复</button>
      </form></details>
    </div>
  </section>;
}
