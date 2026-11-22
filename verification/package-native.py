from pathlib import Path
import base64
import hashlib
import io
import json
import struct
import tarfile
import urllib.request
from urllib.parse import urlparse
root=Path(__file__).resolve().parent.parent
packages=json.loads((root/'baseline/package-lock.json').read_text())['packages']
report={}
for platform in ['darwin-arm64','darwin-x64','linux-x64-gnu']:
    name='@napi-rs/canvas-'+platform
    entry=packages['node_modules/'+name]
    url=entry['resolved']
    assert urlparse(url).scheme=='https' and urlparse(url).hostname=='registry.npmjs.org'
    with urllib.request.urlopen(url,timeout=90) as response: payload=response.read()
    calculated='sha512-'+base64.b64encode(hashlib.sha512(payload).digest()).decode()
    assert calculated==entry['integrity'],name
    target=root/'review/hub-runtime/node_modules'/name
    target.mkdir(exist_ok=True,parents=True)
    with tarfile.open(fileobj=io.BytesIO(payload),mode='r:gz') as tar:
        for item in tar.getmembers():
            filename=Path(item.name).name
            if not item.isfile() or item.name!='package/'+filename:continue
            if filename not in ['package.json','README.md','LICENSE','LICENSE.md'] and not filename.endswith('.node'):continue
            (target/filename).write_bytes(tar.extractfile(item).read())
    metadata=json.loads((target/'package.json').read_text())
    assert metadata['name']==name and metadata['version']==entry['version']
    native=(target/metadata['main']).read_bytes()
    if platform.startswith('darwin'):
        assert native[:4]==b'\xcf\xfa\xed\xfe',name
        machine=struct.unpack_from('<I',native,4)[0]
        assert machine==({'darwin-arm64':0x0100000c,'darwin-x64':0x01000007}[platform])
    else:assert native[:4]==b'\x7fELF' and struct.unpack_from('<H',native,18)[0]==62
    report[platform]={'name':name,'version':entry['version'],'lockedTarballVerified':True,'bytes':len(native)}
(root/'evidence/native-platforms.json').write_text(json.dumps(report,indent=2))
print(report)

