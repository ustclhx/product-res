import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from '../../app/client';
import { displayTime } from '../evidence/types';

type UsageItem = {
  id:string; attempt_id:string; job_id:string; candidate_id:string; project_id:string; node_kind:string;
  model:string | null; input_bytes:number | null; input_tokens:number | null; output_tokens:number | null;
  total_tokens:number | null; elapsed_ms:number | null; max_output_tokens:number | null; max_total_tokens:number | null;
  finish_reason:string | null; request_id:string | null; cost:string | number | null; currency:string | null;
  outcome_status:string; error_code:string | null; recorded_at:string;
};
type UsageResponse = {items:UsageItem[];summary:{receipt_count:number;unrecorded_attempt_count:number;usage_known_count:number;usage_partial_count:number;usage_unknown_count:number;input_tokens_known_sum:number;output_tokens_known_sum:number;total_tokens_known_sum:number;cost_by_currency:Array<{currency:string;cost:string | number}>}};

function amount(value:number | string | null | undefined):string { return value === null || value === undefined ? '未知' : Number(value).toLocaleString('zh-CN'); }
function friendlyStatus(value:string):string { return ({success:'成功',provider_error:'服务错误',invalid_json:'JSON 无效',invalid_schema:'格式不符',invalid_reference:'引用无效',truncated:'输出截断',rejected_before_send:'发送前拒绝',network_error:'网络错误',unknown_error:'未知错误',cancelled:'已取消',stale:'结果已过期',access_changed:'权限已变化'} as Record<string,string>)[value] ?? value; }

export default function ModelUsagePanel({candidateId,projectId}:{candidateId:string;projectId:string}) {
  const [exporting,setExporting] = useState(false);
  const [exportError,setExportError] = useState('');
  const query = useQuery({queryKey:['candidate-model-usage',candidateId,projectId],queryFn:() => api<UsageResponse>(`/pilot/model-usage?candidate_id=${encodeURIComponent(candidateId)}&project_id=${encodeURIComponent(projectId)}`),retry:false,refetchInterval:15000});
  const summary = query.data?.summary;
  async function exportCsv() {
    setExporting(true); setExportError('');
    try {
      const response = await fetch(`/api/v1/pilot/model-usage/export?candidate_id=${encodeURIComponent(candidateId)}&project_id=${encodeURIComponent(projectId)}`,{credentials:'same-origin'});
      if (!response.ok) {
        let message = '导出失败，请稍后重试。';
        try { const body = await response.json() as {message?:string}; message = body.message ?? message; } catch { /* Keep the clear fallback for non-JSON errors. */ }
        throw new Error(message);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = `model-usage-${candidateId}.csv`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) { setExportError(error instanceof ApiError || error instanceof Error ? error.message : '导出失败，请稍后重试。'); }
    finally { setExporting(false); }
  }
  return <details className="panel model-usage" data-testid="model-usage">
    <summary>模型调用记录{summary ? ` · ${summary.receipt_count} 次 · 已知 ${amount(summary.total_tokens_known_sum)} tokens` : ''}</summary>
    {query.isPending && <p role="status">正在加载调用记录…</p>}
    {query.isError && <div className="error" role="alert">模型调用记录暂时无法加载。{query.error instanceof Error ? ` ${query.error.message}` : ''}<button type="button" className="secondary" onClick={() => void query.refetch()}>重试</button></div>}
    {summary && <div className="model-usage__summary"><span>调用 {summary.receipt_count} 次</span><span>用量已知 {summary.usage_known_count} 次</span><span>用量部分已知 {summary.usage_partial_count} 次</span><span>用量未知 {summary.usage_unknown_count} 次</span><span>已知输入 {amount(summary.input_tokens_known_sum)} tokens</span><span>已知输出 {amount(summary.output_tokens_known_sum)} tokens</span><span>已知总计 {amount(summary.total_tokens_known_sum)} tokens</span><span>未记录尝试 {summary.unrecorded_attempt_count} 次</span>{summary.cost_by_currency.map(item => <span key={item.currency}>成本 {amount(item.cost)} {item.currency}</span>)}</div>}
    <div className="toolbar"><button type="button" className="secondary" disabled={exporting} onClick={() => void exportCsv()}>{exporting ? '正在导出…' : '导出 CSV'}</button></div>
    {exportError && <p className="error" role="alert">{exportError}</p>}
    {query.data?.items.length ? <div className="table-scroll"><table><thead><tr><th>时间</th><th>节点 / 模型</th><th>状态</th><th>Tokens</th><th>耗时</th><th>限制 / 结束原因</th><th>成本</th></tr></thead><tbody>{query.data.items.map(item => <tr key={item.id}><td>{displayTime(item.recorded_at)}</td><td>{item.node_kind}<br/><span className="muted">{item.model ?? '模型未知'}</span></td><td>{friendlyStatus(item.outcome_status)}{item.error_code ? <><br/><span className="muted">{item.error_code}</span></> : null}</td><td>入 {amount(item.input_tokens)} / 出 {amount(item.output_tokens)} / 总 {amount(item.total_tokens)}</td><td>{item.elapsed_ms === null ? '未知' : `${amount(item.elapsed_ms)} ms`}</td><td>{item.max_output_tokens === null && item.max_total_tokens === null ? '限制未知' : `输出 ${amount(item.max_output_tokens)} / 总计 ${amount(item.max_total_tokens)}`}<br/><span className="muted">{item.finish_reason ?? '结束原因未知'}</span></td><td>{item.cost === null ? '未知' : `${amount(item.cost)} ${item.currency ?? ''}`}</td></tr>)}</tbody></table></div> : !query.isPending && !query.isError ? <p className="muted">暂无模型调用记录。</p> : null}
    <p className="muted">成本与用量仅显示服务端已记录的数据；未知项不会按零估算。</p>
  </details>;
}
