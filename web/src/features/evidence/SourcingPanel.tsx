import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, command } from '../../app/client';
import { useWorkspace } from '../../app/workspace';
import { memberLabel } from '../../app/members';
import type { Candidate, CandidateAggregate, SourcingAggregate, SourcingProfile, SourcingRecord, SourcingRequirement } from './types';
import { displayTime, statusText } from './types';
import './sourcing.css';

type Kind = 'QUOTE' | 'FITMENT' | 'PRICE';
type OpenForm = { kind: Kind | 'profile'; field?: string; version: number } | null;
const quality: Record<string, string> = { MISSING: '待补充', UNVERIFIED: '待核验', CONFLICT: '有冲突', EXPIRED: '已过期', READY: '已具备' };
const stages = { RESEARCH: '研究准备', SAMPLE: '打样准备', LAUNCH: '上市准备' };
const recordNames = { QUOTE: '供应商报价', FITMENT: '车型适配', PRICE: '售价口径' };
const blankProfile: SourcingProfile = { product_type: 'LISTED', stage: 'RESEARCH' };
const fieldKinds: Record<string, Kind | 'profile'> = {
  procurement_cost: 'QUOTE', procurement_reference_price: 'QUOTE', moq: 'QUOTE', moq_reference: 'QUOTE',
  price: 'PRICE', selling_price: 'PRICE', target_price: 'PRICE', currency: 'PRICE',
  vehicle_fitment: 'FITMENT', fitment_desk_review: 'FITMENT', vehicle_configuration: 'profile',
};
const errorText = (value: unknown) => value instanceof Error ? value.message : '保存未完成，请重试';
function scalar(value: unknown, fallback = '') { return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback; }
function text(form: FormData, key: string) { return scalar(form.get(key)).trim(); }
function optional(form: FormData, key: string) { return text(form, key) || null; }
function safeHttpLink(value: unknown) {
  const link = scalar(value);
  try { const url = new URL(link); return url.protocol === 'http:' || url.protocol === 'https:' ? link : ''; }
  catch { return ''; }
}
function localTime(value?: string) {
  const date = value ? new Date(value) : new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function openGeneral() {
  const element = document.getElementById('legacy-evidence-form');
  if (element instanceof HTMLDetailsElement) element.open = true;
  element?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

export default function SourcingPanel({ data, onChanged, onAssign, field, reviewMode = false }: { data: CandidateAggregate; onChanged: () => Promise<void>; onAssign: (field: string, label: string) => void; field?: string | null; reviewMode?: boolean }) {
  const { members, mode, session, actor, refresh } = useWorkspace();
  const [open, setOpen] = useState<OpenForm | false>(null);
  const [revision, setRevision] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [link, setLink] = useState('');
  const [preview, setPreview] = useState<{ platform: string; product_id: string; normalized_url: string } | null>(null);
  const [linkError, setLinkError] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const query = useQuery({ queryKey: ['sourcing', data.candidate.id, data.candidate.version, data.tasks.map(task => `${task.id}:${task.state}`).join(',')], queryFn: () => api<SourcingAggregate>(`/candidates/${data.candidate.id}/sourcing`), retry: false });
  const deepKind = field ? fieldKinds[field] : undefined;
  const effectiveOpen = open === false ? null : open ?? (deepKind ? {kind:deepKind, field:field ?? undefined, version:data.candidate.version} : null);
  const projectQuery = useQuery({ queryKey: ['sourcing-project', data.project.id], queryFn: () => api<{candidates: Candidate[]}>(`/projects/${data.project.id}`), enabled: effectiveOpen?.kind === 'profile', retry: false });
  const source = query.data;
  const profile = source?.profile ?? blankProfile;
  const requirements = source?.requirements ?? [];
  const required = requirements.filter(item => item.required_now !== false);
  const future = requirements.filter(item => item.required_now === false);
  const records = source?.records ?? [];
  const replaced = new Set(records.flatMap(item => item.supersedes_record_id ? [item.supersedes_record_id] : []));
  const currentRecords = records.filter(item => !replaced.has(item.id));
  const canConfigure = (mode === 'pilot' ? session?.user.id : actor) === data.project.analyst_id;
  const names = new Map(members.map(member => [member.id, memberLabel(member)]));
  const deepRecord = reviewMode && effectiveOpen && effectiveOpen.kind !== 'profile' ? [...currentRecords].reverse().find(item => item.kind === effectiveOpen.kind) : undefined;
  const selectedRevision = revision || deepRecord?.id || '';

  function show(kind: Kind | 'profile', field?: string) {
    setOpen({ kind, field, version: data.candidate.version }); setRevision(''); setError(''); setSaved('');
  }
  async function save(payload: Record<string, unknown>, endpoint: string) {
    setBusy(true); setError(''); setSaved('');
    try {
      await command(`/candidates/${data.candidate.id}/${endpoint}`, { expected_version: effectiveOpen?.version, ...payload });
      setOpen(false); setSaved('已保存。材料可在下方查看，补证任务请由负责人更新结果。');
      refresh(); await onChanged(); await query.refetch();
    } catch (caught) { setError(errorText(caught)); }
    finally { setBusy(false); }
  }
  async function previewLink() {
    setPreviewBusy(true); setLinkError(''); setPreview(null);
    try { setPreview(await api(`/sourcing/link-preview?url=${encodeURIComponent(link)}`)); }
    catch (caught) { setLinkError(errorText(caught)); }
    finally { setPreviewBusy(false); }
  }
  function gap(item: SourcingRequirement) {
    return <div className="sourcing-gap" key={item.field}>
      <div><strong>{item.label}</strong><p className="muted">{item.reason}</p>
        {item.tasks?.length ? item.tasks.map(task => <p className="sourcing-owner" key={task.id}>{names.get(task.owner_id) ?? '项目成员'} · {displayTime(task.due_at)} 截止{task.state === 'BLOCKED' ? ' · 受阻' : ''}</p>) : item.status !== 'READY' && <p className="sourcing-owner">尚未分配 · 项目分析负责人协调 <button type="button" className="secondary" disabled={busy} onClick={() => onAssign(item.field,item.label)}>分配任务</button></p>}
      </div>
      <span className="badge">{quality[item.status] ?? item.status}</span>
      <button className="secondary" type="button" disabled={busy || item.field === 'vehicle_configuration' && !canConfigure} onClick={() => item.field === 'vehicle_configuration' ? show('profile') : item.form_kind === 'GENERAL' ? openGeneral() : show(item.form_kind, item.field)}>{item.status === 'READY' ? '新增记录' : '去补齐'}</button>
    </div>;
  }
  return <section className="sourcing-panel" aria-labelledby="sourcing-title">
    <div className="sourcing-heading"><div><h3 id="sourcing-title">采购材料准备</h3><p className="muted">{profile.product_type === 'OEM' ? 'OEM / 未上架' : profile.product_type === 'BENCHMARK' ? '对标商品' : '在售商品'} · {stages[profile.stage]}</p></div>
      {canConfigure && <button type="button" className="secondary" disabled={busy || !source} onClick={() => show('profile')}>设置 OEM 与阶段</button>}
    </div>
    {query.isPending && <p role="status">正在读取补证材料…</p>}
    {query.error && <div className="error" role="alert">{errorText(query.error)} <button onClick={() => void query.refetch()}>重试</button></div>}
    {source && <>
      <p className="sourcing-status">{source.stage_ready ? '本阶段材料已齐' : `本阶段 ${required.filter(item => !item.ready_for_stage).length} 项待准备`} · 材料准备不代表批准采购。正式初筛：{statusText[source.formal_screening_status ?? 'UNCHECKED']}</p>
      <div className="sourcing-gaps">{required.length ? required.map(gap) : <p className="empty">项目尚未配置必需材料，可先录入货源资料。</p>}</div>
      {future.length > 0 && <details className="sourcing-future"><summary>后续阶段再补（{future.length} 项）</summary>{future.map(gap)}</details>}
      <div className="sourcing-actions"><button type="button" className="secondary" disabled={busy} onClick={() => show('QUOTE')}>录入供应商 / 线下厂商</button><Link to={`/tasks?candidate_id=${data.candidate.id}`}>查看补证任务与结果</Link></div>
    </>}
    {saved && <p role="status">{saved}</p>}
    {error && <div className="error" role="alert">{error}<p>若资料已变化，请先保存当前输入到本地，再关闭表单并刷新候选。</p></div>}
    {effectiveOpen?.kind === 'profile' && (canConfigure ? <ProfileForm key={effectiveOpen.version} profile={profile} candidates={projectQuery.data?.candidates.filter(item => item.id !== data.candidate.id) ?? []} busy={busy} onCancel={() => setOpen(false)} onSave={payload => void save(payload, 'sourcing-profile')} /> : <p className="error" role="alert">车型配置由项目分析负责人维护。</p>)}
    {effectiveOpen && effectiveOpen.kind !== 'profile' && <div className="sourcing-editor">
      <label className="field">修订记录<select value={selectedRevision} disabled={busy} onChange={event => setRevision(event.target.value)}><option value="">新增独立材料</option>{currentRecords.filter(item => item.kind === effectiveOpen.kind).map(item => <option key={item.id} value={item.id}>{recordNames[item.kind]} · {item.source_locator} · {displayTime(item.observed_at)}</option>)}</select></label>
      {reviewMode && selectedRevision && <p className="notice">正在核验已有材料。保存会追加核验版本并保留原记录。</p>}
      {reviewMode && source && !selectedRevision ? <p className="error" role="alert">尚未找到可核验的{recordNames[effectiveOpen.kind]}，请先确认事项是否已有材料。</p> : <RecordForm key={`${effectiveOpen.kind}:${effectiveOpen.field}:${selectedRevision}`} kind={effectiveOpen.kind} field={effectiveOpen.field} record={records.find(item => item.id === selectedRevision)} profile={profile} suggestedLink={preview?.normalized_url} busy={busy} onCancel={() => setOpen(false)} onSave={payload => void save(payload, 'sourcing-records')} />}
    </div>}
    <details className="sourcing-history"><summary>从国内商品网站补充线索</summary>
      <p className="muted">支持 1688、义乌购与 Alibaba 商品链接。当前只识别平台和商品编号，价格和 MOQ 需依据页面或报价单录入。</p>
      <div className="sourcing-link"><label className="field">商品来源链接<input value={link} onChange={event => setLink(event.target.value)} type="url" placeholder="https://detail.1688.com/offer/…" /></label><button type="button" className="secondary" disabled={!link.trim() || previewBusy} onClick={() => void previewLink()}>{previewBusy ? '识别中…' : '识别'}</button></div>
      {linkError && <p role="alert" className="error">{linkError}</p>}
      {preview && <p role="status">已识别：{preview.platform} · 商品编号 {preview.product_id} <button type="button" className="secondary" disabled={busy} onClick={() => show('QUOTE')}>录入参考资料</button></p>}
      <ul>{source?.connectors?.map(item => <li key={item.platform}>{item.platform === 'YIWUGO' ? '义乌购' : item.platform}：尚需官方接入授权 · <a href={item.official_url} target="_blank" rel="noopener noreferrer">官方申请入口</a></li>)}</ul>
    </details>
    <details className="sourcing-history"><summary>已录材料与历史（{records.length}）</summary>
      {records.length ? <ul className="sourcing-records">{[...records].reverse().map(record => <li key={record.id}><strong>{recordNames[record.kind]}</strong> · {replaced.has(record.id) ? '历史版本' : '当前记录'} · {statusText[record.verification]}<p>{record.source_locator} · {displayTime(record.observed_at)}</p><RecordSummary record={record} /></li>)}</ul> : <p className="empty">还没有专用表单记录。已有材料可在下方“原始证据与历史”查看。</p>}
    </details>
  </section>;
}

function ProfileForm({ profile, candidates, busy, onCancel, onSave }: { profile: SourcingProfile; candidates: Candidate[]; busy: boolean; onCancel: () => void; onSave: (payload: Record<string, unknown>) => void }) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    onSave(Object.fromEntries(['product_type','stage','benchmark_candidate_id','target_market','brand','model','year','trim','seat_type'].map(key => [key, optional(form,key)])));
  }
  return <form className="sourcing-form" onSubmit={submit}><h4>候选准备设置</h4><fieldset disabled={busy} className="sourcing-fields"><div className="form-grid">
    <label className="field">商品类型<select name="product_type" defaultValue={profile.product_type}><option value="LISTED">在售商品</option><option value="OEM">OEM / 未上架</option><option value="BENCHMARK">对标商品</option></select></label>
    <label className="field">准备阶段<select name="stage" defaultValue={profile.stage}><option value="RESEARCH">研究</option><option value="SAMPLE">打样</option><option value="LAUNCH">上市</option></select></label>
    <label className="field">对标商品<select name="benchmark_candidate_id" defaultValue={profile.benchmark_candidate_id ?? ''}><option value="">暂不关联</option>{candidates.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
    <label className="field">目标市场<input name="target_market" defaultValue={profile.target_market ?? ''} placeholder="例如 US" /></label>
    <label className="field">品牌<input name="brand" defaultValue={profile.brand ?? ''} /></label><label className="field">车型 / 型号<input name="model" defaultValue={profile.model ?? ''} /></label>
    <label className="field">年份<input name="year" defaultValue={profile.year ?? ''} /></label><label className="field">配置 / 座型<input name="trim" defaultValue={profile.trim ?? ''} placeholder="例如 LE、5 座" /></label>
    <label className="field field-wide">座椅类型<input name="seat_type" defaultValue={profile.seat_type ?? ''} placeholder="原厂织物前排、独立可调头枕等" /></label>
  </div><p className="muted">此设置只调整材料准备清单；已确认的正式初筛标准和采购决策保持原样。</p><FormActions busy={busy} onCancel={onCancel} label="保存设置" /></fieldset></form>;
}

function RecordForm({ kind, field, record, profile, suggestedLink, busy, onCancel, onSave }: { kind: Kind; field?: string; record?: SourcingRecord; profile: SourcingProfile; suggestedLink?: string; busy: boolean; onCancel: () => void; onSave: (payload: Record<string, unknown>) => void }) {
  const old = record?.payload ?? {};
  const value = (key: string, fallback = '') => scalar(old[key], fallback);
  const oldList = (key: string) => Array.isArray(old[key]) ? old[key] as Record<string, unknown>[] : [];
  const [priceUnit, setPriceUnit] = useState(value('price_unit', 'piece'));
  const [moqUnit, setMoqUnit] = useState(value('moq_unit', 'piece'));
  const [basis, setBasis] = useState(kind === 'QUOTE' ? value('quote_basis', field === 'procurement_cost' || field === 'moq' ? 'SUPPLIER_CONFIRMED' : 'PUBLIC_REFERENCE') : value('price_basis', field === 'price' || field === 'currency' ? 'ACTUAL_OFFER' : 'TARGET_ESTIMATE'));
  const [method, setMethod] = useState(value('method', field === 'vehicle_fitment' ? 'PHYSICAL_TEST' : 'DESK_REVIEW'));
  const [tierRows, setTierRows] = useState(Math.max(1, oldList('price_tiers').length));
  const [materialRows, setMaterialRows] = useState(Math.max(1, oldList('shared_materials').length));
  const reference = kind === 'QUOTE' && basis === 'PUBLIC_REFERENCE' || kind === 'PRICE' && basis === 'TARGET_ESTIMATE';
  const [verification, setVerification] = useState(record?.verification ?? 'UNVERIFIED');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const pieces = optional(form,'pieces_per_set');
    const price = { amount:text(form,'amount'), currency:text(form,'currency').toUpperCase(), price_unit:priceUnit, pieces_per_set:pieces ? Number(pieces) : null };
    let payload: Record<string, unknown>;
    if (kind === 'QUOTE') {
      const price_tiers = Array.from({length:tierRows}, (_, index) => ({min_quantity:optional(form,`tier_min_${index}`), max_quantity:optional(form,`tier_max_${index}`), quantity_unit:text(form,`tier_quantity_unit_${index}`), amount:optional(form,`tier_amount_${index}`), price_unit:text(form,`tier_price_unit_${index}`)})).filter(item => item.min_quantity || item.max_quantity || item.amount).map(item => ({...item, min_quantity:Number(item.min_quantity), max_quantity:item.max_quantity ? Number(item.max_quantity) : null}));
      const shared_materials = Array.from({length:materialRows}, (_, index) => ({label:optional(form,`material_label_${index}`), url:optional(form,`material_url_${index}`)})).filter(item => item.label || item.url).map(item => ({label:item.label, url:item.url}));
      const moqDetail = (name:string) => optional(form,`${name}_amount`) ? {amount:Number(text(form,`${name}_amount`)), unit:text(form,`${name}_unit`)} : null;
      payload = { ...price, supplier_name:text(form,'supplier_name'), supplier_channel:text(form,'supplier_channel'), quote_basis:basis, moq:Number(text(form,'moq')), moq_unit:moqUnit, price_tiers, sample_moq:moqDetail('sample_moq'), stock_moq:moqDetail('stock_moq'), custom_moq:moqDetail('custom_moq'), shared_materials, ...Object.fromEntries(['supplier_contact','product_url','supplier_sku','trade_terms','tax_shipping_note'].map(key => [key, optional(form,key)])), lead_time_days:optional(form,'lead_time_days') ? Number(text(form,'lead_time_days')) : null };
    }
    else if (kind === 'PRICE') payload = {...price, price_basis:basis};
    else payload = { ...Object.fromEntries(['brand','model','year','trim','seat_type','checks','sample_ref'].map(key => [key, optional(form,key)])), method, result:text(form,'result'), sample_target_consistent:method === 'PHYSICAL_TEST' ? form.get('sample_target_consistent') === 'on' : null, left_front_seat:method === 'PHYSICAL_TEST' ? {result:text(form,'left_result'), details:text(form,'left_details')} : null, right_front_seat:method === 'PHYSICAL_TEST' ? {result:text(form,'right_result'), details:text(form,'right_details')} : null };
    onSave({kind, payload:{...payload, notes:optional(form,'notes')}, source_locator:text(form,'source_locator'), observed_at:new Date(text(form,'observed_at')).toISOString(), valid_until:optional(form,'valid_until') ? new Date(text(form,'valid_until')).toISOString() : null, verification:reference ? 'UNVERIFIED' : verification, verification_note:optional(form,'verification_note'), supersedes_record_id:record?.id ?? null});
  }
  return <form className="sourcing-form" onSubmit={submit}><h4>录入{recordNames[kind]}</h4><fieldset disabled={busy} className="sourcing-fields"><div className="form-grid">
    {kind === 'QUOTE' && <><label className="field">供应商名称<input name="supplier_name" defaultValue={value('supplier_name')} required /></label><label className="field">供应商渠道<select name="supplier_channel" defaultValue={value('supplier_channel', suggestedLink?.includes('1688.com') ? '1688' : suggestedLink?.includes('yiwugo.com') ? 'YIWUGO' : suggestedLink?.includes('alibaba.com') ? 'ALIBABA' : 'OFFLINE')}><option value="OFFLINE">线下厂商</option><option value="1688">1688</option><option value="YIWUGO">义乌购</option><option value="ALIBABA">Alibaba</option><option value="OTHER">其他</option></select></label><label className="field">价格基准<select name="quote_basis" value={basis} onChange={event => setBasis(event.target.value)}><option value="PUBLIC_REFERENCE">公开参考</option><option value="SUPPLIER_CONFIRMED">供应商确认</option></select></label></>}
    {kind === 'PRICE' && <label className="field">价格口径<select name="price_basis" value={basis} onChange={event => setBasis(event.target.value)}><option value="TARGET_ESTIMATE">目标估算</option><option value="ACTUAL_OFFER">实际报价</option></select></label>}
    {kind !== 'FITMENT' && <><label className="field">金额<input name="amount" defaultValue={value('amount')} type="number" min="0.000001" step="any" required /></label><label className="field">币种<input name="currency" defaultValue={value('currency',kind === 'PRICE' ? 'USD' : 'CNY')} pattern="[A-Za-z]{3}" maxLength={3} required /></label><label className="field">计价单位<select name="price_unit" value={priceUnit} onChange={event => setPriceUnit(event.target.value)}><option value="piece">单件</option><option value="set">套装</option></select></label></>}
    {kind === 'QUOTE' && <><label className="field">MOQ<input name="moq" defaultValue={value('moq')} type="number" min="1" step="1" required /></label><label className="field">MOQ单位<select name="moq_unit" value={moqUnit} onChange={event => setMoqUnit(event.target.value)}><option value="piece">件</option><option value="set">套</option></select></label></>}
    {kind !== 'FITMENT' && (priceUnit === 'set' || kind === 'QUOTE' && moqUnit === 'set') && <label className="field">每套件数<input name="pieces_per_set" defaultValue={value('pieces_per_set')} type="number" min="1" step="1" required /></label>}
    {kind === 'FITMENT' && <>
      <label className="field">品牌<input name="brand" defaultValue={value('brand',profile.brand ?? '')} required /></label><label className="field">车型 / 型号<input name="model" defaultValue={value('model',profile.model ?? '')} required /></label><label className="field">年份<input name="year" defaultValue={value('year',profile.year ?? '')} required /></label><label className="field">配置 / 座型<input name="trim" defaultValue={value('trim',profile.trim ?? '')} /></label><label className="field field-wide">座椅类型<input name="seat_type" defaultValue={value('seat_type',profile.seat_type ?? '')} required /></label>
      <label className="field">核验方式<select name="method" value={method} onChange={event => setMethod(event.target.value)}><option value="DESK_REVIEW">桌面核对</option><option value="PHYSICAL_TEST">实车测试</option></select></label><label className="field">结果<select name="result" defaultValue={value('result','PENDING')}><option value="PENDING">待确认</option><option value="PASS">通过</option><option value="FAIL">不通过</option></select></label>
      {method === 'PHYSICAL_TEST' && <><label className="field">样品编号<input name="sample_ref" defaultValue={value('sample_ref')} required={verification === 'VERIFIED'} placeholder="样品标签与测试记录编号" /></label><label className="field sourcing-check"><input name="sample_target_consistent" type="checkbox" defaultChecked={old.sample_target_consistent === true} required={verification === 'VERIFIED'} /> 样品版本与上述目标车型一致</label>
        {(['left','right'] as const).map(side => { const prior = old[`${side}_front_seat`] as Record<string,unknown> | undefined; return <div className="sourcing-seat-check field-wide" key={side}><strong>{side === 'left' ? '左前排（驾驶席）' : '右前排（副驾席）'}</strong><label className="field">检查结果<select name={`${side}_result`} defaultValue={scalar(prior?.result,'NOT_TESTED')}><option value="NOT_TESTED">未测</option><option value="PASS">通过</option><option value="FAIL">不适配</option></select></label><label className="field">检查明细<textarea name={`${side}_details`} defaultValue={scalar(prior?.details)} required={verification === 'VERIFIED'} placeholder="安装固定、头枕锁定、座椅调节、空间或安全部件干涉" /></label></div>; })}</>}
      <label className="field field-wide">检查内容<textarea name="checks" defaultValue={value('checks')} required placeholder="安装、尺寸、头枕固定、气囊与安全带干涉，以及尚未确认的项目" /></label>
    </>}
    <label className="field field-wide">来源定位<input name="source_locator" defaultValue={record?.source_locator ?? suggestedLink ?? ''} required placeholder="报价单文件名、日期、页码或来源链接" /></label>
    <label className="field">观察时间<input name="observed_at" type="datetime-local" defaultValue={localTime(record?.observed_at)} required /></label><label className="field">有效至<input name="valid_until" type="datetime-local" defaultValue={record?.valid_until ? localTime(record.valid_until) : ''} /></label>
    {!reference && <><label className="field">核验状态<select name="verification" value={verification} onChange={event => setVerification(event.target.value as 'UNVERIFIED' | 'VERIFIED')}><option value="UNVERIFIED">未核验</option><option value="VERIFIED">已核验</option></select></label><label className="field field-wide">备注 / 核验依据<textarea name="verification_note" defaultValue={record?.verification_note ?? ''} required={verification === 'VERIFIED'} placeholder="谁依据哪份材料确认了哪些内容" /></label></>}
  </div>
  {reference && <p className="muted">{kind === 'PRICE' ? '目标售价按估算保存，不会填入实际售价。' : '公开参考价保留为待供应商确认，不会填入正式采购成本。'}</p>}
  <details className="sourcing-extra"><summary>补充细节（选填）</summary><div className="form-grid">
    {kind === 'QUOTE' && <><label className="field">联系人 / 联系方式<input name="supplier_contact" defaultValue={value('supplier_contact')} /></label><label className="field">供应商货号<input name="supplier_sku" defaultValue={value('supplier_sku')} /></label><label className="field field-wide">商品链接<input name="product_url" type="url" defaultValue={value('product_url',suggestedLink)} /></label><label className="field">交期（天）<input name="lead_time_days" type="number" min="0" step="1" defaultValue={value('lead_time_days')} /></label><label className="field">贸易条款<input name="trade_terms" defaultValue={value('trade_terms')} placeholder="例如 EXW / FOB" /></label><label className="field field-wide">税费与运费说明<textarea name="tax_shipping_note" defaultValue={value('tax_shipping_note')} /></label>
      <div className="field-wide sourcing-detail-group"><strong>分类 MOQ</strong><p className="muted">留空表示供应商尚未说明；主 MOQ 仍用于正式筛选。</p><div className="sourcing-detail-rows">{(['sample_moq','stock_moq','custom_moq'] as const).map((name,index) => { const prior = old[name] as Record<string,unknown> | undefined; return <div className="sourcing-inline-row" key={name}><label className="field">{['样品','现货','定制'][index]} MOQ<input name={`${name}_amount`} type="number" min="1" step="1" defaultValue={scalar(prior?.amount)} /></label><label className="field">单位<select name={`${name}_unit`} defaultValue={scalar(prior?.unit,moqUnit)}><option value="piece">件</option><option value="set">套</option></select></label></div>; })}</div></div>
      <div className="field-wide sourcing-detail-group"><strong>数量阶梯价</strong><p className="muted">按数量从小到大填写；末档上限可留空。</p>{Array.from({length:tierRows},(_,index) => { const tier=oldList('price_tiers')[index] ?? {}; return <div className="sourcing-tier-row" key={index}><label className="field">起始数量<input name={`tier_min_${index}`} type="number" min="1" step="1" defaultValue={scalar(tier.min_quantity)} /></label><label className="field">结束数量<input name={`tier_max_${index}`} type="number" min="1" step="1" defaultValue={scalar(tier.max_quantity)} /></label><label className="field">数量单位<select name={`tier_quantity_unit_${index}`} defaultValue={scalar(tier.quantity_unit,moqUnit)}><option value="piece">件</option><option value="set">套</option></select></label><label className="field">单价<input name={`tier_amount_${index}`} type="number" min="0.000001" step="any" defaultValue={scalar(tier.amount)} /></label><label className="field">计价单位<select name={`tier_price_unit_${index}`} defaultValue={scalar(tier.price_unit,priceUnit)}><option value="piece">每件</option><option value="set">每套</option></select></label></div>})}<button type="button" className="secondary" onClick={() => setTierRows(value => value + 1)}>增加一档</button></div>
      <div className="field-wide sourcing-detail-group"><strong>团队可访问的报价原件</strong><p className="muted">只保存共享网页链接和材料说明，系统不会打开或抓取内容。</p>{Array.from({length:materialRows},(_,index) => { const material=oldList('shared_materials')[index] ?? {}; return <div className="sourcing-inline-row" key={index}><label className="field">材料说明<input name={`material_label_${index}`} defaultValue={scalar(material.label)} placeholder="例如 9 月正式报价单" /></label><label className="field">HTTP(S) 共享链接<input name={`material_url_${index}`} type="url" defaultValue={scalar(material.url)} placeholder="https://…" /></label></div>})}<button type="button" className="secondary" onClick={() => setMaterialRows(value => value + 1)}>增加材料</button></div></>}
    <label className="field field-wide">补充备注<textarea name="notes" defaultValue={value('notes')} /></label>
  </div></details><FormActions busy={busy} onCancel={onCancel} label="保存材料" /></fieldset></form>;
}
function FormActions({busy,onCancel,label}:{busy:boolean;onCancel:()=>void;label:string}) {
  return <div className="sourcing-form-actions"><button type="submit" className="primary" disabled={busy}>{busy ? '保存中…' : label}</button><button type="button" className="secondary" onClick={onCancel} disabled={busy}>取消</button></div>;
}
function RecordSummary({record}:{record:SourcingRecord}) {
  const p = record.payload; const v = (key:string) => scalar(p[key], '未提供');
  const materials = Array.isArray(p.shared_materials) ? p.shared_materials as Record<string,unknown>[] : [];
  const tiers = Array.isArray(p.price_tiers) ? p.price_tiers as Record<string,unknown>[] : [];
  const moqs = ([['sample_moq','样品'],['stock_moq','现货'],['custom_moq','定制']] as const).flatMap(([key,label]) => p[key] && typeof p[key] === 'object' ? [{label, value:p[key] as Record<string,unknown>}] : []);
  const seatChecks = ([['left_front_seat','左前排'],['right_front_seat','右前排']] as const).flatMap(([key,label]) => p[key] && typeof p[key] === 'object' ? [{label, value:p[key] as Record<string,unknown>}] : []);
  const resultLabel = (value:unknown) => ({PASS:'通过',FAIL:'不适配',NOT_TESTED:'未测'}[scalar(value)] ?? scalar(value,'未记录'));
  return <div className="muted"><p>{record.kind === 'QUOTE' ? `${v('supplier_name')} · ${v('amount')} ${v('currency')} / ${p.price_unit === 'set' ? `${v('pieces_per_set')} 件装` : '件'} · MOQ ${v('moq')} ${p.moq_unit === 'set' ? '套' : '件'}` : record.kind === 'PRICE' ? `${p.price_basis === 'TARGET_ESTIMATE' ? '目标估算' : '实际报价'} ${v('amount')} ${v('currency')} / ${p.price_unit === 'set' ? `${v('pieces_per_set')} 件装` : '件'}` : `${v('brand')} ${v('model')} ${v('year')} · ${v('seat_type')} · ${p.method === 'DESK_REVIEW' ? '桌面核对' : '实车测试'} · ${{PASS:'通过',FAIL:'不通过',PENDING:'待确认'}[v('result')] ?? v('result')}`}</p>
    {(tiers.length > 0 || moqs.length > 0) && <details className="sourcing-record-detail"><summary>查看报价细节</summary>{moqs.map(item => <p key={item.label}>{item.label} MOQ：{scalar(item.value.amount)} {item.value.unit === 'set' ? '套' : '件'}</p>)}{tiers.map((tier,index) => <p key={index}>阶梯 {index + 1}：{scalar(tier.min_quantity)}–{tier.max_quantity == null ? '以上' : scalar(tier.max_quantity)} {tier.quantity_unit === 'set' ? '套' : '件'} · {scalar(tier.amount)} {v('currency')} / {tier.price_unit === 'set' ? '套' : '件'}</p>)}</details>}
    {seatChecks.length > 0 && <details className="sourcing-record-detail"><summary>查看左右前排检查</summary>{seatChecks.map(item => <p key={item.label}><strong>{item.label}：{resultLabel(item.value.result)}</strong> · {scalar(item.value.details,'未记录明细')}</p>)}</details>}
    {materials.length > 0 && <p className="sourcing-material-links">报价原件：{materials.map((item,index) => { const href=safeHttpLink(item.url); const label=scalar(item.label,'共享材料'); return href ? <a key={index} href={href} target="_blank" rel="noopener noreferrer">{label}</a> : <span key={index}>{label}（旧记录链接不可打开）</span>; })}</p>}</div>;
}
