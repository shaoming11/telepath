// Seeks a time-addressable page frame by frame and saves each frame. Works for the composition and for the 3D film.
import { createServer } from "node:http";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./chrome.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const option = (name, fallback) => { const hit = args.find(arg => arg.startsWith(`--${name}=`)); return hit ? hit.split("=").slice(1).join("=") : fallback; };

const timeline = JSON.parse(await readFile(path.join(root, "timeline.json"), "utf8"));
const fps = timeline.fps;
const film = flag("film");
const pages = Number(option("pages", film ? 6 : 8));
const outDir = path.join(root, "out", film ? "film" : "frames");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2" };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://x").pathname);
    let body;
    if (pathname === "/tokens.css") {
      body = (await readFile(path.join(root, "..", "site", "src", "tokens.css"), "utf8")).replace(/^@import .*$/m, "");
    } else {
      const file = path.join(root, pathname === "/" ? "comp/index.html" : pathname);
      if (!file.startsWith(root)) throw new Error("outside root");
      body = await readFile(file);
    }
    response.writeHead(200, { "content-type": TYPES[path.extname(pathname)] ?? "application/octet-stream", "cache-control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(Number(option("port", 5791)), "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

if (flag("serve")) {
  console.log(`Composition at ${origin}/comp/index.html?t=12`);
  await new Promise(() => {});
}

const url = film ? option("url", "http://localhost:3000/film") : `${origin}/comp/index.html${option("query", "")}`;
const browser = await launch();
const [width, height] = option("size", "1920x1080").split("x").map(Number);
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });

async function open() {
  const page = await context.newPage();
  page.on("pageerror", error => console.error(`[page] ${error.message}`));
  await page.goto(url, { waitUntil: "load", timeout: 120_000 });
  await page.waitForFunction(() => window.__film && Number.isFinite(window.__film.seconds), null, { timeout: 120_000 });
  if (film && !flag("copy")) await page.addStyleTag({ content: ".film-copy,.film-title{display:none!important}" });
  return page;
}

const first = await open();
const seconds = Number(option("seconds", await first.evaluate(() => window.__film.seconds)));
const from = Math.round(Number(option("from", 0)) * fps);
const to = Math.round(Number(option("to", seconds)) * fps);
if (!flag("keep")) await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const step = Number(option("step", 1));
const phase = Number(option("phase", 0));
const queue = [];
if (option("frames")) queue.push(...option("frames").split(",").map(Number));
else for (let frame = from; frame < to; frame++) if (frame % step === phase) queue.push(frame);
let done = 0;
const started = Date.now();
async function worker(page) {
  while (queue.length) {
    const frame = queue.shift();
    const file = path.join(outDir, `f${String(frame).padStart(5, "0")}.jpg`);
    if (flag("keep") && await access(file).then(() => true, () => false)) continue;
    await page.evaluate(t => window.__film.seek(t), frame / fps);
    await page.screenshot({ path: file, type: "jpeg", quality: 96, animations: "allow", timeout: 120_000 });
    if (++done % 150 === 0) console.log(`${done} frames, ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
}
const rest = await Promise.all(Array.from({ length: pages - 1 }, open));
await Promise.all([first, ...rest].map(worker));
console.log(`Captured ${done} frames of ${url} into ${path.relative(root, outDir)} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
await browser.close();
server.close();
