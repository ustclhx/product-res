import json,pathlib,subprocess,datetime,hashlib,base64,sys,time,urllib.request,ssl,socket,uuid
root=pathlib.Path('/root/selfhost-prep/acceptance-1888e7d');phase=sys.argv[1];refresh=phase=='pre-refresh'
if refresh:phase='pre'
assert phase in ['pre','post']
def run(args,inp=None):
 r=subprocess.run(args,input=inp,capture_output=True,text=True,timeout=25)
 if r.returncode:raise RuntimeError('SNAPSHOT_COMMAND_FAILED')
 return r.stdout.strip()
def rpc(path):
 return json.loads(run(['docker','exec','selfhost-accept-probe','node','-e',"fetch('http://127.0.0.1:3101"+path+"').then(async r=>{if(!r.ok)process.exit(1);console.log(JSON.stringify(await r.json()))})"]))
def sql(q):
 return json.loads(run(['docker','exec','product-res-selfhost-postgres-1','psql','-X','-U','postgres','-d','product_res_production','-Atc',q]))
def health():
 r=urllib.request.urlopen('https://selfhost.ezarouter.cc/api/health',timeout=15)
 j=json.loads(r.read());return {'http':r.status,**{k:j.get(k) for k in ['status','version','db','cache','queue','scheduler','jobs']}}
def job(name):
 return json.loads(run(['docker','exec',name,'node','-e',"fetch('http://127.0.0.1:3001/internal/ready').then(async r=>{let j=await r.json();console.log(JSON.stringify({http:r.status,status:j.status,version:j.version,lastCronAt:j.jobs?.lastCronAt}))})"]))
def cache(command):
 return run(['docker','exec','-i','product-res-selfhost-valkey-1','sh','-c','export REDISCLI_AUTH="$(cat /run/secrets/valkey_password)"; exec valkey-cli --raw'],command+'\n')
cachePath=root/'reboot-valkey-private.json'
if phase=='pre' and not refresh:
 assert not cachePath.exists()
 nonce=uuid.uuid4().hex
 cached={'key':'selfhost-acceptance:acceptance:reboot-'+nonce,'value':'persistence-'+nonce}
 assert cache('SET '+cached['key']+' '+cached['value']+' NX')=='OK'
 cachePath.write_text(json.dumps(cached));cachePath.chmod(0o600)
else:cached=json.loads(cachePath.read_text())
cacheValue=cache('GET '+cached['key'])
cacheProbe={'keySha256':hashlib.sha256(cached['key'].encode()).hexdigest(),'valueSha256':hashlib.sha256(cacheValue.encode()).hexdigest(),'matchesExpected':cacheValue==cached['value']}
started=datetime.datetime.now(datetime.timezone.utc)
if phase=='pre' and not refresh:
 assert rpc('/ready')['ready'];assert rpc('/start/reboot-proof')['accepted']
 for _ in range(40):
  probe=rpc('/status/reboot-proof')
  if probe['state']['status']=='waiting':break
  time.sleep(1)
 else:raise RuntimeError('PROBE_NOT_WAITING')
else:probe=rpc('/status/reboot-proof')
if refresh:
 assert (root/'reboot-pre.json').exists() and not (root/'reboot-command.json').exists()
 assert probe['state']['status']=='waiting'
 original=root/'reboot-pre-initial.json'
 if not original.exists():original.write_text((root/'reboot-pre.json').read_text())
sha='1888e7d165b0b87784e7d16a4c39709a9bc063e3'
services=[]
for service in ['postgres','valkey','web','jobs','caddy','backup','migrate']:
 d=json.loads(run(['docker','inspect','product-res-selfhost-'+service+'-1']))[0]
 services.append({'service':service,'idSha256':hashlib.sha256(d['Id'].encode()).hexdigest(),'status':d['State']['Status'],'health':d['State'].get('Health',{}).get('Status'),'exitCode':d['State']['ExitCode'],'restartCount':d['RestartCount'],'startedAt':d['State']['StartedAt'],'finishedAt':d['State']['FinishedAt'],'oomKilled':d['State']['OOMKilled']})
