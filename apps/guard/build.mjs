// Builds the extension into dist/ (load it unpacked from there) and zips it for the Chrome Web Store.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const root = import.meta.dirname;
const dist = path.join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const common = {
  bundle: true,
  minify: true,
  target: "chrome120",
  legalComments: "none",
  logLevel: "warning",
};
await Promise.all([
  build({
    ...common,
    entryPoints: [path.join(root, "src/inpage.ts")],
    outfile: path.join(dist, "inpage.js"),
    format: "iife",
  }),
  build({
    ...common,
    entryPoints: [path.join(root, "src/content.ts")],
    outfile: path.join(dist, "content.js"),
    format: "iife",
  }),
  build({
    ...common,
    entryPoints: [path.join(root, "src/popup.ts")],
    outfile: path.join(dist, "popup.js"),
    format: "iife",
  }),
  build({
    ...common,
    entryPoints: [path.join(root, "src/background.ts")],
    outfile: path.join(dist, "background.js"),
    format: "esm",
  }),
]);
cpSync(path.join(root, "static"), dist, { recursive: true });
console.log("built", dist);

// ---- zip dist/ (deflate) for the Chrome Web Store upload and the manual-install download
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { crc32, deflateRawSync } from "node:zlib";

function zip(dir, out) {
  const files = [];
  const walk = (d, prefix = "") => {
    for (const name of readdirSync(d).sort()) {
      const full = path.join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else files.push({ rel, data: readFileSync(full) });
    }
  };
  walk(dir);
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.rel, "utf8");
    const packed = deflateRawSync(f.data, { level: 9 });
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 10); // time/date
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, packed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(0, 12);
    c.writeUInt32LE(crc >>> 0, 16);
    c.writeUInt32LE(packed.length, 20);
    c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(out, Buffer.concat([...chunks, cd, end]));
  return files.length;
}

const zipOut = path.join(root, "../web/public/mofu-guard.zip");
console.log("zipped", zip(dist, zipOut), "files to", zipOut);
