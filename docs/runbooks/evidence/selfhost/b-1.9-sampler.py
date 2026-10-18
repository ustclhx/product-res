import json,pathlib,time,subprocess,datetime
from control import run,compose,sql,runtime
out=pathlib.Path.cwd()/'docs/runbooks/evidence/selfhost/b-1.9-resources.jsonl'
def sample(phase):
 now=datetime.datetime.now(datetime.timezone.utc).isoformat()
 names=compose('ps','-a','--format','json').stdout.decode().splitlines();containers=[json.loads(x) for x in names if x.strip()]
 live=[c['ID'] for c in containers if c['State']=='running']
 stats=[json.loads(x) for x in run(['docker','stats','--no-stream','--format','{{json .}}',*live]).stdout.decode().splitlines()]
 details=[]
 for c in containers:
  raw=json.loads(run(['docker','inspect',c['ID']]).stdout)[0]
  s=raw['State'];d={'service':c['Service'],'id':c['ID'][:12],'running':s['Running'],'oomKilled':s['OOMKilled'],'exitCode':s['ExitCode'],'restartCount':raw['RestartCount'],'memoryLimitBytes':raw['HostConfig']['Memory'],'nanoCpus':raw['HostConfig']['NanoCpus']}
  if s['Running']:
   proc=run(['docker','exec',c['ID'],'sh','-c',"awk '/VmRSS/{rss+=$2} END{print rss}' /proc/[0-9]*/status; cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.events /sys/fs/cgroup/cpu.stat"],check=False)
   d['procAndCgroup']=proc.stdout.decode().strip()
  details.append(d)
 query="""SELECT json_build_object('version',version(),'maxConnections',current_setting('max_connections'),'connections',(SELECT count(*) FROM pg_stat_activity),'connectionsByDatabase',(SELECT json_object_agg(datname,n) FROM (SELECT coalesce(datname,'background') datname,count(*) n FROM pg_stat_activity GROUP BY datname)t),'walLsn',pg_current_wal_lsn()::text,'walBytes',pg_wal_lsn_diff(pg_current_wal_lsn(),'0/0'),'dbSizes',(SELECT json_object_agg(datname,pg_database_size(oid)) FROM pg_database WHERE datname IN ('acceptance','b_budget_probe')),'journalTableBytes',(SELECT coalesce(sum(pg_total_relation_size(c.oid)),0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('job_engine','dbos') AND c.relkind IN ('r','m')));"""
 pg=json.loads(sql(query))
 vm=run(['colima','--profile','b-budget','ssh','--','sh','-c',"cat /proc/meminfo /proc/stat /proc/pressure/memory; df -B1 /"],timeout=30).stdout.decode()
 probe={}
 try: probe=json.loads(sql("SELECT json_build_object('journalTableBytes',(SELECT coalesce(sum(pg_total_relation_size(c.oid)),0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('job_engine','dbos') AND c.relkind IN ('r','m')),'messages',(SELECT json_object_agg(state,n) FROM (SELECT state,count(*) n FROM job_engine.message GROUP BY state)t),'effects',(SELECT count(*) FROM public.budget_effect));",database='b_budget_probe'))
 except Exception:pass
 record={'observedAt':now,'phase':phase,'dockerStats':stats,'containers':details,'postgres':pg,'probe':probe,'vmRaw':vm}
 with out.open('a') as f:f.write(json.dumps(record)+'\n')
 print(json.dumps({'event':'sample','phase':phase,'connections':pg['connections'],'liveContainers':len(live)}),flush=True)
if __name__=='__main__':
 import sys
 sample(sys.argv[1])
