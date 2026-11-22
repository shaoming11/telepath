// Saves single frames of the composition: node scripts/still.mjs 6 13.5 21 ...
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./chrome.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const query = args.find(arg => arg.startsWith("?")) ?? "";
const times = args.filter(arg => !arg.startsWith("?")).map(Number);
const server = spawn(process.execPath, [path.join(root, "scripts", "capture.mjs"), "--serve", "--port=5796"], { stdio: "ignore" });
await new Promise(resolve => setTimeout(resolve, 700));
await mkdir(path.join(root, "out", "stills"), { recursive: true });
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on("pageerror", error => console.error(`[page] ${error.message}`));
page.on("console", message => { if (message.type() === "error") console.error(`[console] ${message.text()}`); });
await page.goto(`http://127.0.0.1:5796/comp/index.html${query}`);
await page.waitForFunction(() => window.__film, null, { timeout: 30_000 });
for (const t of times) {
  await page.evaluate(time => window.__film.seek(time), t);
  await page.screenshot({ path: path.join(root, "out", "stills", `t${t.toFixed(2).padStart(5, "0")}.png`), animations: "allow" });
}
await browser.close();
server.kill();
