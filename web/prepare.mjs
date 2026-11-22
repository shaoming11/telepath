import { copyFile, mkdir, access } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const app = dirname(fileURLToPath(import.meta.url));
const source = resolve(process.argv[2] ?? join(app, ".."), "public");
await access(join(source, "stage.mjs"));
const generated = join(app, "src", "upstream");
const fonts = join(app, "public", "fonts");
await Promise.all([
  mkdir(generated, { recursive: true }),
  mkdir(fonts, { recursive: true }),
]);
for (const name of [
  "stage.mjs",
  "announcements.mjs",
  "capture.mjs",
  "pcm-worklet.mjs",
  "phone-audio.mjs",
  "phone-data.mjs",
  "channel-monitor.mjs",
  "channel-monitor.css",
]) {
  await copyFile(join(source, name), join(generated, name));
}
for (const name of [
  "Geist-Variable.woff2",
  "GeistMono-Variable.woff2",
  "OFL.txt",
]) {
  await copyFile(join(source, "fonts", name), join(fonts, name));
}
const cues = join(app, "public", "assets");
await mkdir(cues, { recursive: true });
for (const name of [
  "soft",
  "urgent",
  "draft",
  "sent",
  "receipt",
  "error",
  "system",
  "back",
]) {
  const filename = "cue-" + name + ".mp3";
  await copyFile(join(source, "assets", filename), join(cues, filename));
}
