import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const home = dirname(fileURLToPath(import.meta.url));
const base = resolve(process.argv[2] || join(home, ".."));
const port = Number(process.argv[3] || 5798);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw Error("Choose a port between 1 and 65535.");
const dependencyPath = join(base, "node_modules");
const artifacts = [
  "airpods.png",
  "mark.svg",
  "studio-stage.html",
  "studio.bundle.css",
  "studio.bundle.mjs",
  "studio.html",
  "cinema.html",
  "film.html",
  "cinema.bundle.mjs",
  "cinema.bundle.css",
  "cinema-fonts",
  "posters",
];
await Promise.all([
  access(join(base, "hub/server.mjs")),
  access(join(dependencyPath, "ws")),
  ...artifacts.map((n) => access(join(home, "offline", n))),
]);
const temp = resolve(tmpdir());
const runtime = await mkdtemp(join(temp, "telepathy-studio-"));
const mirror = join(runtime, "node_modules");
let hub, closing;
async function close() {
  if (closing) return closing;
  closing = (async () => {
    await hub?.close();
    if (
      dirname(runtime) !== temp ||
      !basename(runtime).startsWith("telepathy-studio-")
    )
      throw Error("Unexpected rehearsal location.");
    const link = await lstat(mirror).catch((e) => {
      if (e.code !== "ENOENT") throw e;
      return null;
    });
    if (link) {
      if (
        !link.isSymbolicLink() ||
        resolve(await readlink(mirror)) !== dependencyPath
      )
        throw Error("Unexpected dependency junction.");
      await unlink(mirror);
    }
    await rm(runtime, { recursive: true, force: true });
  })();
  return closing;
}
try {
  await mkdir(join(runtime, "public"));
  await cp(join(base, "public"), join(runtime, "public"), { recursive: true });
  for (const file of artifacts)
    await cp(join(home, "offline", file), join(runtime, "public", file), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  for (const name of [
    "hub",
    "monitor",
    "maritime",
    "docs",
    "README.md",
    "package.json",
  ])
    await cp(join(base, name), join(runtime, name), { recursive: true });
  await symlink(
    dependencyPath,
    mirror,
    process.platform === "win32" ? "junction" : "dir",
  );
  const { createHub } = await import(
    pathToFileURL(join(runtime, "hub/server.mjs")).href
  );
  hub = createHub({ env: {}, projectRoot: pathToFileURL(base + "/") });
  const info = await hub.start({ host: "127.0.0.1", port });
  const origin = new URL(info.stageUrl).origin;
  console.log("Cinema      " + origin + "/cinema.html");
  console.log("Presenter   " + origin + "/studio.html");
  console.log("Studio      " + origin + "/studio-stage.html");
  console.log("Hub stage   " + info.stageUrl);
  if (process.send) process.send({ ready: true, origin });
  for (const sig of ["SIGINT", "SIGTERM"])
    process.once(sig, () => void close());
  if (process.send)
    process.on("message", async (message) => {
      if (message === "stop") {
        await close();
        process.disconnect();
      }
    });
} catch (error) {
  await close();
  throw error;
}
