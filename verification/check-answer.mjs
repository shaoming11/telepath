import {chromium} from "../edition/film/node_modules/playwright-core/index.mjs";
import {writeFile} from "node:fs/promises";
import {fileURLToPath,pathToFileURL} from "node:url";
import {dirname,join,resolve} from "node:path";
import assert from "node:assert/strict";
const dir=dirname(fileURLToPath(import.meta.url)),fixture=resolve(dir,"../local-tools/room-fixture");
const {createHub}=await import(pathToFileURL(join(fixture,"hub/server.mjs")));
const {createCodec}=await import(pathToFileURL(join(fixture,"hub/codec.mjs")));
const target="The judge on the left looks lost",question="Who looks lost?";
const codec={...createCodec({env:{}}),questionAnswering:true,answer:async request=>{
 const passage=request.passages.find(p=>p.name==="stage-script.md"||JSON.stringify(p).includes("stage-script.md"));
 if(!passage)return {status:"unsupported",question};
 return {status:"answer",question,answer:target,sources:[{id:passage.id,quote:target+"."}]};
}};
const hub=createHub({env:{},codec,projectRoot:pathToFileURL(fixture+"/"),settings:{questionDebounceMs:10,questionQuietMs:60000}});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,args:["--autoplay-policy=no-user-gesture-required"]});
const observations=[],errors=[];let state;
try{
 const info=await hub.start({host:"127.0.0.1",port:5851});const origin=new URL(info.stageUrl).origin;
 const p=await browser.newPage({viewport:{width:1440,height:900}});p.setDefaultTimeout(15000);p.on("pageerror",e=>errors.push(e.message));p.on("websocket",s=>s.on("framereceived",f=>{try{const m=JSON.parse(f.payload);if(m.type==="state")state=m.state;}catch{}}));
 const wait=async(fn,label,limit=25000)=>{const end=Date.now()+limit;while(Date.now()<end){if(fn(state))return;await new Promise(r=>setTimeout(r,60));}throw Error(label+" last question "+JSON.stringify(state?.questionState));};
 await p.goto(origin+"/studio-stage.html");await wait(s=>s?.phase==="lobby","Lobby");
 await p.getByLabel("Reference documents",{exact:true}).setInputFiles({name:"stage-script.md",mimeType:"text/markdown",buffer:Buffer.from("Audience observation. "+target+".")});
 await p.getByRole("button",{name:"Load documents"}).click();await wait(s=>s.references.some(r=>r.name==="stage-script.md"),"Upload");
 const phones={};for(const seat of ["A","B"]){const phone=await browser.newPage();phones[seat]=phone;await phone.goto(origin+"/?sim=1&seat="+seat);await phone.locator('[data-seat="'+seat+'"]').click();for(const id of ["voice-skip","test-audio","earbuds-next","cal-skip","preset-next"])await phone.locator("#"+id).click();}
 await p.getByRole("button",{name:/Begin session/}).click();await wait(s=>s.phase==="live","Begin");
 await phones.A.locator("#sim-text").fill(question+" I do not know.");await phones.A.locator("#sim-text").press("Enter");
 await wait(s=>Object.values(s.seats).some(seat=>seat.pending?.heardAt!=null),"Private answer preview",40000);
 assert(!state.log.some(e=>e.kind==="message"&&e.text===target));
 const panel=p.locator("section").filter({has:p.getByRole("heading",{name:"Conversation answers",exact:true})}).last();
 await panel.getByRole("heading",{name:question,exact:true}).waitFor();await panel.getByText("stage-script.md",{exact:false}).first().waitFor();
 await panel.locator("summary").click();await panel.scrollIntoViewIfNeeded();await p.screenshot({path:join(dir,"answer-evidence.png")});observations.push("The stage displayed the real citation and a private-preview status before approval.");
 const owner=Object.keys(state.seats).find(k=>state.seats[k].pending?.heardAt!=null);observations.push("Preview owner "+owner);await phones[owner].locator("#draft-send").click();await wait(s=>s.log.some(e=>e.kind==="message"&&e.text===target&&e.playedAt),"Approved document answer");
 await p.getByRole("button",{name:/^Reveal/}).click();await wait(s=>s.phase==="reveal","Reveal");await p.getByRole("heading",{name:"Conversation answers"}).waitFor();observations.push("Confirmation delivered the response to the other simulated seat. Reveal retained its source evidence.");assert.deepEqual(errors,[]);
}finally{await writeFile(join(dir,"answer-results.json"),JSON.stringify({observations,errors},null,2));await browser.close();await hub.close();}


