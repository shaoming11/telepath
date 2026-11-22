import {chromium,webkit} from "../edition/film/node_modules/playwright-core/index.mjs";
import {fork} from "node:child_process";
import {once} from "node:events";
import {writeFile} from "node:fs/promises";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import assert from "node:assert/strict";
const dir=dirname(fileURLToPath(import.meta.url)), release=resolve(process.argv[2]);
const hub=fork(join(release,"web/rehearsal.mjs"),[join(release,"hub-runtime"),"5844"],{stdio:["ignore","ignore","inherit","ipc"],windowsHide:true});
const results={};
try{
 const [{origin}]=await Promise.race([once(hub,"message"),once(hub,"exit").then(([c])=>{throw Error("Packaged hub startup "+c);})]);
 for(const [name,engine] of [["Chromium",chromium],["WebKit",webkit]]){
   const browser=await engine.launch({headless:true,executablePath:name==="Chromium"?process.env.CHROME_PATH:undefined, args:name==="Chromium"?["--use-gl=angle","--use-angle=d3d11"]:[]});
   try{
     const ctx=await browser.newContext({viewport:{width:390,height:844},reducedMotion:"reduce"});const page=await ctx.newPage();const errors=[],network=[];page.setDefaultTimeout(30000);
     page.on("pageerror",e=>errors.push(e.message));await ctx.route(/^https?:/,route=>{if(new URL(route.request().url()).origin!==origin){network.push(route.request().url());return route.abort();}return route.continue();});
     await page.goto(origin+"/cinema.html");await page.locator("#still-silence img[src*='posters']").waitFor();await page.waitForFunction(()=>[...document.querySelectorAll("img")].filter(i=>i.loading!=="lazy").every(i=>i.complete&&i.naturalWidth>0));
     await page.locator(".still-head a").first().click();await page.getByText("Hub online",{exact:true}).waitFor();
     await page.getByRole("button",{name:"Operator O"}).click();await page.getByRole("dialog").waitFor();await page.keyboard.press("Escape");await page.getByRole("dialog").waitFor({state:"hidden"});
     await page.goto(origin+"/studio.html");await page.locator("#opening").getByRole("button",{name:"Next beat"}).click();await page.waitForURL(url=>url.hash==="#send");
     await page.locator("#send").getByRole("link",{name:"Live stage"}).click();await page.waitForURL(url=>url.hash==="#live-stage");await page.getByText("Hub online",{exact:true}).waitFor();
     await page.screenshot({path:join(dir,"package-"+name+".png")});assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
     results[name]={mobileStills:true,presenterNavigation:true,operatorDialog:true,external:network,errors};
     if(name==="Chromium"){
       const file=await browser.newPage({viewport:{width:1440,height:900}});await file.goto(new URL("file:///"+join(release,"START HERE.html").replaceAll("\\","/")).href);
       await file.locator("video").evaluate(v=>new Promise((r,j)=>{if(v.readyState>=1)return r();v.onloadedmetadata=r;v.onerror=()=>j(Error("Movie cannot be opened."));}));
       const metadata=await file.locator("video").evaluate(v=>[v.duration,v.videoWidth,v.videoHeight]);assert.deepEqual(metadata,[62,1920,1080]);await file.locator("video").evaluate(v=>{v.currentTime=49.5;});await file.waitForFunction(()=>!document.querySelector("video").seeking);
       await file.screenshot({path:join(dir,"review-index.png")});results[name].filePlayback=metadata;await file.close();
     }
   }finally{await browser.close();}
 }
}finally{await writeFile(join(dir,"unpacked-review.json"),JSON.stringify(results,null,2));if(hub.connected){const done=once(hub,"exit");hub.send("stop");await done;}}


