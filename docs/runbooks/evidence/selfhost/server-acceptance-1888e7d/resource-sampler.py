import json,subprocess,time,pathlib,datetime,os
base=pathlib.Path('/root/selfhost-prep/acceptance-1888e7d');base.mkdir(mode=0o700,exist_ok=True)
(base/'sampler.pid').write_text(str(os.getpid()))
def run(a):
 p=subprocess.run(a,capture_output=True,text=True,timeout=20)
 return p.stdout.strip() if p.returncode==0 else ''
while True:
 try:
  ids=run(['docker','ps','--format','{{.Names}}']).splitlines()
  own=[n for n in ids if n.startswith(('product-res-selfhost-','selfhost-accept-','selfhost-restore-'))]
  stats=run(['docker','stats','--no-stream','--format','{{json .}}',*own]) if own else ''
  containers=[]
  for line in stats.splitlines():
   s=json.loads(line);containers.append({k:s.get(k) for k in ['Name','CPUPerc','MemUsage','MemPerc','PIDs']})
  mem={k:int(v.strip().split()[0]) for l in pathlib.Path('/proc/meminfo').read_text().splitlines() for k,v in [l.split(':',1)] if k in ['MemTotal','MemAvailable','SwapTotal','SwapFree']}
  pg=''
  if 'product-res-selfhost-postgres-1' in ids:
   pg=run(['docker','exec','product-res-selfhost-postgres-1','psql','-X','-U','postgres','-d','product_res_production','-Atc',"select json_build_object('connections',(select count(*) from pg_stat_activity),'idleInTransaction',(select count(*) from pg_stat_activity where state='idle in transaction'),'databaseBytes',pg_database_size(current_database()),'walBytes',(select sum(size) from pg_ls_waldir()),'engineBytes',(select coalesce(sum(pg_total_relation_size(c.oid)),0) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('job_engine','dbos') and c.relkind='r'))"])
  s=os.statvfs('/var/lib/docker')
  item={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'memoryKiB':mem,'diskFreeBytes':s.f_bavail*s.f_frsize,'containers':containers,'postgres':json.loads(pg) if pg else None,'cpuTicks':pathlib.Path('/proc/stat').read_text().splitlines()[0]}
  with (base/'resources.jsonl').open('a') as f:f.write(json.dumps(item)+'\n')
 except Exception as e:
  with (base/'sampler-errors.log').open('a') as f:f.write(type(e).__name__+'\n')
 time.sleep(5)
