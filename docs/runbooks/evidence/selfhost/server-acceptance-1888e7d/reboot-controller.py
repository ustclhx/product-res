import pathlib,re,subprocess,shlex,time,json,datetime
root=pathlib.Path.cwd();out=pathlib.Path('/tmp/selfhost-acceptance-1888e7d')
for change,number in [('foundation','7.4'),('job-engine','6.4'),('delivery','7.1'),('delivery','7.2')]:
 text=(root/'openspec/changes'/('add-selfhost-'+change)/'tasks.md').read_text();assert re.search(r'^- \[x\] '+re.escape(number)+r' ',text,re.M),'PREREQUISITE_NOT_ACCEPTED'
ssh=['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=5','product-res-ecs']
def command(code):return ssh+[shlex.join(['python3','-B','-c',code])]
request="""import pathlib,json,datetime,subprocess,os
p=pathlib.Path('/root/selfhost-prep/acceptance-1888e7d')
for suite,count in [('queue',14),('scheduler',10)]:
 j=json.loads((p/(suite+'-r2')/'summary.json').read_text());assert j['success'] and j['passed']==count and j['failed']==0 and j['pending']==0
j=json.loads((p/'recovery-r6/summary.json').read_text());assert j['success'] and j['passed']==10 and j['failed']==0 and j['pending']==1 and all(x['status']=='passed' for x in j['results'] if '61-minute collection pipeline' not in x['title'])
original=json.loads((p/'workflow-r2/summary.json').read_text())
long=[x for x in original['results'] if '61-minute collection pipeline' in x['title']]
assert any(x['status']=='passed' and x['durationMs']>3600000 for x in long)
assert (p/'approved-fixture-provenance.json').exists()
pre=json.loads((p/'reboot-pre.json').read_text());now=datetime.datetime.now(datetime.timezone.utc)
assert (now-datetime.datetime.fromisoformat(pre['at'])).total_seconds()<90
assert pre['probe']['status']=='waiting' and pre['valkeyProbe']['matchesExpected'] and pre['backup']['healthy']
assert pre['nonSelfhost']['count']==15 and pre['nonSelfhost']['allStopped'] and pre['nonSelfhost']['allRestartNo']
assert pre['warp']['active']=='inactive' and pre['warp']['enabled']=='disabled'
marker=p/'reboot-command.json';assert not marker.exists()
with marker.open('x') as f:
 json.dump({'requestedAt':now.isoformat(),'target':'product-res-ecs','method':'systemctl reboot','prerequisitesVerified':True},f);f.flush();os.fsync(f.fileno())
r=subprocess.run(['systemctl','reboot'],capture_output=True,text=True);print(json.dumps({'rebootRequestExit':r.returncode}),flush=True)
"""
started=time.monotonic()
try:r=subprocess.run(command(request),capture_output=True,text=True,timeout=20);code=r.returncode
except subprocess.TimeoutExpired:code='ssh-closed-during-request'
if code not in (0,255,'ssh-closed-during-request'):raise RuntimeError('REBOOT_REQUEST_PREREQUISITE_FAILED')
print(json.dumps({'event':'approved-real-reboot-requested','sshExit':code}),flush=True)
poll="""import pathlib,json,hashlib
p=pathlib.Path('/root/selfhost-prep/acceptance-1888e7d');pre=json.loads((p/'reboot-pre.json').read_text());now=hashlib.sha256(pathlib.Path('/proc/sys/kernel/random/boot_id').read_bytes()).hexdigest();print(json.dumps({'newBoot':now!=pre['bootIdSha256'],'uptimeSeconds':float(pathlib.Path('/proc/uptime').read_text().split()[0])}))"""
while True:
 try:
  r=subprocess.run(command(poll),capture_output=True,text=True,timeout=8)
  if 'Host key verification failed' in r.stderr:raise RuntimeError('SSH_HOST_KEY_CHANGED')
  data=json.loads(r.stdout) if r.returncode==0 else {}
  if data.get('newBoot'):
   observed={'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'rebootRequestToNewBootSeconds':round(time.monotonic()-started,3),**data};(out/'new-boot.json').write_text(json.dumps(observed,indent=2)+'\n');print(json.dumps(observed),flush=True);break
 except (subprocess.TimeoutExpired,json.JSONDecodeError):pass
 if time.monotonic()-started>180:raise RuntimeError('NEW_BOOT_NOT_OBSERVED')
 print(json.dumps({'event':'waiting-for-new-host-boot','elapsedSeconds':round(time.monotonic()-started,1)}),flush=True);time.sleep(5)
r=subprocess.run(ssh+['python3 -u -B /root/selfhost-prep/recover-1888e7d.py'],capture_output=True,text=True,timeout=540)
f=out/'recovery-private.log';f.write_text(r.stdout+r.stderr);f.chmod(0o600)
print(json.dumps({'automaticRecoveryExit':r.returncode,'requestToRecoveryObservationSeconds':round(time.monotonic()-started,3)}),flush=True)
if r.returncode:raise SystemExit(1)
