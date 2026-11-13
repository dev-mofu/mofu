/*
 * Checked by Mofu: a small card with Mofu's verdict for a Robinhood Chain token.
 *
 *   <div data-mofu-token="0x…"></div>
 *   <script src="https://mofu.works/widget.js" async></script>
 *
 * Options on the div: data-theme="light" | "dark" (default: follows the visitor's setting).
 * Renders inside a closed shadow root, so the page's styles don't leak in and ours don't leak out.
 * Token names come from the contract, so every bit of text is set with textContent.
 */
(function () {
  "use strict";
  if (window.__mofuWidget) return;
  var script = document.currentScript;
  var BASE = "https://mofu.works";
  try {
    if (script && script.src) BASE = new URL(script.src).origin;
  } catch {
    /* keep the default */
  }
  var ADDRESS = /^0x[0-9a-fA-F]{40}$/;
  var VERDICT = {
    clean: { word: "CLEAN", text: "No red flags in the code" },
    caution: { word: "CAUTION", text: "A few things to check" },
    risky: { word: "RISKY", text: "Someone has strong control" },
  };
  var ICON = { ok: "✓", warn: "!", risk: "✕", info: "i" };
  var CSS =
    ":host{all:initial;display:block;max-width:380px}" +
    "*{box-sizing:border-box;font-family:'DM Sans',system-ui,-apple-system,'Segoe UI',sans-serif}" +
    ".card{--bg:#171316;--fg:#f4f0f1;--muted:#a8a0a3;--line:#2e292b;--ok:#5bd394;--warn:#f2b84b;--risk:#ff6b6b;--pink:#ff4f9a;" +
    "background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:16px;padding:14px 16px;line-height:1.35}" +
    ".card.light{--bg:#fff;--fg:#17121a;--muted:#6e6670;--line:#e6dfe3;--ok:#178a52;--warn:#a86a00;--risk:#c62f2f;--pink:#d6246f}" +
    ".top{display:flex;align-items:center;gap:8px}" +
    ".top img{width:20px;height:20px;image-rendering:pixelated}" +
    ".brand{font:600 11px/1 ui-monospace,'Cascadia Code',monospace;letter-spacing:2px;color:var(--pink);flex:1}" +
    ".pill{font-weight:800;font-size:11px;letter-spacing:1px;padding:4px 9px;border-radius:999px;color:#fff}" +
    ".pill.clean{background:var(--ok)}.pill.caution{background:var(--warn)}.pill.risky{background:var(--risk)}" +
    ".name{margin:10px 0 2px;font-size:17px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".sum{margin:0 0 8px;font-size:13px;color:var(--muted)}" +
    "ul{list-style:none;margin:0;padding:0;display:grid;gap:5px}" +
    "li{display:grid;grid-template-columns:18px 1fr;gap:8px;font-size:13.5px}" +
    "li span{width:18px;height:18px;border-radius:50%;border:1.5px solid currentColor;display:grid;place-items:center;font-size:10px;font-weight:800}" +
    ".ok{color:var(--ok)}.warn{color:var(--warn)}.risk{color:var(--risk)}.info{color:var(--muted)}" +
    "li b{font-weight:500;color:var(--fg)}" +
    "a{display:inline-block;margin-top:10px;font-size:13.5px;font-weight:700;color:var(--pink);text-decoration:none}" +
    "a:hover{text-decoration:underline}" +
    ".foot{margin:6px 0 0;font-size:11px;color:var(--muted)}";

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function ago(iso) {
    var s = (Date.now() - Date.parse(iso)) / 1000;
    if (!(s >= 0)) return "";
    if (s < 90) return "just now";
    if (s < 5400) return Math.round(s / 60) + " min ago";
    if (s < 129600) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " days ago";
  }

  function theme(host) {
    var t = host.getAttribute("data-theme");
    if (t === "light" || t === "dark") return t;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }

  function frame(host) {
    var root = host.attachShadow({ mode: "closed" });
    var style = el("style");
    style.textContent = CSS;
    var card = el("div", "card " + theme(host));
    root.append(style, card);
    return card;
  }

  function header(card, verdict) {
    var top = el("div", "top");
    var img = el("img");
    img.src = BASE + "/favicon.svg";
    img.alt = "";
    top.append(img, el("span", "brand", "CHECKED BY MOFU"));
    if (verdict) top.append(el("span", "pill " + verdict, VERDICT[verdict].word));
    card.append(top);
  }

  function render(host) {
    if (host.__mofu) return;
    host.__mofu = true;
    var address = (host.getAttribute("data-mofu-token") || "").trim();
    var card = frame(host);
    if (!ADDRESS.test(address)) {
      header(card, null);
      card.append(
        el("p", "sum", "Set data-mofu-token to a token contract address (0x + 40 characters)."),
      );
      return;
    }
    header(card, null);
    card.append(el("p", "sum", "Reading Robinhood Chain…"));
    fetch(BASE + "/token/" + address.toLowerCase() + ".json")
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, body: body };
        });
      })
      .then(function (r) {
        card.textContent = "";
        var d = r.body || {};
        if (!r.ok || !d.verdict) {
          header(card, null);
          card.append(
            el("p", "sum", (d && d.message) || "Mofu couldn't scan this token right now."),
          );
          return;
        }
        if (!d.isContract) {
          header(card, null);
          card.append(el("p", "sum", "There's no contract at this address on Robinhood Chain."));
          return;
        }
        header(card, d.verdict);
        var name = d.name ? d.name + (d.symbol ? " (" + d.symbol + ")" : "") : d.symbol || address;
        card.append(el("p", "name", name), el("p", "sum", VERDICT[d.verdict].text));
        var list = el("ul");
        (d.lines || []).forEach(function (l) {
          var li = el("li", ICON[l.status] ? l.status : "info");
          li.append(el("span", null, ICON[l.status] || "i"), el("b", null, l.label));
          list.append(li);
        });
        card.append(list);
        var link = el("a", null, "Full report on mofu.works →");
        link.href = d.url;
        link.target = "_blank";
        link.rel = "noopener";
        card.append(link);
        card.append(
          el(
            "p",
            "foot",
            "A check of the contract code, not financial advice" +
              (d.scannedAt ? " · scanned " + ago(d.scannedAt) : ""),
          ),
        );
      })
      .catch(function () {
        card.textContent = "";
        header(card, null);
        card.append(el("p", "sum", "Mofu couldn't be reached right now."));
      });
  }

  function scan(node) {
    if (!node || !node.querySelectorAll) return;
    if (node.hasAttribute && node.hasAttribute("data-mofu-token")) render(node);
    var found = node.querySelectorAll("[data-mofu-token]");
    for (var i = 0; i < found.length; i++) render(found[i]);
  }

  window.__mofuWidget = { render: render };
  var start = function () {
    scan(document);
    // Pages that add the placeholder later (single-page apps) still get a card.
    if (window.MutationObserver)
      new MutationObserver(function (records) {
        records.forEach(function (rec) {
          rec.addedNodes.forEach(scan);
        });
      }).observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
