"use strict";
// Builds the .ccx with tools/build-ccx.mjs, unpacks it and checks the package.
// Temp folders go to the OS temp directory and are not removed by the test.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const ID = "dev.halation.photoshop";
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const HAS_UNZIP = !spawnSync("unzip", ["-v"]).error;

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function build(extra = []) {
  const out = tmpDir("halation-build-");
  const r = spawnSync(process.execPath, [path.join(ROOT, "tools", "build-ccx.mjs"), "--out-dir", out, ...extra], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `build failed:\n${r.stdout}\n${r.stderr}`);
  return { out, ccx: path.join(out, `${ID}_PS.ccx`), stdout: r.stdout };
}

function zipEntries(ccx) {
  const r = spawnSync("unzip", ["-Z1", ccx], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split("\n").filter(Boolean).sort();
}

function unzip(ccx) {
  const dir = tmpDir("halation-ccx-");
  const t = spawnSync("unzip", ["-tq", ccx], { encoding: "utf8" });
  assert.equal(t.status, 0, "unzip -t: " + t.stdout + t.stderr);
  const r = spawnSync("unzip", ["-q", ccx, "-d", dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return dir;
}

function scaled(p, s) {
  const ext = path.extname(p);
  return p.slice(0, -ext.length) + "@" + s + "x" + ext;
}

function pngSize(file) {
  const b = fs.readFileSync(file);
  assert.equal(b.toString("hex", 0, 8), "89504e470d0a1a0a", file + " is not a PNG");
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function checkPackage(dir, entries) {
  // manifest at the root, no nesting, no macOS junk
  assert.ok(entries.includes("manifest.json"), "manifest.json must be at the archive root");
  assert.ok(!entries.some((e) => e.startsWith(ID + "/")), "contents must not be nested in a folder");
  for (const e of entries) {
    assert.ok(!e.split("/").some((part) => part.startsWith(".") || part === "__MACOSX"), "hidden entry " + e);
  }

  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(m.manifestVersion, 5);
  assert.equal(m.id, ID);
  assert.equal(m.name, "Halation");
  assert.equal(m.version, "1.1.2");
  assert.equal(m.version, PKG.version);
  assert.equal(m.main, "index.html");
  assert.equal(typeof m.host, "object");
  assert.ok(!Array.isArray(m.host), "host must be an object, not an array");
  assert.deepEqual(m.host, { app: "PS", minVersion: "24.4.0", data: { apiVersion: 2 } });
  assert.deepEqual(Object.keys(m.requiredPermissions), ["clipboard"]);

  const panels = m.entrypoints.filter((e) => e.type === "panel");
  assert.equal(panels.length, 1);
  assert.equal(m.entrypoints.length, 1);

  const files = new Set(entries);
  assert.ok(files.has(m.main));

  const icons = [...m.icons, ...panels[0].icons];
  assert.ok(icons.length >= 3);
  for (const ic of icons) {
    for (const s of ic.scale) {
      const rel = scaled(ic.path, s);
      assert.ok(files.has(rel), "missing icon " + rel);
      const size = pngSize(path.join(dir, rel));
      assert.deepEqual(size, { width: ic.width * s, height: ic.height * s }, rel);
    }
  }

  const html = fs.readFileSync(path.join(dir, m.main), "utf8");
  const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((x) => x[1]);
  const links = [...html.matchAll(/<link[^>]*\shref="([^"]+)"/g)].map((x) => x[1]);
  assert.equal(scripts[0], "halation-core.js", "the core loads first");
  for (const ref of [...scripts, ...links]) assert.ok(files.has(ref), "index.html references missing " + ref);
  return { manifest: m, scripts };
}

test("build: .ccx has manifest.json at the root, host object, all referenced files", { skip: !HAS_UNZIP && "unzip CLI not found" }, () => {
  const { ccx } = build();
  assert.ok(fs.existsSync(ccx), "ccx written");
  const entries = zipEntries(ccx);
  const dir = unzip(ccx);
  checkPackage(dir, entries);
});

test("build: the Node zip writer gives an equivalent valid archive", { skip: !HAS_UNZIP && "unzip CLI not found" }, () => {
  const sys = build(["--skip-bundle", "--zip", "system"]);
  const nodeZip = build(["--skip-bundle", "--zip", "node"]);
  const a = zipEntries(sys.ccx);
  const b = zipEntries(nodeZip.ccx);
  assert.deepEqual(b, a);
  const dir = unzip(nodeZip.ccx);
  checkPackage(dir, b);
  for (const rel of b) {
    assert.ok(
      fs.readFileSync(path.join(dir, rel)).equals(fs.readFileSync(path.join(nodeZip.out, ID, rel))),
      "content differs: " + rel
    );
  }
});

test("build: the manifest validator rejects a host array, a missing icon and a version mismatch", async () => {
  const { validatePluginDir } = await import(pathToFileURL(path.join(ROOT, "tools", "build-ccx.mjs")).href);
  const { out } = build(["--skip-bundle"]);
  const good = path.join(out, ID);
  assert.deepEqual(validatePluginDir(good, { packageVersion: PKG.version }).errors, []);

  const bad = tmpDir("halation-bad-");
  fs.cpSync(good, bad, { recursive: true });
  const mPath = path.join(bad, "manifest.json");
  const m = JSON.parse(fs.readFileSync(mPath, "utf8"));
  m.host = [m.host];
  fs.writeFileSync(mPath, JSON.stringify(m));
  fs.renameSync(path.join(bad, "icons", "plugin@2x.png"), path.join(bad, "icons", "plugin-moved.png"));
  const errs = validatePluginDir(bad, { packageVersion: "9.9.9" }).errors.join("\n");
  assert.match(errs, /host must be a single object/);
  assert.match(errs, /plugin@2x\.png is missing/);
  assert.match(errs, /package\.json version 9\.9\.9/);
});

test("build: plugin scripts load as plain <script>s and define their globals", () => {
  const { out } = build(["--skip-bundle"]);
  const dir = path.join(out, ID);
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((x) => x[1]);
  // No module, no require, no window: like a browser page minus the DOM. panel.js needs the DOM.
  const sandbox = { console, setTimeout, clearTimeout, performance };
  vm.createContext(sandbox);
  for (const s of scripts) {
    if (s === "panel.js") continue;
    vm.runInContext(fs.readFileSync(path.join(dir, s), "utf8"), sandbox, { filename: s });
  }
  for (const g of ["HalationCore", "HalationColor", "HalationSettingsStore", "HalationCurveEditor", "HalationDiagnostics", "HalationBridge"]) {
    assert.ok(sandbox[g], g + " defined");
  }
  assert.equal(typeof sandbox.HalationCore.renderPreview, "function");
  assert.equal(typeof sandbox.HalationBridge.createBridge, "function");
  // panel.js at least parses
  new vm.Script(fs.readFileSync(path.join(dir, "panel.js"), "utf8"), { filename: "panel.js" });
});

// v1.1.2 (plan review С1): `.is-hidden` sat above `.hint`, `.row` and `.preview-img`, which set
// `display` with the same specificity, so seven elements were never hidden. The hiding rule must
// be the last rule of the stylesheet and must name every class that sets `display` itself.
test("styles: the hiding rule is the last one and wins over every class that sets display", () => {
  const css = fs.readFileSync(path.join(ROOT, "src", "plugin", "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  const last = rules.at(-1);
  assert.equal(last.sel, ".is-hidden", "the last rule is the plain hiding rule, alone (a rejected selector cannot take it down)");
  assert.match(last.body, /^\s*display:\s*none;\s*$/);
  const compound = rules.at(-2);
  assert.match(compound.body, /^\s*display:\s*none;\s*$/);
  const hidingSelectors = compound.sel.split(",").map((x) => x.trim());
  assert.ok(hidingSelectors.every((x) => /^\.[a-z0-9-]+\.is-hidden$/.test(x)), compound.sel);
  // classes that appear together with is-hidden in the panel markup
  const html = fs.readFileSync(path.join(ROOT, "src", "plugin", "index.html"), "utf8");
  const together = new Set();
  for (const m of html.matchAll(/class="([^"]*\bis-hidden\b[^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c && c !== "is-hidden") together.add(c);
  }
  assert.ok(together.has("hint") && together.has("row") && together.has("preview-img"));
  for (const r of rules.slice(0, -2)) {
    if (!/display\s*:/.test(r.body)) continue;
    for (const sel of r.sel.split(",").map((x) => x.trim())) {
      const m = /^\.([a-z0-9-]+)$/i.exec(sel);
      if (!m || !together.has(m[1])) continue;
      assert.ok(hidingSelectors.includes("." + m[1] + ".is-hidden"), "." + m[1] + " sets display and needs ." + m[1] + ".is-hidden in the hiding rule");
    }
  }
  // the old always-visible report field is gone from the markup
  assert.ok(!/<textarea/.test(html), "no <textarea> in index.html: the fallback field is created on a clipboard failure only");
});
