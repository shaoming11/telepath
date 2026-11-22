import {chromium} from "../edition/film/node_modules/playwright-core/index.mjs";
import {fork} from "node:child_process";import {once} from "node:events";import {writeFile} from "node:fs/promises";import {dirname,join} from "node:path";import {fileURLToPath} from "node:url";import assert from "node:assert/strict";
const dir=dirname(fileURLToPath(import.meta.url)),root=join(dir,"..");const records=[],errors=[];
const service=fork(join(root,"review/web/rehearsal.mjs"),[join(root,"review/hub-runtime"),"5859"],{stdio:["ignore","ignore","inherit","ipc"],windowsHide:true});
let browser;
try{
 const [{origin}]=await Promise.race([once(service,"message"),once(service,"exit").then(()=>{throw Error("Fixture unavailable.");})]);browser=await chromium.launch({executablePath:process.env.CHROME_PATH,args:["--autoplay-policy=no-user-gesture-required"]});
 const stage=await browser.newPage({viewport:{width:1440,height:900}});let state;
 stage.on("pageerror",e=>errors.push(e.message));stage.on("websocket",s=>s.on("framereceived",f=>{try{const m=JSON.parse(f.payload);if(m.type==="state")state=m.state;}catch{}}));
 async function wait(fn,label){const end=Date.now()+20000;while(Date.now()<end){if(fn(state))return;await new Promise(r=>setTimeout(r,70));}throw Error(label);}
 await stage.goto(origin+"/studio-stage.html");await wait(s=>s?.phase==="lobby","Lobby");
 const phones={};for(const seat of ["A","B"]){const p=await browser.newPage();phones[seat]=p;await p.goto(origin+"/?sim=1&seat="+seat);await p.locator('[data-seat="'+seat+'"]').click();for(const id of ["voice-skip","test-audio","earbuds-next","cal-skip","preset-next"])await p.locator("#"+id).click();}
 await stage.getByRole("button",{name:/Begin session/}).click();await wait(s=>s.phase==="live","Begin");const session=state.sessionId;
 await phones.B.locator('[data-signal="R1"]').click();await wait(s=>s.log.some(e=>e.kind==="message"&&e.text==="Slow down"&&e.playedAt),"Initial delivery");
 const second=await browser.newPage({viewport:{width:390,height:844}});await second.goto(origin+"/cinema.html#cinema-live");await second.getByRole("heading",{name:"“Slow down”"}).waitFor();records.push("A stage opened mid-session immediately showed the confirmed whisper.");
 const address=phones.A.url();await phones.A.goto("about:blank");await wait(s=>!s.seats.A.online,"Seat A disconnect");
 const readout=stage.locator(".seat-card.amber .seat-header small");assert.match(await readout.innerText(),/offline/i);
 await phones.A.goto(address);await phones.A.waitForLoadState("domcontentloaded");await phones.A.screenshot({path:join(dir,"returning-seat.png")});if(await phones.A.locator('[data-seat="A"]').isVisible())await phones.A.locator('[data-seat="A"]').click();await wait(s=>s.seats.A.online,"Seat A reconnect");await writeFile(join(dir,"returning-seat-ui.txt"),await phones.A.locator("body").innerText());for(const id of ["voice-skip","test-audio","earbuds-next","cal-skip","preset-next"]){const next=phones.A.locator("#"+id);if(await next.isVisible())await next.click();}await phones.A.locator('[data-signal="R1"]').waitFor();
 await phones.B.locator('[data-signal="R2"]').click();await wait(s=>s.log.some(e=>e.kind==="message"&&e.text==="One minute left"&&e.playedAt),"Delivery after reconnect");assert.equal(state.sessionId,session);assert.equal(state.log.filter(e=>e.kind==="message"&&e.text==="Slow down").length,1);
 await second.getByRole("heading",{name:"“One minute left”"}).waitFor();records.push("The projector showed Seat A offline, then recovered. The same session delivered the next cue without duplicating the earlier line.");
 await stage.getByRole("button",{name:/^Reveal/}).click();await second.getByRole("heading",{name:"Here’s what passed between us."}).waitFor();
 await second.getByRole("button",{name:"Operator O"}).click();const d=second.getByRole("dialog");await d.getByRole("button",{name:"Reset",exact:true}).click();await d.getByRole("button",{name:"Confirm reset"}).click();await wait(s=>s.sessionId!==session&&s.phase==="lobby","Reset sync");
 assert.equal(state.bits,0);await stage.getByRole("heading",{name:"Ready to begin?"}).waitFor();assert.equal(await stage.getByRole("heading",{name:"“One minute left”"}).count(),0);
 records.push("Reset from the second stage cleared the first stage and returned both to a fresh lobby.");assert.deepEqual(errors,[]);
}finally{await browser?.close();if(service.connected){const done=once(service,"exit");service.send("stop");await done;}await writeFile(join(dir,"handoff-recovery.json"),JSON.stringify({records,errors},null,2));}



