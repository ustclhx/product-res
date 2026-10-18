-- 仅独立Docker恢复夹具，绝不用于生产写入。
set role migrator;
    insert into organization(id,name,slug) values ('019a0000-0000-7000-8000-000000000001','Restore fixture','restore-fixture');
    insert into credit_grant(id,workspace_id,source,source_ref,amount,remaining) values ('019a0000-0000-7000-8000-000000000002','019a0000-0000-7000-8000-000000000001','admin','restore-fixture',17,17);
    insert into credit_ledger(id,workspace_id,grant_id,delta,type) values ('019a0000-0000-7000-8000-000000000003','019a0000-0000-7000-8000-000000000001','019a0000-0000-7000-8000-000000000002',17,'grant');
    insert into job_engine.queue(name,policy) values ('restore-fixture','{}');
    insert into job_engine.message(id,queue,body) values ('019a0000-0000-7000-8000-000000000004','restore-fixture','{}');
    insert into job_engine.workflow_event(id,workflow_id,type,payload) values ('019a0000-0000-7000-8000-000000000005','restore-fixture','marker','{}');
    insert into job_engine.workflow_wait(id,workflow_id,name,type,deadline) values ('019a0000-0000-7000-8000-000000000006','restore-fixture','marker','marker',now()+interval '1 day');
    insert into job_engine.schedule(id,cron,next_scheduled_at) values ('restore-fixture','*/5 * * * *',now()+interval '5 minutes');

-- 直接SQL构造真实DBOS状态/已完成step快照，只验证恢复持久内容，不声称引擎执行或恢复ownership。
insert into dbos.workflow_status(workflow_uuid,status,name,application_version)
  values ('d-drill-fixture','PENDING','direct-sql-restore-fixture','fixture');
insert into dbos.operation_outputs(workflow_uuid,function_id,function_name,output)
  values ('d-drill-fixture',0,'prepared','17');
