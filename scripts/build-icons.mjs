import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cachedBuild } from "./build-cache.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

const source = join(root, "public/icon.png");

function iconContent(content, path) {
  if (!path.endsWith(".icns")) return content;

  const entries = [];

  for (let offset = 8; offset < content.length;) {
    if (offset + 8 > content.length) return content;

    const length = content.readUInt32BE(offset + 4);

    if (length < 8 || offset + length > content.length) return content;
    entries.push(content.subarray(offset, offset + length));
    offset += length;
  }

  return Buffer.concat([content.subarray(0, 8), ...entries.sort(Buffer.compare)]);
}

function copyIfChanged(from, to) {
  const content = iconContent(readFileSync(from), from);

  try {
    if (iconContent(readFileSync(to), to).equals(content)) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  copyFileSync(from, to);
}

if (process.argv[2]) copyIfChanged(process.argv[2], source);

const desktopIcons = ["32x32.png", "128x128.png", "128x128@2x.png", "icon.icns", "icon.ico"];

const densities = ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"];

const androidIcons = ["ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png"];

const resources = join(root, "clients/android/app/src/main/res");

await cachedBuild({
  name: "icons",
  inputs: [source, join(root, "scripts/icon-background.svg"), fileURLToPath(import.meta.url), join(root, "scripts/build-cache.mjs"), join(root, "bun.lock")],
  outputs: [...desktopIcons.map(name => join(root, "clients/desktop/icons", name)), ...densities.flatMap(density => androidIcons.map(name => join(resources, `mipmap-${density}`, name))), join(resources, "drawable/piop_icon.png")],
  key: "tauri-icons",
}, async () => {
  const output = mkdtempSync(join(tmpdir(), "piop-icons-"));

  try {
    const foreground = join(output, "foreground.svg");
    const image = readFileSync(source).toString("base64");
    writeFileSync(foreground, `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="-341 -341 1706 1706"><image width="1024" height="1024" href="data:image/png;base64,${image}"/></svg>`);
    const manifest = join(output, "icons.json");
    writeFileSync(manifest, JSON.stringify({
      default: source,
      bg_color: "#f3f1ec",
      android_bg: join(root, "scripts/icon-background.svg"),
      android_fg: foreground,
      android_fg_scale: 75,
    }));

    const result = spawnSync(process.execPath, [
      join(root, "node_modules/@tauri-apps/cli/tauri.js"),
      "icon", manifest, "--output", output,
    ], { cwd: root, stdio: "inherit" });

    if (result.error) throw result.error;

    if (result.status !== 0) throw new Error(`Icon generation failed (${result.status})`);

    for (const name of desktopIcons) {
      copyIfChanged(join(output, name), join(root, "clients/desktop/icons", name));
    }

    for (const density of densities) {
      for (const name of androidIcons) {
        const relative = join(`mipmap-${density}`, name);
        copyIfChanged(join(output, "android", relative), join(resources, relative));
      }
    }

    copyIfChanged(join(output, "128x128@2x.png"), join(resources, "drawable/piop_icon.png"));
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
