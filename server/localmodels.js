/**
 * WEIGHTS THE USER ALREADY HAS, wherever they keep them.
 *
 * The catalogue in models.js knows exact file names and byte counts, which is
 * right for what Studio downloads and wrong for everything else: a models
 * folder on another drive, an fp16 build where the catalogue names int8, a
 * checkpoint nobody here has heard of. This module is the other half —
 *
 *   - scan the folders ComfyUI will actually load from, and say what is there;
 *   - write the extra_model_paths YAML that makes ComfyUI see a chosen folder;
 *   - let a local file STAND IN for a catalogue file (same model folder), and
 *     rename it in every graph at the engine door, before the ledger records
 *     the graph — so the record names the file that really rendered;
 *   - open a native folder picker, because a browser cannot hand over a path.
 *
 * Nothing here downloads, deletes or moves a file.
 */
import { readdir, stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { readdirSync, statSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

/** ComfyUI's model folder names, as listed in its own extra_model_paths
 *  example. Scanned in this order. */
export const MODEL_FOLDERS = [
  "checkpoints", "diffusion_models", "unet", "text_encoders", "clip", "vae", "loras",
  "clip_vision", "controlnet", "upscale_models", "audio_encoders", "embeddings",
  "latent_upscale_models", "model_patches", "style_models", "background_removal",
  "frame_interpolation", "conditioning_bridges",
];

/* Folders ComfyUI treats as one shelf: a loader reading `diffusion_models`
 * also lists `unet`, and `text_encoders` also lists `clip`. */
const ALIASES = [["diffusion_models", "unet"], ["text_encoders", "clip"]];
export const folderGroup = (folder) => ALIASES.find((g) => g.includes(folder)) || [folder];
export const shelfOf = (folder) => folderGroup(folder)[0];

/** Loader inputs name files relative to a shelf, never arbitrary disk paths. */
export const MODEL_INPUT_FOLDERS = {
  unet_name: ["diffusion_models", "unet"], ckpt_name: ["checkpoints"],
  clip_name: ["text_encoders", "clip"], vae_name: ["vae"], lora_name: ["loras"],
  clip_vision: ["clip_vision"], clip_vision_name: ["clip_vision"],
  control_net_name: ["controlnet"], style_model_name: ["style_models"],
  audio_encoder_name: ["audio_encoders"], bg_removal_name: ["background_removal"],
  adapter: ["conditioning_bridges"],
  upscale_model: ["latent_upscale_models"],
  model_name: ["upscale_models", "background_removal", "frame_interpolation", "latent_upscale_models"],
};

/** Accept either separator so selections survive Windows/Linux handoffs. */
export function modelName(value) {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f:*?"<>|]/.test(value)
      || /^[\\/]/.test(value)) return null;
  const parts = value.split(/[\\/]/);
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join(path.sep);
}
export function requireModelName(value) {
  const name = modelName(value);
  if (!name) {
    const error = new Error("Choose a model filename relative to its shelf, not an absolute or parent path.");
    error.status = 400;
    throw error;
  }
  return name;
}
export const modelLeaf = (value) => String(value || "").split(/[\\/]/).pop();
const nameKey = (value) => {
  const name = modelName(value);
  return process.platform === "win32" ? name?.toLowerCase() : name;
};

/** Exact relative paths win. A bare name may locate one nested path, but never
 * choose between different subfolders with the same filename. A loader cannot
 * distinguish the same relative name in multiple physical shelves either. */
export function findShelfModel(files, folder, name, { fallback = true } = {}) {
  const wanted = modelName(name);
  if (!wanted) return null;
  const folders = Array.isArray(folder) ? folder : folderGroup(folder);
  const candidates = files.filter((file) => folders.includes(file.folder));
  const distinct = (rows) => [...new Map(rows.map((file) => [
    file.base && file.bytes && file.at
      ? `${key(file.base)}:${shelfOf(file.folder)}:${nameKey(file.name)}:${file.bytes}:${file.at}`
      : (file.full ? key(file.full) : `${file.folder}/${nameKey(file.name)}`),
    file,
  ])).values()];
  const exacts = distinct(candidates.filter((file) => nameKey(file.name) === nameKey(wanted)));
  if (exacts.length > 1) {
    const distinctBases = new Set(exacts.map((f) => f.base && key(f.base)).filter(Boolean));
    if (exacts.every((f) => f.base) && distinctBases.size === exacts.length) return exacts[0];
    const error = new Error(`${wanted} exists in several configured model folders. Give each copy a distinct relative path or keep one copy.`);
    error.status = 400;
    throw error;
  }
  const exact = exacts[0];
  if (exact || !fallback || wanted !== modelLeaf(wanted)) return exact || null;
  const matches = distinct(candidates.filter((file) => nameKey(modelLeaf(file.name)) === nameKey(wanted)));
  if (matches.length > 1) {
    const distinctPaths = new Set(matches.map((f) => `${shelfOf(f.folder)}:${nameKey(f.name)}`));
    const distinctBases = new Set(matches.map((f) => f.base && key(f.base)).filter(Boolean));
    if (distinctPaths.size === 1 && matches.every((f) => f.base) && distinctBases.size === matches.length) return matches[0];
    const error = new Error(`More than one ${wanted} exists. Choose its subfolder in the model picker.`);
    error.status = 400;
    throw error;
  }
  return matches[0] || null;
}

const WEIGHT_RE = /\.(safetensors|sft|gguf|ckpt|pt|pth|bin)$/i;

const key = (p) => {
  let r = path.resolve(p);
  try { r = realpathSync(r); } catch { /* virtual or not on disk */ }
  return process.platform === "win32" ? r.toLowerCase() : r;
};
export const samePath = (a, b) => key(a) === key(b);

export function uniqueDirs(dirs) {
  const out = [];
  for (const d of dirs) if (d && !out.some((o) => samePath(o, d))) out.push(path.resolve(d));
  return out;
}

/** `base_path` of every --extra-model-paths-config YAML named in an argv. */
export async function extraBases(args = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--extra-model-paths-config" || !args[i + 1]) continue;
    try {
      const t = await readFile(args[i + 1], "utf-8");
      for (const m of t.matchAll(/^\s*base_path:\s*['"]?([^'"\r\n]+?)['"]?\s*$/gm)) out.push(m[1].trim());
    } catch { /* an unreadable YAML is ComfyUI's to report, in its own log */ }
  }
  return out;
}

