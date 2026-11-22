import {build} from "../local-tools/node_modules/esbuild/lib/main.js";
import {createServer} from "node:http";
import {readFile, mkdir} from "node:fs/promises";
import {resolve, dirname, sep, extname} from "node:path";
import {fileURLToPath} from "node:url";

const here=dirname(fileURLToPath(import.meta.url));
const site=resolve(here,"../comparison/site");
const out=resolve(here,"bundle");
await mkdir(out,{recursive:true});
await build({stdin:{contents:`import React from "react";import {createRoot} from "react-dom/client";import {FilmPage} from "./src/film/FilmPage";createRoot(document.getElementById("root")).render(<FilmPage/>);`,resolveDir:site,loader:"tsx"},
  outfile:resolve(out,"viewer.js"),bundle:true,jsx:"automatic",minify:true,format:"esm",loader:{".woff2":"file",".woff":"file"},nodePaths:[resolve(here,"../local-tools/node_modules")],define:{"process.env.NODE_ENV":JSON.stringify("production")}});
const types={".js":"application/javascript",".wasm":"application/wasm",".woff2":"font/woff2",".css":"text/css",".glb":"model/gltf-binary"};
createServer(async(req,res)=>{
  try{
    const path=new URL(req.url,"http://localhost").pathname;
    if(path==="/film"||path==="/"){res.writeHead(200,{"content-type":"text/html; charset=utf-8"});res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/viewer.css"><title>Telepathy · Comparison film</title></head><body style="margin:0"><div id="root"></div><script type="module" src="/viewer.js"></script></body></html>');return;}
    const root=/^\/(models|draco)\//.test(path)?resolve(site,"public"):out;
    const file=resolve(root,"."+decodeURIComponent(path));if(!file.startsWith(root+sep))throw Error();
    const data=await readFile(file);res.writeHead(200,{"content-type":types[extname(file)]||"application/octet-stream"});res.end(data);
  }catch{res.writeHead(404).end();}
}).listen(4197,"127.0.0.1",()=>console.log("Comparison film at http://127.0.0.1:4197/film"));
