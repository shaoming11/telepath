import {chromium} from "../edition/film/node_modules/playwright-core/index.mjs";
import {mkdir,writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import assert from "node:assert/strict";
const dir=process.argv[3]||dirname(fileURLToPath(import.meta.url));await mkdir(dir,{recursive:true});
const base=process.argv[2]||"http://127.0.0.1:4131";
const suffix=process.argv[4]==="portable"?".html":"";
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH,args:["--use-gl=angle","--use-angle=d3d11","--disable-backgrounding-occluded-windows","--disable-renderer-backgrounding"]});
const results=[],errors=[],external=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const ctx=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1});
await ctx.addInitScript(()=>{window.cinemaDrawCalls=0;for(const key of ["drawElements","drawArrays"]){const orig=WebGL2RenderingContext.prototype[key];WebGL2RenderingContext.prototype[key]=function(...args){window.cinemaDrawCalls++;return orig.apply(this,args);};}});
const p=await ctx.newPage();p.setDefaultTimeout(25000);
const origins=new Set([new URL(base).origin]);
await ctx.route(/^https?:/,route=>{if(!origins.has(new URL(route.request().url()).origin)){external.push(route.request().url());return route.abort();}return route.continue();});
p.on("pageerror",e=>errors.push(e.message));
const shot=name=>p.screenshot({path:join(dir,name+".png"),timeout:30000});
const states=[];let sockets=0;p.on("websocket",s=>{if(!s.url().includes("role=stage"))return;sockets++;s.on("framereceived",f=>{try{const m=JSON.parse(f.payload);if(m.type==="state")states.push(m.state.phase);}catch{}});});
try{
 await p.goto(base+"/cinema"+suffix);await p.locator(".film canvas").waitFor();await p.getByText("Hub online",{exact:true}).waitFor();await p.evaluate(()=>document.fonts.ready);await wait(1800);
 const holds=[7.2,15.7,26.3,37.1,45.4];
 for(const [width,height] of [[1440,900],[1920,1080]]){
  await p.setViewportSize({width,height});
  for(const [i,t] of holds.entries()){
   await p.evaluate(t=>window.scrollTo({top:t*120,behavior:"instant"}),t);
   await p.waitForFunction(t=>{const v=document.querySelector(".cinema-progress>div").style.transform;const n=Number(v.match(/\(([^)]+)\)/)?.[1]);return Math.abs(n-t/46)<.0002;},t);
   await shot("cinema-"+width+"-"+(i+1));
  }
 }
 await wait(1300);const before=await p.evaluate(()=>window.cinemaDrawCalls);assert(before>0);await wait(900);const after=await p.evaluate(()=>window.cinemaDrawCalls);assert.equal(after,before,"GPU kept drawing on a held chapter.");results.push("Draw calls stopped while a projector chapter was held.");
 const initialPhase=states.at(-1);await p.keyboard.press("Space");await p.waitForFunction(()=>document.getElementById("cinema-live").getBoundingClientRect().top<5);assert.equal(states.at(-1),initialPhase);assert.equal(sockets,1);
 results.push("Two projector resolutions, five 3D holds, one live connection and a keyboard handoff preserving the phase.");
 await p.getByRole("link",{name:"← Story",exact:true}).click();await p.waitForFunction(()=>window.scrollY<3);
 await p.keyboard.down("Space");await wait(320);await p.keyboard.down("Space");await p.keyboard.up("Space");await p.waitForFunction(()=>window.scrollY>=7.2*120-1,null,{timeout:27000});await wait(300);assert(Math.abs(await p.evaluate(()=>window.scrollY)-864)<2);results.push("Holding Space advances exactly one chapter.");
 await p.setViewportSize({width:390,height:844});await p.locator(".cinema-stills").waitFor();
 for(const [i,name] of ["silence","tap","meanings","asks","reveal"].entries()){
   const el=p.locator("#still-"+name);await el.scrollIntoViewIfNeeded();await el.evaluate(node=>node.scrollIntoView({block:"start"}));await shot("cinema-390-"+(i+1));assert(await el.evaluate(n=>n.scrollWidth<=n.clientWidth+1));
 }
 await p.setViewportSize({width:1440,height:900});await p.emulateMedia({reducedMotion:"reduce"});await p.locator(".cinema-stills").waitFor();assert.equal(await p.locator(".film canvas").count(),0);results.push("Narrow and reduced-motion modes present five product stills without a WebGL canvas.");
 await p.emulateMedia({reducedMotion:"no-preference"});await p.goto(base+"/film"+suffix);await p.waitForFunction(()=>window.__film?.seek,null,{timeout:75000});
 const sample=async t=>{await p.evaluate(t=>window.__film.seek(t),t);return await p.screenshot();};
 const a=await sample(15.7);await sample(37.1);const b=await sample(15.7);assert(a.equals(b),"Random seeks changed the image for the same timestamp.");await shot("bare-film-15-7");
 for(const t of [1.8,4.2,7.2,9.7,12.4,15.7,20.4,26.3,31.4,34,37.1,45.4]){await p.evaluate(t=>window.__film.seek(t),t);await shot("bare-film-"+String(t).replace(".","-"));}
 results.push("Bare film route captured twelve timestamps. Returning to a prior timestamp produced byte-identical screenshots.");
 const no=await ctx.newPage();await no.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(kind,...rest){return kind==="webgl2"||kind==="webgl"?null:original.call(this,kind,...rest);};});await no.goto(base+"/cinema"+suffix);await no.locator(".cinema-stills").waitFor();assert.equal(await no.locator(".film canvas").count(),0);await no.close();results.push("Desktop with WebGL disabled displays the static story.");
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
}finally{await writeFile(join(dir,"cinema-results.json"),JSON.stringify({results,errors,external},null,2));await browser.close();}