/** extraBases, read synchronously: for config.js's picks and workflow.js
 *  videoReady(), which run where nothing can wait (an import, a status poll). */
export function extraBasesSync(args = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--extra-model-paths-config" || !args[i + 1]) continue;
    try {
      const t = readFileSync(args[i + 1], "utf-8");
      for (const m of t.matchAll(/^\s*base_path:\s*['"]?([^'"\r\n]+?)['"]?\s*$/gm)) out.push(m[1].trim());
    } catch { /* an unreadable YAML is ComfyUI's to report, in its own log */ }
  }
  return out;
}

/**
 * EVERY FOLDER THE ENGINE LOADS WEIGHTS FROM, one answer for every reader
 * (setF on 7b241ea): the models folder, the extra ones (modelsAlso), the
 * base_path of each extra_model_paths YAML the engine is launched with, and
 * the install's own ComfyUI/models. The Models screen (models.js), the engine
 * door (engine/client.js) and the Models-screen scan (index.js modelBases)
 * read all four; config.js's file picks and workflow.js videoReady() read only
 * the first two, so a pinned models folder with H3 in the rig's own
 * ComfyUI/models read "installed" on the Models screen and was refused with
 * "Get MiniMax H3 (0.0 GB)" on the Video screen, after a restart too.
 * `cfg` is config's shape: { modelsDir, modelsAlso, comfyDir, comfy: { extraArgs } }.
 */
