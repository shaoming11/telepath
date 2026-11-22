const {chromium}=require("C:/Users/Sharon/AppData/Local/ms-playwright-go/1.50.1/package");
const fs=require("node:fs/promises");
const path=require("node:path");
(async()=>{
 const mode=process.argv[2]||"swiftshader",prefix=process.argv[3]||"ondemand";
 const b=await chromium.launch({executablePath:"C:/Program Files/Google/Chrome/Application/chrome.exe",args:["--use-gl=angle","--use-angle="+mode,"--enable-unsafe-swiftshader","--ignore-gpu-blocklist","--force-color-profile=srgb","--disable-renderer-backgrounding"]});
 try{
 const p=await b.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});
 p.on("console",m=>{if(["error","warning"].includes(m.type()))console.log(m.text().slice(0,420));});
 p.on("pageerror",e=>console.log(e.message));
 await p.goto("http://127.0.0.1:4198/film");await p.waitForFunction(()=>window.__film,null,{timeout:100000});
 await p.addStyleTag({content:".film-title,.film-copy{display:none!important}"});
 const start=Date.now();
 for(const [i,t] of [15.7,26,37.1,15.7].entries()){
   await p.evaluate(t=>window.__film.seek(t),t);
   const img=await p.evaluate(()=>document.querySelector("canvas").toDataURL("image/jpeg",.94).split(",")[1]);
   await fs.writeFile(path.join(__dirname,prefix+"-"+i+"-canvas.jpg"),Buffer.from(img,"base64"));
   await p.screenshot({path:path.join(__dirname,prefix+"-"+i+".jpg"),quality:95,timeout:35000});
 }
 console.log("Four deterministic seeks and captures in "+(Date.now()-start)+" ms");
 }finally{await b.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
