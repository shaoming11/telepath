import {chromium} from "../edition/film/node_modules/playwright-core/index.mjs";
import {fork} from "node:child_process";
import {once} from "node:events";
import {appendFile,readFile,writeFile} from "node:fs/promises";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import assert from "node:assert/strict";
const root=resolve(dirname(fileURLToPath(import.meta.url)),".."),evidence=join(root,"evidence");
const deadline=Date.parse(process.argv[2]);
if(!Number.isFinite(deadline)||deadline<=Date.now())throw Error("Use a future closing time.");
const log=join(evidence,"overnight.ndjson"),port=5837,origin="http://127.0.0.1:"+port;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const note=e=>appendFile(log,JSON.stringify({time:new Date().toISOString(),...e})+"\n");
const media=join(root,"review/telepathy-launch.mp4");const hash=async file=>createHash("sha256").update(await readFile(file)).digest("hex");
const originalHash=await hash(media);
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH,args:["--use-gl=angle","--use-angle=d3d11","--autoplay-policy=no-user-gesture-required","--disable-backgrounding-occluded-windows","--disable-renderer-backgrounding"]});
const context=await browser.newContext({viewport:{width:1440,height:900}});const page=await context.newPage();page.setDefaultTimeout(45000);
let service,state,sockets=0,passes=0;const errors=[],external=[];
await context.route(/^https?:/,route=>{if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());return route.abort();}return route.continue();});
page.on("pageerror",e=>errors.push(e.message));page.on("websocket",s=>{if(s.url().includes("role=stage")){sockets++;s.on("framereceived",f=>{try{const m=JSON.parse(f.payload);if(m.type==="state")state=m.state;}catch{}});}});
async function start(){
 service=fork(join(root,"review/web/rehearsal.mjs"),[join(root,"review/hub-runtime"),String(port)],{stdio:["ignore","ignore","inherit","ipc"],windowsHide:true});
 await Promise.race([once(service,"message"),once(service,"exit").then(([c])=>{throw Error("Isolated hub did not start ("+c+").");})]);
}
async function stop(){if(service?.connected){const exited=once(service,"exit");service.send("stop");await exited;}service=null;}
async function waitState(predicate,label,timeout=50000){const until=Date.now()+timeout;while(Date.now()<until){if(predicate(state))return;await delay(100);}throw Error(label);}
async function hold(time){
 await page.evaluate(t=>window.scrollTo({top:t*120,behavior:"instant"}),time);
 await page.waitForFunction(t=>{const v=document.querySelector(".cinema-progress>div").style.transform;return Math.abs(Number(v.match(/\(([^)]+)\)/)?.[1])-t/46)<.0003;},time);
}
async function check(){
 if(passes&&passes%3===0){
   const last=state.hubId;await stop();await page.getByRole("heading",{name:"Hub offline."}).waitFor();await start();await waitState(s=>s.hubId!==last&&s.phase==="lobby"&&s.bits===0,"Reconnect retained stale state.");
 }
 await hold([7.2,15.7,26.3,37.1,45.4][passes%5]);
 await page.locator(".cinema-head a").click();
 await page.getByRole("button",{name:"Operator O"}).click();await page.getByRole("button",{name:"Canned take",exact:true}).click();await page.keyboard.press("Escape");
 await waitState(s=>s?.canned&&s.phase==="live","Live phase missing.");await waitState(s=>s?.canned&&s.phase==="reveal","Reveal missing.");
 const messages=state.log.filter(e=>e.kind==="message").length;assert(messages>0&&state.bits>0);
 await page.getByRole("heading",{name:"Here’s what passed between us."}).waitFor();
 await page.getByRole("link",{name:"← Story",exact:true}).click();await hold(15.7);
 assert.equal(await hash(media),originalHash);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 passes++;await note({event:"pass",passes,sockets,messages,bits:state.bits,heap:await page.evaluate(()=>performance.memory?.usedJSHeapSize),movieSha256:originalHash});
}
try{
 await writeFile(log,"");await start();await page.goto(origin+"/cinema.html");await page.locator(".film canvas").waitFor();await waitState(s=>s?.phase==="lobby","Cannot open packaged lobby.");
 await note({event:"started",deadline:new Date(deadline).toISOString()});await check();
 while(Date.now()<deadline){
  const next=Math.min(deadline,Date.now()+2*3600000);await note({event:"holding",next:new Date(next).toISOString()});
  while(Date.now()<next)await delay(Math.min(60000,next-Date.now()));
  await check();
 }
 await note({event:"completed",passes,errors,external});
}catch(e){await note({event:"failed",passes,reason:e.message});throw e;}
finally{await browser.close();await stop();}

