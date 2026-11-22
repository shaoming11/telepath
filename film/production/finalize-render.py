from pathlib import Path
root=Path('edition')
cinema=root/'web/src/cinema/cinema.css'
css=cinema.read_text()
a=css.index('.film .film-label[data-at=')
b=css.index('@media (max-width: 700px)',a)
desktop=css[a:b]
mobile=css[b:]
a2=mobile.index('  .film .film-label[data-at=')
small=mobile[a2:mobile.rfind('}')]
film=root/'web/src/cinema/film/film.css'
film.write_text(film.read_text()+'\n'+desktop+'\n@media(max-width:700px){\n'+small+'}\n')
cinema.write_text(css[:a]+mobile[:a2]+'}\n')
path=root/'film/render.mjs'
s=path.read_text().replace('import { build }','import { createHash } from "node:crypto";\nimport { build }',1)
s=s.replace('dirname, extname, join, resolve, sep','basename, dirname, extname, join, resolve, sep')
s=s.replace('  bundle = join(output, "viewer"),\n  plates = join(output, "plates");','  bundle = join(output, "viewer");')
s=s.replace('const fps = timeline.fps;','if (!["all","encode","plates","posters","serve"].includes(mode))throw Error("Choose all, encode, plates, posters or serve.");\nconst fps = timeline.fps;')
a=s.index('await Promise.all([\n  mkdir(bundle')
b=s.index('  stdin:',a)
s=s[:a]+'const built = await build({\n  write:false,\n'+s[b:]
a=s.index('const css = await readFile(')
b=s.index('const types =',a)
s=s[:a]+'''const viewer = new Map(built.outputFiles.map(file => ["/"+basename(file.path), file.contents]));
const fingerprint = createHash("sha256").update(JSON.stringify({width:1920,height:1080,quality:97,fps,native}));
for(const [name,bytes] of [...viewer].sort(([a],[b])=>a.localeCompare(b))) fingerprint.update(name).update(bytes);
for(const file of ["models/airpods.glb","draco/draco_decoder.wasm","draco/draco_wasm_wrapper.js","draco/draco_decoder.js"])fingerprint.update(await readFile(join(scene,"public",file)));
const plates=join(output,"plates",fingerprint.digest("hex").slice(0,20));
await mkdir(plates,{recursive:true});
'''+s[b:]
s=s.replace('else body = await readFile(safePath(bundle, path));','else if (viewer.has(path)) body=viewer.get(path);\n    else {res.writeHead(404).end();return;}')
s=s.replace('await writeFile(target + ".part", bytes);\n          await rename(target + ".part", target);','const pending=target+"."+process.pid+".part";\n          await writeFile(pending, bytes);\n          await rename(pending, target);')
s=s.replace('join(output, "telepathy.partial.mp4")','join(output, "telepathy."+process.pid+".partial.mp4")')
path.write_text(s)

