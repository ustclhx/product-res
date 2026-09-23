import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { command } from '../../app/client';
import type { PilotJob, PilotJobState } from './jobs';

const activeStates = new Set<PilotJobState>(['QUEUED', 'RUNNING']);
const stateText: Record<PilotJobState, string> = {
  QUEUED: '已排队', RUNNING: '正在整理', SUCCEEDED: '已完成', FAILED: '执行失败', CANCELLED: '已取消', OUTCOME_UNKNOWN: '结果暂时无法确认',
};

export function JobStatus<T>({ job, error, title = '后台任务', children }: { job?: PilotJob<T>; error?: Error | null; title?: string; children?: (result: T) => ReactNode }) {
  const queryClient = useQueryClient();
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState('');
  async function cancel() {
    if (job?.version == null) return;
    setCancelBusy(true); setCancelError('');
    try {
      await command(`/pilot/jobs/${job.id}/cancel`, {expected_version:job.version});
      await queryClient.invalidateQueries({queryKey:['pilot-job']});
    } catch (reason) { setCancelError(reason instanceof Error ? reason.message : '取消未完成，请重试。'); }
    finally { setCancelBusy(false); }
  }
  if (error) return <div className="error" role="alert"><strong>{title}状态读取失败</strong><p>{error.message}</p><p>任务编号已保留，刷新页面后会继续读取。</p></div>;
  if (!job) return null;
  const active = activeStates.has(job.state);
  const resultRecord = typeof job.result === 'object' && job.result !== null ? job.result as Record<string, unknown> : null;
  const nodeRun = typeof resultRecord?.node_run === 'object' && resultRecord.node_run !== null ? resultRecord.node_run as Record<string, unknown> : null;
  const staleReasons = Array.isArray(nodeRun?.stale_reasons) ? nodeRun.stale_reasons.filter((item): item is string => typeof item === 'string') : [];
  return <section className={`job-status job-status--${job.state.toLowerCase()}`} aria-live="polite" aria-busy={active}>
    <div className="job-status__heading"><div><strong>{title}：{stateText[job.state]}</strong><p>{job.state === 'QUEUED' ? '已保存请求，等待可用执行名额。' : job.state === 'RUNNING' ? '可以离开本页，稍后返回仍会继续显示进度。' : job.state === 'OUTCOME_UNKNOWN' ? '外部请求可能已经执行。为避免重复计费，系统不会自动重试。请先核对记录，再明确发起新任务。' : job.state === 'FAILED' ? (job.error_message ?? '本次任务未完成。请检查配置或材料后重新发起。') : job.stale ? '整理依据已变化，输出只保留为历史，不能直接采用。' : '结果已保存，请人工检查后继续。'}</p>{job.stale && staleReasons.length > 0 && <ul aria-label="草稿失效原因">{staleReasons.map((reason,index) => <li key={`${index}-${reason}`}>{reason}</li>)}</ul>}</div><div className="mini-actions"><span className={`badge ${job.state === 'FAILED' || job.state === 'OUTCOME_UNKNOWN' || job.stale ? 'warning' : ''}`}>{job.stale ? '已过期' : stateText[job.state]}</span>{active && job.version != null && <button type="button" disabled={cancelBusy} onClick={() => void cancel()}>{cancelBusy ? '正在取消…' : '取消任务'}</button>}</div></div>
    {cancelError && <p className="error" role="alert">{cancelError}</p>}
    {job.state === 'SUCCEEDED' && !job.stale && job.result != null && children?.(job.result)}
    <details><summary>查看执行记录</summary><p className="small muted">任务编号 <code>{job.id}</code>{job.updated_at ? ` · 更新于 ${new Date(job.updated_at).toLocaleString('zh-CN', { hour12: false })}` : ''}</p>{job.attempts?.length ? <ol className="timeline">{job.attempts.map((attempt, index) => <li key={attempt.id ?? index}>第 {index + 1} 次 · {attempt.state ?? '状态未知'}{attempt.error_message ? ` · ${attempt.error_message}` : ''}{attempt.historical_output != null && <details><summary>历史输出（不可采用）</summary><pre className="small" style={{whiteSpace:'pre-wrap', overflowWrap:'anywhere'}}>{JSON.stringify(attempt.historical_output, null, 2)}</pre></details>}</li>)}</ol> : <p className="muted">暂无更多执行明细。</p>}</details>
  </section>;
}
