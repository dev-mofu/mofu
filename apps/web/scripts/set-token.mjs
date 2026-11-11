// Fill the $MOFU contract card on the landing page: node scripts/set-token.mjs <CA> <PONS_URL>
import { readFileSync, writeFileSync } from "node:fs";
const [ca, pons] = process.argv.slice(2);
if (!ca || !/^0x[0-9a-fA-F]{40}$/.test(ca)) throw new Error("CA must be 0x + 40 hex characters");
if (!pons || !/^https:\/\//.test(pons)) throw new Error("Pons link must start with https://");
const file = new URL("../index.html", import.meta.url);
let s = readFileSync(file, "utf8");
if (!s.includes("__MOFU_CA__") || !s.includes("__PONS_URL__"))
  throw new Error("placeholders not found");
s = s.replaceAll("__MOFU_CA__", ca).replaceAll("__PONS_URL__", pons);
writeFileSync(file, s);
console.log("token card set:", ca, pons);
