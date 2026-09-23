import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NodeRun } from '../features/evidence/types.ts';
import { isAdoptedDraftStale, selectEvaluationDrafts } from '../features/evaluations/evaluationDrafts.ts';

function run(id:string,created_at:string,extra:Partial<NodeRun> = {}):NodeRun {
  return {id,node_kind:'EVALUATION_ORGANIZER',run_state:'SUCCEEDED',created_at,output:{summary:id},...extra};
}

test('selects the newest successful fresh draft and keeps stale older drafts in history', () => {
  const oldStale = run('old','2026-09-20T09:00:00Z',{is_stale:true,adoption_status:'STALE',stale_reasons:['证据版本已变化']});
  const fresh = run('fresh','2026-09-20T10:00:00Z',{adoption_status:'PENDING_REVIEW'});
  const failed = run('failed','2026-09-20T11:00:00Z',{run_state:'FAILED'});
  const result = selectEvaluationDrafts([oldStale,fresh,failed]);
  assert.equal(result.latest?.id,'fresh');
  assert.deepEqual(result.history.map(item => item.id),['failed','old']);
  assert.deepEqual(result.history[1].stale_reasons,['证据版本已变化']);
});

test('fresh aggregate status wins for a run also present in the cached job result', () => {
  const canonical = run('same','2026-09-20T10:00:00Z',{is_stale:true,adoption_status:'STALE'});
  const cached = run('same','2026-09-20T10:00:00Z',{is_stale:false,adoption_status:'PENDING_REVIEW'});
  const result = selectEvaluationDrafts([canonical],cached);
  assert.equal(result.latest?.id,'same');
  assert.equal(result.latest?.is_stale,true);
  assert.equal(result.history.length,0);
});

test('an adopted draft blocks save after its source is stale or evidence changes', () => {
  const adoption = {runId:'draft',evidenceKey:'evidence-v1'};
  assert.equal(isAdoptedDraftStale(adoption,'evidence-v1',[run('draft','2026-09-20T10:00:00Z',{is_stale:true})]),true);
  assert.equal(isAdoptedDraftStale(adoption,'evidence-v2',[run('draft','2026-09-20T10:00:00Z')]),true);
  assert.equal(isAdoptedDraftStale(adoption,'evidence-v1',[run('draft','2026-09-20T10:00:00Z',{adoption_status:'PENDING_REVIEW'})]),false);
});
