#!/usr/bin/env python3
"""给运行中的b-1.9-run.py添加可选storage/backup资源；只操作其独占runtime。
从runtime.ready输出取得 --runtime，原控制器finally负责统一清理；约2分钟。
"""
import argparse,json,pathlib,shutil,uuid,time,datetime,sys
parser=argparse.ArgumentParser()
parser.add_argument('--runtime',type=pathlib.Path,required=True)
args=parser.parse_args()
if not (args.runtime/'control.py').is_file():
 raise RuntimeError('owned resource-controller runtime required')
sys.path.insert(0,str(args.runtime.resolve()))
from control import runtime,run,compose,sql,state
root=pathlib.Path.cwd();s=json.loads((runtime/'env-state.json').read_text());deploy=pathlib.Path(s['directory']);secret=deploy/'secrets';cert=deploy/'certs';images=json.loads((runtime/'bundle/release.json').read_text())['images'];env={**s['env']}
for service in ['object-storage','backup']:
 start=time.time();r=run(['docker','pull',images[service]],timeout=900,check=False);print(json.dumps({'event':'optional.pull','service':service,'exitCode':r.returncode,'seconds':time.time()-start}),flush=True)
 if r.returncode:sys.exit(1)
for name in ['s3_admin_access_key_id','s3_admin_secret_access_key','s3_access_key_id','s3_secret_access_key','backup_s3_access_key_id','backup_s3_secret_access_key','budget_backup_admin_id','budget_backup_admin_key']:
 (secret/name).write_text(uuid.uuid4().hex+uuid.uuid4().hex);(secret/name).chmod(0o644)
# 本机唯一CA签发两个服务证书；备份身份独立，TLS校验不跳过。
def certificate(directory,sans):
 directory.mkdir(exist_ok=True);extension=directory/'extensions';extension.write_text('subjectAltName='+','.join('DNS:'+x for x in sans)+'\nextendedKeyUsage=serverAuth\n')
 for args in [
  ['openssl','req','-new','-newkey','rsa:2048','-nodes','-keyout',str(directory/'server.key'),'-out',str(directory/'server.csr'),'-subj','/CN='+sans[0]],
  ['openssl','x509','-req','-in',str(directory/'server.csr'),'-CA',str(cert/'ca.crt'),'-CAkey',str(cert/'ca.key'),'-CAcreateserial','-out',str(directory/'server.crt'),'-days','2','-extfile',str(extension)]]:run(args)
 directory.chmod(0o755);(directory/'server.key').chmod(0o644);(directory/'server.crt').chmod(0o644)
certificate(cert/'caddy',['b-budget.test','s3.b-budget.test']);certificate(cert/'backup-tls',['backup-tls'])
for name in ['object-storage-init.mjs','Caddyfile.object-storage']:
 shutil.copyfile((runtime/'bundle')/name,deploy/name)
(envfile:=deploy/'.env').write_text(envfile.read_text()+'S3_PUBLIC_DOMAIN=s3.b-budget.test\nS3_BUCKET=b-budget-files\nBACKUP_S3_ENDPOINT=https://backup-tls:8443\nBACKUP_S3_PREFIX=s3://b-budget-backup/b-budget/pg17\nBACKUP_CA_FILE='+str(cert/'ca.crt')+'\n')
env.update({k.upper().replace('-','_')+'_IMAGE':v for k,v in images.items()})
args=['docker','compose','--project-directory',str(deploy),'--env-file',str(envfile),'-f',str(runtime/'bundle/compose.yaml'),'-f',str(runtime/'bundle/compose.object-storage.yaml'),'-f',str(runtime/'bundle/compose.backup.yaml'),'--profile','object-storage','--profile','caddy','config','--format','json']
r=__import__('subprocess').run(args,env=env,capture_output=True,timeout=30)
if r.returncode:raise RuntimeError('optional config failed; raw withheld')
fresh=json.loads(r.stdout);previous=json.loads((runtime/'stack.json').read_text())
for group in ['services','networks','volumes','secrets']:previous[group].update(fresh[group])
c=previous
for name in ['caddy','object-storage','object-storage-init']:
 c['services'][name].pop('profiles',None)
