import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const source = join(root, "public/icon.png");

if (process.argv[2]) copyFileSync(process.argv[2], source);

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

  for (const name of ["32x32.png", "128x128.png", "128x128@2x.png", "icon.icns", "icon.ico"]) {
    copyFileSync(join(output, name), join(root, "src-tauri/icons", name));
  }

  const resources = join(root, "android/app/src/main/res");

  for (const density of ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]) {
    for (const name of ["ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png"]) {
      const relative = join(`mipmap-${density}`, name);
      copyFileSync(join(output, "android", relative), join(resources, relative));
    }
  }

  copyFileSync(join(output, "128x128@2x.png"), join(resources, "drawable/piop_icon.png"));
} finally {
  rmSync(output, { recursive: true, force: true });
}