const basesOf = (cfg, extra) => uniqueDirs([cfg?.modelsDir, ...(cfg?.modelsAlso || []), ...extra,
  cfg?.comfyDir ? path.join(cfg.comfyDir, "models") : null].filter(Boolean));
export const engineBasesSync = (cfg) => basesOf(cfg, extraBasesSync(cfg?.comfy?.extraArgs || []));
export const engineBases = async (cfg) => basesOf(cfg, await extraBases(cfg?.comfy?.extraArgs || []));

/**
 * Every weight file under each standard folder of each base. `name` is the
 * native relative loader path, e.g. minimax\\model.safetensors on Windows.
 * Directory links below a shelf are skipped to avoid cycles; a chosen base
 * or shelf can itself be a linked directory. Empty/partial files are skipped.
 */
const TMP_PREFIX = path.resolve(os.tmpdir()) + path.sep;
const baseScanCache = new Map();

export async function scanBases(bases) {
  const files = [], seenShelfRoots = new Set(), seenAcrossBases = new Set(), now = Date.now();
  const pushBase = (baseFiles) => {
    for (const f of baseFiles) {
      if (!seenAcrossBases.has(`${f.shelf}:${nameKey(f.name)}`)) files.push(f);
    }
    for (const f of baseFiles) seenAcrossBases.add(`${f.shelf}:${nameKey(f.name)}`);
  };
  for (const base of uniqueDirs(bases)) {
    const isTmp = base.startsWith(TMP_PREFIX);
    if (!isTmp) {
      const hit = baseScanCache.get(base);
      if (hit && now - hit.at < 5000) { pushBase(hit.files); continue; }
    }
    const baseFiles = [];
    for (const folder of MODEL_FOLDERS) {
      const root = path.join(base, folder), shelfKey = `${shelfOf(folder)}:${key(root)}`;
      if (seenShelfRoots.has(shelfKey)) continue;
      seenShelfRoots.add(shelfKey);
      const pending = [root];
      while (pending.length) {
        const dir = pending.shift();
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { pending.push(full); continue; }
          if (!e.isFile() || !WEIGHT_RE.test(e.name)) continue;
          const st = await stat(full).catch(() => null);
          if (!st?.isFile() || st.size === 0) continue;
          baseFiles.push({ base, folder, shelf: shelfOf(folder), name: path.relative(root, full), full, bytes: st.size, at: st.mtimeMs });
        }
      }
    }
    if (!isTmp) baseScanCache.set(base, { at: Date.now(), files: baseFiles });
    pushBase(baseFiles);
  }
  return files;
}

/** Startup/default selection and synchronous readiness share the same shelf
 * rules. No weight bytes are read. Callers reuse a snapshot when checking
 * several slots rather than rescanning it per candidate. */
export function scanBasesSync(bases) {
  const files = [], seenShelfRoots = new Set(), seenAcrossBases = new Set(), now = Date.now();
  const pushBase = (baseFiles) => {
    for (const f of baseFiles) {
      if (!seenAcrossBases.has(`${f.shelf}:${nameKey(f.name)}`)) files.push(f);
    }
    for (const f of baseFiles) seenAcrossBases.add(`${f.shelf}:${nameKey(f.name)}`);
  };
  for (const base of uniqueDirs(bases)) {
    const isTmp = base.startsWith(TMP_PREFIX);
    if (!isTmp) {
      const hit = baseScanCache.get(base);
      if (hit && now - hit.at < 5000) { pushBase(hit.files); continue; }
    }
    const baseFiles = [];
    for (const folder of MODEL_FOLDERS) {
      const root = path.join(base, folder), shelfKey = `${shelfOf(folder)}:${key(root)}`;
      if (seenShelfRoots.has(shelfKey)) continue;
      seenShelfRoots.add(shelfKey);
      const pending = [root];
      while (pending.length) {
        const dir = pending.shift();
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { pending.push(full); continue; }
          if (!e.isFile() || !WEIGHT_RE.test(e.name)) continue;
          let st;
          try { st = statSync(full); } catch { continue; }
          if (!st.isFile() || st.size === 0) continue;
          baseFiles.push({ base, folder, shelf: shelfOf(folder), name: path.relative(root, full), full, bytes: st.size, at: st.mtimeMs });
        }
      }
    }
    if (!isTmp) baseScanCache.set(base, { at: Date.now(), files: baseFiles });
    pushBase(baseFiles);
  }
  return files;
}

