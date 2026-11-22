import json
import subprocess
from pathlib import Path
import numpy as np
from scipy import signal
from scipy.io import wavfile
p=Path(__file__).resolve().parent
root=p.parent
movie=root/'film-master/telepathy-launch.mp4'
ffmpeg=Path('C:/ffmpeg/bin/ffmpeg.exe')
rate,source=wavfile.read(root/'film-master/audio/audio.wav')
source=source.astype(np.float32)/32768
raw=subprocess.run([str(ffmpeg),'-v','error','-i',str(movie),'-map','0:a:0','-f','f32le','-ac','2','-ar',str(rate),'-'],capture_output=True,check=True).stdout
encoded=np.frombuffer(raw,dtype='<f4').reshape(-1,2)
checks=[]
for t in [10.4,13.6,16.1,31.4,34.0,36.5,41.2,48.5,55.2]:
    start=int(t*rate)
    margin=1200
    expected=source[start:start+12000].mean(axis=1)
    actual=encoded[start-margin:start+12000+margin].mean(axis=1)
    scores=signal.correlate(actual,expected,mode='valid',method='fft')
    index=int(scores.argmax())
    part=actual[index:index+len(expected)]
    corr=float(np.corrcoef(expected,part)[0,1])
    assert corr>.99 and abs(index-margin)<rate/60,(t,corr,index)
    checks.append({'time':t,'offsetSamples':index-margin,'correlation':round(corr,5)})
data={'sampleRate':rate,'sourceSeconds':len(source)/rate,'decodeSeconds':round(len(encoded)/rate,6),'comparisons':checks}
(p/'master-sync.json').write_text(json.dumps(data,indent=2))
print(json.dumps(data))

