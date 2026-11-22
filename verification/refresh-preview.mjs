import {readFile,realpath,rename,writeFile} from "node:fs/promises";import {tmpdir} from "node:os";import {dirname,basename,join,resolve} from "node:path";import {fileURLToPath} from "node:url";import assert from "node:assert/strict";
const root=resolve(dirname(fileURLToPath(import.meta.url)),".."),runtime=await realpath(process.argv[2]),origin=new URL(process.argv[3]);
assert.equal(dirname(runtime).toLowerCase(),(await realpath(tmpdir())).toLowerCase());assert(basename(runtime).startsWith("telepathy-studio-"));assert.equal(origin.hostname,"127.0.0.1");
const publicDir=join(runtime,"public"),local=join(root,"review/web/offline"),remote=async name=>{const response=await fetch(new URL(name,origin),{cache:"no-store"});assert.equal(response.status,200);return Buffer.from(await response.arrayBuffer());};
for(const name of ["mark.svg","studio-stage.html","cinema.html","studio.bundle.mjs","cinema.bundle.mjs","cinema.bundle.css","studio.bundle.css"])assert((await readFile(join(publicDir,name))).equals(await remote(name)),"Wrong preview directory at "+name);
for(const name of ["studio.bundle.mjs","cinema.bundle.mjs","cinema.bundle.css","studio.bundle.css"]){
 const target=join(publicDir,name),next=await readFile(join(local,name)),previous=await readFile(target);
 if(!previous.equals(next)){const tmp=target+"."+process.pid+".incoming";await writeFile(tmp,next,{flag:"wx"});await rename(tmp,target);}
 assert(next.equals(await remote(name)),"Preview returned a stale "+name);
}
console.log("The live preview now serves the four current application assets.");

