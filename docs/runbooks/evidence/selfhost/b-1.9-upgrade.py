#!/usr/bin/env python3
"""本任务独占runtime内的旧SDK迁移复核；不更改正式镜像/lockfile。"""
import argparse,sys,json,pathlib
parser=argparse.ArgumentParser()
parser.add_argument('--runtime',type=pathlib.Path,required=True)
args=parser.parse_args()
sys.path.insert(0,str(args.runtime.resolve()))
from control import runtime,compose,sql
print(sql('CREATE DATABASE b_budget_upgrade OWNER migrator;'))
print(sql('\\i /usr/local/share/selfhost/02-db-grants.sql',database='b_budget_upgrade'))
s=json.loads((runtime/'env-state.json').read_text());secret=pathlib.Path(s['directory'])/'secrets';c=json.loads((runtime/'stack.json').read_text())
for name in ['app_database_url','migrator_database_url']:
 target=secret/('upgrade_'+name);target.write_text((secret/name).read_text().replace('/acceptance?','/b_budget_upgrade?'));target.chmod(0o644);c['secrets']['upgrade_'+name]={'file':str(target)}
x=json.loads(json.dumps(c['services']['migrate']));x['secrets']=[{'source':'upgrade_migrator_database_url','target':'migrator_database_url'},{'source':'upgrade_app_database_url','target':'app_database_url'}];x.pop('healthcheck',None);x['command']=['sleep','infinity'];c['services']['upgrade']=x;(runtime/'stack.json').write_text(json.dumps(c,indent=2))
compose('up','-d','--no-deps','upgrade')
script="const fs=require('fs');const {spawnSync}=require('child_process'); const r=spawnSync('pnpm',['--filter','@product-res/db','db:migrate'],{env:{...process.env,MIGRATION_DATABASE_URL:fs.readFileSync(process.env.MIGRATION_DATABASE_URL_FILE,'utf8').trim()},stdio:'pipe'}); console.log(JSON.stringify({event:'upgrade.business_migrated',exitCode:r.status})); process.exit(r.status??1)"
r=compose('exec','-T','upgrade','node','-e',script,check=False);print(r.stdout.decode())
r=compose('exec','-T','upgrade','npm','install','--prefix','/tmp/old-engine','--ignore-scripts','--package-lock=false','@dbos-inc/dbos-sdk@5.1.10',timeout=180,check=False);print(json.dumps({'event':'upgrade.old_sdk_installed','exitCode':r.returncode}))
r=compose('exec','-T','upgrade','node','-e',"console.log(JSON.stringify(require('/tmp/old-engine/node_modules/@dbos-inc/dbos-sdk/package.json').bin))");print(r.stdout.decode())

import json,pathlib,datetime
from control import compose,sql
records=[]
old="""const fs=require('fs');const {spawnSync}=require('child_process');fs.writeFileSync('/tmp/old-engine/dbos-config.yaml','name: budget-upgrade\\nsystem_database_url: ${BUDGET_MIGRATION_URL}\\n');const r=spawnSync('node',['/tmp/old-engine/node_modules/@dbos-inc/dbos-sdk/dist/src/cli/cli.js','schema','--app-role','app'],{cwd:'/tmp/old-engine',env:{...process.env,BUDGET_MIGRATION_URL:fs.readFileSync(process.env.MIGRATION_DATABASE_URL_FILE,'utf8').trim()},stdio:'pipe'});console.log(JSON.stringify({event:'upgrade.old_schema',exitCode:r.status}));process.exit(r.status??1)"""
probe="""import {readFileSync} from 'node:fs';process.env.TEST_JOB_OLD_DATABASE_URL=readFileSync('/run/secrets/app_database_url','utf8').trim();await import('/src/packages/platform/test/node/fixtures/job-schema-probe.ts')"""
new="""import {readFileSync} from 'node:fs';import {migrateNodeJobEngine} from '/src/packages/platform/src/node/job-engine-migrate.ts';await migrateNodeJobEngine({databaseUrl:readFileSync(process.env.MIGRATION_DATABASE_URL_FILE,'utf8').trim(),applicationRole:'app',readonlyRole:'readonly'});console.log(JSON.stringify({event:'upgrade.current_schema',passed:true}))"""
for name,code,is_esm in [('old-init',old,False),('old-repeat',old,False),('old-schema-app-rejection',probe,True),('upgrade',new,True),('upgrade-repeat',new,True),('upgraded-app-start',probe,True)]:
 args=['exec','-T','upgrade','node']+(['--experimental-strip-types','--input-type=module'] if is_esm else [])+['-e',code]
 r=compose(*args,timeout=60,check=False)
 events=[json.loads(line) for line in r.stdout.decode().splitlines() if line.startswith('{')]
 row={'check':name,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exitCode':r.returncode,'events':events};records.append(row);print(json.dumps(row),flush=True)
 if r.returncode:break
(runtime/'upgrade.json').write_text(json.dumps({'old':'5.1.10','current':'5.2.11','database':'b_budget_upgrade','formalImageSha':'081305013b022f457c561eecf5828b1959e13908','checks':records},indent=2)+'\n')
compose('stop','-t','2','upgrade')
