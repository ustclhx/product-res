import pathlib,json,re,hashlib,gzip,statistics,sys,datetime
source=pathlib.Path(sys.argv[1]);dest=pathlib.Path(sys.argv[2]);raw=source.read_bytes();items=[json.loads(l) for l in raw.splitlines()]
def mem(v):
 x=re.fullmatch(r'\s*([0-9.]+)\s*([A-Za-z]+)\s*',v.split('/')[0]);return float(x[1])*{'B':1,'KiB':1024,'MiB':1024**2,'GiB':1024**3,'KB':1000,'MB':1000**2,'GB':1000**3}[x[2]]
rows=[];previous=None;previousAt=None;deltas=[];gaps=[];counterResets=0
for i in items:
 ticks=list(map(int,i['cpuTicks'].split()[1:9]));total=sum(ticks);idle=ticks[3]+ticks[4];cpu=None
 if previous:
  dt=total-previous[0];di=idle-previous[1]
  elapsed=(datetime.datetime.fromisoformat(i['at'])-datetime.datetime.fromisoformat(previousAt)).total_seconds()
  if elapsed>30:gaps.append({'from':previousAt,'to':i['at'],'seconds':round(elapsed,3)})
  if dt<=0:counterResets+=1
  if dt>0 and 0<elapsed<=30:cpu=100*(dt-di)/dt;deltas.append((dt,dt-di))
 previous=(total,idle);previousAt=i['at']
 containers=[{'name':c['Name'],'workingSetMiB':round(mem(c['MemUsage'])/2**20,3),'dockerCpuPercent':float(c['CPUPerc'].strip('%'))} for c in i['containers']]
 rows.append({'at':i['at'],'hostCpuPercent':round(cpu,3) if cpu is not None else None,'availableMemoryMiB':round(i['memoryKiB']['MemAvailable']/1024,3),'freeDiskGiB':round(i['diskFreeBytes']/2**30,4),'containerWorkingSetMiB':round(sum(c['workingSetMiB'] for c in containers),3),'postgres':i['postgres'],'containers':containers})
peaks={}
for row in rows:
 for c in row['containers']:
  p=peaks.setdefault(c['name'],{'maxWorkingSetMiB':0,'maxDockerCpuPercent':0})
  p['maxWorkingSetMiB']=max(p['maxWorkingSetMiB'],c['workingSetMiB']);p['maxDockerCpuPercent']=max(p['maxDockerCpuPercent'],c['dockerCpuPercent'])
pg=[i['postgres'] for i in items if i['postgres']]
cpus=sorted(r['hostCpuPercent'] for r in rows if r['hostCpuPercent'] is not None)
summary={'sha':'1888e7d165b0b87784e7d16a4c39709a9bc063e3','sampleStart':items[0]['at'],'sampleEnd':items[-1]['at'],'samples':len(items),'samplingGapsOver30Seconds':gaps,'cpuCounterResets':counterResets,'rawSha256':hashlib.sha256(raw).hexdigest(),'hostPhysicalMemoryMiB':items[0]['memoryKiB']['MemTotal']/1024,'minAvailableMemoryMiB':min(r['availableMemoryMiB'] for r in rows),'maxOwnedContainerWorkingSetMiB':max(r['containerWorkingSetMiB'] for r in rows),'minFreeDiskGiB':min(r['freeDiskGiB'] for r in rows),'hostCpuPercent':{'max':max(cpus),'p95':cpus[int((len(cpus)-1)*.95)],'tickWeightedMean':round(100*sum(i[1] for i in deltas)/sum(i[0] for i in deltas),3)},'postgres':{k:{'first':pg[0][k],'last':pg[-1][k],'max':max(i[k] for i in pg)} for k in ['connections','idleInTransaction','databaseBytes','walBytes','engineBytes']},'swapKiB':{'initialUsed':items[0]['memoryKiB']['SwapTotal']-items[0]['memoryKiB']['SwapFree'],'finalUsed':items[-1]['memoryKiB']['SwapTotal']-items[-1]['memoryKiB']['SwapFree'],'maxUsed':max(i['memoryKiB']['SwapTotal']-i['memoryKiB']['SwapFree'] for i in items)},'containers':peaks,'notes':['Host CPU 100% means both vCPUs. Derived from Linux /proc/stat deltas, excludes idle and iowait; guest fields excluded from total to avoid double-counting.','Docker CPU 100% means one core. Memory is Docker working set, not exact RSS; cgroup peaks and OOM counters are separate evidence.','CPU excludes intervals over 30s and reset counters; sampler intentionally stopped while awaiting approval, and host reboot interrupts sampling. Gaps are reported, not presented as continuous coverage. Nominal sleep 5s plus collection time; actual intervals are preserved. Sampling boundaries are explicit; recorded deployment/migration activity, manual full backup, restores and all long tests are included.','PG connections/WAL are cluster-wide; databaseBytes/engineBytes cover main product_res_production only; engine-footprints records isolated suite databases separately.','Transient idle-in-transaction is expected during caller-transaction visibility/rollback tests; report final value separately.','Limits are per-service ceilings, not reserved memory. Official resident limits total 3712MiB with backup, 4480MiB with second jobs; simultaneous saturation exceeds this host. Results apply to measured fixture workload, not arbitrary production concurrency.']}
(dest/'resources.json').write_text(json.dumps(summary,indent=2)+'\n')
with (dest/'resources.jsonl.gz').open('wb') as f:
 with gzip.GzipFile(fileobj=f,mode='wb',mtime=0) as g:g.write(raw)
# Keep minute observations and every measured minimum/maximum visible without decompression.
selected={};
for n,r in enumerate(rows):selected[r['at'][:16]]=n
indexes=set(selected.values())|{0,len(rows)-1}
for k in ['hostCpuPercent','availableMemoryMiB','freeDiskGiB','containerWorkingSetMiB']:
 valid=[i for i,r in enumerate(rows) if r[k] is not None];indexes.add(min(valid,key=lambda i:rows[i][k]));indexes.add(max(valid,key=lambda i:rows[i][k]))
(dest/'resource-samples.json').write_text(json.dumps([rows[i] for i in sorted(indexes)],indent=2)+'\n')
print(json.dumps({k:summary[k] for k in ['samples','minAvailableMemoryMiB','minFreeDiskGiB','maxOwnedContainerWorkingSetMiB','hostCpuPercent']}))
