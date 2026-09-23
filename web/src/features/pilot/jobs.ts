import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../app/client';
import { useWorkspace } from '../../app/workspace';

export type PilotJobState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'OUTCOME_UNKNOWN';
export type PilotJob<T = unknown> = {
  id: string;
  version?: number;
  state: PilotJobState;
  stale?: boolean;
  adoptable?: boolean;
  error_code?: string | null;
  error_message?: string | null;
  result?: T | null;
  job_kind?: string;
  created_at?: string;
  updated_at?: string;
  attempts?: Array<{ id?: string; state?: string; started_at?: string; finished_at?: string; error_message?: string | null; historical_output?: unknown }>;
};

const activeStates = new Set<PilotJobState>(['QUEUED', 'RUNNING']);

export function useDurableJob<T>(scope: string) {
  const { mode, session } = useWorkspace();
  const storageKey = `product-res-job:${session?.workspace.id ?? 'demo'}:${scope}`;
  const [jobId, setJobId] = useState(() => mode === 'pilot' ? sessionStorage.getItem(storageKey) ?? '' : '');
  const query = useQuery({
    queryKey: ['pilot-job', session?.workspace.id, jobId],
    queryFn: () => api<{ job: PilotJob<T> }>(`/pilot/jobs/${jobId}`),
    enabled: mode === 'pilot' && Boolean(jobId),
    retry: false,
    refetchInterval: result => activeStates.has(result.state.data?.job.state ?? 'SUCCEEDED') ? 1500 : result.state.data?.job.job_kind === 'assistant' ? 15000 : false,
  });
  function remember(job: PilotJob<T>) {
    sessionStorage.setItem(storageKey, job.id); setJobId(job.id);
  }
  function clear() { sessionStorage.removeItem(storageKey); setJobId(''); }
  return { job: query.data?.job, jobId, remember, clear, refetch: query.refetch, error: query.error };
}
