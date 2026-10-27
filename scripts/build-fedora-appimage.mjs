/**
 * Build a standalone Fedora / Linux x86_64 AppImage for AIPLAY Studio.
 *
 * Bundles:
 *   1. Official SHA-256 verified Node.js Linux x64 runtime (from installer/linux/runtime.json)
 *   2. Complete verified AIPLAY Studio application payload + production node_modules
 *   3. AppRun entrypoint supporting:
 *      - Default GUI Launcher (Full Studio, Music Only, Comfy Cloud API, RunPod GPU API)
 *      - Direct API / mode flags: --cloud / --api, --runpod / --remote, --music, --studio / --full
 *      - Built-in --smoke-test for headless AppImage + API connectivity verification
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, stat, rm, cp, copyFile, chmod, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stageInstallPayload } from "./package.mjs";
import { validateRuntimePins, downloadVerified, verifyChecksumListing, validateRuntimeListing } from "./build-linux-installer.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "dist", "linux");
const CACHE_DIR = path.join(OUT_DIR, ".cache");
const APPIMAGE_TOOL_URL = "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage";
const APPIMAGE_RUNTIME_URL = "https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function ensureAppImageTool() {
  await mkdir(CACHE_DIR, { recursive: true });
  const toolPath = path.join(CACHE_DIR, "appimagetool-x86_64.AppImage");
  if (!existsSync(toolPath)) {
    console.log("  Downloading official appimagetool-x86_64.AppImage…");
    const res = await fetch(APPIMAGE_TOOL_URL, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`Failed to download appimagetool: HTTP ${res.status}`);
    await writeFile(toolPath, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
  }
  await chmod(toolPath, 0o755);
  const runtimePath = path.join(CACHE_DIR, "runtime-x86_64");
  if (!existsSync(runtimePath)) {
    console.log("  Downloading official AppImage type2 runtime-x86_64…");
    const res = await fetch(APPIMAGE_RUNTIME_URL, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`Failed to download runtime-x86_64: HTTP ${res.status}`);
    await writeFile(runtimePath, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
  }
  await chmod(runtimePath, 0o755);
  return { toolPath, runtimePath };
}

function createAppRunScript(version, commit) {
  return `#!/bin/sh
set -eu

# Ensure Fedora /usr/sbin (fusermount3, lspci, etc.) is on PATH
PATH="/usr/sbin:/sbin:$PATH"
export PATH

HERE="$(CDPATH= cd "$(dirname "$0")" && pwd -P)"
NODE_BIN="$HERE/usr/lib/aiplay-studio/runtime/bin/node"
PAYLOAD_DIR="$HERE/usr/lib/aiplay-studio/payload"
BUNDLE_STAMP="${version}-${commit.slice(0, 8)}-${Date.now()}"

if [ ! -x "$NODE_BIN" ] || [ ! -d "$PAYLOAD_DIR" ]; then
  printf '%s\\n' "AIPLAY Studio AppImage is incomplete (missing bundled runtime or payload)." >&2
  exit 1
fi

PATH="$HERE/usr/lib/aiplay-studio/runtime/bin:$PATH"
export PATH

DATA_ROOT="\${XDG_DATA_HOME:-\$HOME/.local/share}/aiplay-studio"
APP_DIR="\$DATA_ROOT/app"
STAMP_FILE="\$APP_DIR/.appimage-bundle-stamp"

mkdir -p "\$DATA_ROOT"

# Stage or update writable application tree when the AppImage bundle changes
CURRENT_STAMP=""
if [ -f "\$STAMP_FILE" ]; then
  CURRENT_STAMP="$(cat "\$STAMP_FILE" 2>/dev/null || true)"
fi

if [ "\$CURRENT_STAMP" != "\$BUNDLE_STAMP" ] || [ ! -f "\$APP_DIR/server/index.js" ]; then
  printf '%s\\n' "  [AIPLAY Studio AppImage] Syncing bundled Studio payload (\$BUNDLE_STAMP) to \$APP_DIR..."
  STAGE_DIR="\$DATA_ROOT/.stage-\$\$"
  rm -rf "\$STAGE_DIR"
  mkdir -p "\$STAGE_DIR"
  cp -a "\$PAYLOAD_DIR/." "\$STAGE_DIR/"
  chmod -R u+w "\$STAGE_DIR"
  # Preserve user custom workflows if present
  if [ -d "\$APP_DIR/workflows/custom" ]; then
    mkdir -p "\$STAGE_DIR/workflows"
    cp -a "\$APP_DIR/workflows/custom" "\$STAGE_DIR/workflows/"
  fi
  printf '%s\\n' "\$BUNDLE_STAMP" > "\$STAGE_DIR/.appimage-bundle-stamp"
  rm -rf "\$APP_DIR.prev"
  if [ -d "\$APP_DIR" ]; then
    mv "\$APP_DIR" "\$APP_DIR.prev"
  fi
  mv "\$STAGE_DIR" "\$APP_DIR"
  rm -rf "\$APP_DIR.prev"
fi

MODE="launcher"
while [ \$# -gt 0 ]; do
  case "\$1" in
    --help|-h)
      cat <<'EOF'
AIPLAY Studio — Standalone Fedora Linux AppImage

Usage:
  AIPLAY-Studio.AppImage [options] [mode]

Modes:
  (default)              Open the AIPLAY Studio Launcher (Full Studio, Music Only, Comfy Cloud API, RunPod GPU)
  --cloud, --api         Start directly in Comfy Cloud Router API mode (api.comfy.org, no local GPU required)
  --runpod               Start directly in RunPod Cloud GPU API mode (api.runpod.io)
  --music                Start directly in Native Music-Only mode (audio.cpp Vulkan/CPU + Hosted APIs)
  --full, --studio       Start directly in Full Studio mode (ComfyUI + Native GGUF + Hosted APIs)
  --smoke-test           Run self-contained AppImage & remote API connectivity check and exit

ComfyUI Source Options (Regular Local Folder or Headless Server):
  --headless=<url>       Connect to an external / headless ComfyUI server (e.g. --headless=http://127.0.0.1:8188 or --headless=http://192.168.x.x:8188)
  --comfy-dir=<path>     Point to a Regular local ComfyUI install folder (containing main.py or ComfyUI/main.py)
EOF
      exit 0
      ;;
    --headless=*)
      export AIPLAY_COMFY_URL="\${1#*=}"
      shift
      ;;
    --comfy-dir=*)
      export AIPLAY_RIG="\${1#*=}"
      shift
      ;;
    --cloud|--api)
      MODE="cloud"
      shift
      ;;
    --runpod|--remote)
      MODE="runpod"
      shift
      ;;
    --music)
      MODE="music"
      shift
      ;;
    --full|--studio)
      MODE="full"
      shift
      ;;
    --smoke-test)
      MODE="smoke"
      shift
      ;;
    *)
      break
      ;;
  esac
done

cd "\$APP_DIR"

if [ "\$MODE" = "smoke" ]; then
  exec "\$NODE_BIN" -e '
    const checks = [];
    const feedRes = await fetch("https://aiplay.live/_api/desktop/feed", { signal: AbortSignal.timeout(10000) });
    checks.push({ endpoint: "AIPLAY Community API (https://aiplay.live/_api/desktop/feed)", status: feedRes.status, ok: feedRes.ok });
    const { PROVIDERS } = await import("./server/apiEngine.js");
    checks.push({ endpoint: "Hosted API Engine Providers", providers: Object.keys(PROVIDERS), ok: Object.keys(PROVIDERS).length > 0 });
    const { yueGgufStatus } = await import("./server/music/yue-gguf.js");
    const gguf = await yueGgufStatus();
    checks.push({ endpoint: "Native YuE2 GGUF Engine", installed: gguf.installed, modelFile: gguf.modelFile, ok: true });
    console.log(JSON.stringify({ appimage: "ok", node: process.version, platform: process.platform, arch: process.arch, checks }, null, 2));
    if (!checks.every(c => c.ok)) process.exit(1);
  '
elif [ "\$MODE" = "cloud" ]; then
  export AIPLAY_OPEN="\${AIPLAY_OPEN:-1}"
  exec "\$NODE_BIN" "\$APP_DIR/scripts/start-cloud.mjs" "\$@"
elif [ "\$MODE" = "runpod" ]; then
  export AIPLAY_OPEN="\${AIPLAY_OPEN:-1}"
  exec "\$NODE_BIN" "\$APP_DIR/scripts/start-remote.mjs" "\$@"
elif [ "\$MODE" = "music" ]; then
  export AIPLAY_OPEN="\${AIPLAY_OPEN:-1}"
  exec "\$NODE_BIN" "\$APP_DIR/scripts/start-music.mjs" "\$@"
elif [ "\$MODE" = "full" ]; then
  export AIPLAY_OPEN="\${AIPLAY_OPEN:-1}"
  exec "\$NODE_BIN" "\$APP_DIR/server/index.js" "\$@"
else
  exec "\$NODE_BIN" "\$APP_DIR/launcher/launcher.mjs" "\$@"
fi
`;
}

async function main() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("This Fedora AppImage builder targets Linux x86_64.");
  }

  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const pins = validateRuntimePins(JSON.parse(await readFile(path.join(ROOT, "installer/linux/runtime.json"), "utf8")));
  const runtime = pins.architectures.x64;

  await mkdir(CACHE_DIR, { recursive: true });
  const checksumsFile = path.join(CACHE_DIR, `SHASUMS256-${pins.nodeVersion}.txt`);
  await downloadVerified(pins.checksums.url, checksumsFile, pins.checksums);
  verifyChecksumListing(await readFile(checksumsFile, "utf8"), runtime);

  const nodeArchive = path.join(CACHE_DIR, runtime.file);
  console.log(`  Verifying official Node.js v${pins.nodeVersion} Linux x64 runtime…`);
  await downloadVerified(runtime.url, nodeArchive, runtime);
  const topFolder = `node-v${pins.nodeVersion}-linux-x64`;
  validateRuntimeListing(execFileSync("tar", ["-tzf", nodeArchive]).toString("utf8"), topFolder);

  const { toolPath: appimageTool, runtimePath: appimageRuntime } = await ensureAppImageTool();

  const buildStage = path.join(os.tmpdir(), `aiplay-appimage-stage-${randomUUID()}`);
  const appDir = path.join(buildStage, "AIPLAY-Studio.AppDir");
  const usrLib = path.join(appDir, "usr/lib/aiplay-studio");
  const payloadDir = path.join(usrLib, "payload");
  const extractDir = path.join(buildStage, "extract");

  try {
    await mkdir(usrLib, { recursive: true });
    await mkdir(extractDir, { recursive: true });

    console.log("  Extracting Node.js runtime into AppDir…");
    execFileSync("tar", ["-xzf", nodeArchive, "--no-same-owner", "--no-same-permissions", "-C", extractDir]);
    await cp(path.join(extractDir, topFolder), path.join(usrLib, "runtime"), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
    await rm(path.join(usrLib, "runtime/include"), { recursive: true, force: true }).catch(() => {});
    await rm(path.join(usrLib, "runtime/share"), { recursive: true, force: true }).catch(() => {});
    await rm(path.join(usrLib, "runtime/lib/node_modules/npm"), { recursive: true, force: true }).catch(() => {});
    await rm(path.join(usrLib, "runtime/bin/npm"), { force: true }).catch(() => {});
    await rm(path.join(usrLib, "runtime/bin/npx"), { force: true }).catch(() => {});
    try {
      execFileSync("strip", ["--strip-unneeded", path.join(usrLib, "runtime/bin/node")]);
    } catch { /* strip optional */ }
    await chmod(path.join(usrLib, "runtime/bin/node"), 0o755);

    console.log("  Staging AIPLAY Studio application payload & dependencies…");
    await stageInstallPayload({ root: ROOT, stage: payloadDir, platform: "linux" });
    await cp(path.join(ROOT, "node_modules"), path.join(payloadDir, "node_modules"), {
      recursive: true,
      dereference: true,
    });
    // Trim redundant build/example artifacts in node_modules (three/examples, .map files) to keep AppImage < 50 MB for Git
    await rm(path.join(payloadDir, "node_modules/three/examples"), { recursive: true, force: true }).catch(() => {});
    await rm(path.join(payloadDir, "node_modules/three/src"), { recursive: true, force: true }).catch(() => {});
    await rm(path.join(payloadDir, "node_modules/ag-psd/dist/bundle.js"), { force: true }).catch(() => {});

    let commit = "local";
    try {
      commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    } catch { /* fallback */ }

    const appRunPath = path.join(appDir, "AppRun");
    await writeFile(appRunPath, createAppRunScript(pkg.version, commit), { mode: 0o755 });
    await chmod(appRunPath, 0o755);

    const desktopContent = `[Desktop Entry]
Type=Application
Name=AIPLAY Studio
GenericName=AI Music, Video & Creative Studio
Comment=Local & Cloud AI Studio (YuE2 GGUF, Comfy Cloud API, RunPod GPU, fal.ai)
Exec=AppRun
Icon=aiplay-studio
Terminal=false
Categories=AudioVideo;
StartupNotify=true
`;
    await writeFile(path.join(appDir, "aiplay-studio.desktop"), desktopContent, { mode: 0o644 });
    await mkdir(path.join(appDir, "usr/share/applications"), { recursive: true });
    await writeFile(path.join(appDir, "usr/share/applications/aiplay-studio.desktop"), desktopContent, { mode: 0o644 });

    const iconSrc = path.join(ROOT, "web/assets/aiplay-logo.svg");
    await copyFile(iconSrc, path.join(appDir, "aiplay-studio.svg"));
    await symlink("aiplay-studio.svg", path.join(appDir, ".DirIcon"));
    await mkdir(path.join(appDir, "usr/share/icons/hicolor/scalable/apps"), { recursive: true });
    await copyFile(iconSrc, path.join(appDir, "usr/share/icons/hicolor/scalable/apps/aiplay-studio.svg"));

    await mkdir(path.join(appDir, "usr/share/metainfo"), { recursive: true });
    const appdataXml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>live.aiplay.studio</id>
  <metadata_license>CC0-1.0</metadata_license>
  <project_license>Apache-2.0</project_license>
  <name>AIPLAY Studio</name>
  <summary>Local and Cloud AI Music, Video, and Creative Studio</summary>
  <description>
    <p>Standalone Linux AppImage for AIPLAY Studio supporting native YuE2 GGUF Vulkan/CPU music synthesis, Comfy Cloud Router API, RunPod Cloud GPU, fal.ai, and local ComfyUI.</p>
  </description>
  <launchable type="desktop-id">aiplay-studio.desktop</launchable>
  <url type="homepage">https://aiplay.live/aiplay-studio</url>
