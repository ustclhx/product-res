import type { Channel } from "../../generated/contracts";
export type { Channel } from "../../generated/contracts";

export interface Project { id: string; name: string; channel: Channel; market?: string; direction?: string; goal?: string; constraints?: string[]; default_due_days?: number; source_feedback_id?: string | null; analyst_id?: string | null; decision_owner_id?: string | null; current_criteria_id?: string | null; version?: number; created_at?: string; updated_at?: string }
export interface CriteriaRule { field: string; operator: "lte" | "gte" | "eq"; threshold: string; unit?: string; currency?: string | null }
export interface Criteria { research_learning?: string | null; id: string; version?: number; rules?: CriteriaRule[]; required_evidence?: string[]; confirmed_by?: string; confirmed_at?: string; created_at?: string; template_id?: string; template_version?: string; parent_revision_id?: string | null }
export interface TemplateField { key: string; label: string; required?: boolean; group?: string }
export interface ProjectTemplate { id: string; version: string; name: string; channel: Channel; description?: string; fields?: TemplateField[]; rules?: CriteriaRule[]; required_evidence?: string[]; is_demo?: boolean }
export interface Candidate { id: string; title: string; external_id?: string; source_url?: string; business_status?: string; screening_status?: string; market?: string; is_demo?: boolean; created_at?: string }
export interface ProjectDetail { project: Project; criteria_versions?: Criteria[]; candidates?: Candidate[] }
