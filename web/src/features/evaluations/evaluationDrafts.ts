import type { NodeRun } from '../evidence/types';

export function isDraftFresh(run: NodeRun): boolean {
  return !run.is_stale && run.adoption_status !== 'STALE';
}

function successful(run: NodeRun): boolean {
  return ['SUCCEEDED', 'SUCCESS'].includes(run.run_state ?? run.status ?? run.state ?? '');
}

export function selectEvaluationDrafts(aggregateRuns: NodeRun[], liveRun?: NodeRun): {latest?:NodeRun;history:NodeRun[]} {
  const runs = [...aggregateRuns];
  if (liveRun?.id && !aggregateRuns.some(run => run.id === liveRun.id)) runs.push(liveRun);
  const eligible = runs.filter(run => successful(run) && isDraftFresh(run)).sort((a,b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  const latest = eligible[0] ?? aggregateRuns.filter(successful).sort((a,b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0] ?? liveRun;
  return {latest,history:runs.filter(run => run.id !== latest?.id).sort((a,b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))};
}

export function isAdoptedDraftStale(adoption: {runId:string;evidenceKey:string} | null, evidenceKey: string, runs: NodeRun[]): boolean {
  if (!adoption) return false;
  const source = runs.find(run => run.id === adoption.runId);
  return Boolean(!source || source?.is_stale || source?.adoption_status === 'STALE' || adoption.evidenceKey !== evidenceKey);
}
