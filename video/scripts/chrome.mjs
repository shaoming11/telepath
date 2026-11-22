import { existsSync, readdirSync } from "node:fs";
import pkg from "playwright-core";

export const { chromium } = pkg;

export function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = `${process.env.HOME}/.cache/ms-playwright`;
  if (existsSync(cache)) {
    const dir = readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort().pop();
    if (dir) return `${cache}/${dir}/chrome-linux64/chrome`;
  }
  throw new Error("Set CHROME_PATH to a Chromium binary, or run `npx playwright-core install chromium`.");
}

export const GL_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];

export function launch() {
  return chromium.launch({ executablePath: chromePath(), args: [...GL_ARGS, "--force-color-profile=srgb", "--hide-scrollbars"] });
}