nonself=[]
baseline=json.loads((root/'deployment.json').read_text())['nonSelfhost']
assert isinstance(baseline,list) and len(baseline)==15
for prior in baseline:
 name=prior['name']
 d=json.loads(run(['docker','inspect',name]))[0]
 assert d['State']['Status']=='exited' and d['HostConfig']['RestartPolicy']['Name']=='no'
 nonself.append({'name':d['Name'],'stopped':True,'restartNo':True,'identity':d['Id'],'startedAt':d['State']['StartedAt'],'finishedAt':d['State']['FinishedAt'],'restartCount':d['RestartCount']})
nonself=list({i['name']:i for i in nonself}.values())
private=root/('reboot-legacy-'+phase+'-private.json');private.write_text(json.dumps(nonself));private.chmod(0o600)
encode=lambda s:base64.urlsafe_b64encode(s.encode()).decode().rstrip('=')
native='workflow:'+encode('selfhost-probe-v1')+':'+encode('reboot-proof')
wait=sql("SELECT coalesce(json_agg(json_build_object('state',state,'deadline',deadline,'createdAt',created_at,'finishedAt',finished_at)),'[]') FROM job_engine.workflow_wait WHERE workflow_id='"+native+"' AND name='original-deadline'")
backup=json.loads(run(['docker','exec','product-res-selfhost-backup-1','python3','/usr/local/lib/selfhost-backup/backup.py','status']))
if phase=='pre':assert backup['healthy'], 'BACKUP_NOT_HEALTHY_FOR_PREBOOT'
row={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'valkeyProbe':cacheProbe,'sha':sha,'bootIdSha256':hashlib.sha256(pathlib.Path('/proc/sys/kernel/random/boot_id').read_bytes()).hexdigest(),'uptimeSeconds':float(pathlib.Path('/proc/uptime').read_text().split()[0]),'services':services,'web':health(),'jobs':job('product-res-selfhost-jobs-1'),'jobs2':job('selfhost-accept-jobs2'),'probe':{'status':probe['state']['status'],'rows':probe['rows'],'wait':wait},'data':sql("SELECT json_build_object('users',(SELECT count(*) FROM public.\"user\"),'filesReady',(SELECT count(*) FROM public.file WHERE status='ready' AND deleted_at IS NULL),'markers',(SELECT count(*) FROM public.d_vm_effect))"),'backup':{k:backup[k] for k in ['base','dump','verification','replica','schedule','archive','healthy','checkedAt']},'nonSelfhost':{'count':len(nonself),'allStopped':all(i['stopped'] for i in nonself),'allRestartNo':all(i['restartNo'] for i in nonself),'stateFingerprintSha256':hashlib.sha256(json.dumps(sorted([{k:v for k,v in i.items() if k in ['name','identity','startedAt','stopped','restartNo']} for i in nonself],key=lambda i:i['name']),sort_keys=True).encode()).hexdigest()},'warp':{'startedThisBoot':run(['systemctl','show','warp-svc','-p','ExecMainStartTimestampMonotonic','--value']) not in ('','0'),'active':subprocess.run(['systemctl','is-active','warp-svc'],capture_output=True,text=True).stdout.strip(),'enabled':subprocess.run(['systemctl','is-enabled','warp-svc'],capture_output=True,text=True).stdout.strip()},'dockerEnabled':run(['systemctl','is-enabled','docker'])=='enabled','hostOomKillsSinceBoot':int(dict(l.split() for l in pathlib.Path('/proc/vmstat').read_text().splitlines())['oom_kill'])}
with ssl.create_default_context().wrap_socket(socket.create_connection(('selfhost.ezarouter.cc',443),timeout=10),server_hostname='selfhost.ezarouter.cc') as s:row['tlsVerified']=True;row['certificateSha256']=hashlib.sha256(s.getpeercert(binary_form=True)).hexdigest()
(root/('reboot-'+phase+'.json')).write_text(json.dumps(row,indent=2)+'\n')
print(json.dumps({'phase':phase,'at':row['at'],'webHttp':row['web']['http'],'probeStatus':row['probe']['status'],'nonSelfhost':row['nonSelfhost'],'warp':row['warp'],'hostOomKillsSinceBoot':row['hostOomKillsSinceBoot']}))
