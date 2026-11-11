// Refuses to deploy a build that isn't ready for production. Runs after `vite build`.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(path.join(root, "dist/mofu_web/wrangler.json"), "utf8"));
const problems = [];

// Cloudflare's Turnstile test keys (1x…, 2x…, 3x…) always pass or always fail: never for production.
const siteKey = config.vars?.TURNSTILE_SITE_KEY ?? "";
if (!siteKey || /^[123]x0{10,}/.test(siteKey)) {
  problems.push(
    `TURNSTILE_SITE_KEY is "${siteKey}", a Cloudflare test key. Put your production site key in wrangler.jsonc (see LAUNCH.md).`,
  );
}

// Nothing secret may end up in the public assets.
const assets = path.join(root, "dist/client");
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
for (const file of walk(assets)) {
  const rel = path.relative(assets, file);
  if (/(^|[\\/])\.dev\.vars$|\.env/.test(rel))
    problems.push(`${rel} would be uploaded as a public asset.`);
  if (
    /\.(js|html|css|json|txt|map)$/.test(rel) &&
    /sk-or-v1-[A-Za-z0-9]{20,}/.test(readFileSync(file, "utf8"))
  ) {
    problems.push(`${rel} contains something that looks like an OpenRouter key.`);
  }
}

if (
  !existsSync(path.join(assets, "index.html")) ||
  !existsSync(path.join(assets, "app/index.html"))
) {
  problems.push("The landing page or the app page is missing from the build.");
}

if (problems.length) {
  console.error("Not deploying:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log("Deploy checks passed.");
