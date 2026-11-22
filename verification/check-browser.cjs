const {chromium}=require("C:/Users/Sharon/AppData/Local/ms-playwright-go/1.50.1/package");
const fs=require("node:fs/promises");
const path=require("node:path");
const assert=require("node:assert/strict");
const out=__dirname;
const errors=[],observations=[],stageFrames=[];
const app="http://127.0.0.1:4119",hub="http://127.0.0.1:5780";
const sizes=[{width:1440,height:900},{width:1920,height:1080},{width:390,height:844}];
const shot=async(page,name)=>{await page.screenshot({path:path.join(out,name+".png"),animations:"disabled",timeout:20000});};
async function main(){
 const b=await chromium.launch({headless:true,executablePath:"C:/Program Files/Google/Chrome/Application/chrome.exe",args:["--disable-backgrounding-occluded-windows","--disable-renderer-backgrounding","--autoplay-policy=no-user-gesture-required"]});
 try{
 const c=await b.newContext({viewport:sizes[0],deviceScaleFactor:1});const p=await c.newPage();p.setDefaultTimeout(9000);
 p.on("pageerror",e=>errors.push(e.message));p.on("console",m=>{if(m.type()==="error")errors.push(m.text());});
 p.on("websocket",s=>{if(!s.url().includes("role=stage"))return;observations.push("Stage socket opened");s.on("framereceived",f=>{try{const x=JSON.parse(f.payload);if(x.type==="state")stageFrames.push(x.state);}catch{}});});
 await p.goto(app);await p.getByText("Hub online",{exact:true}).waitFor();await p.evaluate(()=>document.fonts.ready);
 for(const size of sizes){await p.setViewportSize(size);for(const id of ["opening","send","receipt","question","preview","wrap","live-stage"]){
  await p.locator("#"+id).evaluate(el=>el.scrollIntoView({block:"start",behavior:"instant"}));await p.waitForFunction(id=>Math.abs(document.getElementById(id).getBoundingClientRect().top)<3,id);
  await shot(p,size.width+"-"+id);const overflow=await p.locator("#"+id).evaluate(el=>el.scrollWidth-el.clientWidth);assert(overflow<3,"horizontal overflow "+id+": "+overflow);
 }}
 await p.emulateMedia({reducedMotion:"reduce"});await p.locator("#send").evaluate(el=>el.scrollIntoView());await shot(p,"390-reduced");await p.setViewportSize(sizes[0]);await p.locator("#opening").evaluate(el=>el.scrollIntoView());await p.keyboard.press("ArrowRight");await p.waitForURL("**/#send");await p.keyboard.press("ArrowLeft");await p.waitForURL("**/#opening");await p.locator("#opening").getByRole("link",{name:"Live stage"}).click();await p.waitForURL("**/#live-stage");
 await p.getByRole("button",{name:"Operator O"}).click();await p.getByRole("dialog").waitFor();await shot(p,"1440-operator");await p.keyboard.press("Escape");
 const seats={};
 for(const s of ["A","B"]){const ctx=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:1});const phone=await ctx.newPage();phone.setDefaultTimeout(12000);seats[s]=phone;await phone.goto(hub+"/?sim=1&seat="+s);await phone.locator('[data-seat="'+s+'"]').click();await phone.locator("#voice-skip").click();await phone.locator("#test-audio").click();await phone.locator("#earbuds-next").click();await phone.locator("#cal-skip").click();await phone.locator("#preset-next").click();observations.push("Simulated setup complete for "+s);}
 await p.getByRole("button",{name:/^Begin session/}).click();await p.getByRole("heading",{name:"Channel",exact:true}).waitFor();
 const a=seats.A,coach=seats.B;
 await coach.locator('[data-signal="R1"]').click();
 const wait=async (fn,desc,ms=18000)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn(stageFrames.at(-1)))return;await new Promise(r=>setTimeout(r,70));}throw Error("Timed out: "+desc);};
 await wait(s=>s?.log.some(e=>e.kind==="message"&&e.text==="Slow down"&&e.playedAt),"first playback");await a.keyboard.press("r");await wait(s=>s?.log.some(e=>e.kind==="receipt"),"receipt",5000);observations.push("B fixed whisper, confirmed playback, A receipt");
 for(const size of sizes){await p.setViewportSize(size);await shot(p,size.width+"-live");}
 await coach.locator('[data-signal="R2"]').click();await wait(s=>s?.log.some(e=>e.text==="One minute left"&&e.playedAt),"time cue");
 await coach.locator("#sim-text").fill("The judge on the left looks lost.");await coach.locator("#sim-text").press("Enter");
 await wait(s=>s?.seats?.B?.pending?.heardAt,"private preview heard",35000);await coach.locator("#draft-send").click();await wait(s=>s?.log.some(e=>e.kind==="message"&&/left looks lost/i.test(e.text||"")&&e.playedAt),"approved delivery");observations.push("B private preview heard, B approved, A playback confirmed");
 await coach.locator('[data-signal="OUT"]').click();await wait(s=>s?.log.some(e=>e.kind==="message"&&e.text==="Wrap it up now"&&e.playedAt),"Out");
 await p.getByRole("button",{name:/^Reveal/}).click();await p.getByRole("heading",{name:"Here’s what passed between us."}).waitFor();
 const actual=stageFrames.at(-1);observations.push({phase:actual.phase,bits:actual.bits,messages:actual.log.filter(e=>e.kind==="message").map(e=>({text:e.text,played:!!e.playedAt})),receipt:actual.log.some(e=>e.kind==="receipt")});
 for(const size of sizes){await p.setViewportSize(size);await p.locator("#live-stage").evaluate(el=>el.scrollIntoView());await shot(p,size.width+"-reveal");await p.getByRole("button",{name:"Operator O"}).click();await shot(p,size.width+"-operator");await p.keyboard.press("Escape");}
 await p.setViewportSize(sizes[0]);await p.getByRole("button",{name:"Operator O"}).click();await p.getByRole("button",{name:"Canned take",exact:true}).click();await p.keyboard.press("Escape");await wait(s=>s?.canned&&s.phase==="live","canned live");await p.getByText("Canned take · Bundled rehearsal playback",{exact:true}).waitFor();await shot(p,"1440-canned");await wait(s=>s?.canned&&s.phase==="reveal","canned reveal",38000);observations.push("Canned take reached reveal");
 assert.equal(observations.filter(x=>x==="Stage socket opened").length,1);assert.deepEqual(errors,[]);console.log("Browser rehearsal passed");
 }finally{await fs.writeFile(path.join(out,"browser-results.json"),JSON.stringify({observations,errors,lastPhase:stageFrames.at(-1)?.phase},null,2));await b.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
