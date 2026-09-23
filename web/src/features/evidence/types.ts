export type Candidate = {
  id: string;
  version: number;
  project_id: string;
  title: string;
  external_id?: string | null;
  sku?: string | null;
  market?: string | null;
  business_status: string;
  screening_status: string;
  current_evaluation_id?: string | null;
  current_submission_id?: string | null;
  approval_id?: string | null;
  is_demo?: boolean;
};

export type Project = {
  id: string;
  name: string;
  channel: string;
  market: string;
  analyst_id: string;
  decision_owner_id: string;
};

export type CriteriaRule = {
  field: string;
  operator: 'lte' | 'gte' | 'eq';
  threshold: string;
  unit?: string | null;
  currency?: string | null;
};

export type Criteria = {
  id: string;
  version: number;
  template_id?: string;
  template_version?: string;
  required_evidence: string[];
  rules: CriteriaRule[];
};

export type Evidence = {
  sourcing_record_id?: string | null;
  id: string;
  version: number;
  field: string;
  value: string | null;
  unit?: string | null;
  currency?: string | null;
  window?: string | null;
  source_locator: string;
  observed_at: string;
  valid_until?: string | null;
  epistemic_kind: 'FACT' | 'ESTIMATE' | 'ASSUMPTION';
  verification: 'VERIFIED' | 'UNVERIFIED' | 'CONFLICT';
  supersedes_id?: string | null;
  is_demo?: boolean;
  created_at?: string;
};

export type RuleResult = {
  rule_key: string;
  field: string;
  status: 'PASS' | 'FAIL' | 'NEEDS_EVIDENCE';
  reason: string;
  evidence_ids?: string[];
  observed?: string | null;
  threshold?: string | null;
  operator?: string | null;
  unit?: string | null;
  currency?: string | null;
  overridden?: boolean;
};

export type Screening = {
  id: string;
  version: number;
  status: string;
  criteria_id: string;
  input_hash: string;
  evidence_ids: string[];
  rule_results: RuleResult[];
  missing_fields: string[];
  failed_rule_keys?: string[];
  unresolved_failed_rule_keys?: string[];
  created_at?: string;
};

export type Override = {
  id: string;
  reason: string;
  rule_keys?: string[];
  actor_id?: string;
  created_at?: string;
};

export type Dimension = { summary?: string; evidence_ids?: string[]; [key: string]: unknown };

export type Evaluation = {
  id: string;
  version: number;
  criteria_id: string;
  evidence_ids: string[];
  input_hash: string;
  dimensions: Record<string, Dimension>;
  unknowns: string[];
  counterevidence: string[];
  assumptions: string[];
  forecast: {
    currency?: string | null;
    window_start?: string | null;
    window_end?: string | null;
    revenue_basis?: 'GROSS' | 'NET' | null;
    units?: string | null;
    metrics?: Record<string, string | null>;
  };
  assistant_versions: Record<string, unknown>;
  parent_revision_id?: string | null;
  created_at?: string;
};

export type Submission = {
  id: string;
  evaluation_id: string;
  criteria_id: string;
  input_hash?: string;
  actor_id?: string;
  status?: string;
  created_at?: string;
  kind?: string;
  reason?: string;
};

export type Decision = {
  id: string;
  action: string;
  reason: string;
  questions?: string[];
  actor_id?: string;
  evaluation_id?: string | null;
  criteria_id?: string | null;
  created_at?: string;
};

export type Task = {
  id: string;
  type: string;
  field?: string | null;
  question: string;
  owner_id: string;
  due_at: string;
  completion_criteria: string;
  state: string;
  overdue?: boolean;
};

export type NodeRun = {
  id: string;
  node_kind: string;
  state?: string;
  status?: string;
  run_state?: string;
  output?: Record<string, unknown> | null;
  error?: string | null;
  error_summary?: string | null;
  created_at?: string;
  is_stale?: boolean;
  stale_reasons?: string[];
  adoption_status?: string;
  current_input_hash?: string | null;
};

export type CandidateAggregate = {
  clock: string;
  sources: Array<{id:string;entry_kind:string;source_ref:string;source_url?:string;collected_at:string;is_demo:boolean}>;
  candidate: Candidate;
  project: Project;
  criteria: Criteria | null;
  criteria_versions: Criteria[];
  evidence: Evidence[];
  screenings: Screening[];
  overrides: Override[];
  evaluations: Evaluation[];
  submissions: Submission[];
  decisions: Decision[];
  tasks: Task[];
  outcomes: unknown[];
  obligations: unknown[];
  feedback: unknown[];
  activity: unknown[];
  node_runs: NodeRun[];
  validation_conclusions: unknown[];
};

export type SourcingProfile = {
  product_type: 'OEM' | 'LISTED' | 'BENCHMARK';
  stage: 'RESEARCH' | 'SAMPLE' | 'LAUNCH';
  benchmark_candidate_id?: string | null;
  target_market?: string | null;
  brand?: string | null;
  model?: string | null;
  year?: string | null;
  trim?: string | null;
  seat_type?: string | null;
};

export type SourcingRecord = {
  id: string;
  kind: 'QUOTE' | 'FITMENT' | 'PRICE';
  source_locator: string;
  observed_at?: string;
  valid_until?: string | null;
  verification: 'UNVERIFIED' | 'VERIFIED';
  verification_note?: string | null;
  payload: Record<string, unknown>;
  supersedes_record_id?: string | null;
};

export type SourcingRequirement = {
  field: string;
  label: string;
  status: string;
  reason?: string;
  form_kind: 'QUOTE' | 'FITMENT' | 'PRICE' | 'GENERAL';
  evidence_ids?: string[];
  tasks?: Task[];
  required_now: boolean;
  ready_for_stage: boolean;
};

export type SourcingAggregate = {
  profile?: SourcingProfile | null;
  records: SourcingRecord[];
  requirements: SourcingRequirement[];
  tasks?: Task[];
  connectors?: Array<{platform:string;status:string;official_url:string}>;
  stage_ready?: boolean;
  formal_screening_status?: string;
  clock?: string;
};

export const statusText: Record<string, string> = {
  PREPARING: '准备材料', RETURNED: '已退回', IN_REVIEW: '待决策', VALIDATING: '验证中',
  WATCHING: '观察', REJECTED: '已否决', OUTCOME_PENDING: '待回填结果', REVIEWED: '已复盘',
  UNCHECKED: '未初筛', PASS: '通过', NEEDS_EVIDENCE: '待补证', EXCLUDED: '不符合硬规则', OVERRIDDEN: '已例外恢复',
  FACT: '事实', ESTIMATE: '估算', ASSUMPTION: '假设', VERIFIED: '已核验', UNVERIFIED: '未核验', CONFLICT: '有冲突',
};

export const evidenceFieldText: Record<string, string> = {
  procurement_cost: '采购报价', procurement_reference_price: '供应参考价',
  moq: '最小起订量', moq_reference: '参考起订量',
  price: '实际售价', selling_price: '预计售价', target_price: '目标售价', currency: '币种',
  vehicle_fitment: '实车适配', fitment_desk_review: '适配资料检查', vehicle_configuration: '车型配置',
};

export function evidenceFieldLabel(field: string): string {
  return evidenceFieldText[field] ?? field;
}

export function displayTime(value?: string | null): string {
  if (!value) return '未提供';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}
