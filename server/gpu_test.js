/**
 * VRAM ON AMD AND INTEL, WITHOUT TOUCHING WHAT DECIDES A RENDER.
 *
 * server/gpu.js now reads memory in use and load on any card: Windows' own GPU
 * counters through server/gpu-win.ps1, amdgpu's sysfs files on Linux. These
 * pin the pieces that can be checked without a card, and the promise that
 * matters most: the free-VRAM gates that refuse to start a render still read
 * nvidia-smi only, so a machine that renders today renders tomorrow.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pickAdapter, fromAdapters, fromSmiOutput, readAmdSysfs, readIntelSysfs } from "./gpu.js";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const IGPU = { name: "AMD Radeon(TM) Graphics", vendor: "amd", totalMb: 512, usedMb: 300, utilPct: 3, luid: "0x0_0x1" };
const DGPU = { name: "AMD Radeon RX 9060 XT", vendor: "amd", totalMb: 16188, usedMb: 2413, utilPct: 12, luid: "0x0_0x2" };
const ARC = { name: "Intel(R) Arc(TM) A770 Graphics", vendor: "intel", totalMb: 16032, usedMb: 900, utilPct: 0, luid: "0x0_0x3" };

test("the card Studio renders on: the one named, else the most dedicated memory", () => {
  assert.equal(pickAdapter([IGPU, DGPU]).name, DGPU.name, "a discrete card beats the integrated one");
  assert.equal(pickAdapter([DGPU, ARC], "Intel(R) Arc(TM) A770 Graphics").name, ARC.name, "the engine's own name wins");
  assert.equal(pickAdapter([IGPU, DGPU], "Radeon RX 9060 XT").name, DGPU.name, "a torch-style name without the vendor still matches");
  assert.equal(pickAdapter([{ name: "x", totalMb: 0 }]), null, "no dedicated memory is not a card");
  assert.equal(pickAdapter([]), null);
});

test("a helper reading becomes the same row nvidia-smi gives, and an unreadable number stays null", () => {
  const now = 1_000_000;
  const row = fromAdapters({ at: now - 1000, adapters: [IGPU, DGPU] }, "", now);
  assert.deepEqual({ name: row.name, totalMb: row.totalMb, usedMb: row.usedMb, utilPct: row.utilPct, vendor: row.vendor },
    { name: DGPU.name, totalMb: 16188, usedMb: 2413, utilPct: 12, vendor: "amd" });
  assert.equal(row.source, "Windows GPU counters");
  assert.match(row.note, /reads high/, "the same caveat as nvidia-smi's reading");
  const blind = fromAdapters({ at: now, adapters: [{ ...DGPU, usedMb: -1, utilPct: -1 }] }, "", now);
  assert.equal(blind.usedMb, null, "-1 from the helper is 'cannot read', never '0 used'");
  assert.equal(blind.utilPct, null);
  assert.equal(fromAdapters({ at: now - 11_000, adapters: [DGPU] }, "", now), null, "a helper that stopped talking is not a reading");
  assert.equal(fromAdapters(null), null);
});

test("amdgpu on Linux: the numbers in its own files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiplay-sysfs-"));
  try {
    const card = async (n, files) => {
      const dev = path.join(root, n, "device");
      await mkdir(dev, { recursive: true });
      for (const [f, v] of Object.entries(files)) await writeFile(path.join(dev, f), `${v}\n`);
    };
    await card("card0", { mem_info_vram_total: 512 * 1048576, mem_info_vram_used: 100 * 1048576 });
    await card("card1", { mem_info_vram_total: 16 * 1024 * 1048576, mem_info_vram_used: 3 * 1024 * 1048576, gpu_busy_percent: 41 });
    await mkdir(path.join(root, "card1-DP-1"), { recursive: true });   // a connector, not a card
    const r = readAmdSysfs(root, "AMD Radeon RX 7900 XTX");
    assert.deepEqual({ name: r.name, totalMb: r.totalMb, usedMb: r.usedMb, utilPct: r.utilPct, vendor: r.vendor },
      { name: "AMD Radeon RX 7900 XTX", totalMb: 16384, usedMb: 3072, utilPct: 41, vendor: "amd" });
    assert.equal(r.source, "amdgpu (sysfs)");
    await writeFile(path.join(root, "card1", "device", "product_name"), "AMD Radeon RX 9070 XT\n");
    assert.equal(readAmdSysfs(root).name, "AMD Radeon RX 9070 XT", "reads product_name from sysfs when no name is supplied");
    assert.equal(readAmdSysfs(path.join(root, "missing")), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("intel drm (i915 / xe) on Linux: local memory and busy percentage from sysfs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiplay-intel-sysfs-"));
  try {
    const dev = path.join(root, "card0", "device");
    await mkdir(path.join(dev, "tile0", "gt0"), { recursive: true });
    await writeFile(path.join(dev, "vendor"), "0x8086\n");
    await writeFile(path.join(dev, "product_name"), "Intel(R) Arc(TM) A770 Graphics\n");
    await writeFile(path.join(dev, "tile0", "lmem_total_bytes"), `${16 * 1024 * 1048576}\n`);
    await writeFile(path.join(dev, "tile0", "lmem_avail_bytes"), `${14 * 1024 * 1048576}\n`);
    await writeFile(path.join(dev, "tile0", "gt0", "gt_busy_percent"), "27\n");
    const r = readIntelSysfs(root);
    assert.deepEqual({ name: r.name, totalMb: r.totalMb, usedMb: r.usedMb, utilPct: r.utilPct, vendor: r.vendor },
      { name: "Intel(R) Arc(TM) A770 Graphics", totalMb: 16384, usedMb: 2048, utilPct: 27, vendor: "intel" });
    assert.equal(r.source, "intel drm (sysfs)");
    assert.equal(readIntelSysfs(path.join(root, "missing")), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("multi-GPU nvidia-smi output picks the largest VRAM card or named adapter", () => {
  const smi = "NVIDIA GeForce RTX 3070, 8192, 6339, 0\nNVIDIA GeForce RTX 5070, 12227, 454, 97\n";
  const picked = fromSmiOutput(smi);
  assert.deepEqual(
    { name: picked.name, totalMb: picked.totalMb, usedMb: picked.usedMb, utilPct: picked.utilPct, vendor: picked.vendor },
    { name: "NVIDIA GeForce RTX 5070", totalMb: 12227, usedMb: 454, utilPct: 97, vendor: "nvidia" },
  );
  const named = fromSmiOutput(smi, "RTX 3070");
  assert.equal(named.name, "NVIDIA GeForce RTX 3070");
});

test("the gates that refuse a render still read nvidia-smi only", () => {
  /* YuE2's floor, the 3D runner and native GGUF's settle all go through this
   * one function; on AMD it has always answered null ("nothing to wait for"). */
  const runner = src("./mesh/runner.js");
  const fn = runner.match(/export function freeVramMb\([\s\S]*?\n\}/)[0];
  assert.match(fn, /spawn\("nvidia-smi"/);
  assert.doesNotMatch(fn, /gpu-win|gpuStatus|sysfs/);
  for (const f of ["./music/yue.js", "./mesh/runner.js", "./jobs.js"]) {
    assert.doesNotMatch(src(f), /^import[^\n]*gpu\.js"|gpuStatus\(/m, `${f} decides nothing from the display reading`);
  }
});

