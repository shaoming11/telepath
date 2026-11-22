import {webkit} from "../edition/film/node_modules/playwright-core/index.mjs";
import {writeFile} from "node:fs/promises";import {dirname,join} from "node:path";import {fileURLToPath} from "node:url";import assert from "node:assert/strict";
const dest=dirname(fileURLToPath(import.meta.url));const browser=await webkit.launch();
const result={errors:[]};
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}});page.on("pageerror",e=>result.errors.push(e.message));page.setDefaultTimeout(45000);
 await page.goto("http://127.0.0.1:5827/cinema.html");
 await page.waitForFunction(()=>document.querySelector(".film canvas")||document.querySelector(".cinema-stills"));
 if(await page.locator(".cinema-stills").count()){
   result.mode="static fallback";await page.locator("#still-tap").scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector("#still-tap figure img")?.naturalWidth>0);
 }else{
   await page.evaluate(()=>scrollTo(0,15.7*120));
   await page.waitForFunction(()=>{const v=document.querySelector(".cinema-progress>div")?.style.transform;return Math.abs(Number(v?.match(/\(([^)]+)\)/)?.[1])-15.7/46)<.001;});
   const bright=await page.evaluate(()=>{const canvas=document.querySelector(".film canvas"),probe=document.createElement("canvas");probe.width=96;probe.height=54;const c=probe.getContext("2d");c.drawImage(canvas,0,0,96,54);const pixels=c.getImageData(0,0,96,54).data;let n=0;for(let k=0;k<pixels.length;k+=4)if(pixels[k]+pixels[k+1]+pixels[k+2]>220)n++;return n;});
   assert(bright>35,"No visible product pixels.");result.mode="WebGL";result.brightSamples=bright;
 }
 await page.screenshot({path:join(dest,"webkit-desktop.png")});
 await page.locator((result.mode==="WebGL"?".cinema-head":".still-head")+" a").first().click();await page.getByText("Hub online",{exact:true}).waitFor();result.stage=true;assert.deepEqual(result.errors,[]);
}finally{await writeFile(join(dest,"webkit-desktop.json"),JSON.stringify(result,null,2));await browser.close();}

