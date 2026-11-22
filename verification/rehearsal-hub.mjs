import {resolve,join} from "node:path";
import {pathToFileURL} from "node:url";
const base=resolve(process.argv[2]);
const {createHub}=await import(pathToFileURL(join(base,"hub/server.mjs")).href);
const hub=createHub({env:{},settings:{roomSenseMs:600}});
const info=await hub.start({host:"127.0.0.1",port:Number(process.argv[3]||5780)});
console.log(info.stageUrl);
for(const sign of ["SIGINT","SIGTERM"]) process.once(sign,async()=>{await hub.close();});
