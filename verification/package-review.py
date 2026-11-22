from pathlib import Path
import os
import stat
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED, ZIP_STORED
import hashlib
root=Path(__file__).resolve().parent.parent
review=root/'review'
delivery=root/'delivery'
delivery.mkdir(exist_ok=True)
out=delivery/'Telepathy-review.zip'
tmp=delivery/'Telepathy-review.partial.zip'
required=['START HERE.html','telepathy-launch.mp4','launch.mjs','web/offline/cinema.bundle.mjs','hub-runtime/hub/server.mjs','hub-runtime/node_modules/ws/package.json','notes/VERIFICATION.md']
assert all((review/name).is_file() for name in required)
with ZipFile(tmp,'w',allowZip64=True,compression=ZIP_DEFLATED,compresslevel=6) as archive:
    for item in sorted(review.rglob('*')):
        if not item.is_file() or item.name in ['.env','.DS_Store'] or '.git' in item.parts: continue
        name=item.relative_to(review).as_posix()
        info=ZipInfo.from_file(item,arcname='Telepathy/'+name)
        if item.suffix in ['.command','.sh']:
            info.create_system=3;info.external_attr=(stat.S_IFREG|0o755)<<16
        info.compress_type=ZIP_STORED if item.suffix.lower() in ['.mp4','.png','.jpg','.woff2','.zip','.mp3','.wasm'] else ZIP_DEFLATED
        archive.writestr(info,item.read_bytes())
with ZipFile(tmp) as archive:
    assert archive.testzip() is None
    assert len([i for i in archive.namelist() if i.endswith('telepathy-launch.mp4')])==1
    assert hashlib.sha256(archive.read('Telepathy/telepathy-launch.mp4')).digest()==hashlib.sha256((root/'film-master/telepathy-launch.mp4').read_bytes()).digest()
os.replace(tmp,out)
manifest=[]
for item in sorted(delivery.iterdir()):
    if item.suffix in ['.bundle','.zip']:
        manifest.append(hashlib.sha256(item.read_bytes()).hexdigest()+'  '+item.name)
(delivery/'SHA256SUMS.txt').write_text('\n'.join(manifest)+'\n')
print('Review ZIP',out.stat().st_size,'bytes')

