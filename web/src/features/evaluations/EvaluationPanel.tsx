import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError, command } from '../../app/client';
import { useWorkspace } from '../../app/workspace';
import type { CandidateAggregate, Evaluation, NodeRun } from '../evidence/types';
import { displayTime } from '../evidence/types';
import { JobStatus } from '../pilot/JobStatus';
import { useDurableJob, type PilotJob } from '../pilot/jobs';
import { isAdoptedDraftStale, isDraftFresh, selectEvaluationDrafts } from './evaluationDrafts';

type Props = { data: CandidateAggregate; onChanged: () => Promise<void>; onShowEvidence: (id: string) => void };
type DimensionKey = 'demand' | 'competition' | 'differentiation' | 'supply_cost' | 'risk';
const dimensions: Array<[DimensionKey, string]> = [['demand','需求'],['competition','竞争'],['differentiation','差异化'],['supply_cost','供应与成本'],['risk','风险']];
const metricLabels: Record<string, string> = {revenue:'收入',procurement:'采购',platform:'平台',fulfillment:'履约',advertising:'广告',refunds:'退款',other:'其他'};

function lines(value: string): string[] { return value.split('\n').map(item => item.trim()).filter(Boolean); }
function toIso(value: string): string | null { if (!value) return null; const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
function toLocalInput(value?: string | null): string { if (!value) return ''; const date = new Date(value); if (Number.isNaN(date.getTime())) return ''; return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0,16); }
function summary(evaluation: Evaluation | undefined, key: DimensionKey): string { const value = evaluation?.dimensions[key]?.summary; return typeof value === 'string' ? value : ''; }
function refs(evaluation: Evaluation | undefined, key: DimensionKey): string[] { const value = evaluation?.dimensions[key]?.evidence_ids; return Array.isArray(value) ? value : []; }
function record(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function textList(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }

export default function EvaluationPanel({ data, onChanged, onShowEvidence }: Props) {
  const { mode } = useWorkspace();
  const assistantJob = useDurableJob<{node_run?: NodeRun;output?:Record<string,unknown>}>(`evaluation:${data.candidate.id}`);
  const refreshedJob = useRef('');
  const latest = data.evaluations.at(-1);
  const supersededIds = new Set(data.evidence.flatMap(item => item.supersedes_id ? [item.supersedes_id] : []));
  const currentEvidence = data.evidence.filter(item => !supersededIds.has(item.id));
  const currentEvidenceKey = currentEvidence.map(item => `${item.id}:${item.version}`).sort().join('|');
  const currentIds = new Set(currentEvidence.map(item => item.id));
  const currentRefs = (ids: string[]) => ids.filter(id => currentIds.has(id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dimensionText, setDimensionText] = useState<Record<DimensionKey,string>>({
    demand:summary(latest,'demand'), competition:summary(latest,'competition'), differentiation:summary(latest,'differentiation'), supply_cost:summary(latest,'supply_cost'), risk:summary(latest,'risk'),
  });
  const [evidenceIds, setEvidenceIds] = useState<string[]>(currentRefs(latest?.evidence_ids ?? []));
  const [dimensionRefs, setDimensionRefs] = useState<Record<DimensionKey,string[]>>({
    demand:currentRefs(refs(latest,'demand')), competition:currentRefs(refs(latest,'competition')), differentiation:currentRefs(refs(latest,'differentiation')), supply_cost:currentRefs(refs(latest,'supply_cost')), risk:currentRefs(refs(latest,'risk')),
  });
  const [unknowns, setUnknowns] = useState((latest?.unknowns ?? []).join('\n'));
  const [counterevidence, setCounterevidence] = useState((latest?.counterevidence ?? []).join('\n'));
  const [assumptions, setAssumptions] = useState((latest?.assumptions ?? []).join('\n'));
  const [adoption, setAdoption] = useState<{runId:string;evidenceKey:string} | null>(null);
  const [forecast, setForecast] = useState({
    currency:latest?.forecast.currency ?? '', window_start:toLocalInput(latest?.forecast.window_start), window_end:toLocalInput(latest?.forecast.window_end), revenue_basis:latest?.forecast.revenue_basis ?? '', units:latest?.forecast.units ?? '',
    revenue:latest?.forecast.metrics?.revenue ?? '', procurement:latest?.forecast.metrics?.procurement ?? '', platform:latest?.forecast.metrics?.platform ?? '', fulfillment:latest?.forecast.metrics?.fulfillment ?? '', advertising:latest?.forecast.metrics?.advertising ?? '', refunds:latest?.forecast.metrics?.refunds ?? '', other:latest?.forecast.metrics?.other ?? '',
  });
  const aggregateRuns = data.node_runs.filter(run => run.node_kind === 'EVALUATION_ORGANIZER');
  const liveNodeRun = assistantJob.job?.state === 'SUCCEEDED' && !assistantJob.job.stale
    ? assistantJob.job.result?.node_run
    : undefined;
  const liveRun = liveNodeRun?.id && !aggregateRuns.some(run => run.id === liveNodeRun.id)
    ? {...liveNodeRun,node_kind:'EVALUATION_ORGANIZER'}
    : undefined;
  const {latest:latestRun,history:runHistory} = selectEvaluationDrafts(aggregateRuns,liveRun);
  const latestRunState = latestRun?.run_state ?? latestRun?.status ?? latestRun?.state;
  const aiOutput = latestRun && isDraftFresh(latestRun) ? record(latestRun.output) : null;
  const aiDimensions = record(aiOutput?.dimensions);
  const knownRuns = [...aggregateRuns, ...(liveRun ? [liveRun] : [])];
  const adoptedRunStale = isAdoptedDraftStale(adoption,currentEvidenceKey,knownRuns);
  const adoptedRunId = adoption && !adoptedRunStale ? adoption.runId : null;
  const adoptedOutput = record(knownRuns.find(run => run.id === adoptedRunId)?.output);
  const referencedEvidence = useMemo(() => new Set(evidenceIds), [evidenceIds]);

  useEffect(() => {
    if (assistantJob.job?.state !== 'SUCCEEDED' || refreshedJob.current === assistantJob.job.id) return;
    refreshedJob.current = assistantJob.job.id;
    void onChanged();
  }, [assistantJob.job?.id, assistantJob.job?.state, onChanged]);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); setNotice(success); await onChanged(); }
    catch (caught) { setError(caught instanceof ApiError || caught instanceof Error ? caught.message : '操作未完成'); await onChanged(); }
    finally { setBusy(false); }
  }

  function toggleEvidence(id: string) {
    setEvidenceIds(values => values.includes(id) ? values.filter(value => value !== id) : [...values, id]);
  }
  function toggleDimensionEvidence(key: DimensionKey, id: string) {
    setDimensionRefs(values => ({...values, [key]: values[key].includes(id) ? values[key].filter(value => value !== id) : [...values[key], id]}));
  }
  function useAssistantDraft() {
    if (!aiOutput || !latestRun?.id) return;
    const nextText = {...dimensionText};
    const nextRefs = {...dimensionRefs};
    for (const [key] of dimensions) {
      const part = record(aiDimensions?.[key]);
      nextText[key] = text(part?.summary) ?? nextText[key];
      nextRefs[key] = currentRefs(textList(part?.evidence_ids));
    }
    setDimensionText(nextText); setDimensionRefs(nextRefs);
    setUnknowns(textList(aiOutput.unknowns).join('\n'));
    setCounterevidence(textList(aiOutput.counterevidence).join('\n'));
    setAssumptions(textList(aiOutput.assumptions).join('\n'));
    setEvidenceIds(currentRefs([...new Set([...textList(aiOutput.citations), ...Object.values(nextRefs).flat()])]));
    setAdoption({runId:latestRun.id,evidenceKey:currentEvidenceKey});
    setNotice(`${mode === 'pilot' ? '模型' : '模拟'}整理已复制到人工草稿；请核对后保存，内容不会自动成为事实。`);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (adoptedRunStale) { setError('已复制的模型草稿依据已变化，当前内容尚未保存。请刷新后复制最新草稿，或明确转为纯人工草稿；已填写内容会保留。'); return; }
    const dimensionPayload = Object.fromEntries(dimensions.map(([key]) => [key, {summary:dimensionText[key].trim(), evidence_ids:dimensionRefs[key]}]));
    void run(() => command(`/candidates/${data.candidate.id}/evaluations`, {
      expected_version:data.candidate.version, parent_revision_id:latest?.id ?? null, dimensions:dimensionPayload,
      evidence_ids:evidenceIds, unknowns:lines(unknowns), counterevidence:lines(counterevidence), assumptions:lines(assumptions),
      forecast:{currency:forecast.currency || null, window_start:toIso(forecast.window_start), window_end:toIso(forecast.window_end), revenue_basis:forecast.revenue_basis || null, units:forecast.units || null, metrics:Object.fromEntries(Object.keys(metricLabels).map(key => [key, forecast[key as keyof typeof forecast] || null]))},
      assistant_run_id: mode === 'pilot' ? adoptedRunId ?? undefined : undefined,
      assistant_versions:adoptedRunId && adoptedOutput ? {provider:text(adoptedOutput?.provider) ?? (mode === 'pilot' ? 'configured-model' : 'fixture'),model_version:text(adoptedOutput?.model_version) ?? (mode === 'pilot' ? 'recorded-on-run' : 'simulated'),prompt_version:text(adoptedOutput?.prompt_version) ?? 'unknown',schema_version:text(adoptedOutput?.schema_version) ?? 'unknown',node_run_id:adoptedRunId,is_simulated:String(mode === 'demo'),adoption:'human_reviewed'} : {},
    }), latest ? '已保存新的人工修订版本。' : '已保存第一版评估快照。');
  }

  return <section className="stack" id="stage-evaluation" aria-labelledby="evaluation-title">
    <div className="page-heading"><div><h2 id="evaluation-title">评估整理</h2><p className="muted">五个维度分别陈述判断、证据和未知项，不用总分替代业务决定。</p></div><button className="primary" type="button" disabled={busy || (mode === 'pilot' && ['QUEUED','RUNNING'].includes(assistantJob.job?.state ?? ''))} onClick={() => { void (mode === 'pilot' ? run(async () => { const response = await command<{job:PilotJob<{node_run?:NodeRun;output?:Record<string,unknown>}>}>(`/candidates/${data.candidate.id}/assistant-runs`, {expected_version:data.candidate.version,node_kind:'EVALUATION_ORGANIZER'}); assistantJob.remember(response.job); }, '评估整理已排队，可以离开本页后再返回查看。') : run(() => command(`/candidates/${data.candidate.id}/assistant-runs`, {expected_version:data.candidate.version,node_kind:'EVALUATION_ORGANIZER',fixture:'default'}), '模拟 AI 已按当前证据完成整理。')); }}>{mode === 'pilot' ? '整理评估草稿' : '运行模拟 AI 整理'}</button></div>
    {error && <div className="error" role="alert">{error} <button type="button" onClick={() => void onChanged()}>刷新最新版本</button></div>}
    {notice && <div className="notice" role="status">{notice}</div>}

    {latest ? <section className="panel stack" aria-labelledby="current-evaluation"><div className="toolbar"><h3 id="current-evaluation">当前评估 v{data.evaluations.length}</h3><span className="muted">{displayTime(latest.created_at)} · 标准 {latest.criteria_id}</span></div><div className="data-table"><table><thead><tr><th>维度</th><th>人工判断</th><th>引用证据</th></tr></thead><tbody>{dimensions.map(([key,label]) => <tr key={key}><td><strong>{label}</strong></td><td>{summary(latest,key) || '未知，尚未形成判断'}</td><td>{refs(latest,key).length ? refs(latest,key).map(id => <a href={`#evidence-${id}`} onClick={event => {event.preventDefault(); onShowEvidence(id);}} key={id}>{id} </a>) : '无'}</td></tr>)}</tbody></table></div><div className="split-view"><div><strong>未知项</strong><ul>{latest.unknowns.length ? latest.unknowns.map(item => <li key={item}>{item}</li>) : <li>无已记录未知项</li>}</ul></div><div><strong>反证</strong><ul>{latest.counterevidence.length ? latest.counterevidence.map(item => <li key={item}>{item}</li>) : <li>无已记录反证</li>}</ul></div></div></section> : <p className="empty">尚无评估快照。可先运行模拟整理，再由分析负责人核对并保存。</p>}

    {mode === 'pilot' && <JobStatus job={assistantJob.job} error={assistantJob.error} title="评估草稿整理" />}
    {latestRun && <section className="panel stack"><div className="toolbar"><h3>最近一次{mode === 'pilot' ? '评估草稿整理' : '模拟整理'}</h3><span className="badge">{!isDraftFresh(latestRun) ? '已过期' : adoptedRunId === latestRun.id ? '已复制，待保存' : latestRun.adoption_status === 'PENDING_REVIEW' ? '待人工复核' : mode === 'pilot' ? '待人工复核' : '模拟 AI'} · {latestRunState ?? '已记录'}</span></div>{aiOutput ? <><p>{text(aiOutput.summary) ?? '已生成结构化五维草稿，请逐项核对证据引用。'}</p><p className="muted">运行来源：{text(aiOutput.provider) ?? (mode === 'pilot' ? '已配置模型' : 'fixture')} / {text(aiOutput.model_version) ?? '版本见执行记录'} / {text(aiOutput.prompt_version) ?? '未标注'}</p><button className="secondary" type="button" disabled={Boolean(latestRun.is_stale || latestRun.adoption_status === 'STALE')} onClick={useAssistantDraft}>复制到人工修订草稿</button></> : <p className="muted">{latestRun.stale_reasons?.join('；') ?? '本次执行没有可采用的输出。'}{'error_summary' in latestRun ? latestRun.error_summary ?? latestRun.error ?? '' : ''}</p>}</section>}
    {runHistory.length > 0 && <details><summary>评估草稿历史（{runHistory.length}）</summary><ul className="timeline">{runHistory.map(run => <li key={run.id}><strong>{run.is_stale || run.adoption_status === 'STALE' ? '已过期' : '已完成'}</strong> · {displayTime(run.created_at)}<p>{run.is_stale || run.adoption_status === 'STALE' ? run.stale_reasons?.length ? run.stale_reasons.join('；') : '输入版本已变化，请重新整理草稿。' : `运行编号 ${run.id}`}</p></li>)}</ul></details>}
    {adoptedRunStale && <div className="error" role="alert"><strong>已复制的草稿已过期，保存已暂停。</strong><p>当前表单内容保留。请整理并复制最新草稿，或将这份内容明确转为纯人工草稿。</p><button type="button" className="secondary" onClick={() => {setAdoption(null);setNotice('已明确转为纯人工草稿；原填写内容保留，保存时不再关联过期模型运行。');setError('');}}>保留输入并转为纯人工草稿</button></div>}

    <details className="panel"><summary>{latest ? '人工修订并保存新版本' : '检查并保存评估快照'}</summary><form className="stack" onSubmit={submit}>
      {dimensions.map(([key,label]) => <fieldset className="stack" key={key}><legend>{label}</legend><label className="field">判断<textarea required value={dimensionText[key]} onChange={event => setDimensionText({...dimensionText,[key]:event.target.value})} placeholder="基于证据陈述判断；信息不足时明确写未知及影响" /></label><div className="field"><span>本维度证据</span>{currentEvidence.map(item => <label key={item.id}><input type="checkbox" checked={dimensionRefs[key].includes(item.id)} onChange={() => toggleDimensionEvidence(key,item.id)} /> {item.field} · {item.value ?? '未知'} · {item.id}</label>)}</div></fieldset>)}
      <div className="form-grid"><label className="field">未知项（每行一项）<textarea value={unknowns} onChange={event => setUnknowns(event.target.value)} /></label><label className="field">反证（每行一项）<textarea value={counterevidence} onChange={event => setCounterevidence(event.target.value)} /></label><label className="field">假设（每行一项）<textarea value={assumptions} onChange={event => setAssumptions(event.target.value)} /></label></div>
      <details><summary>预测口径与数值（可选，未知请留空）</summary><div className="form-grid"><label className="field">币种<input maxLength={3} value={forecast.currency} onChange={event => setForecast({...forecast,currency:event.target.value.toUpperCase()})} placeholder="USD" /></label><label className="field">窗口开始<input type="datetime-local" value={forecast.window_start} onChange={event => setForecast({...forecast,window_start:event.target.value})} /></label><label className="field">窗口结束<input type="datetime-local" value={forecast.window_end} onChange={event => setForecast({...forecast,window_end:event.target.value})} /></label><label className="field">收入口径<select value={forecast.revenue_basis} onChange={event => setForecast({...forecast,revenue_basis:event.target.value})}><option value="">未知</option><option value="GROSS">销售总额（GROSS）</option><option value="NET">净收入（NET）</option></select></label><label className="field">数量基数<input inputMode="decimal" pattern="[0-9]+([.][0-9]+)?" value={forecast.units} onChange={event => setForecast({...forecast,units:event.target.value})} /></label>{Object.entries(metricLabels).map(([key,label]) => <label className="field" key={key}>{label}<input inputMode="decimal" pattern="[0-9]+([.][0-9]+)?" value={forecast[key as keyof typeof forecast]} onChange={event => setForecast({...forecast,[key]:event.target.value})} /></label>)}</div></details>
      <div className="field"><span>评估总引用证据</span>{currentEvidence.map(item => <label key={item.id}><input type="checkbox" checked={referencedEvidence.has(item.id)} onChange={() => toggleEvidence(item.id)} /> {item.field} · {item.id}</label>)}</div>
      <p className="muted">草稿仅可引用当前证据，已被替代的引用需重新核对。{mode === 'pilot' ? '模型输出须经人工复核和修订，保存时会保留采用来源。' : '模拟输出只是整理建议，'}保存后生成新版本，历史评估与提交保持原样。</p>
      <button className="secondary" type="submit" disabled={busy || adoptedRunStale}>保存人工评估版本</button>
    </form></details>

    {data.evaluations.length > 1 && <details><summary>历史评估版本（{data.evaluations.length - 1}）</summary><ol className="timeline">{data.evaluations.slice(0,-1).reverse().map((item,index) => <li key={item.id}><strong>v{data.evaluations.length-index-1}</strong> · {displayTime(item.created_at)} · 标准 {item.criteria_id} · 引用 {item.evidence_ids.length} 条证据</li>)}</ol></details>}
  </section>;
}
