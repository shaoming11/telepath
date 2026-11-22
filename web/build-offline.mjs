import { build } from "esbuild";
import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, "offline");
await mkdir(out, { recursive: true });
const shared = {
  absWorkingDir: root,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  minify: true,
  legalComments: "eof",
  external: ["/fonts/*"],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
};
await build({
  ...shared,
  entryPoints: ["offline-entry.jsx"],
  outfile: join(out, "studio.bundle.mjs"),
});
const resources = {
  "/models/airpods.glb": "model/gltf-binary",
  "/draco/draco_decoder.wasm": "application/wasm",
  "/draco/draco_wasm_wrapper.js": "application/javascript",
  "/draco/draco_decoder.js": "application/javascript",
};
const packed = {};
for (const [url, mime] of Object.entries(resources)) {
  packed[url] = [
    mime,
    (await readFile(join(root, "public", url.slice(1)))).toString("base64"),
  ];
}
await build({
  ...shared,
  entryPoints: ["offline-cinema.jsx"],
  outfile: join(out, "cinema.bundle.mjs"),
  loader: { ".woff2": "file", ".woff": "file" },
  assetNames: "cinema-fonts/[name]-[hash]",
  publicPath: "/",
  plugins: [
    {
      name: "offline-hardware",
      setup(builder) {
        builder.onResolve({ filter: /^telepathy:hardware$/ }, () => ({
          path: "assets",
          namespace: "hardware",
        }));
        builder.onLoad({ filter: /^assets$/, namespace: "hardware" }, () => ({
          contents: "export default " + JSON.stringify(packed),
          loader: "js",
        }));
      },
    },
  ],
});
for (const name of ["airpods.png", "mark.svg"])
  await copyFile(join(root, "public", name), join(out, name));
await cp(join(root, "public/posters"), join(out, "posters"), {
  recursive: true,
});
for (const [bundle, routes] of [
  ["studio", ["studio.html", "studio-stage.html"]],
  ["cinema", ["cinema.html", "film.html"]],
]) {
  const page =
    '<!doctype html><html lang="en" data-telepathy="rehearsal"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="/mark.svg"><link rel="stylesheet" href="/' +
    bundle +
    '.bundle.css"><title>Telepathy</title></head><body><div id="root"></div><script type="module" src="/' +
    bundle +
    '.bundle.mjs"></script></body></html>';
  for (const route of routes) await writeFile(join(out, route), page);
}
