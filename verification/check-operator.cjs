const {chromium}=require("C:/Users/Sharon/AppData/Local/ms-playwright-go/1.50.1/package");
const fs=require("node:fs/promises");
const path=require("node:path");
const assert=require("node:assert/strict");
const app=process.argv[2]||"http://127.0.0.1:4119/stage";
const hub=process.argv[3]||"http://127.0.0.1:5780";
const results=[],errors=[];let state;
const wait=async(fn,label,ms=12000)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn(state))return;await new Promise(r=>setTimeout(r,60));}throw Error(label);};
async function main(){
 const browser=await chromium.launch({executablePath:"C:/Program Files/Google/Chrome/Application/chrome.exe",args:["--autoplay-policy=no-user-gesture-required","--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream"]});
 try{
 const p=await browser.newPage({viewport:{width:1440,height:900}});p.setDefaultTimeout(12000);
 p.on("pageerror",e=>errors.push(e.message));
 p.on("websocket",s=>s.on("framereceived",f=>{try{const x=JSON.parse(f.payload);if(x.type==="state")state=x.state;}catch{}}));
 await p.goto(app);await wait(s=>s?.hubId,"connect");const d=p.getByRole("dialog");
 const op=async()=>{if(!await d.isVisible())await p.getByRole("button",{name:"Operator O"}).click();};
 const close=async()=>{await p.keyboard.press("Escape");await d.waitFor({state:"hidden"});};
 await op();await d.getByRole("button",{name:"Reset",exact:true}).click();assert(await d.getByRole("button",{name:"Confirm reset"}).isVisible());
 await close();await op();assert(await d.getByRole("button",{name:"Reset",exact:true}).isVisible());const old=state.sessionId;
 await d.getByRole("button",{name:"Reset",exact:true}).click();await d.getByRole("button",{name:"Confirm reset"}).click();await wait(s=>s?.sessionId!==old&&s?.phase==="lobby","new session");await close();results.push("Reset disarms on close and takes effect only after confirmation.");
 await p.getByLabel("Reference documents",{exact:true}).setInputFiles({name:"rehearsal-brief.txt",mimeType:"text/plain",buffer:Buffer.from("The demonstration uses two simulated seats and one local hub.")});await p.getByRole("button",{name:"Load documents"}).click();await wait(s=>s?.references?.some(r=>r.name==="rehearsal-brief.txt"),"reference load");await p.getByRole("button",{name:"Clear documents"}).click();await wait(s=>s?.references?.length===0,"reference clear");results.push("Synthetic document uploaded and cleared.");
 await p.getByRole("button",{name:"Start listening"}).click();
 await p.getByText(/Transcription unavailable|Check the configured speech provider|configured speech provider|Speech transcription is unavailable/i).first().waitFor({timeout:14000}).catch(()=>{});
 const mic=await p.locator('section').filter({has:p.getByRole('heading',{name:'Room microphone',exact:true})}).last().innerText();results.push({syntheticMicrophone:mic.slice(0,600)});
 if(await p.getByRole("button",{name:"Stop listening"}).isVisible())await p.getByRole("button",{name:"Stop listening"}).click();
 const phones={};for(const s of ["A","B"]){const c=await browser.newContext();const h=await c.newPage();phones[s]=h;await h.goto(hub+"/?sim=1&seat="+s);await h.locator('[data-seat="'+s+'"]').click();await h.locator("#voice-skip").click();await h.locator("#test-audio").click();await h.locator("#earbuds-next").click();await h.locator("#cal-skip").click();await h.locator("#preset-next").click();}
 await op();await d.getByRole("button",{name:"Begin",exact:true}).click();await wait(s=>s.phase==="live","operator begin");
 await d.getByLabel("Pitch beat").selectOption("problem");await d.getByRole("button",{name:"Ask coach",exact:true}).click();await wait(s=>s.coach?.status==="ready","local coach");await d.getByRole("button",{name:"Send to both seats"}).click();await wait(s=>s.announcement?.status==="played","coach playback");results.push({coach:state.coach.source,heard:state.announcement.heard});
 await d.getByLabel("Preset line").selectOption("sound-check");await d.getByRole("button",{name:"Send announcement"}).click();await wait(s=>s.announcement?.text?.includes("Sound check")&&s.announcement.status==="played","manual announcement");results.push("Both simulated seats acknowledged the manual announcement.");
 await d.getByLabel("Sending seat").selectOption("B");await d.getByRole("group",{name:"Inject a signal"}).getByRole("combobox").nth(1).selectOption("L1");await d.getByRole("button",{name:"Inject",exact:true}).click();await wait(s=>s.log.some(e=>e.kind==="message"&&e.text==="Show the demo now"&&e.playedAt),"inject");
 await d.getByRole("button",{name:"Replay last"}).click();await wait(s=>s.log.some(e=>e.kind==="replay"&&e.text==="Show the demo now"),"replay");results.push("Operator injection delivered the selected line and Replay produced a hub replay event.");
 await d.getByRole("group",{name:"Preset",exact:true}).getByRole("combobox").selectOption("Meeting");await d.getByRole("button",{name:"Set preset"}).click();await wait(s=>s.preset==="Meeting","preset switch",20000);results.push("Meeting codebook became active.");
 await d.getByRole("button",{name:"Reveal",exact:true}).click();await wait(s=>s.phase==="reveal","operator reveal");await close();results.push("Operator Reveal changed the hub phase.");assert.deepEqual(errors,[]);
 }finally{await fs.writeFile(path.join(__dirname,"operator-results.json"),JSON.stringify({results,errors},null,2));await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});

