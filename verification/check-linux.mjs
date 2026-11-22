import {chromium} from "../edition/film/node_modules/playwright-core/index.mjs";
import {writeFile} from "node:fs/promises";import {dirname,join} from "node:path";import {fileURLToPath} from "node:url";import assert from "node:assert/strict";
const dir=dirname(fileURLToPath(import.meta.url));const origin="http://127.0.0.1:5847";
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
try{
 const p=await browser.newPage({viewport:{width:390,height:844}});let state;const errors=[];
 p.on("websocket",s=>s.on("framereceived",f=>{try{const m=JSON.parse(f.payload);if(m.type==="state")state=m.state;}catch{}}));p.on("pageerror",e=>errors.push(e.message));
 await p.goto(origin+"/studio-stage.html");await p.getByText("Hub online",{exact:true}).waitFor();
 await p.getByLabel("Reference documents",{exact:true}).setInputFiles([join(dir,"fixtures/fixture.pdf"),join(dir,"fixtures/fixture.docx")]);
 await p.getByRole("button",{name:"Load documents"}).click();
 await p.getByText(/fixture\.pdf ·/).waitFor();await p.getByText(/fixture\.docx ·/).waitFor();
 const refs=state.references.filter(r=>r.name.startsWith("fixture."));assert.equal(refs.length,2);assert(refs.every(r=>r.characters>10));assert.deepEqual(errors,[]);
 await p.getByRole("button",{name:"Clear documents"}).click();await p.goto(origin+"/cinema.html");await p.locator("#still-silence figure img").waitFor();
 await writeFile(join(dir,"linux-package.json"),JSON.stringify({packagedLinuxRuntime:true,references:refs.map(r=>({name:r.name,characters:r.characters})),mobileCinema:true,errors},null,2));
}finally{await browser.close();}