test("the Windows helper: one category read per tick, never alive in a test, never keeping Studio alive", () => {
  const ps = src("./gpu-win.ps1");
  const cs = ps.slice(ps.indexOf('Add-Type -TypeDefinition @"'), ps.indexOf('\n"@'));
  assert.doesNotMatch(cs, /`/, "a backtick in PowerShell's here-string is an escape: it broke the C# once");
  assert.match(cs, /engineCat\.ReadCategory\(\)\["Utilization Percentage"\]/, "one read of GPU Engine per tick (was ~80 ms CPU/s per counter)");
  assert.match(cs, /CounterSample\.Calculate\(before, d\.Sample\)/);
  assert.match(cs, /\(d\.Flags & 2\) != 0 \|\| d\.VendorId == 0x1414/, "the software rasteriser is not a card");
  const gpu = src("./gpu.js");
  assert.match(ps, /\$ParentPid -gt 0 -and -not \(Get-Process -Id \$ParentPid/, "it exits once Studio is gone");
  assert.match(gpu, /"-ParentPid", String\(process\.pid\)/);
  assert.match(gpu, /!process\.env\.NODE_TEST_CONTEXT/);
  assert.match(gpu, /proc\.unref\(\);\n\s+proc\.stdout\.unref\?\.\(\);/);
  assert.match(gpu, /helperStarts >= 3/, "a helper that keeps dying is not restarted forever");
  assert.match(gpu, /if \(smiMissing\) return Promise\.resolve\(noSmi\(\)\);/, "a missing nvidia-smi is not spawned every 3 s");
});

test("the meter says 'not readable' instead of drawing an idle card", () => {
  const app = src("../web/app.js");
  assert.match(app, /const known = Number\.isFinite\(g\.usedMb\) && g\.totalMb > 0;/);
  assert.match(app, /GB VRAM · use not readable/);
  assert.doesNotMatch(app, /\$\{g\.utilPct\}% busy\\n\$\{g\.note\}/, "no 'null% busy'");
  assert.match(src("./fit.js"), /usedGb: Number\.isFinite\(gpu\.usedMb\) \? exactGb\(gpu\.usedMb\) : null/);
});
