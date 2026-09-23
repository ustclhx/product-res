import { useState, type ChangeEvent, type FormEvent } from "react";
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { command, preview } from "../../app/client";
import { api } from '../../app/client';
import { useWorkspace } from '../../app/workspace';
import { JobStatus } from '../pilot/JobStatus';
import { useDurableJob, type PilotJob } from '../pilot/jobs';
import type { Channel } from "../../generated/contracts";

const MAX_CSV_BYTES = 2 * 1024 * 1024;

type EntryMode = "discover" | "manual" | "csv";
type BusyAction = "discover" | "recover" | "add-discovered" | "manual" | "read-file" | "preview" | "confirm";
type CsvRowChoice = "select" | "skip";
type DiscoveryCoverage = "COVERED" | "NO_SAMPLE_COVERAGE" | "NO_COVERAGE" | "EMPTY";
type CsvRowStatus = "VALID" | "INVALID" | "DUPLICATE";

interface IntakePanelProps {
  projectId: string;
  projectChannel: string;
  projectDirection?: string;
  projectVersion: number;
  onChanged: () => Promise<void>;
}

interface DiscoveryItem {
  item_id?: string;
  title: string;
  external_id: string;
  source_url: string;
  source_ref: string;
  channel: Channel;
  market: string;
  is_demo: boolean;
}

interface DiscoveryResult {
  coverage: DiscoveryCoverage;
  query: string;
  channel: Channel;
  market: string;
  provider?: string;
  provider_version: string;
  is_demo?: boolean;
  batch?: { id: string; source_id?: string; query?: string; market?: string; location?: string; collected_at?: string };
  items: DiscoveryItem[];
}

type PilotSource = { id: string; label: string; status: 'READY' | 'NOT_CONFIGURED' | 'CREDENTIAL_MISSING' | 'AUTHORIZATION_REQUIRED' | 'LIMIT_REQUIRED' | 'RETENTION_REQUIRED' | 'QUOTA_EXHAUSTED'; channel: string; market: string; request_limit: number; requests_reserved: number; requests_remaining: number; result_limit: number; timeout_seconds: number | null; query_scope: { channel: string; market: string; location: string; language: string }; is_demo: false };
const sourceStatusText: Record<PilotSource['status'], string> = { READY:'可查询', NOT_CONFIGURED:'未配置', CREDENTIAL_MISSING:'缺少凭据', AUTHORIZATION_REQUIRED:'待确认授权', LIMIT_REQUIRED:'待设置额度', RETENTION_REQUIRED:'待确认留存', QUOTA_EXHAUSTED:'额度已用完' };
type DiscoveryJob = PilotJob<DiscoveryResult> & { job_kind?: string; project_id?: string; provider?: string; query?: string; batch_metadata?: { id?: string; query?: string; market?: string; location?: string; language?: string; collected_at?: string; item_count?: number; request_id?: string; cost?: number | null } | null; recovery?: { kind: string; supported: boolean; message: string } | null };

interface CsvMapping {
  title: string;
  external_id: string | null;
  source_url: string | null;
  sku: string | null;
}

interface CsvValues {
  title: string | null;
  external_id: string | null;
  source_url: string | null;
  sku: string | null;
}

interface CsvPreviewRow {
  row_number: number;
  status: CsvRowStatus;
  values: CsvValues;
  errors: string[];
  duplicate_candidate_id: string | null;
  similar_title_candidate_ids: string[];
}

interface CsvPreview {
  project: { id: string; channel: Channel; market: string };
  summary_hash: string;
  mapping: CsvMapping;
  rows: CsvPreviewRow[];
  counts: { valid: number; invalid: number; duplicate: number; total: number };
  limits: { max_bytes: number; max_rows: number };
}

interface CandidateWriteResult {
  reused: boolean;
}

interface CsvConfirmResult {
  created_count: number;
  reused_count: number;
  skipped_rows: number[];
}

interface ManualFields {
  title: string;
  external_id: string;
  source_url: string;
  sku: string;
}

const DEFAULT_MAPPING_INPUTS: Record<keyof CsvMapping, string> = {
  title: "title",
  external_id: "external_id",
  source_url: "source_url",
  sku: "sku",
};

