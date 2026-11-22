import {chromium} from "../edition/film/node_modules/playwright-core/index.mjs";
import {cp,writeFile,mkdir,access} from "node:fs/promises";
import {dirname,join} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import assert from "node:assert/strict";
const evidence=dirname(fileURLToPath(import.meta.url));
const root=join(evidence,"..");
const review=join(root,"review/hub-runtime");
const fixture=join(root,"local-tools/room-fixture");
await mkdir(fixture,{recursive:true});
for(const file of ["hub","public","monitor","maritime","docs","package.json","README.md"])await cp(join(review,file),join(fixture,file),{recursive:true});
await cp(join(root,"edition/web/offline"),join(fixture,"public"),{recursive:true});
const {symlink}=await import("node:fs/promises");
try{await access(join(fixture,"node_modules/ws"));}catch{await symlink(join(review,"node_modules"),join(fixture,"node_modules"),"junction");}
const {createAudio}=await import(pathToFileURL(join(fixture,"hub/audio.mjs")));
const {createHub}=await import(pathToFileURL(join(fixture,"hub/server.mjs")));
let synthetic;
const original=createAudio({env:{},allowBundledFallback:true});
const audio={...original,listen:async(seat,enabled,callbacks)=>{assert.equal(seat,"room");synthetic=enabled?callbacks:null;return true;},mic:async()=>{}};
const hub=createHub({env:{},audio,settings:{roomInput:"mac"},projectRoot:pathToFileURL(review+"/")});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH,args:["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream","--autoplay-policy=no-user-gesture-required"]});
const results=[],errors=[];
try{
 const info=await hub.start({host:"127.0.0.1",port:5835});
 const page=await browser.newPage();await page.context().grantPermissions(["microphone"],{origin:new URL(info.stageUrl).origin});
 let state;page.on("pageerror",e=>errors.push(e.message));page.on("websocket",s=>s.on("framereceived",f=>{try{const m=JSON.parse(f.payload);if(m.type==="state")state=m.state;}catch{}}));
 await page.goto(new URL("/studio-stage.html",info.stageUrl).href);
 const wait=async(fn,label)=>{const end=Date.now()+15000;while(Date.now()<end){if(fn(state))return;await new Promise(r=>setTimeout(r,60));}throw Error(label);};
 await wait(s=>s?.phase==="lobby","No lobby.");
 await page.getByLabel("Reference documents",{exact:true}).setInputFiles([join(evidence,"fixtures/fixture.pdf"),join(evidence,"fixtures/fixture.docx")]);
 await page.getByRole("button",{name:"Load documents"}).click();await wait(s=>s.references?.some(r=>r.name==="fixture.pdf")&&s.references.some(r=>r.name==="fixture.docx"),"Reference formats failed.");
 results.push("The original reference parser extracted text from a synthetic PDF and a DOCX uploaded through the stage.");
 await page.getByRole("button",{name:"Clear documents"}).click();await wait(s=>!s.references.length,"Clear documents.");
 await page.getByRole("button",{name:"Start listening"}).click();await wait(s=>s.room.listening&&synthetic,"Synthetic audio input never started.");
 const second=await browser.newPage();await second.goto(new URL("/studio-stage.html",info.stageUrl).href);await second.getByText("Hub online",{exact:true}).waitFor();assert(await second.getByRole("button",{name:"Start listening"}).isDisabled());await second.close();results.push("A second operator cannot take the active room microphone.");
 synthetic.committed("First. Second.",{streamId:4,segment:0});
 synthetic.diarized({segment_index:0,words:[{speaker_id:"speaker_0",text:"First."},{speaker_id:null,type:"spacing",text:" "},{speaker_id:"speaker_1",text:"Second."}]},4);
 await wait(s=>s.room.transcript[0]?.speakers?.length===2,"Speaker labels did not reach the stage.");
 await page.locator("summary").filter({hasText:"Room transcript"}).click();
 const selectors=page.locator("details[open] select");
 assert.equal(await selectors.count(),2);await selectors.first().selectOption("A");
 await wait(s=>s.room.transcript[0].speakers.some(x=>x.seat==="A"),"Speaker assignment was ignored.");
 await page.screenshot({path:join(evidence,"simulated-room.png"),fullPage:true});
 await page.getByRole("button",{name:"Clear transcript"}).click();await wait(s=>!s.room.transcript.length,"Transcript did not clear.");
 await page.getByRole("button",{name:"Stop listening"}).click();await wait(s=>!s.room.listening,"Microphone did not stop.");
 results.push("A synthetic transcription adapter supplied two speakers. Label assignment, transcript clearing and stop all updated the hub.");
 assert.deepEqual(errors,[]);
}finally{await browser.close();await hub.close();await writeFile(join(evidence,"room-results.json"),JSON.stringify({results,errors},null,2));}

