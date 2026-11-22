from pathlib import Path
import os
import subprocess
import shutil
import zipfile
root=Path(__file__).resolve().parent.parent
delivery=root/'delivery'
staging=root/'local-tools'/'source-export'
delivery.mkdir(exist_ok=True)
staging.mkdir(exist_ok=True)
def ignored(src, entries):
    path=Path(src)
    skipped={'node_modules','.wasp','out','offline','dist','__pycache__','.git'}
    if path.name=='public': skipped.update({'assets','posters','fonts'})
    if path.name=='src': skipped.add('upstream')
    return [n for n in entries if n in skipped or n.endswith(('.mp4','.wav','.log','.tmp','.partial'))]
for name in ['web','film']:
    shutil.copytree(root/'edition'/name,staging/name,ignore=ignored,dirs_exist_ok=True)
shutil.copy2(root/'edition/README.md',staging/'web/STUDIO.md')
repo=root/'local-tools'/'delivery.git'
if not repo.exists(): subprocess.run(['git','init','--bare',str(repo)],check=True,capture_output=True)
env={**os.environ,'GIT_DIR':str(repo),'GIT_WORK_TREE':str(staging),'GIT_INDEX_FILE':str(root/'local-tools'/'delivery.index')}
def git(*args,input=None):
    return subprocess.run(['git',*args],cwd=staging,env=env,check=True,stdout=subprocess.PIPE,input=input).stdout.decode().strip()
base=subprocess.check_output(['git','-C',str(root/'baseline'),'rev-parse','HEAD'],text=True).strip()
git('fetch','--no-tags',str(root/'baseline'),base)
git('update-ref','refs/heads/telepathy-demo',base)
git('read-tree',base)
git('add','--','web','film')
tree=git('write-tree')
ref='refs/heads/codex/telepathy-studio'
try:
    prior=git('rev-parse','--verify',ref)
    same=git('rev-parse',prior+'^{tree}')==tree
except subprocess.CalledProcessError:
    prior=base; same=False
commit=prior if same else git('-c','user.name=Codex','-c','user.email=codex@localhost','commit-tree',tree,'-p',prior,input=b'Add Telepathy cinema, presenter stage and launch-film source\n')
git('update-ref',ref,commit)
paths=git('diff','--name-only',base,commit).splitlines()
assert paths and all(f.startswith(('web/','film/')) for f in paths)
assert all(not any(s in f for s in ('/out/','/node_modules/','/offline/','/posters/','/upstream/','.mp4','.wav','.env')) for f in paths)
bundle=delivery/'Telepathy-source.bundle'
git('bundle','create',str(bundle),ref,'^'+base)
subprocess.run(['git','-C',str(root/'baseline'),'bundle','verify',str(bundle)],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
with zipfile.ZipFile(delivery/'Telepathy-source.zip','w',zipfile.ZIP_DEFLATED,compresslevel=7) as z:
    for name in paths: z.write(staging/name,name)
(root/'evidence/source-branch.txt').write_text(f'Base {base}\nBranch codex/telepathy-studio\nCommit {commit}\nFiles {len(paths)}\n'+'\n'.join(paths)+'\n')
print(commit,len(paths),bundle.stat().st_size)


