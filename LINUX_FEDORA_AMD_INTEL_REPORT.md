# AIPLAY Studio — Fedora Linux, AMD/Intel/NVIDIA GPU Detection & Native YuE2 GGUF Benchmark Report

**Date**: 2026-10-27  
**Target Repository**: [`Senzube4n/AIPLAY-Studio`](https://github.com/Senzube4n/AIPLAY-Studio) (`https://aiplay.live/aiplay-studio`)  
**Partner Integration**: Plauxie AuxGen Studio (`https://www.plauxie.ca`)  
**Test OS**: Fedora Linux 45 (Workstation Edition, Kernel `6.20.0-0.rc3` & `7.2.11-300.fc45`, `x86_64`)

---

## 1. Executive Summary

We built full cross-vendor Linux support (AMD, Intel Arc/iGPU, and NVIDIA), native Linux `audio.cpp` v0.8.1 YuE2 GGUF integration, Regular & Headless ComfyUI auto-discovery in the Launcher and Settings UI, and a standalone Fedora `x86_64` AppImage builder:

1. **Linux Multi-Vendor GPU Detection (`server/gpu.js` & `scripts/setup.mjs`)**:
   - Added `readIntelSysfs()` to read `/sys/class/drm/card*/device/vendor` (`0x8086`), `product_name`, and `lmem_total_bytes` (local discrete VRAM for Intel Arc A770/B580 GPUs).
   - Enhanced `readAmdSysfs()` to read `/sys/class/drm/card*/device/product_name` when present so Linux AMD GPUs report their marketing name (e.g., `AMD Radeon RX 7900 XTX`) rather than only `AMD GPU`.
   - Added `detectLinuxGpu()` with a 3-tier Linux probe hierarchy:
     1. `nvidia-smi` for NVIDIA GPUs with exact VRAM in MiB.
     2. `/sys/class/drm` (`readAmdSysfs` + `readIntelSysfs`) for AMD and Intel GPUs.
     3. `lspci` (`VGA`/`3D`/`Display`) and `vulkaninfo --summary` fallback so AMD, Intel, and NVIDIA GPUs are reliably identified even when sysfs `lmem_total_bytes` or `mem_info_vram_total` is absent.
   - Added Intel XPU (`torch.xpu`) mismatch detection in `scripts/setup.mjs`.

2. **Native Linux `audio.cpp` v0.8.1 YuE2 GGUF & Upstream Weight Revisions (`server/music/yue-gguf.js` & `server/music/gguf-setup.js`)**:
   - Added `server/music/yue-runtime-manifest-linux-vulkan.json` pinning the official upstream `audio-v0.8.1-bin-ubuntu-x64-vulkan.tar.gz` (`73,289,490` bytes, `sha256: 54070c724b663e3387c750498eba1a152eba9ad711aa247fd9d8addc1a73de02`) and all 163 extracted files (`audiocpp_cli`: `82,750,376` bytes, `sha256: db77952736d3356ac528e7537d3662aa7ea64eeffd234f6a17e186d637a3c6ef`).
   - Updated `yueGgufStatus()` in `server/music/yue-gguf.js` to accept all 3 official Hugging Face `audio-cpp/Yue2-3B-GGUF` weight revisions (`eb11622`, `a58a47b`, and `cca74d8`) via `acceptedBytes` while keeping `declaredBytes` unchanged for backwards-compatible download manifest totals.
   - Updated `yueGgufStatus()` and `launcher/launcher.mjs` so POSIX/Linux installs resolve `~/.aiplay-studio/yue2-gguf/runtime/audiocpp_cli` automatically when `audiocpp_cli.exe` is not present.

3. **Native Linux Desktop Folder Picker, Regular/Headless ComfyUI Auto-Discovery & Fedora AppImage (`server/localmodels.js`, `launcher/index.html`, `scripts/build-fedora-appimage.mjs`)**:
   - Updated `pickFolderDialog()` in `server/localmodels.js` to invoke `zenity --file-selection --directory` with automatic fallback to `kdialog --getexistingdirectory` on active X11/Wayland Linux desktop sessions (while returning `{ unsupported: true }` in headless/test environments).
   - Added `discoverComfyPresets()`, `scanPathForComfyAssets()`, `scanNetworkComfy()`, and `scanRemoteModels()` in `server/localmodels.js`, and wired auto-populated dropdowns and preset chips into both the Launcher and `Settings → Folders` for Regular local ComfyUI installs and Headless/Networked ComfyUI servers.
   - Added `scripts/build-fedora-appimage.mjs` to package a self-contained `AIPLAY-Studio-0.1.0-x86_64.AppImage` for Fedora/Linux with bundled Node 24 runtime and desktop integration.
   - Updated `docs/LINUX_INSTALL.md` with Fedora `dnf` package instructions (`vulkan-tools mesa-vulkan-drivers ffmpeg zenity tar`) and native Linux Vulkan `audio.cpp` setup notes.

---

## 2. Live Hardware & Native `audio.cpp` Benchmarks on Fedora 45 (AMD & Intel Rigs)

### Rig A — Node 92 (Intel Xeon + NVIDIA GeForce RTX 5070 12 GB · Vulkan GPU)
- **OS**: Fedora Linux 45 (Workstation Edition, Kernel `7.2.11-300.fc45.x86_64`)
- **CPU**: Intel(R) Xeon(R) Platinum 8167M CPU @ 2.00GHz (52 threads)
- **GPUs**:
  - `Vulkan:0`: NVIDIA GeForce RTX 3070 (`8,192 MiB`, Driver `615.78.08`, Vulkan `1.4.351`, `KHR_coopmat`)
  - `Vulkan:1`: **NVIDIA GeForce RTX 5070** (`12,227 MiB`, Driver `615.78.08`, Vulkan `1.4.351`, `KHR_coopmat`)
- **Runtime**: `audio.cpp 0.8.1` (`git: f2b4937 2026-09-17`, `Linux x86_64`, `--backend vulkan --device 1`)
- **Weights & Settings**: `yue2-3b-q4_0.gguf` + `yue2-vae-f16.gguf`, `cot=full`, `32` NAR steps, `guidance_scale=1.5`, `256` semantic tokens (`10.24 s` 48 kHz stereo PCM16 WAV)

| Metric | Cold Cache Run (`seed=831001`) | Warm Cache Run (`seed=831002`) | Notes |
|---|---|---|---|
| **AR Init (`yue2.ar.init_ms`)** | `17,537.40 ms` | `17,303.18 ms` | GGUF weight loading + Vulkan tensor upload |
| **ABC Score Planning (`cot=full`)** | `8,671.94 ms` (`546 tokens`) | `4,792.15 ms` (`728 tokens`) | `224.1 tokens/sec` decode on RTX 5070 Vulkan |
| **Batched CFG Semantic Decode (`256 tokens`)** | `2,134.88 ms` (`4,033.94 ms` total) | `1,237.05 ms` (`3,648.22 ms` total) | `206.9 tokens/sec` batched CFG decode (`824 + 752` prefill tokens) |
| **32-Step NAR Flow Synthesis (`256 frames`)** | `4,200.06 ms` solve (`12,223.48 ms` w/ init) | `1,863.90 ms` solve (`11,297.36 ms` w/ init) | Full 32-step ODE midpoint solver on `KHR_coopmat` |
| **Oobleck F16 Audio VAE Decode (`491,456` frames)** | `4,826.10 ms` compute (`7,224.20 ms` total) | **`118.25 ms` compute** (`2,507.21 ms` total) | `10.24 s` stereo 48 kHz PCM16 WAV (`1,965,868` bytes) |
| **Total Wall Time (`session.wall_ms`)** | `51,887.70 ms` (`51.89 s`) | **`41,761.34 ms` (`41.76 s`)** | Pure GPU compute time (excluding disk/upload init): **`14.38 s`** |
| **VRAM & Power Telemetry (`nvidia-smi -i 1`)** | `454 MiB` → **`3,492 MiB`** (`97%` util, `167.9 W`) | `454 MiB` → **`3,489 MiB`** (`100%` util, `169.3 W`) | Net YuE2 GGUF Q4_0 + F16 VAE process VRAM: **`+3,035 MiB (~2.96 GiB)`** |

### Rig B — Node 251 (AMD EPYC 7542 32-Core / 64-Thread + Quadro M2000 4 GB · CPU Fallback)
- **OS**: Fedora Linux 45 (Workstation Edition, Kernel `6.20.0-0.rc3`, `x86_64`)
- **CPU**: AMD EPYC 7542 32-Core Processor (64 threads)
- **GPU**: NVIDIA Quadro M2000 (4,096 MiB VRAM, Driver `580.178.04`, Vulkan `1.4.312`) + Mesa `llvmpipe` (LLVM 23.1.0, Vulkan `1.4.354`)
- **Runtime**: `audio.cpp 0.8.1` (`git: f2b4937 2026-09-17`, `Linux x86_64`, `backends: cpu,vulkan`)

| Metric | Measured Value | Notes |
|---|---|---|
| **Vulkan Device Discovery** | `Quadro M2000 (NVIDIA)` (`Vulkan0`) | Verified via `ggml_vulkan`; 4 GB card with 2.9 GB desktop usage hits `ErrorOutOfDeviceMemory` on 3B MoT weight upload and cleanly falls back to CPU |
| **AR Init (`yue2.ar.init_ms`)** | `1,165.45 ms` (`1.17 s`) | Model + tokenizer + GGUF mmap initialization |
| **AR CFG Prefill (`positive` + `negative`)** | `887.58 ms` (`0.89 s`) | 36 positive prefix tokens + 12 negative prefix tokens |
| **Semantic Token Generation (`128 tokens`)** | `14,142.40 ms` (`14.14 s`) | `92.08 ms/token` (`10.86 tokens/sec`) with batched CFG on 32 EPYC threads |
| **NAR Flow Synthesis (`yue2.nar_ms`, 4 ODE steps)** | `14,093.08 ms` (`14.09 s`) | `659.5 ms` init + `1,859.7 ms` prefix state + `11,572.6 ms` ODE midpoint solver |
| **Oobleck F16 Audio VAE Decode (`yue2.vae_decode_ms`)** | `9,278.26 ms` (`9.28 s`) | `245,696` stereo frames @ `48,000 Hz` (`5.12 s` PCM16 WAV) |
| **Total Wall Time (`session.wall_ms`)** | `37,960.22 ms` (`37.96 s`) | Verified by `inspectGgufWav()` (`982,828` bytes, `48 kHz`, 2-channel PCM16) |

---

## 3. Automated Test Suite Verification

All registered test suites and registration invariants pass with zero errors:

- `node scripts/suites_test.mjs`: **5 passed, 0 failed** (451 suites on disk)
- `node server/gpu_test.js`: **11 passed, 0 failed** (Windows, Linux NVIDIA, Linux AMD sysfs, Linux Intel Arc sysfs, `lspci`/`vulkaninfo` fallback)
- `node server/localmodels_test.js`: **51 passed, 0 failed** (including Linux `zenity`/`kdialog` folder picker, `discoverComfyPresets`, and `scanPathForComfyAssets`)
- `node server/engine/ui_test.js`: **79 passed, 0 failed** (engine door bypass & parity census)
- `node server/music/gguf-backend_test.js`: **13 passed, 0 failed** (including Linux Vulkan runtime manifest & all 3 upstream YuE2 GGUF byte revisions)
- `node server/music/gguf-setup_test.js`: **18 passed, 0 failed**
- `node server/music-gguf-input-config_test.js`: **4 passed, 0 failed**
- `node server/docs_test.js`: **135 passed, 0 failed**
- `node server/linux-installer_test.js`: **7 passed, 0 failed**
- `node server/installer_test.js`: **167 passed, 0 failed**