c['services']['jobs']['hostname']='b-budget-jobs-1';c['services']['jobs']['environment']['JOB_EXECUTOR_ID']='b-budget-jobs-1'
c['services']['jobs2']=json.loads(json.dumps(c['services']['jobs']));c['services']['jobs2']['hostname']='b-budget-jobs-2';c['services']['jobs2']['environment']['JOB_EXECUTOR_ID']='b-budget-jobs-2';c['services']['jobs2']['networks']['ingress']['ipv4_address']='172.30.77.5'
c['services']['caddy']['ports']=[{'target':8080,'published':'28480','host_ip':'127.0.0.1','protocol':'tcp'},{'target':443,'published':'28443','host_ip':'127.0.0.1','protocol':'tcp'}]
# 完整profile本地预算变体；生产Compose无改动。小fixture backup cap256另有D先前证据，本轮重新测。
caps={'postgres':('1g','0.5'),'valkey':('192m','0.1'),'web':('640m','0.3'),'jobs':('384m','0.2'),'jobs2':('384m','0.2'),'caddy':('128m','0.1'),'object-storage':('512m','0.3'),'backup':('256m','0.2')}
for name,(mem,cpu) in caps.items():c['services'][name]['mem_limit']=mem;c['services'][name]['cpus']=cpu
# 只为本轮提供本地external-S3替身；不同bucket和独立密钥，不交给web/jobs。
for name in ['budget_backup_admin_id','budget_backup_admin_key']:c['secrets'][name]={'file':str(secret/name)}
backup_s3=json.loads(json.dumps(c['services']['object-storage']));backup_s3['environment'].update({'S3_PUBLIC_DOMAIN':'backup-tls','S3_BUCKET':'b-budget-backup','S3_ADMIN_ACCESS_KEY_ID_FILE':'/run/secrets/budget_backup_admin_id','S3_ADMIN_SECRET_ACCESS_KEY_FILE':'/run/secrets/budget_backup_admin_key','S3_ACCESS_KEY_ID_FILE':'/run/secrets/backup_s3_access_key_id','S3_SECRET_ACCESS_KEY_FILE':'/run/secrets/backup_s3_secret_access_key'});backup_s3['secrets']=[{'source':x,'target':x} for x in ['budget_backup_admin_id','budget_backup_admin_key','backup_s3_access_key_id','backup_s3_secret_access_key']];backup_s3['volumes']=[{'type':'volume','source':'budget_backup_objects','target':'/data'},{'type':'volume','source':'budget_backup_metadata','target':'/metadata'}];backup_s3['networks']={'budget_backup_object':{'aliases':['object-storage']}};c['services']['backup-s3']=backup_s3
init=json.loads(json.dumps(c['services']['object-storage-init']));init['environment'].update({'S3_BUCKET':'b-budget-backup','S3_ADMIN_ACCESS_KEY_ID_FILE':'/run/secrets/budget_backup_admin_id','S3_ADMIN_SECRET_ACCESS_KEY_FILE':'/run/secrets/budget_backup_admin_key'});init['secrets']=[{'source':x,'target':x} for x in ['budget_backup_admin_id','budget_backup_admin_key']];init['networks']={'budget_backup_object':None};init['depends_on']={'backup-s3':{'condition':'service_healthy'}};c['services']['backup-s3-init']=init
proxy=runtime/'backup.Caddyfile';proxy.write_text('''{
 auto_https off
 servers {
  protocols h1 h2
 }
}
https://backup-tls:8443 {
 tls /certs/server.crt /certs/server.key
 handle_errors {
  respond "Backup storage is unavailable" 503
 }
 reverse_proxy backup-s3:8333
}
''')
gateway=json.loads(json.dumps(c['services']['caddy']));gateway.pop('ports',None);gateway.pop('sysctls',None);gateway['environment']={};gateway['volumes']=[{'type':'bind','source':str(proxy),'target':'/etc/caddy/Caddyfile','read_only':True},{'type':'bind','source':str(cert/'backup-tls'),'target':'/certs','read_only':True},{'type':'volume','source':'budget_backup_tls_data','target':'/data'},{'type':'volume','source':'budget_backup_tls_config','target':'/config'}];gateway['networks']={'data':None,'budget_backup_object':None};gateway['depends_on']={'backup-s3':{'condition':'service_healthy'}};c['services']['backup-tls']=gateway
c['networks']['budget_backup_object']={'name':'b-budget_backup_object','internal':True}
for name in ['budget_backup_objects','budget_backup_metadata','budget_backup_tls_data','budget_backup_tls_config']:c['volumes'][name]={'name':'b-budget_'+name}
# 所有新增文件只含随机fixture或路径；先停止自己运行的应用，保留PG和owner卷。
# 与主采样器握手，避免PG重建窗口使主控制器误判并执行finally清理。
(runtime/'sampling-paused').write_text('profile transition\n')
deadline=time.monotonic()+120
while not (runtime/'sampling-pause-ack').exists():
 if time.monotonic()>deadline:
  (runtime/'sampling-paused').unlink(missing_ok=True)
  raise RuntimeError('controller did not acknowledge sampling pause; PG untouched')
 time.sleep(0.5)