/** Rewrite only model-bearing loader inputs before hashing/submission. Prompts,
 * media inputs and output prefixes are never searched or changed. */
export function resolveGraphModels(graph, files) {
  if (!graph || typeof graph !== "object") return graph;
  let changed = false;
  const out = {};
  for (const [id, node] of Object.entries(graph)) {
    let next = null;
    for (const [input, value] of Object.entries(node?.inputs || {})) {
      // `adapter` is shelf-specific only on Studio's conditioning-bridge node.
      if (input === "adapter" && node.class_type !== "AiplayH3ConditioningBridge") continue;
      const folders = MODEL_INPUT_FOLDERS[input.replace(/\d+$/, "")];
      if (!folders || typeof value !== "string") continue;
      const found = findShelfModel(files, folders, value);
      if (found && found.name !== value) (next ||= { ...node.inputs })[input] = found.name;
    }
    out[id] = next ? { ...node, inputs: next } : node;
    if (next) changed = true;
  }
  return changed ? out : graph;
}

/** { folder: { files, bytes } } — the preview shown before a folder is adopted. */
export function countByFolder(files) {
  const out = {};
  for (const f of files) {
    const c = (out[f.folder] ||= { files: 0, bytes: 0 });
    c.files++; c.bytes += f.bytes;
  }
  return out;
}

/** Writes the YAML that makes ComfyUI load from `dir`, and returns its path. */
export async function writeModelPathsYaml(dir, appData, also = []) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  /* `also`: earlier models folders, still loaded from so a change of folder
   * never strands what was already downloaded (config.modelsAlso). */
  const block = (name, base, isDefault) => [
    `${name}:`,
    `  base_path: ${q(base)}`,
    ...(isDefault ? ["  is_default: true"] : []),
    ...MODEL_FOLDERS.map((f) => `  ${f}: ${f}/`),
  ];
  const body = [
    "# Written by AIPLAY Studio at every engine start — the models folder chosen",
    "# on the Models screen. Edits here are overwritten; change the folder there.",
    ...block("aiplay_models", dir, true),
    ...also.flatMap((d, i) => block(`aiplay_models_also_${i + 1}`, d, false)),
    "",
  ].join("\n");
  await mkdir(appData, { recursive: true });
  const file = path.join(appData, "extra_model_paths.aiplay.yaml");
  await writeFile(file, body, "utf-8");
  return file;
}

/**
 * A graph with every loader input naming an overridden catalogue file renamed
 * to its local stand-in. Only inputs that ARE file names — ComfyUI's loaders
 * call them unet_name, ckpt_name, clip_name2, lora_name … — and only exact
 * whole-string matches, so a prompt is never touched even if its whole text is
 * a file name. Returns the SAME object when nothing matched, so a graph without
 * overrides is hashed exactly as before.
 */
const FILE_INPUT = /(^|_)name\d*$/;
export function applyModelOverrides(graph, overrides) {
  if (!graph || typeof graph !== "object" || !overrides) return graph;
  const names = Object.keys(overrides).filter((k) => overrides[k]);
  if (!names.length) return graph;
  let changed = false;
  const out = {};
  for (const [id, node] of Object.entries(graph)) {
    const inputs = node?.inputs;
    let next = null;
    if (inputs && typeof inputs === "object") {
      for (const [k, v] of Object.entries(inputs)) {
        const modelInput = FILE_INPUT.test(k) || (node.class_type === "AiplayH3ConditioningBridge" && k === "adapter");
        if (typeof v === "string" && modelInput && names.includes(v)) (next ||= { ...inputs })[k] = overrides[v];
      }
    }
    if (next) { changed = true; out[id] = { ...node, inputs: next }; } else out[id] = node;
  }
  return changed ? out : graph;
}

