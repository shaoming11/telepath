import {chromium} from "../edition/film/node_modules/playwright-core/index.mjs";
import {fork} from "node:child_process";import {once} from "node:events";import {writeFile} from "node:fs/promises";import {dirname,join} from "node:path";import {fileURLToPath} from "node:url";
const proof=dirname(fileURLToPath(import.meta.url)),root=join(proof,"..");
const hub=fork(join(root,"edition/web/rehearsal.mjs"),[join(root,"baseline"),"5855"],{stdio:["ignore","ignore","inherit","ipc"],windowsHide:true});
let browser;const results={};
try{
 const [{origin}]=await Promise.race([once(hub,"message"),once(hub,"exit").then(()=>{throw Error("Fixture unavailable.");})]);
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH,args:["--use-angle=d3d11","--autoplay-policy=no-user-gesture-required"]});
 const p=await browser.newPage({viewport:{width:1440,height:900}});
 async function audit(label){
  await p.evaluate(()=>document.fonts.ready);await p.addScriptTag({path:join(root,"local-tools/node_modules/axe-core/axe.min.js")});
  results[label]=await p.evaluate(async()=>{const r=await axe.run(document,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21a","wcag21aa","wcag22aa"]}});return r.violations.map(v=>({id:v.id,impact:v.impact,items:v.nodes.map(n=>({target:n.target,reason:n.failureSummary})).slice(0,9)}));});
 }
 await p.goto(origin+"/studio.html");await p.getByText("Hub online",{exact:true}).waitFor();await audit("presenter");
 await p.goto(origin+"/cinema.html");await p.locator(".film canvas").waitFor();await p.evaluate(()=>scrollTo(0,15.7*120));await p.waitForFunction(()=>document.querySelector(".cinema-progress>div")?.style.transform.includes("0.341"));await audit("cinema");
 await p.goto(origin+"/studio-stage.html");await p.getByText("Hub online",{exact:true}).waitFor();await audit("lobby");
 await p.getByRole("button",{name:"Operator O"}).click();await audit("operator");await p.getByRole("button",{name:"Canned take",exact:true}).click();await p.keyboard.press("Escape");await p.getByText("Canned take · Bundled rehearsal playback",{exact:true}).waitFor();await audit("live");
 await p.getByRole("heading",{name:"Here’s what passed between us."}).waitFor({timeout:45000});await audit("reveal");
 await p.setViewportSize({width:390,height:844});await p.goto(origin+"/cinema.html");await p.locator("#still-tap figure img").waitFor();await audit("mobile");
}finally{await writeFile(join(proof,"accessibility.json"),JSON.stringify(results,null,2));await browser?.close();if(hub.connected){const end=once(hub,"exit");hub.send("stop");await end;}}
console.log(Object.fromEntries(Object.entries(results).map(([k,v])=>[k,v.map(i=>i.id)])));