</component>
`;
    await writeFile(path.join(appDir, "usr/share/metainfo/aiplay-studio.appdata.xml"), appdataXml, { mode: 0o644 });

    const outAppImage = path.join(OUT_DIR, `AIPLAY-Studio-${pkg.version}-x86_64.AppImage`);
    const stagedAppImage = path.join(buildStage, `AIPLAY-Studio-${pkg.version}-x86_64.AppImage`);
    console.log(`  Packing SquashFS AppImage → ${outAppImage}…`);
    execFileSync(appimageTool, ["--no-appstream", "--runtime-file", appimageRuntime, appDir, stagedAppImage], {
      env: { ...process.env, ARCH: "x86_64", PATH: `/usr/sbin:/sbin:${process.env.PATH}` },
      stdio: "inherit",
    });
    await chmod(stagedAppImage, 0o755);

    const replaceAppImage = async (dest) => {
      await mkdir(path.dirname(dest), { recursive: true });
      await rm(dest, { force: true }).catch(() => {});
      await copyFile(stagedAppImage, dest);
      await chmod(dest, 0o755);
    };

    await replaceAppImage(outAppImage);

    const appsDir = path.join(os.homedir(), "Applications");
    const userAppImage = path.join(appsDir, "AIPLAY-Studio.AppImage");
    await replaceAppImage(userAppImage);

    const appImagesDir = path.join(os.homedir(), "AppImages");
    if (existsSync(appImagesDir)) {
      await replaceAppImage(path.join(appImagesDir, "AIPLAY-Studio.AppImage"));
    }

    // Ensure ~/.local/bin has fusermount3/fusermount symlinks on Fedora where they live in /usr/sbin
    const localBinDir = path.join(os.homedir(), ".local/bin");
    await mkdir(localBinDir, { recursive: true });
    for (const fm of ["fusermount3", "fusermount"]) {
      const sbinPath = `/usr/sbin/${fm}`;
      const dstPath = path.join(localBinDir, fm);
      if (existsSync(sbinPath) && !existsSync(dstPath)) {
        await symlink(sbinPath, dstPath).catch(() => {});
      }
    }

    // Register Fedora desktop entry pointing to ~/Applications/AIPLAY-Studio.AppImage
    const localAppsDir = path.join(os.homedir(), ".local/share/applications");
    const localIconsDir = path.join(os.homedir(), ".local/share/icons/hicolor/scalable/apps");
    await mkdir(localAppsDir, { recursive: true });
    await mkdir(localIconsDir, { recursive: true });
    await copyFile(iconSrc, path.join(localIconsDir, "aiplay-studio.svg"));
    await writeFile(
      path.join(localAppsDir, "aiplay-studio.desktop"),
      desktopContent.replace("Exec=AppRun", `Exec=env PATH=/usr/sbin:/sbin:/usr/local/bin:/usr/bin:/bin ${userAppImage}`),
      { mode: 0o644 }
    );

    const fileBytes = await readFile(outAppImage);
    const statInfo = await stat(outAppImage);
    console.log(JSON.stringify({
      ok: true,
      appImage: outAppImage,
      installedAppImage: userAppImage,
      desktopEntry: path.join(localAppsDir, "aiplay-studio.desktop"),
      sizeBytes: statInfo.size,
      sizeMb: Number((statInfo.size / (1024 * 1024)).toFixed(2)),
      sha256: sha256(fileBytes),
      nodeRuntime: pins.nodeVersion,
    }, null, 2));
  } finally {
    await rm(buildStage, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error("AppImage build failed:", err.message);
  process.exit(1);
});