/**
 * The OS folder picker, on the machine Studio runs on — which is the machine
 * the browser is on, since Studio only listens on loopback.
 * Resolves { path } (null when cancelled), { unsupported } off Windows, or
 * { error }.
 *
 * The caption is a parameter because the launcher asks for the other folder
 * Studio cannot guess — the ComfyUI install — through the same dialog, and a
 * picker captioned "your models" is how somebody hands it the wrong one.
 */
export const MODELS_PROMPT =
  "Choose the folder that holds your models (the one containing checkpoints, diffusion_models, vae, ...)";
export function pickFolderDialog(start = "", description = MODELS_PROMPT, {
  platform = process.platform, env = process.env, execFileFn = execFile,
} = {}) {
  if (platform === "linux" && !env.NODE_TEST_CONTEXT && (env.DISPLAY || env.WAYLAND_DISPLAY)) {
    const startArg = start ? (start.endsWith("/") ? start : `${start}/`) : "";
    return new Promise((resolve) => {
      execFileFn("zenity", [
        "--file-selection", "--directory",
        `--title=${description}`,
        ...(startArg ? [`--filename=${startArg}`] : []),
      ], { timeout: 10 * 60_000 }, (err, stdout) => {
        if (!err) return resolve({ path: String(stdout).trim() || null });
        if (err.code === 1) return resolve({ path: null }); // user cancelled zenity
        execFileFn("kdialog", [
          "--getexistingdirectory", start || ".",
          "--title", description,
        ], { timeout: 10 * 60_000 }, (kErr, kStdout) => {
          if (!kErr) return resolve({ path: String(kStdout).trim() || null });
          if (kErr.code === 1) return resolve({ path: null }); // user cancelled kdialog
          resolve({ unsupported: true });
        });
      });
    });
  }
  if (platform !== "win32") return Promise.resolve({ unsupported: true });
  const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const ps = [
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$o=New-Object System.Windows.Forms.Form -Property @{TopMost=$true;ShowInTaskbar=$false}",
    "$d=New-Object System.Windows.Forms.FolderBrowserDialog",
    `$d.Description=${lit(description)}`,
    "$d.ShowNewFolderButton=$false",
    `$d.SelectedPath=${lit(start)}`,
    "if($d.ShowDialog($o) -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($d.SelectedPath)}",
  ].join(";");
  return new Promise((resolve) => {
    execFileFn("powershell.exe", ["-NoProfile", "-STA", "-Command", ps],
      { timeout: 10 * 60_000, windowsHide: true },
      (err, stdout) => resolve(err
        ? { error: String(err.message || err).split("\n")[0] }
        : { path: String(stdout).trim() || null }));
  });
}

/** Resolve either a parent folder containing ComfyUI/main.py or a direct main.py folder. */
export function resolveComfyDirPath(rig) {
  if (!rig) return "";
  try {
    if (existsSync(path.join(rig, "ComfyUI", "main.py"))) return path.join(rig, "ComfyUI");
    if (existsSync(path.join(rig, "main.py"))) return rig;
  } catch { /* fall back */ }
  return path.join(rig, "ComfyUI");
}