compose('stop','-t','2','probe-worker-a','probe-worker-b')
compose('stop','-t','35','web','jobs','jobs2','caddy')
(runtime/'stack.json').write_text(json.dumps(c,indent=2))
for services in [('object-storage','backup-s3'),('object-storage-init','backup-s3-init'),('backup-tls',),('postgres','valkey'),('web','jobs','jobs2','caddy','probe-worker-a','probe-worker-b','backup')]:
 r=compose('up','-d','--no-deps',*services,timeout=180,check=False);print(json.dumps({'event':'optional.up','services':services,'exitCode':r.returncode}),flush=True)
 if r.returncode:sys.exit(1)
 if 'object-storage' in services:
  deadline=time.monotonic()+100
  while time.monotonic()<deadline:
   statuses=[json.loads(compose('ps','-a','--format','json',name).stdout)['Health'] for name in services]
   if all(x=='healthy' for x in statuses):break
   time.sleep(2)
 if 'object-storage-init' in services:
  for name in services:
   cid=compose('ps','-a','-q',name).stdout.decode().strip();code=run(['docker','wait',cid],timeout=90).stdout.decode().strip();print(json.dumps({'event':'optional.init','service':name,'exitCode':code}),flush=True)
   if code!='0':sys.exit(1)
 if 'postgres' in services:time.sleep(10)
# 全部服务共存后追加90条队列积压，不创建第二个长任务。
extra=json.loads(json.dumps(c['services']['probe-produce']))
extra['hostname']='probe-produce-extra'
extra['environment'].update({'PROBE_EXECUTOR_ID':'probe-produce-extra','PROBE_SECOND_BATCH':'1'})
c['services']['probe-produce-extra']=extra
(runtime/'stack.json').write_text(json.dumps(c,indent=2))
compose('run','--rm','--no-deps','probe-produce-extra',timeout=90)
report={'additionalQueueMessages':90,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'formalSha':'081305013b022f457c561eecf5828b1959e13908','steadyProductionCaps':caps,'productionSteadyMiB':3520,'productionSteadyCpu':1.9,'extraLocalS3Fixture':{'services':['backup-s3','backup-tls'],'capMiB':640,'cpu':0.4},'extraProbeWorkers':{'capMiB':1024,'cpu':0.6},'archiveMode':sql('SHOW archive_mode'),'archiveTimeout':sql('SHOW archive_timeout'),'archiveCommandIsWalg':'selfhost-walg' in sql('SHOW archive_command')}
(runtime/'all-profiles.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report),flush=True)

(runtime/'sampling-paused').unlink(missing_ok=True)
