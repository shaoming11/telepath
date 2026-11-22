// Runs a private hub, drives two simulated seats through the pitch flow and photographs the real stage.
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createHub } from "../../hub/server.mjs";
import { launch } from "./chrome.mjs";

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "out", "stage");
await mkdir(out, { recursive: true });

const hub = createHub({ env: {}, settings: { roomSenseMs: 15_000 } });
const { stageUrl } = await hub.start({ port: 0, host: "127.0.0.1" });

function seat(name) {
  const socket = new WebSocket(new URL(`/ws?role=seat&sim=1&seat=${name}`, stageUrl).href.replace(/^http/, "ws"));
  const send = frame => socket.send(JSON.stringify(frame));
  let sequence = 0;
  const client = { state: null, send, signal: signal => send({ type: "signal", signal, id: `${name}-${++sequence}` }), close: () => socket.close() };
  socket.on("message", data => {
    const frame = JSON.parse(String(data));
    if (frame.type === "state") client.state = frame.state;
    if (frame.type === "cache") send({ type: "cache_ready", activeId: frame.activeId });
    if (frame.type === "audio" && frame.messageId) setTimeout(() => send({ type: "heard", messageId: frame.messageId }), 250);
  });
  client.ready = new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); }).then(() => {
    send({ type: "configure", mode: 2 });
    for (const step of ["voice", "earbuds", "calibrate", "ready"]) send({ type: "setup", step, complete: true });
  });
  return client;
}

const browser = await launch();
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage();
await page.goto(stageUrl, { waitUntil: "load" });
const stage = { state: () => page.evaluate(() => document.body.dataset.phase) };
const shot = name => page.screenshot({ path: path.join(out, `${name}.png`), animations: "allow" });
const operator = action => page.evaluate(async act => {
  const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws?role=stage`);
  await new Promise(resolve => { socket.onopen = resolve; });
  socket.send(JSON.stringify({ type: "operator", action: act }));
  await new Promise(resolve => setTimeout(resolve, 150));
  socket.close();
}, action);
async function until(test, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await test()) return; await delay(50); }
  throw new Error(`Timed out waiting for ${label}`);
}
const logged = (client, test) => () => Boolean(client.state?.log?.some(test));

const a = seat("A");
const b = seat("B");
await Promise.all([a.ready, b.ready]);
await until(() => a.state?.canBegin, "both seats ready");
await delay(1200);
await page.addStyleTag({ content: "#room-microphone-panel{display:none!important}" });
await shot("lobby");
await operator("begin");
await until(async () => await stage.state() === "live", "live");
a.send({ type: "sim_transcript", text: "This is the Telepathy pitch. Let me explain how it works.", level: 0.18 });
await delay(2500);

b.signal("R1");
await until(logged(a, entry => entry.kind === "message" && entry.text === "Slow down"), "Slow down");
await delay(350);
await shot("live-whisper");
await delay(2500);
a.signal("R1");
await until(logged(a, entry => entry.kind === "receipt"), "receipt");
await delay(3000);

b.signal("R2");
await until(logged(a, entry => entry.kind === "message" && entry.text === "One minute left"), "One minute left");
await delay(4000);

b.send({ type: "sim_transcript", text: "The judge on the left looks lost.", level: 0.19 });
await until(() => b.state?.seats?.B?.pending?.text, "draft for B");
await delay(1500);
await shot("live-draft");
await delay(2000);
b.signal("R1");
await until(logged(a, entry => entry.kind === "message" && entry.text === "The judge on the left looks lost"), "draft sent");
await delay(4000);

b.signal("OUT");
await until(logged(a, entry => entry.kind === "message" && entry.text === "Wrap it up now"), "Wrap it up now");
await delay(600);
await shot("live-urgent");
await delay(2500);
b.signal("BACK");
await delay(1500);

await operator("reveal");
await until(async () => await stage.state() === "reveal", "reveal");
const started = Date.now();
const burst = [];
while (Date.now() - started < 7000) {
  const name = `reveal-${String(burst.length).padStart(3, "0")}`;
  await shot(name);
  burst.push({ name, at: (Date.now() - started) / 1000 });
}
await shot("reveal");
await writeFile(path.join(out, "manifest.json"), JSON.stringify({
  burst,
  bits: a.state.bits,
  messages: a.state.log.filter(entry => entry.kind === "message").map(entry => entry.text),
}, null, 2));
console.log(`Stage captured: ${burst.length} reveal frames, messages: ${a.state.log.filter(entry => entry.kind === "message").map(entry => entry.text).join(" | ")}`);
a.close(); b.close();
await browser.close();
await hub.close();
