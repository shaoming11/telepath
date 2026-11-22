import { createHash } from "node:crypto";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import {
  access,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const home = dirname(fileURLToPath(import.meta.url));
const flags = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const i = arg.indexOf("=");
    return [arg.slice(2, i), arg.slice(i + 1)];
  }),
);
const scene = resolve(flags.scene || join(home, "../web")),
  edit = resolve(flags.edit || join(home, "edit")),
  proof = resolve(flags.proof || join(home, "out/proof"));
const sourceDir = join(scene, "src/cinema");
const output = resolve(flags.out || join(home, "out")),
  bundle = join(output, "viewer");
const mode = flags.mode || "all",
  native = flags.angle || (process.platform === "win32" ? "d3d11" : "default");
const timeline = JSON.parse(
  await readFile(join(edit, "timeline.json"), "utf8"),
);
if (!["all", "encode", "plates", "posters", "serve"].includes(mode))
  throw Error("Choose all, encode, plates, posters or serve.");
const fps = timeline.fps;
const frameName = (i) => "f" + String(i).padStart(5, "0") + ".jpg";
const checkedFile = async (file) => {
  try {
    return (await stat(file)).size > 1500;
  } catch {
    return false;
  }
};
const built = await build({
  write: false,
  stdin: {
    contents: await readFile(join(home, "Capture.jsx"), "utf8"),
    resolveDir: sourceDir,
    loader: "jsx",
  },
  outfile: join(bundle, "viewer.js"),
  bundle: true,
  jsx: "automatic",
  minify: true,
  format: "esm",
  loader: { ".woff2": "file", ".woff": "file" },
  nodePaths: [join(home, "node_modules")],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
const viewer = new Map(
  built.outputFiles.map((file) => ["/" + basename(file.path), file.contents]),
);
const fingerprint = createHash("sha256").update(
  JSON.stringify({ width: 1920, height: 1080, quality: 97, fps, native }),
);
for (const [name, bytes] of [...viewer].sort(([a], [b]) => a.localeCompare(b)))
  fingerprint.update(name).update(bytes);
for (const file of [
  "models/airpods.glb",
  "draco/draco_decoder.wasm",
  "draco/draco_wasm_wrapper.js",
  "draco/draco_decoder.js",
])
  fingerprint.update(await readFile(join(scene, "public", file)));
const plates = join(output, "plates", fingerprint.digest("hex").slice(0, 20));
await mkdir(plates, { recursive: true });
const types = {
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".css": "text/css",
  ".glb": "model/gltf-binary",
  ".html": "text/html",
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};
function safePath(root, p) {
  const result = resolve(root, "." + p);
  if (!result.startsWith(root + sep)) throw Error("Invalid asset path.");
  return result;
}
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    let body;
    if (path === "/film") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/viewer.css"><title>Telepathy film</title></head><body style="margin:0"><div id="root"></div><script type="module" src="/viewer.js"></script></body></html>',
      );
      return;
    }
    if (path === "/tokens.css")
      body = (await readFile(join(sourceDir, "tokens.css"), "utf8"))
        .replace(/^@import .*$/m, "")
        .replace(".film, .cinema", ":root");
    else if (path.startsWith("/out/film/"))
      body = await readFile(safePath(plates, path.slice("/out/film".length)));
    else if (path === "/out/stage/manifest.json")
      body = await readFile(join(proof, "manifest.json"), "utf8").catch((e) => {
        if (e.code !== "ENOENT") throw e;
        return JSON.stringify({ burst: [] });
      });
    else if (path === "/out/stage/live-whisper.png")
      body = await readFile(join(proof, "1920-live.png"));
    else if (path === "/out/stage/reveal.png")
      body = await readFile(join(proof, "1920-reveal.png"));
    else if (/^\/out\/stage\/reveal-\d{2}\.png$/.test(path))
      body = await readFile(join(proof, "burst", path.split("/").pop()));
    else if (path.startsWith("/node_modules/@fontsource-variable/inter/"))
      body = await readFile(safePath(home, path));
    else if (path.startsWith("/comp/") || path === "/timeline.json")
      body = await readFile(safePath(edit, path));
    else if (/^\/(models|draco)\//.test(path))
      body = await readFile(safePath(join(scene, "public"), path));
    else if (viewer.has(path)) body = viewer.get(path);
    else {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": types[extname(path)] || "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve, reject) =>
  server
    .once("error", reject)
    .listen(Number(flags.port || 0), "127.0.0.1", resolve),
);
const origin = "http://127.0.0.1:" + server.address().port;
console.log("Film route " + origin + "/film");
if (mode === "serve") await new Promise(() => {});
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
  args: [
    "--force-color-profile=srgb",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--hide-scrollbars",
    ...(native === "default"
      ? []
      : ["--use-gl=angle", "--use-angle=" + native]),
    ...(native === "swiftshader"
      ? ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
      : []),
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
});
let encoder;
try {
  if (mode === "posters") {
    const posterDir = resolve(flags.posters || join(scene, "public/posters"));
    await mkdir(posterDir, { recursive: true });
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1040, height: 585 });
    await page.goto(origin + "/film");
    await page.waitForFunction(() => window.__film?.seek, null, {
      timeout: 90000,
    });
    await page.addStyleTag({
      content: ".film-copy,.film-title{display:none!important}",
    });
    for (const [name, time] of Object.entries({
      silence: 7.2,
      tap: 15.7,
      meanings: 26.3,
      asks: 37.1,
      reveal: 45.4,
    })) {
      await page.evaluate((t) => window.__film.seek(t), time);
      await page.screenshot({ path: join(posterDir, name + ".png") });
    }
    await page.close();
    console.log("Five fallback images saved in " + posterDir);
  }
  if (mode === "plates" || mode === "all") {
    let page;
    async function open() {
      await page?.close().catch(() => {});
      page = await ctx.newPage();
      await page.goto(origin + "/film", { timeout: 90000 });
      await page.waitForFunction(() => window.__film, null, { timeout: 90000 });
      await page.addStyleTag({
        content: ".film-copy,.film-title{display:none!important}",
      });
      await page.evaluate(() => window.__film.seek(15.7));
      const color = await page.evaluate(() => {
        const c = document.querySelector("canvas"),
          scaled = document.createElement("canvas");
        scaled.width = 96;
        scaled.height = 54;
        const two = scaled.getContext("2d");
        two.drawImage(c, 0, 0, 96, 54);
        const pixels = two.getImageData(0, 0, 96, 54).data;
        let bright = 0;
        for (let k = 0; k < pixels.length; k += 4)
          if (pixels[k] + pixels[k + 1] + pixels[k + 2] > 220) ++bright;
        return bright;
      });
      if (color < 35)
        throw Error(
          "The GPU returned an empty product frame. Retry using --angle=swiftshader.",
        );
    }
    await open();
    const seconds = await page.evaluate(() => window.__film.seconds),
      total = Math.round(seconds * fps);
    for (let i = 0; i < total; i++) {
      const target = join(plates, frameName(i));
      if (await checkedFile(target)) continue;
      for (let attempt = 0; ; attempt++) {
        try {
          await page.evaluate((t) => window.__film.seek(t), i / fps);
          const bytes = await page.screenshot({
            type: "jpeg",
            quality: 97,
            timeout: 35000,
          });
          const pending = target + "." + process.pid + ".part";
          await writeFile(pending, bytes);
          await rename(pending, target);
          break;
        } catch (err) {
          if (attempt >= 2) throw err;
          console.log("Reopening the renderer at frame " + i);
          await open();
        }
      }
      if ((i + 1) % 100 === 0) console.log("3D " + (i + 1) + "/" + total);
    }
    await page.close();
    console.log("Captured " + total + " frames.");
  }
  if (mode === "encode" || mode === "all") {
    const audio = resolve(flags.audio || join(home, "out/audio.wav"));
    await Promise.all([
      access(audio),
      access(join(proof, "1920-live.png")),
      access(join(proof, "1920-reveal.png")),
    ]);
    for (let i = 0; i < Math.round(timeline.beats.stage[0] * fps); i++)
      if (!(await checkedFile(join(plates, frameName(i)))))
        throw Error("Missing 3D frame " + i);
    const page = await ctx.newPage();
    await page.goto(origin + "/comp/index.html?film=1");
    await page.waitForFunction(() => window.__film);
    const partial = join(output, "telepathy." + process.pid + ".partial.mp4"),
      movie = join(output, "telepathy-launch.mp4");
    encoder = spawn(
      process.env.FFMPEG || "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "image2pipe",
        "-framerate",
        String(fps),
        "-c:v",
        "mjpeg",
        "-i",
        "pipe:0",
        "-i",
        audio,
        "-c:v",
        "libx264",
        "-threads",
        "3",
        "-preset",
        "medium",
        "-crf",
        "16",
        "-vf",
        "scale=out_color_matrix=bt709:out_range=tv",
        "-pix_fmt",
        "yuv420p",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-colorspace",
        "bt709",
        "-c:a",
        "aac",
        "-b:a",
        "256k",
        "-shortest",
        "-movflags",
        "+faststart",
        partial,
      ],
      { stdio: ["pipe", "ignore", "inherit"], windowsHide: true },
    );
    const finished = once(encoder, "exit");
    encoder.stdin.on("error", () => {});
    const total = Math.round(timeline.seconds * fps);
    for (let i = 0; i < total; i++) {
      const data = await page.evaluate(async (t) => {
        await window.__film.seek(t);
        return document
          .getElementById("frame")
          .toDataURL("image/jpeg", 0.98)
          .split(",")[1];
      }, i / fps);
      await new Promise((resolve, reject) =>
        encoder.stdin.write(Buffer.from(data, "base64"), (err) =>
          err ? reject(err) : resolve(),
        ),
      );
      if ((i + 1) % 300 === 0) console.log("Final " + (i + 1) + "/" + total);
    }
    encoder.stdin.end();
    const [code] = await finished;
    if (code !== 0) throw Error("FFmpeg exited with " + code);
    await rename(partial, movie);
    console.log(movie);
  }
} finally {
  encoder?.kill();
  await browser.close();
  server.close();
}
