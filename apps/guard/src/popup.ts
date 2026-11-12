/** Toolbar popup: protection and hover switches, and a quick scan box. */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const protection = $<HTMLInputElement>("protection");
const hover = $<HTMLInputElement>("hover");
const form = $<HTMLFormElement>("scan");
const input = $<HTMLInputElement>("query");
const err = $<HTMLParagraphElement>("err");

chrome.storage.sync.get(["protection", "hover"]).then((s) => {
  protection.checked = s.protection !== false;
  hover.checked = s.hover !== false;
});
protection.addEventListener(
  "change",
  () => void chrome.storage.sync.set({ protection: protection.checked }),
);
hover.addEventListener("change", () => void chrome.storage.sync.set({ hover: hover.checked }));

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(q))
    void chrome.tabs.create({ url: `https://mofu.works/app/?tx=${q}` });
  else if (/^0x[0-9a-fA-F]{40}$/.test(q))
    void chrome.tabs.create({ url: `https://mofu.works/app/?scan=${q}` });
  else err.hidden = false;
});
input.addEventListener("input", () => (err.hidden = true));
$<HTMLSpanElement>("version").textContent = `v${chrome.runtime.getManifest().version}`;
