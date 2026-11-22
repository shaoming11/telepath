import {chromium} from "../edition/film/node_modules/playwright-core/index.mjs";
import {writeFile} from "node:fs/promises";import {dirname,join} from "node:path";import {fileURLToPath} from "node:url";
const dir=dirname(fileURLToPath(import.meta.url)),result=[];
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,args:["--use-gl=angle","--use-angle=d3d11","--disable-backgrounding-occluded-windows","--disable-renderer-backgrounding"]});
try{
 const p=await browser.newPage({viewport:{width:1440,height:900}});
 for(const [width,height] of [[1440,900],[1920,1080]]){
  await p.setViewportSize({width,height});await p.goto("http://127.0.0.1:5827/cinema.html");await p.locator(".film canvas").waitFor();
  await p.evaluate(()=>scrollTo(0,7.2*120));await p.waitForFunction(()=>document.querySelector(".cinema-progress>div")?.style.transform.includes("0.156"));
  await p.keyboard.press("Space");
  const sample=await p.evaluate(async()=>{
   const times=[];let previous=0;const start=performance.now();
   await new Promise(resolve=>{function observe(t){if(previous)times.push(t-previous);previous=t;if(t-start>=6500)resolve();else requestAnimationFrame(observe);}requestAnimationFrame(observe);});
   const steady=times.slice(6).filter(n=>n>0);const sorted=steady.toSorted((a,b)=>a-b);const quant=p=>Number(sorted[Math.floor(p*(sorted.length-1))].toFixed(2));
   return {samples:steady.length,medianMs:quant(.5),p95Ms:quant(.95),over50Ms:steady.filter(n=>n>50).length,scrollMoved:scrollY>1000};
  });result.push({width,height,...sample});
 }
}finally{await writeFile(join(dir,"projector-frame-pacing.json"),JSON.stringify(result,null,2));await browser.close();}