/** Find a Python executable inside a local ComfyUI install or its parent directory. */
export function detectComfyPython(rig, customPy = null) {
  if (customPy && customPy !== "headless" && existsSync(customPy)) return customPy;
  if (!rig) return null;
  for (const rel of [
    ["venv", "Scripts", "python.exe"], ["venv", "bin", "python"], ["venv", "bin", "python3"],
    ["python_embeded", "python.exe"],
    [".venv", "Scripts", "python.exe"], [".venv", "bin", "python"], [".venv", "bin", "python3"],
    ["ComfyUI", ".venv", "Scripts", "python.exe"], ["ComfyUI", ".venv", "bin", "python"], ["ComfyUI", ".venv", "bin", "python3"],
    ["ComfyUI", "venv", "Scripts", "python.exe"], ["ComfyUI", "venv", "bin", "python"], ["ComfyUI", "venv", "bin", "python3"],
  ]) {
    const p = path.join(rig, ...rel);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Universal directory scanner: walks `targetPath` up to `maxDepth` to find
 * ComfyUI installations (`main.py`), Python virtual environments, and model
 * directories containing weight files. Works on any OS, drive, or network mount.
 */
const SKIP_SCAN_DIRS = new Set([
  ".git", "node_modules", "__pycache__", ".cache", ".venv", "venv", "python_embeded",
  "proc", "sys", "dev", "run", "tmp", "var", "etc", "usr", "lib", "lib64", "bin", "sbin",
  "Windows", "Program Files", "Program Files (x86)", "ProgramData", "$RECYCLE.BIN", "System Volume Information",
]);

export function scanPathForComfyAssets(targetPath, { maxDepth = 3 } = {}) {
  const root = String(targetPath || "").trim();
  if (!root || !existsSync(root)) {
    return { ok: false, error: `Folder not found: ${root || "(empty)"}` };
  }
  const resolvedRoot = path.resolve(root);
  const regularInstalls = [];
  const modelFolders = [];
  const pythonEnvs = [];
  const seenInstalls = new Set();
  const seenModels = new Set();
  const seenPy = new Set();

  const inspectDir = (dir, depth) => {
    let normDir;
    try { normDir = key(dir); } catch { return; }

    // 1. Is this a ComfyUI installation?
    if (existsSync(path.join(dir, "main.py")) && (existsSync(path.join(dir, "nodes.py")) || existsSync(path.join(dir, "comfy")))) {
      if (!seenInstalls.has(normDir)) {
        seenInstalls.add(normDir);
        const py = detectComfyPython(dir, null) || detectComfyPython(path.dirname(dir), null);
        const mDir = existsSync(path.join(dir, "models")) ? path.join(dir, "models") : null;
        const oDir = path.join(dir, "output");
        regularInstalls.push({
          label: `${path.basename(path.dirname(dir))}/${path.basename(dir)} (${dir})`,
          rig: dir,
          parentRig: path.dirname(dir),
          comfyDir: dir,
          python: py,
          modelsDir: mDir,
          outputDir: oDir,
        });
        if (py) {
          const pyKey = key(py);
          if (!seenPy.has(pyKey)) {
            seenPy.add(pyKey);
            pythonEnvs.push({ path: py, label: `${py}` });
          }
        }
      }
    }

    // 2. Does this directory have a standalone Python venv?
    const pyHere = detectComfyPython(dir, null);
    if (pyHere) {
      const pyKey = key(pyHere);
      if (!seenPy.has(pyKey)) {
        seenPy.add(pyKey);
        pythonEnvs.push({ path: pyHere, label: `${pyHere}` });
      }
    }

    // 3. Is this a ComfyUI models folder (contains standard shelf subfolders)?
    const hasShelf = ["checkpoints", "diffusion_models", "unet", "vae", "loras", "text_encoders", "clip"]
      .some((shelf) => existsSync(path.join(dir, shelf)));
    if (hasShelf && !seenModels.has(normDir)) {
      seenModels.add(normDir);
      let fileCount = 0;
      let totalBytes = 0;
      try {
        const scanned = scanBasesSync([dir]);
        fileCount = scanned.length;
        totalBytes = scanned.reduce((acc, f) => acc + (f.bytes || 0), 0);
      } catch { /* ignore */ }
      if (fileCount > 0 || path.basename(dir).toLowerCase() === "models") {
        const gb = (totalBytes / 1073741824).toFixed(1);
        modelFolders.push({
          path: dir,
          files: fileCount,
          bytes: totalBytes,
          label: fileCount > 0 ? `${dir} (${fileCount} files · ${gb} GB)` : `${dir} (empty models folder)`,
        });
      }
    }

    if (depth >= maxDepth) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".aiplay-studio") continue;
      if (SKIP_SCAN_DIRS.has(entry.name)) continue;
      const sub = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      if (!isDir && entry.isSymbolicLink()) {
        try { isDir = statSync(sub).isDirectory(); } catch { isDir = false; }
      }
      if (isDir) inspectDir(sub, depth + 1);
    }
  };

  inspectDir(resolvedRoot, 0);
  return {
    ok: true,
    scannedPath: resolvedRoot,
    regularInstalls,
    modelFolders,
    pythonEnvs,
  };
}

