import { chromium } from "playwright-core";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const home = dirname(fileURLToPath(import.meta.url));
const [repositoryArg, outputArg, portArg] = process.argv.slice(2);
if (!repositoryArg)
  throw Error(
    "Supply a Telepathy checkout containing its installed hub dependencies.",
  );
const output = resolve(outputArg || join(home, "out/proof"));
await mkdir(join(output, "burst"), { recursive: true });
const service = fork(
  join(home, "../web/rehearsal.mjs"),
  [resolve(repositoryArg), portArg || "5806"],
  { stdio: ["ignore", "ignore", "inherit", "ipc"], windowsHide: true },
);
let browser, stage, state;
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(test, reason, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (test(state)) return;
    await sleep(50);
  }
  throw Error(reason);
}
try {
  const [{ origin }] = await Promise.race([
    once(service, "message"),
    once(service, "exit").then(([code]) => {
      throw Error("Rehearsal could not start (" + code + ").");
    }),
  ]);
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    ],
  });
  stage = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  stage.setDefaultTimeout(20000);
  stage.on("pageerror", (e) => errors.push(e.message));
  stage.on("websocket", (s) =>
    s.on("framereceived", (f) => {
      try {
        const m = JSON.parse(f.payload);
        if (m.type === "state") state = m.state;
      } catch {}
    }),
  );
  await stage.goto(origin + "/studio-stage.html");
  await until((s) => s?.phase === "lobby", "Lobby unavailable.");
  await stage.evaluate(() => document.fonts.ready);
  const seats = {};
  for (const seat of ["A", "B"]) {
    const phone = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    seats[seat] = phone;
    await phone.goto(origin + "/?sim=1&seat=" + seat);
    await phone.locator('[data-seat="' + seat + '"]').click();
    for (const id of [
      "voice-skip",
      "test-audio",
      "earbuds-next",
      "cal-skip",
      "preset-next",
    ])
      await phone.locator("#" + id).click();
  }
  await stage.getByRole("button", { name: /^Begin session/ }).click();
  await until((s) => s?.phase === "live", "Begin failed.");
  const played = (text) => (s) =>
    s?.log.some(
      (e) => e.kind === "message" && e.text === text && e.playedAt != null,
    );
  await seats.B.locator('[data-signal="R1"]').click();
  await until(played("Slow down"), "Fixed cue did not play.");
  await seats.A.keyboard.press("r");
  await until(
    (s) => s.log.some((e) => e.kind === "receipt"),
    "Receipt did not arrive.",
    4500,
  );
  await stage.getByRole("heading", { name: "“Slow down”" }).waitFor();
  await stage.screenshot({ path: join(output, "1920-live.png") });
  await seats.B.locator('[data-signal="R2"]').click();
  await until(played("One minute left"), "Time cue did not play.");
  await seats.B.locator("#sim-text").fill("The judge on the left looks lost.");
  await seats.B.locator("#sim-text").press("Enter");
  await until(
    (s) => s.seats.B.pending?.heardAt != null,
    "Private preview did not play.",
    40000,
  );
  const draft = state.seats.B.pending.text;
  assert(
    !state.log.some((e) => e.kind === "message" && e.text === draft),
    "Draft reached the partner before approval.",
  );
  await seats.B.locator("#draft-send").click();
  await until(played(draft), "Approved draft did not play.");
  await seats.B.locator('[data-signal="OUT"]').click();
  await until(played("Wrap it up now"), "Closing cue did not play.");
  await stage.getByRole("button", { name: /^Reveal/ }).click();
  await until((s) => s.phase === "reveal", "Reveal failed.");
  await stage
    .getByRole("heading", { name: "Here’s what passed between us." })
    .waitFor();
  await stage.screenshot({ path: join(output, "1920-reveal.png") });
  const timelineTop = await stage
    .getByRole("heading", { name: "Timeline", exact: true })
    .evaluate((el) => el.getBoundingClientRect().top);
  const distance = Math.max(0, Math.min(440, timelineTop - 490));
  const burst = [];
  for (let i = 0; i <= 24; i++) {
    const at = i / 6;
    const interval = Math.max(0, Math.min(1, (at - 1.1) / 2.25));
    const y = distance * interval * interval * (3 - 2 * interval);
    await stage.evaluate(
      (n) => window.scrollTo({ top: n, behavior: "instant" }),
      y,
    );
    const name = "reveal-" + String(i).padStart(2, "0");
    await stage.screenshot({ path: join(output, "burst", name + ".png") });
    burst.push({ at, name });
  }
  assert.deepEqual(errors, []);
  const messages = state.log
    .filter((e) => e.kind === "message")
    .map((e) => ({ text: e.text, played: e.playedAt != null }));
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify(
      {
        burst,
        bits: state.bits,
        messages,
        receipt: true,
        privatePreviewBeforeApproval: true,
      },
      null,
      2,
    ),
  );
  console.log(
    "Captured " +
      messages.length +
      " delivered messages, " +
      state.bits +
      " tapped bits and " +
      burst.length +
      " reveal frames.",
  );
} finally {
  await browser?.close();
  if (service.connected) {
    const stopped = once(service, "exit");
    service.send("stop");
    await stopped;
  }
}
