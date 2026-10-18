import pathlib,json,subprocess,datetime,time,urllib.request,sys
p=pathlib.Path('/root/selfhost-prep/acceptance-1888e7d');sha='1888e7d165b0b87784e7d16a4c39709a9bc063e3';started=time.monotonic();bootWall=datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(seconds=float(pathlib.Path('/proc/uptime').read_text().split()[0]))
pre=json.loads((p/'reboot-pre.json').read_text())
def run(args):
 r=subprocess.run(args,capture_output=True,text=True,timeout=25)
 if r.returncode:raise RuntimeError('COMMAND_NOT_READY')
 return r.stdout.strip()
def rpc(path):return json.loads(run(['docker','exec','selfhost-accept-probe','node','-e',"fetch('http://127.0.0.1:3101"+path+"').then(async r=>{if(!r.ok)process.exit(1);console.log(JSON.stringify(await r.json()))})"]))
while True:
 try:
  h=json.loads(urllib.request.urlopen('https://selfhost.ezarouter.cc/api/health',timeout=10).read());assert h['status']=='ok' and h['version']==sha
  stamp=datetime.datetime.fromisoformat(h['jobs']['lastCronAt'].replace('Z','+00:00'));assert stamp>bootWall
  for name in ['product-res-selfhost-jobs-1','selfhost-accept-jobs2']:
   j=json.loads(run(['docker','exec',name,'node','-e',"fetch('http://127.0.0.1:3001/internal/ready').then(async r=>{let j=await r.json();console.log(JSON.stringify({http:r.status,status:j.status,version:j.version}))})"]));assert j['http']==200 and j['status']=='ok' and j['version']==sha
  b=json.loads(run(['docker','exec','product-res-selfhost-backup-1','python3','/usr/local/lib/selfhost-backup/backup.py','status']));assert b['healthy']
  assert rpc('/ready')['ready']
  residents=json.loads(run(['docker','inspect',*['product-res-selfhost-'+n+'-1' for n in ['postgres','valkey','web','jobs','caddy','backup']]]));assert all(d['State']['Status']=='running' and d['State'].get('Health',{}).get('Status')=='healthy' for d in residents)
  break
 except Exception:
  if time.monotonic()-started>480:raise RuntimeError('AUTOMATIC_RECOVERY_NOT_READY')
  print(json.dumps({'event':'waiting-for-natural-postboot-readiness','elapsedSeconds':round(time.monotonic()-started,1)}),flush=True);time.sleep(10)
run(['python3','-B','/root/selfhost-prep/boot-snapshot-1888e7d.py','post']);post=json.loads((p/'reboot-post.json').read_text())
checks={'actualBootChanged':pre['bootIdSha256']!=post['bootIdSha256'],'sameFullSha':post['web']['version']==sha and post['jobs']['version']==sha and post['jobs2']['version']==sha,'freshNaturalHeartbeat':datetime.datetime.fromisoformat(post['web']['jobs']['lastCronAt'].replace('Z','+00:00'))>bootWall,'productionCertificatePreserved':pre['certificateSha256']==post['certificateSha256'] and post['tlsVerified'],'dataPreserved':pre['data']==post['data'],'pendingTaskRecovered':post['probe']['status']=='waiting' and post['probe']['rows']==pre['probe']['rows'],'originalWaitDeadlinePreserved':pre['probe']['wait'][0]['deadline']==post['probe']['wait'][0]['deadline'],'dailySlotNotRepeated':pre['backup']['schedule']==post['backup']['schedule'] and pre['backup']['base']['backupId']==post['backup']['base']['backupId'],'backupAndReplicaResumed':post['backup']['healthy'],'nonSelfhostStayedStopped':post['nonSelfhost']['count']==pre['nonSelfhost']['count']==15 and post['nonSelfhost']['allStopped'] and post['nonSelfhost']['allRestartNo'],'warpStayedDisabled':post['warp']['active']=='inactive' and post['warp']['enabled']=='disabled' and not post['warp']['startedThisBoot'],'dockerStillEnabled':post['dockerEnabled'],'noHostOom':pre['hostOomKillsSinceBoot']==post['hostOomKillsSinceBoot']==0}
a=next(s for s in pre['services'] if s['service']=='migrate');b=next(s for s in post['services'] if s['service']=='migrate')
checks['valkeyAofPersisted']=pre['valkeyProbe']==post['valkeyProbe'] and post['valkeyProbe']['matchesExpected']
checks['nonSelfhostNeverRestarted']=pre['nonSelfhost']['stateFingerprintSha256']==post['nonSelfhost']['stateFingerprintSha256']
checks['migrationNotRerun']=all(a[k]==b[k] for k in ['idSha256','status','exitCode','restartCount','startedAt','finishedAt']) and b['status']=='exited' and b['exitCode']==0
checks['allResidentServicesAutomaticallyHealthy']=all(s['status']=='running' and s['health']=='healthy' for s in post['services'] if s['service']!='migrate')
assert all(checks.values()), 'POSTBOOT_CHECK_FAILED'
assert rpc('/resume/reboot-proof')['accepted']
for _ in range(60):
 task=rpc('/status/reboot-proof')
 if task['state']['status']=='completed':break
 time.sleep(1)
else:raise RuntimeError('RESUMED_PROBE_NOT_COMPLETE')
checks['successfulCallbacksNotRepeated']=task['rows']==[{'prepared':1,'completed':1}]
checks['originalTaskCompleted']=task['state']['status']=='completed' and task['state'].get('output',{}).get('resumed') is True
assert all(checks.values()), 'PROBE_RESULT_FAILED'
(p/'reboot-task-recovered.json').write_text(json.dumps({'checks':checks,'task':task,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()},indent=2)+'\n')
backupStart=time.monotonic()
while True:
 b=json.loads(run(['docker','exec','product-res-selfhost-backup-1','python3','/usr/local/lib/selfhost-backup/backup.py','status']))
 if b['healthy'] and all(datetime.datetime.fromisoformat(b[k]['lastSuccess'].replace('Z','+00:00'))>bootWall for k in ['verification','replica']):break
 if time.monotonic()-backupStart>480:raise RuntimeError('AUTOMATIC_POSTBOOT_BACKUP_NOT_RESUMED')
 print(json.dumps({'event':'waiting-for-natural-postboot-backup-cycle','elapsedSeconds':round(time.monotonic()-backupStart,1)}),flush=True);time.sleep(10)
checks['freshPostbootBackupVerification']=datetime.datetime.fromisoformat(b['verification']['lastSuccess'].replace('Z','+00:00'))>bootWall
checks['freshPostbootReplicaSuccess']=datetime.datetime.fromisoformat(b['replica']['lastSuccess'].replace('Z','+00:00'))>bootWall
(p/'backup-postboot.json').write_text(json.dumps(b,indent=2)+'\n')
report={'sha':sha,'completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'bootWallEstimate':bootWall.isoformat(),'automaticRecoveryObservationSeconds':round(time.monotonic()-started,3),'checks':checks,'probeAfterEvent':{'status':task['state']['status'],'rows':task['rows'],'resumed':task['state'].get('output',{}).get('resumed')},'manualServiceStarts':False,'ownerFilesDeletedOrEdited':False,'success':True,'observerReordered':True,'observerReason':'Capture unchanged pending task and original deadline before waiting for the independent 5-minute backup cycle; all original checks retained. No service restart or manual backup trigger.'}
(p/'reboot.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report),flush=True)