/**
 * Dynamically discover ComfyUI installations, Python environments, model
 * directories, output directories, and saved/local headless endpoints on ANY
 * user's system without hardcoded machine-specific paths or IPs.
 */
export function discoverComfyPresets(saved = {}) {
  const home = os.homedir();
  const candidateRoots = [
    saved.rig && !/^https?:\/\//i.test(saved.rig) ? saved.rig : null,
    path.join(home, "ComfyUI"),
    path.join(home, "StabilityMatrix", "Packages", "ComfyUI"),
    path.join(home, "AI"),
    path.join(home, "aiplay-studio"),
    path.join(home, ".aiplay-studio", "engine"),
    ...(Array.isArray(saved.scannedDirs) ? saved.scannedDirs : []),
  ].filter(Boolean);

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) candidateRoots.push(path.join(localAppData, "Programs", "ComfyUI"));
    for (const d of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
      if (!existsSync(`${d}:\\`)) continue;
      for (const rel of ["ComfyUI", "AI", "StabilityMatrix\\Packages\\ComfyUI", "ComfyUI_windows_portable"]) {
        const p = `${d}:\\${rel}`;
        if (existsSync(p)) candidateRoots.push(p);
      }
    }
  } else {
    for (const sysDir of ["/opt/ComfyUI", "/opt/comfyui"]) {
      if (existsSync(sysDir)) candidateRoots.push(sysDir);
    }
    for (const mountRoot of ["/mnt", "/media", "/run/media", "/Volumes"]) {
      if (!existsSync(mountRoot)) continue;
      try {
        for (const e1 of readdirSync(mountRoot)) {
          const p1 = path.join(mountRoot, e1);
          candidateRoots.push(p1);
          try {
            for (const e2 of readdirSync(p1)) {
              candidateRoots.push(path.join(p1, e2));
            }
          } catch { /* ignore non-dir or permission */ }
        }
      } catch { /* ignore */ }
    }
  }

  const seenComfyDirs = new Set();
  const regularInstalls = [];
  for (const cand of candidateRoots) {
    const cDir = resolveComfyDirPath(cand);
    if (!cDir || !existsSync(path.join(cDir, "main.py"))) continue;
    const normKey = key(cDir);
    if (seenComfyDirs.has(normKey)) continue;
    seenComfyDirs.add(normKey);
    const py = detectComfyPython(cand, null) || detectComfyPython(cDir, null);
    const modelsDir = existsSync(path.join(cDir, "models")) ? path.join(cDir, "models") : null;
    const outputDir = path.join(cDir, "output");
    regularInstalls.push({
      label: `${cDir}`,
      rig: cDir,
      parentRig: path.dirname(cDir),
      comfyDir: cDir,
      python: py,
      modelsDir,
      outputDir,
    });
  }

  const rawModelDirs = [
    saved.modelsDir,
    ...(Array.isArray(saved.modelsAlso) ? saved.modelsAlso : []),
    ...regularInstalls.map((r) => r.modelsDir),
    ...candidateRoots.map((c) => path.join(c, "models")),
    ...candidateRoots.map((c) => path.join(c, "ComfyUI", "models")),
  ].filter((d) => d && existsSync(d));

  const modelFolders = uniqueDirs(rawModelDirs).map((d) => {
    let fileCount = 0;
    let totalBytes = 0;
    try {
      const files = scanBasesSync([d]);
      fileCount = files.length;
      totalBytes = files.reduce((acc, f) => acc + (f.bytes || 0), 0);
    } catch { /* ignore */ }
    const gb = (totalBytes / 1073741824).toFixed(1);
    return {
      path: d,
      files: fileCount,
      bytes: totalBytes,
      label: fileCount > 0 ? `${d} (${fileCount} files · ${gb} GB)` : d,
    };
  });

  const rawOutDirs = [
    saved.outputDir,
    ...regularInstalls.map((r) => r.outputDir),
    path.join(home, ".aiplay-studio", "output"),
  ].filter(Boolean);
  const seenOut = new Set();
  const outputFolders = [];
  for (const d of rawOutDirs) {
    const r = path.resolve(d);
    if (seenOut.has(r)) continue;
    seenOut.add(r);
    outputFolders.push({ path: r, label: r });
  }

  const pythonEnvs = [];
  const seenPy = new Set();
  const pyCandidates = [
    saved.python && saved.python !== "headless" ? saved.python : null,
    ...regularInstalls.map((r) => r.python),
    process.platform === "win32" ? null : "/usr/bin/python3",
  ].filter((x) => x && existsSync(x));
  for (const p of pyCandidates) {
    const r = key(p);
    if (seenPy.has(r)) continue;
    seenPy.add(r);
    pythonEnvs.push({
      path: p,
      label: p.includes(".venv") || p.includes("venv") || p.includes("python_embeded")
        ? `Venv (${p})`
        : `System Python (${p})`,
    });
  }

  const headlessPresets = [];
  const seenUrls = new Set();
  const addHeadless = (u, label) => {
    if (!u || typeof u !== "string") return;
    const clean = u.trim().replace(/\/+$/, "");
    if (!clean || seenUrls.has(clean)) return;
    seenUrls.add(clean);
    headlessPresets.push({ url: clean, label: label || clean });
  };
  if (saved.comfyUrl) addHeadless(saved.comfyUrl, `Saved Server (${saved.comfyUrl})`);
  if (Array.isArray(saved.headlessHistory)) {
    for (const h of saved.headlessHistory) addHeadless(h, h);
  }
  addHeadless("http://127.0.0.1:8188", "Localhost (http://127.0.0.1:8188)");

  const defaultInstall = regularInstalls[0] || null;
  const resolvedRig = (saved.rig && !/^https?:\/\//i.test(saved.rig) ? resolveComfyDirPath(saved.rig) : null)
    || defaultInstall?.comfyDir
    || "";
  const resolvedPy = detectComfyPython(saved.rig || resolvedRig, saved.python)
    || defaultInstall?.python
    || "";
  const resolvedModels = saved.modelsDir || defaultInstall?.modelsDir || modelFolders[0]?.path || "";
  const resolvedOutput = saved.outputDir || defaultInstall?.outputDir || outputFolders[0]?.path || "";

  return {
    comfyMode: saved.comfyMode === "headless" ? "headless" : "regular",
    comfyUrl: saved.comfyUrl || "http://127.0.0.1:8188",
    rig: resolvedRig,
    comfyDir: resolvedRig ? resolveComfyDirPath(resolvedRig) : "",
    python: resolvedPy,
    detectedPython: resolvedPy || null,
    modelsDir: resolvedModels,
    modelsAlso: Array.isArray(saved.modelsAlso) ? saved.modelsAlso : [],
    outputDir: resolvedOutput,
    presets: {
      regularInstalls,
      headlessServers: headlessPresets,
      modelFolders,
      outputFolders,
      pythonEnvs,
    },
  };
}

