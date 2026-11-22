import {chromium} from "../edition/film/node_modules/playwright-core/index.mjs";
import {fork} from "node:child_process";
import {once} from "node:events";
import {appendFile,writeFile} from "node:fs/promises";
import {dirname,resolve,join} from "node:path";
import {fileURLToPath} from "node:url";
import assert from "node:assert/strict";
const folder=dirname(fileURLToPath(import.meta.url)),root=resolve(folder,"..");
const finish=Date.parse(process.argv[2]),port=Number(process.argv[3]||5815);
if(!Number.isFinite(finish)||finish<Date.now())throw Error("Use a future ISO date with an offset.");
const origin="http://127.0.0.1:"+port;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH,args:["--autoplay-policy=no-user-gesture-required","--disable-backgrounding-occluded-windows","--disable-renderer-backgrounding"]});
const page=await browser.newPage({viewport:{width:1440,height:900}});
const log=join(folder,"endurance.ndjson");
const delay=t=>new Promise(r=>setTimeout(r,t));
let child,errors=[],state,sockets=0,passes=0;
page.on("pageerror",e=>errors.push(e.message));
page.on("websocket",s=>{if(s.url().includes("role=stage")){sockets++;s.on("framereceived",f=>{try{const m=JSON.parse(f.payload);if(m.type==="state")state=m.state;}catch{}});}});
async function start(){
  child=fork(join(root,"edition/web/rehearsal.mjs"),[join(root,"baseline"),String(port)],{stdio:["ignore","ignore","inherit","ipc"],windowsHide:true});
  await Promise.race([once(child,"message"),once(child,"exit").then(([c])=>{throw Error("Rehearsal ended early "+c);})]);
}
async function stop(){
  if(!child||child.exitCode!==null)return;
  const stopped=once(child,"exit");child.send("stop");const [code]=await stopped;if(code!==0)throw Error("Rehearsal exit "+code);child=null;
}
async function online(){await page.getByText("Hub online",{exact:true}).waitFor({timeout:60000});}
async function waitState(fn,label,ms=45000){const end=Date.now()+ms;while(Date.now()<end){if(fn(state))return;await delay(200);}throw Error(label);}
async function write(event){await appendFile(log,JSON.stringify({time:new Date().toISOString(),...event})+"\n");}
try{
  await writeFile(log,"");await start();await page.goto(origin+"/studio-stage.html");await online();
  await write({event:"started",finish:new Date(finish).toISOString()});
  do{
    const old=state.hubId;
    if(passes){
      await stop();
      await page.getByRole("heading",{name:"Hub offline."}).waitFor({timeout:20000});
      await start();await online();await waitState(s=>s?.hubId!==old&&s.phase==="lobby"&&s.bits===0,"Fresh hub did not replace state.");
    }
    const startSockets=sockets;
    await page.getByRole("button",{name:"Operator O"}).click();await page.getByRole("button",{name:"Canned take",exact:true}).click();await page.keyboard.press("Escape");
    await waitState(s=>s?.canned&&s.phase==="live","Canned take did not start.");
    await waitState(s=>s?.canned&&s.phase==="reveal","Canned take did not reveal.");
    await page.getByRole("heading",{name:"Here’s what passed between us."}).waitFor();
    const counts={bits:state.bits,messages:state.log.filter(e=>e.kind==="message").length};
    assert(counts.bits>0&&counts.messages>0);assert.equal(sockets,startSockets);assert.deepEqual(errors,[]);
    passes++;
    await write({event:"pass",passes,sockets,...counts,heap:await page.evaluate(()=>performance.memory?.usedJSHeapSize)});
    const due=Math.min(finish,Date.now()+15*60000);while(Date.now()<due)await delay(Math.min(60000,due-Date.now()));
  }while(Date.now()<finish);
  await write({event:"completed",passes,errors});
}catch(e){await write({event:"failed",passes,reason:e.message});throw e;}
finally{await browser.close();await stop();}

