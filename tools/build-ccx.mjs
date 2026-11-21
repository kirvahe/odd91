#!/usr/bin/env node
// Builds the Photoshop plugin package (no npm dependencies, no UXP Developer Tool).
//
//   1. node tools/bundle-core.mjs        -> build/halation-core.js (global HalationCore)
//   2. copy src/plugin/ + the core bundle -> <out>/dev.halation.photoshop/
//   3. validate the manifest              (JSON, host is an object, versions, files, icons)
//   4. zip the folder CONTENTS            -> <out>/dev.halation.photoshop_PS.ccx
//      (manifest.json at the archive root, no .DS_Store / __MACOSX / hidden files)
//
// Usage: node tools/build-ccx.mjs [--out-dir dist] [--zip auto|system|node] [--skip-bundle]
//
// Nothing is deleted: files are overwritten in place, files left over in the output
// folder from older builds are reported (and never packed: the archive is built from
// an explicit file list), and the .ccx is written to a temp file and renamed.

import { spawnSync } from "node:child_process";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync, renameSync,
} from "node:fs";
import { deflateRawSync } from "node:zlib";
import { dirname, join, relative, sep, posix, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src", "plugin");
const CORE_BUNDLE = join(ROOT, "build", "halation-core.js");
const BUNDLER = join(ROOT, "tools", "bundle-core.mjs");
const PLUGIN_ID = "dev.halation.photoshop";
const MIN_PS = [24, 4, 0];
const ALLOWED_PERMISSIONS = new Set(["clipboard", "localFileSystem"]);

// ------------------------------------------------------------------ helpers

function fail(msg) {
  console.error("build-ccx: ERROR: " + msg);
  process.exit(1);
}

function toPosix(p) {
  return p.split(sep).join(posix.sep);
}

function isHidden(name) {
  return name.startsWith(".") || name === "__MACOSX" || name === "Thumbs.db";
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (isHidden(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFiles(full, base));
    else if (st.isFile()) out.push(toPosix(relative(base, full)));
  }
  return out;
}

function parseVersion(s) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(s || ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function pngSize(file) {
  const b = readFileSync(file);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || sig.some((v, i) => b[i] !== v) || b.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function scaledPath(p, scale) {
  const ext = extname(p);
  return p.slice(0, p.length - ext.length) + "@" + scale + "x" + ext;
}

// ------------------------------------------------------------------ validation

/**
 * Validate an unpacked plugin folder. Returns { errors, warnings, manifest }.
 * opts.packageVersion: version from package.json, must equal manifest.version.
 */
export function validatePluginDir(dir, opts = {}) {
  const errors = [];
  const warnings = [];
  const exists = (rel) => existsSync(join(dir, rel));
  let manifest = null;

  const mPath = join(dir, "manifest.json");
  if (!existsSync(mPath)) return { errors: ["manifest.json is missing"], warnings, manifest };
  try {
    manifest = JSON.parse(readFileSync(mPath, "utf8"));
  } catch (e) {
    return { errors: ["manifest.json does not parse: " + e.message], warnings, manifest };
  }

  if (manifest.manifestVersion !== 5) errors.push("manifestVersion must be 5");
  if (typeof manifest.id !== "string" || !/^[A-Za-z0-9._-]+$/.test(manifest.id)) errors.push("id must be an ASCII string");
  if (manifest.id !== PLUGIN_ID) errors.push(`id must be "${PLUGIN_ID}"`);
  if (!manifest.name) errors.push("name is missing");
  if (!parseVersion(manifest.version)) errors.push("version must be x.y.z");
  if (!manifest.main || !exists(manifest.main)) errors.push(`main file "${manifest.main}" is missing`);

  const host = manifest.host;
  if (!host || typeof host !== "object" || Array.isArray(host)) {
    errors.push("host must be a single object, not an array (an array gives install error -4)");
  } else {
    if (host.app !== "PS") errors.push('host.app must be "PS"');
    const mv = parseVersion(host.minVersion);
    if (!mv) errors.push("host.minVersion must be x.y.z");
    else if (cmpVersion(mv, MIN_PS) < 0) errors.push("host.minVersion must be at least 24.4.0 (Imaging API)");
    if (!host.data || host.data.apiVersion !== 2) errors.push("host.data.apiVersion must be 2");
  }

  const perms = manifest.requiredPermissions;
  if (perms !== undefined && (typeof perms !== "object" || Array.isArray(perms))) {
    errors.push("requiredPermissions must be an object");
  } else if (perms) {
    for (const k of Object.keys(perms)) if (!ALLOWED_PERMISSIONS.has(k)) warnings.push(`unexpected permission "${k}"`);
    if (perms.localFileSystem && perms.localFileSystem !== "plugin") warnings.push("localFileSystem wider than \"plugin\"");
  }

  const eps = Array.isArray(manifest.entrypoints) ? manifest.entrypoints : null;
  if (!eps) errors.push("entrypoints must be an array");
  const panels = eps ? eps.filter((e) => e && e.type === "panel") : [];
  if (eps && panels.length !== 1) errors.push(`exactly one panel entrypoint expected, found ${panels.length}`);
  if (eps && eps.length !== panels.length) warnings.push("entrypoints other than the panel are present");
  const panel = panels[0];
  if (panel) {
    if (!panel.id) errors.push("panel entrypoint has no id");
    if (!panel.label || !panel.label.default) errors.push("panel entrypoint has no label.default");
  }

  // icons: top-level + panel; with scale [1, 2] UXP looks for name@1x.png and name@2x.png
  const iconSets = [];
  if (Array.isArray(manifest.icons)) iconSets.push(["icons", manifest.icons]);
  else errors.push("top-level icons array is missing");
  for (const e of panels) {
    if (Array.isArray(e.icons)) iconSets.push([`entrypoint ${e.id} icons`, e.icons]);
    else errors.push(`entrypoint ${e.id} has no icons array`);
  }
  for (const [where, icons] of iconSets) {
    for (const ic of icons) {
      if (!ic || !ic.path) {
        errors.push(`${where}: icon without path`);
        continue;
      }
      const ext = extname(ic.path).toLowerCase();
      if (ext !== ".png") errors.push(`${where}: ${ic.path} must be a PNG`);
      const scales = Array.isArray(ic.scale) && ic.scale.length ? ic.scale : [1];
      for (const s of scales) {
        const rel = scaledPath(ic.path, s);
        if (!exists(rel)) {
          errors.push(`${where}: ${rel} is missing`);
          continue;
        }
        const size = pngSize(join(dir, rel));
        if (!size) errors.push(`${where}: ${rel} is not a valid PNG`);
        else if (size.width !== ic.width * s || size.height !== ic.height * s) {
          errors.push(`${where}: ${rel} is ${size.width}x${size.height}, expected ${ic.width * s}x${ic.height * s}`);
        }
      }
      if (!exists(ic.path)) warnings.push(`${where}: unsuffixed fallback ${ic.path} is missing`);
    }
  }

  if (opts.packageVersion !== undefined && opts.packageVersion !== manifest.version) {
    errors.push(`package.json version ${opts.packageVersion} != manifest version ${manifest.version}`);
  }

  // panel.js must carry the same version and the same panel id
  if (exists("panel.js")) {
    const js = readFileSync(join(dir, "panel.js"), "utf8");
    const m = /PLUGIN_VERSION\s*=\s*"([^"]+)"/.exec(js);
    if (!m) errors.push("panel.js has no PLUGIN_VERSION");
    else if (m[1] !== manifest.version) errors.push(`panel.js PLUGIN_VERSION ${m[1]} != manifest version ${manifest.version}`);
    if (panel && panel.id && !js.includes(panel.id)) errors.push(`panel.js does not set up the panel "${panel.id}"`);
  }

  // every <script src> / <link href> of the main page must exist; the core loads before the panel
  if (manifest.main && exists(manifest.main)) {
    const html = readFileSync(join(dir, manifest.main), "utf8");
    const refs = [];
    for (const m of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) refs.push(m[1]);
    for (const m of html.matchAll(/<link[^>]*\shref="([^"]+)"/g)) refs.push(m[1]);
    for (const r of refs) {
      if (/^[a-z]+:/i.test(r) || r.startsWith("//")) {
        errors.push(`${manifest.main} references a remote file: ${r}`);
        continue;
      }
      if (!exists(r)) errors.push(`${manifest.main} references a missing file: ${r}`);
    }
    const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
    const coreAt = scripts.indexOf("halation-core.js");
    if (coreAt < 0) errors.push(`${manifest.main} does not load halation-core.js`);
    else if (scripts.some((s, i) => i < coreAt && s !== "halation-core.js")) {
      errors.push("halation-core.js must be the first script");
    }
  }

  return { errors, warnings, manifest };
}

function checkCoreBundle(file) {
  if (!existsSync(file)) fail(`core bundle not found: ${relative(ROOT, file)}`);
  const text = readFileSync(file, "utf8");
  if (text.length < 1000) fail("core bundle is suspiciously small");
  if (!text.includes("HalationCore")) fail("core bundle does not define HalationCore");
  // UXP (manifest v5) blocks code generation from strings unless explicitly allowed.
  const codegen = /new\s+Function\s*\(|(^|[^.\w$])eval\s*\(/m.exec(text);
  if (codegen) fail("core bundle uses eval/new Function, which UXP blocks: " + JSON.stringify(codegen[0]));
  return statSync(file).size;
}

// ------------------------------------------------------------------ zip

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Minimal ZIP writer (deflate, no directory entries) used when the system zip is absent. */
export function writeZipNode(baseDir, files, outFile) {
  const { time, date } = dosDateTime(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const rel of files) {
    const data = readFileSync(join(baseDir, rel));
    const name = Buffer.from(rel, "utf8");
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x0314, 4); // made by: Unix, 2.0
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  writeFileSync(outFile, Buffer.concat([...locals, cd, end]));
}

function writeZipSystem(baseDir, files, outFile) {
  const r = spawnSync("zip", ["-X", "-9", "-q", "-D", outFile, "-@"], {
    cwd: baseDir,
    input: files.join("\n") + "\n",
    encoding: "utf8",
  });
  if (r.error || r.status !== 0) {
    throw new Error("system zip failed: " + (r.error ? r.error.message : r.stderr || "exit " + r.status));
  }
}

function hasSystemZip() {
  const r = spawnSync("zip", ["-v"], { encoding: "utf8" });
  return !r.error && r.status === 0;
}

/** List entry names from a ZIP's central directory. */
export function readZipEntries(file) {
  const b = readFileSync(file);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end of central directory)");
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt central directory");
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    names.push(b.toString("utf8", p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

// ------------------------------------------------------------------ main

function parseArgs(argv) {
  const a = { outDir: join(ROOT, "dist"), zip: "auto", skipBundle: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--out-dir") a.outDir = argv[++i];
    else if (v.startsWith("--out-dir=")) a.outDir = v.slice(10);
    else if (v === "--zip") a.zip = argv[++i];
    else if (v.startsWith("--zip=")) a.zip = v.slice(6);
    else if (v === "--skip-bundle") a.skipBundle = true;
    else fail("unknown argument " + v);
  }
  if (!isAbsolute(a.outDir)) a.outDir = resolve(process.cwd(), a.outDir);
  if (!["auto", "system", "node"].includes(a.zip)) fail("--zip must be auto, system or node");
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

  // 1. core bundle
  if (!args.skipBundle) {
    if (!existsSync(BUNDLER)) fail("tools/bundle-core.mjs not found");
    const r = spawnSync(process.execPath, [BUNDLER], { cwd: ROOT, stdio: "inherit" });
    if (r.status !== 0) fail("tools/bundle-core.mjs failed (exit " + r.status + ")");
  }
  const coreSize = checkCoreBundle(CORE_BUNDLE);

  // 2. copy the plugin folder
  const pluginDir = join(args.outDir, PLUGIN_ID);
  mkdirSync(pluginDir, { recursive: true });
  const srcFiles = listFiles(SRC);
  if (srcFiles.includes("halation-core.js")) fail("src/plugin must not contain halation-core.js (the build adds it)");
  for (const rel of srcFiles) {
    const dest = join(pluginDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(SRC, rel), dest);
  }
  copyFileSync(CORE_BUNDLE, join(pluginDir, "halation-core.js"));
  const files = [...srcFiles, "halation-core.js"].sort();

  const stale = listFiles(pluginDir).filter((f) => !files.includes(f));
  if (stale.length) {
    console.warn("build-ccx: warning: left over from an older build (not packed, remove by hand): " + stale.join(", "));
  }

  // 3. validate
  const v = validatePluginDir(pluginDir, { packageVersion: pkg.version });
  for (const w of v.warnings) console.warn("build-ccx: warning: " + w);
  if (v.errors.length) fail("manifest validation failed:\n  - " + v.errors.join("\n  - "));
  if (!files.includes("manifest.json")) fail("manifest.json not in the file list");

  // 4. zip the folder contents
  const ccx = join(args.outDir, `${v.manifest.id}_${v.manifest.host.app}.ccx`);
  const tmp = `${ccx}.tmp-${process.pid}`;
  const useSystem = args.zip === "system" || (args.zip === "auto" && hasSystemZip());
  if (args.zip === "system" && !hasSystemZip()) fail("--zip system requested but zip is not installed");
  if (useSystem) writeZipSystem(pluginDir, files, tmp);
  else writeZipNode(pluginDir, files, tmp);
  renameSync(tmp, ccx);

  const entries = readZipEntries(ccx);
  if (!entries.includes("manifest.json")) fail("manifest.json is not at the archive root");
  const bad = entries.filter((e) => e.split("/").some(isHidden) || e.endsWith("/"));
  if (bad.length) fail("archive contains hidden files or folders: " + bad.join(", "));
  const missing = files.filter((f) => !entries.includes(f));
  if (missing.length) fail("archive is missing: " + missing.join(", "));

  console.log(`build-ccx: core bundle ${coreSize} bytes`);
  console.log(`build-ccx: plugin folder ${relative(process.cwd(), pluginDir) || pluginDir} (${files.length} files)`);
  console.log(`build-ccx: package ${relative(process.cwd(), ccx) || ccx} (${statSync(ccx).size} bytes, ${useSystem ? "system zip" : "node zip"}, ${entries.length} entries)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