const EMPTY_MANUAL: ManualFields = { title: "", external_id: "", source_url: "", sku: "" };

function messageFrom(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

function optionalText(value: string): string | null {
  const normalized = value.trim();
  return normalized || null;
}

function contentBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function IntakePanel({ projectId, projectChannel, projectDirection = '', projectVersion, onChanged }: IntakePanelProps) {
  const { mode: runtimeMode, session } = useWorkspace();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<EntryMode>("discover");
  const [direction, setDirection] = useState(projectDirection);
  const [demoResults, setDemoResults] = useState<DiscoveryItem[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [recoveryTaskId, setRecoveryTaskId] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [manual, setManual] = useState<ManualFields>(EMPTY_MANUAL);
  const [csv, setCsv] = useState("");
  const [csvFilename, setCsvFilename] = useState("candidates.csv");
  const [mappingInputs, setMappingInputs] = useState(DEFAULT_MAPPING_INPUTS);
  const [previewData, setPreviewData] = useState<CsvPreview | null>(null);
  const [rowChoices, setRowChoices] = useState<Record<number, CsvRowChoice>>({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [selectedJobId, setSelectedJobId] = useState('');
  const sourcesQuery = useQuery({ queryKey: ['pilot-sources'], queryFn: () => api<{ items: PilotSource[] }>('/pilot/sources'), enabled: runtimeMode === 'pilot', retry: false });
  const sources = sourcesQuery.data?.items ?? [];
  const discoverySources = sources.filter(source => source.id !== 'newapi' && source.channel === projectChannel);
  const effectiveSourceId = sourceId || discoverySources.find(item => item.status === 'READY')?.id || discoverySources[0]?.id || '';
  const discoveryJob = useDurableJob<DiscoveryResult>(`discovery:${projectId}`);
  const historyQuery = useQuery({
    queryKey: ['pilot-discovery-history', session?.workspace.id, projectId, effectiveSourceId],
    queryFn: () => api<{ items: DiscoveryJob[] }>(`/projects/${encodeURIComponent(projectId)}/discovery/history?provider=${encodeURIComponent(effectiveSourceId)}`),
    enabled: runtimeMode === 'pilot' && Boolean(effectiveSourceId),
    retry: false,
  });
  const pilotResult = discoveryJob.job?.state === 'SUCCEEDED' ? discoveryJob.job.result ?? undefined : undefined;
  const discoveryResult = runtimeMode === 'pilot' ? pilotResult : undefined;
  const results = runtimeMode === 'pilot' ? discoveryResult?.items ?? [] : demoResults;
  const discoveryJobs = historyQuery.data?.items ?? [];
  const activeJobId = selectedJobId || discoveryJob.jobId;
  const shownJob: DiscoveryJob | undefined = discoveryJob.job;

  const isBusy = busy !== null;

  function begin(action: BusyAction): void {
    setBusy(action);
    setError("");
    setMessage("");
  }

  function changeMode(nextMode: EntryMode): void {
    setMode(nextMode);
    setError("");
    setMessage("");
  }

  function changeCsv(nextCsv: string): void {
    setCsv(nextCsv);
    setPreviewData(null);
    setRowChoices({});
  }

  function resolvedMapping(): CsvMapping | null {
    const title = mappingInputs.title.trim();
    if (!title) {
      setError("商品名称的列名不能为空。");
      return null;
    }
    return {
      title,
      external_id: optionalText(mappingInputs.external_id),
      source_url: optionalText(mappingInputs.source_url),
      sku: optionalText(mappingInputs.sku),
    };
  }

  async function discover(): Promise<void> {
    const query = direction.trim();
    if (!query) {
      setError("请输入研究方向，或先在项目中填写方向。");
      return;
    }
    begin("discover");
    try {
      const data = await command<DiscoveryResult | { job: PilotJob<DiscoveryResult> }>(`/projects/${projectId}/discovery`, {
        query,
        expected_version: projectVersion,
        ...(runtimeMode === 'pilot' ? { provider: effectiveSourceId } : {}),
      });
      if ('job' in data) {
        discoveryJob.remember(data.job);
        setSelectedJobId(data.job.id);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['pilot-sources'] }),
          queryClient.invalidateQueries({ queryKey: ['pilot-discovery-history', session?.workspace.id, projectId] }),
        ]);
        setMessage('新的外部查询已排队并占用 1 次请求额度。可以离开本页，返回后仍会继续显示结果。');
      } else {
        setDemoResults(data.items);
        if (data.coverage === "NO_SAMPLE_COVERAGE") setMessage("示例发现目前只覆盖露营方向。你可以换成“户外露营”，或使用手工与 CSV 导入。");
        else setMessage(`找到 ${data.items.length} 个 ${data.channel} / ${data.market} 示例候选。`);
      }
      setChosen([]);
    } catch (reason: unknown) {
      setError(messageFrom(reason, "发现服务暂时不可用。"));
    } finally {
      setBusy(null);
    }
  }

  function openExistingJob(): void {
    const job = discoveryJobs.find(item => item.id === selectedJobId);
    if (job) {
      discoveryJob.remember(job);
      setChosen([]);
      setMessage('已复用历史记录；本次查看没有发起外部请求，也没有占用新额度。');
    }
  }

  async function recoverDataForSEO(): Promise<void> {
    if (!shownJob?.id || !shownJob.version || !recoveryTaskId.trim()) return;
    begin('recover');
    try {
      const response = await command<{ job: DiscoveryJob; reused: boolean }>(`/pilot/jobs/${shownJob.id}/recover-dataforseo`, {
        expected_version: shownJob.version,
        task_id: recoveryTaskId.trim(),
      });
      discoveryJob.remember(response.job);
      setSelectedJobId(response.job.id);
      await queryClient.invalidateQueries({ queryKey: ['pilot-discovery-history', session?.workspace.id, projectId] });
      setMessage(response.reused ? '该原任务已恢复，继续复用同一历史批次。' : '已通过供应商免费核对取回原结果；没有重发市场查询。');
    } catch (reason: unknown) {
      setError(messageFrom(reason, '原任务恢复未完成。请核对 task ID 与供应商记录。'));
    } finally {
      setBusy(null);
    }
  }

  async function addDiscovered(): Promise<void> {
    const selected = results.filter((item) => chosen.includes(item.item_id ?? item.external_id));
    if (selected.length === 0) return;
    begin("add-discovered");
    let completed = 0;
    try {
      for (const item of selected) {
        try {
          await command<CandidateWriteResult>(`/projects/${projectId}/discovery/candidates`, runtimeMode === 'pilot' ? {
            batch_id: discoveryResult?.batch?.id,
            item_id: item.item_id,
            expected_version: projectVersion,
          } : { selection: item, expected_version: projectVersion });
          completed += 1;
          setChosen((current) => current.filter((externalId) => externalId !== (item.item_id ?? item.external_id)));
        } catch (reason: unknown) {
          if (completed > 0) await onChanged();
          throw new Error(
            completed > 0
              ? `已纳入 ${completed} 个候选，随后操作失败：${messageFrom(reason, "纳入候选失败。")}`
              : messageFrom(reason, "纳入候选失败。"),
            { cause: reason },
          );
        }
      }
      await onChanged();
      setMessage(`已纳入 ${completed} 个候选，并保留${runtimeMode === 'pilot' ? '查询批次与真实' : '示例发现'}来源。`);
    } catch (reason: unknown) {
      setError(messageFrom(reason, "纳入候选失败。"));
    } finally {
      setBusy(null);
    }
  }

  async function addManual(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const title = manual.title.trim();
    if (!title) {
      setError("商品名称不能为空。");
      return;
    }
    begin("manual");
    try {
      const result = await command<CandidateWriteResult>(`/projects/${projectId}/candidates`, {
        title,
        external_id: optionalText(manual.external_id),
        source_url: optionalText(manual.source_url),
        sku: optionalText(manual.sku),
        expected_version: projectVersion,
      });
      setManual(EMPTY_MANUAL);
      await onChanged();
      setMessage(result.reused ? "已为现有候选追加手工来源。" : "手工候选已加入候选池。");
    } catch (reason: unknown) {
      setError(messageFrom(reason, "手工候选导入失败。"));
    } finally {
      setBusy(null);
    }
  }

  async function readFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;
    setError("");
    setMessage("");
    setPreviewData(null);
    setRowChoices({});
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("仅支持 .csv 文件。");
      return;
    }
    if (file.size > MAX_CSV_BYTES) {
      setError("CSV 文件不能超过 2 MiB，请拆分后再导入。");
      return;
    }
    setBusy("read-file");
    try {
      const buffer = await file.arrayBuffer();
      const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      setCsvFilename(file.name);
      setCsv(content);
      setMessage(`已读取 ${file.name}，请确认列名映射后生成预览。`);
    } catch (reason: unknown) {
      setError(messageFrom(reason, "文件不是有效的 UTF-8 CSV。"));
    } finally {
      setBusy(null);
    }
  }

  async function inspectCsv(): Promise<void> {
    if (!csv.trim()) {
      setError("请先粘贴 CSV 内容或选择文件。");
      return;
    }
    if (contentBytes(csv) > MAX_CSV_BYTES) {
      setError("CSV 内容不能超过 2 MiB，请拆分后再导入。");
      return;
    }
    const mapping = resolvedMapping();
    if (!mapping) return;
    begin("preview");
    try {
      const data = await preview<CsvPreview>("/candidate-imports/preview", {
        project_id: projectId,
        filename: csvFilename,
        content: csv,
        mapping,
      });
      setPreviewData(data);
      setRowChoices(
        Object.fromEntries(
          data.rows.map((row) => [row.row_number, row.status === "INVALID" ? "skip" : "select"]),
        ),
      );
      setMessage(`预览完成：共 ${data.counts.total} 行。请逐行确认导入或跳过。`);
    } catch (reason: unknown) {
      setError(messageFrom(reason, "无法生成 CSV 导入预览。"));
    } finally {
      setBusy(null);
    }
  }

  async function commitCsv(): Promise<void> {
    if (!previewData || previewData.rows.length === 0) return;
    const unresolved = previewData.rows.filter((row) => !rowChoices[row.row_number]);
    if (unresolved.length > 0) {
      setError(`请为第 ${unresolved.map((row) => row.row_number).join("、")} 行选择“导入”或“跳过”。`);
      return;
    }
    const invalidSelected = previewData.rows.filter(
      (row) => row.status === "INVALID" && rowChoices[row.row_number] === "select",
    );
    if (invalidSelected.length > 0) {
      setError(`第 ${invalidSelected.map((row) => row.row_number).join("、")} 行无效，不能导入。`);
      return;
    }
    const selectedRows = previewData.rows
      .filter((row) => rowChoices[row.row_number] === "select")
      .map((row) => row.row_number);
    const skippedRows = previewData.rows
      .filter((row) => rowChoices[row.row_number] === "skip")
      .map((row) => row.row_number);
    begin("confirm");
    try {
      const result = await command<CsvConfirmResult>("/candidate-imports/confirm", {
        project_id: projectId,
        filename: csvFilename,
        content: csv,
        mapping: previewData.mapping,
        summary_hash: previewData.summary_hash,
        selected_rows: selectedRows,
        skipped_rows: skippedRows,
        expected_version: projectVersion,
      });
      setPreviewData(null);
      setRowChoices({});
      setCsv("");
      setCsvFilename("candidates.csv");
      await onChanged();
      setMessage(
        `CSV 导入完成：新建 ${result.created_count} 个，追加来源 ${result.reused_count} 个，跳过 ${result.skipped_rows.length} 行。`,
      );
    } catch (reason: unknown) {
      setError(messageFrom(reason, "CSV 提交失败。"));
    } finally {
      setBusy(null);
    }
  }

  function setChoice(rowNumber: number, choice: CsvRowChoice): void {
    setRowChoices((current) => ({ ...current, [rowNumber]: choice }));
  }

  return (
    <section className="panel intake-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">候选入口</p><h2>把机会纳入候选池</h2></div>
        <span className="muted">先预览，再写入</span>
      </div>

      <div className="tabs" role="tablist" aria-label="候选录入方式">
        {([["discover", "按方向发现"], ["manual", "手工添加"], ["csv", "CSV 导入"]] as const).map(([value, label]) => (
          <button
            className={mode === value ? "tab tab--active" : "tab"}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => changeMode(value)}
            key={value}
          >
            {label}
          </button>
        ))}
      </div>

      {message && <div className="notice" role="status">{message}</div>}
      {error && <div className="error" role="alert">{error}</div>}

      {mode === "discover" && (
        <div className="intake-body">
          {runtimeMode === 'pilot' && <>{!sourcesQuery.isPending && !sourcesQuery.isError && discoverySources.length === 0 && <p className="muted">首轮数据源未覆盖此渠道，可使用手工或 CSV 纳入候选。</p>}<label className="field">查询来源<select value={effectiveSourceId} onChange={event => { setSourceId(event.target.value); setSelectedJobId(''); }} disabled={isBusy || sourcesQuery.isPending}><option value="">请选择来源</option>{discoverySources.map(source => <option key={source.id} value={source.id} disabled={source.status !== 'READY'}>{source.label} · {sourceStatusText[source.status]}</option>)}</select></label>{sourcesQuery.isError && <div className="error" role="alert">无法读取真实来源状态。仍可使用手工或 CSV 导入。</div>}{discoverySources.length > 0 && <div className="source-status-list">{discoverySources.map(source => <div key={source.id}><strong>{source.label}</strong><span className={`badge ${source.status !== 'READY' ? 'warning' : ''}`}>{sourceStatusText[source.status]}</span><p className="muted">{source.channel} · {source.market} · {source.query_scope?.location ?? '美国'} / {source.query_scope?.language ?? '英语'} · 每次最多 {source.result_limit} 条 · 等待上限 {source.timeout_seconds ?? '配置异常'} 秒</p><p className="muted">剩余 {source.requests_remaining ?? 0} 次；已预留 {source.requests_reserved}/{source.request_limit} 次请求{source.status !== 'READY' ? '。可继续复用历史、手工或 CSV 导入。' : ''}</p></div>)}</div>}</>}
          {runtimeMode === 'pilot' && <div className="field">
            <label htmlFor="existing-discovery-job">已有市场查询批次</label>
            <div className="form-actions">
              <select id="existing-discovery-job" value={activeJobId} onChange={event => setSelectedJobId(event.target.value)} disabled={isBusy || historyQuery.isPending}>
                <option value="">选择已有查询批次</option>
                {discoveryJobs.map(job => <option key={job.id} value={job.id}>{job.created_at ? new Date(job.created_at).toLocaleString('zh-CN', { hour12: false }) : job.id} · {job.query ?? '未记录方向'} · {{ QUEUED: '排队中', RUNNING: '执行中', SUCCEEDED: '已完成', FAILED: '失败', CANCELLED: '已取消', OUTCOME_UNKNOWN: '结果待确认' }[job.state]}</option>)}
              </select>
              <button className="secondary" type="button" onClick={openExistingJob} disabled={isBusy || !selectedJobId}>复用所选历史（不占额度）</button>
            </div>
            {historyQuery.isError && <p className="error" role="alert">无法读取已有查询批次。仍可发起新查询或使用手工、CSV 导入。</p>}
            {!historyQuery.isPending && !historyQuery.isError && discoveryJobs.length === 0 && <p className="muted">当前项目和来源还没有市场查询历史。</p>}
          </div>}
          <label className="field">研究方向
            <input value={direction} onChange={(event) => setDirection(event.target.value)} placeholder="填写项目研究方向" disabled={isBusy} />
          </label>
          <button className="primary" type="button" onClick={() => void discover()} disabled={isBusy || (runtimeMode === 'pilot' && discoverySources.find(source => source.id === effectiveSourceId)?.status !== 'READY')}>
            {busy === "discover" ? "正在提交…" : runtimeMode === 'pilot' ? '刷新：发起新的外部查询（可能计费）' : "发现示例候选"}
          </button>
          <p className="muted">{runtimeMode === 'pilot' ? '刷新会占用一次服务端请求额度。查询结果是指定来源在当前时间返回的有限线索，不代表市场全量或真实销量。' : '示例发现服务覆盖预置的露营方向关键词，也可使用手工与 CSV 导入。'}</p>
          {runtimeMode === 'pilot' && <JobStatus job={discoveryJob.job} error={discoveryJob.error} title="市场查询" />}
          {runtimeMode === 'pilot' && shownJob?.batch_metadata && <p className="muted">当前观察：{shownJob.batch_metadata.query ?? shownJob.query} · {shownJob.batch_metadata.market} / {shownJob.batch_metadata.location} / {shownJob.batch_metadata.language} · {shownJob.batch_metadata.collected_at ? new Date(shownJob.batch_metadata.collected_at).toLocaleString('zh-CN', { hour12: false }) : '时间未知'} · {shownJob.batch_metadata.item_count ?? 0} 条</p>}
          {runtimeMode === 'pilot' && shownJob?.recovery && <div className="notice"><p>{shownJob.recovery.message}</p>{shownJob.recovery.supported && shownJob.recovery.kind === 'DATAFORSEO_TASK_ID' && <div className="form-actions"><input aria-label="DataForSEO task ID" value={recoveryTaskId} onChange={event => setRecoveryTaskId(event.target.value)} placeholder="DataForSEO task ID" disabled={isBusy} /><button className="secondary" type="button" onClick={() => void recoverDataForSEO()} disabled={isBusy || !recoveryTaskId.trim()}>{busy === 'recover' ? '正在免费核对…' : '核对并恢复原结果（不重发查询）'}</button></div>}</div>}
          {runtimeMode === 'pilot' && discoveryResult && results.length === 0 && <div className="empty"><strong>{discoveryResult.coverage === 'NO_COVERAGE' ? '该来源不覆盖当前渠道或市场' : '本次查询没有返回匹配结果'}</strong><p>可调整方向、更换可用来源，或使用手工与 CSV 导入。</p></div>}
          {results.length > 0 && (
            <>
              <div className="candidate-picks">
                {results.map((item) => (
                  <label className="candidate-pick" key={item.item_id ?? item.external_id}>
                    <input
                      type="checkbox"
                      checked={chosen.includes(item.item_id ?? item.external_id)}
                      disabled={isBusy}
                      onChange={(event) => setChosen((current) => event.target.checked
                        ? [...current, item.item_id ?? item.external_id]
                        : current.filter((externalId) => externalId !== (item.item_id ?? item.external_id)))}
                    />
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.external_id} · {item.channel} / {item.market} · {item.is_demo ? '示例数据（模拟发现）' : '真实来源线索，待人工核验'}</small>
                    </span>
                  </label>
                ))}
              </div>
              <button className="primary" type="button" disabled={isBusy || chosen.length === 0} onClick={() => void addDiscovered()}>
                {busy === "add-discovered" ? "正在纳入…" : `纳入已选择候选（${chosen.length}）`}
              </button>
            </>
          )}
        </div>
      )}

      {mode === "manual" && (
        <form className="form-grid intake-body" onSubmit={(event) => void addManual(event)}>
          <label className="field field-wide">商品名称
            <input required maxLength={300} value={manual.title} disabled={isBusy} onChange={(event) => setManual({ ...manual, title: event.target.value })} />
          </label>
          <label className="field">外部商品标识
            <input maxLength={200} value={manual.external_id} disabled={isBusy} onChange={(event) => setManual({ ...manual, external_id: event.target.value })} placeholder="ASIN / SKU / 自定义编号" />
          </label>
          <label className="field">SKU
            <input maxLength={200} value={manual.sku} disabled={isBusy} onChange={(event) => setManual({ ...manual, sku: event.target.value })} />
          </label>
          <label className="field field-wide">来源链接
            <input type="url" maxLength={2000} value={manual.source_url} disabled={isBusy} onChange={(event) => setManual({ ...manual, source_url: event.target.value })} placeholder="https://…" />
          </label>
          <div className="form-actions">
            <button className="primary" type="submit" disabled={isBusy}>{busy === "manual" ? "正在加入…" : "加入候选池"}</button>
          </div>
        </form>
      )}

      {mode === "csv" && (
        <div className="intake-body">
          <label className="field">CSV 文件（UTF-8，最多 2 MiB / 1000 行）
            <input type="file" accept=".csv,text/csv" onChange={(event) => void readFile(event)} disabled={isBusy} />
          </label>
          <label className="field">或粘贴 CSV 文本
            <textarea
              rows={6}
              value={csv}
              disabled={isBusy}
              onChange={(event) => changeCsv(event.target.value)}
              placeholder={"title,external_id,source_url,sku\n折叠露营桌,SKU-001,https://example.invalid/item,DESK-01"}
            />
          </label>
          <details>
            <summary>列名映射（4 个字段）</summary>
            <div className="form-grid">
              {([["title", "商品名称列（必填）"], ["external_id", "外部标识列"], ["source_url", "来源链接列"], ["sku", "SKU 列"]] as const).map(([field, label]) => (
                <label className="field" key={field}>{label}
                  <input
                    value={mappingInputs[field]}
                    disabled={isBusy}
                    onChange={(event) => {
                      setMappingInputs((current) => ({ ...current, [field]: event.target.value }));
                      setPreviewData(null);
                      setRowChoices({});
                    }}
                    placeholder={field === "title" ? "CSV 中的列名" : "留空表示不导入"}
                  />
                </label>
              ))}
            </div>
          </details>
          <button className="primary" type="button" onClick={() => void inspectCsv()} disabled={isBusy}>
            {busy === "read-file" ? "正在读取文件…" : busy === "preview" ? "正在生成预览…" : "生成导入预览"}
          </button>

          {previewData && (
            <div className="import-preview">
              <div className="preview-stats" aria-label="CSV 预览统计">
                <span>有效 {previewData.counts.valid}</span>
                <span className="warning">无效 {previewData.counts.invalid}</span>
                <span>重复 {previewData.counts.duplicate}</span>
                <span>总计 {previewData.counts.total}</span>
              </div>
              {previewData.rows.length === 0 ? (
                <p className="empty">CSV 中没有数据行。</p>
              ) : (
                <table className="data-table">
                  <caption>逐行选择导入或跳过；重复行可以导入，以便为现有候选保留这次 CSV 来源。</caption>
                  <thead><tr><th>行号</th><th>候选内容</th><th>校验结果</th><th>处理方式</th></tr></thead>
                  <tbody>
                    {previewData.rows.map((row) => (
                      <tr key={row.row_number}>
                        <td>{row.row_number}</td>
                        <td>
                          <strong>{row.values.title || "未填写名称"}</strong><br />
                          <span className="muted">外部标识：{row.values.external_id || "—"} · SKU：{row.values.sku || "—"}</span>
                        </td>
                        <td>
                          {row.status === "INVALID" && <span className="error-text">无效：{row.errors.join("；")}</span>}
                          {row.status === "DUPLICATE" && <span className="warning">项目内已有同一候选，可追加本次来源</span>}
                          {row.status === "VALID" && <span>可以导入</span>}
                          {row.similar_title_candidate_ids.length > 0 && <small className="muted"><br />另有同名候选，仅提示，不会自动合并</small>}
                        </td>
                        <td>
                          <label>
                            <input
                              type="radio"
                              name={`csv-row-${row.row_number}`}
                              checked={rowChoices[row.row_number] === "select"}
                              disabled={isBusy || row.status === "INVALID"}
                              onChange={() => setChoice(row.row_number, "select")}
                            /> 导入
                          </label>{" "}
                          <label>
                            <input
                              type="radio"
                              name={`csv-row-${row.row_number}`}
                              checked={rowChoices[row.row_number] === "skip"}
                              disabled={isBusy}
                              onChange={() => setChoice(row.row_number, "skip")}
                            /> 跳过
                          </label>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="form-actions">
                <button className="secondary" type="button" disabled={isBusy} onClick={() => { setPreviewData(null); setRowChoices({}); }}>返回修改</button>
                <button className="primary" type="button" disabled={isBusy || previewData.rows.length === 0} onClick={() => void commitCsv()}>
                  {busy === "confirm" ? "正在提交…" : "确认导入所选行"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <p className="intake-footnote">每个候选都会保留项目、渠道、市场、进入方式和来源；相似名称只提示，不自动合并。</p>
    </section>
  );
}

export default IntakePanel;
