/** Live parts of /verify/ (contract check) and /stats/ (counters), on top of the docs page script. */
import "./docs.js";

const nf = new Intl.NumberFormat("en-US");

interface GuardCheck {
  isContract: boolean;
  name: string | null;
  symbol: string | null;
  verdict: "clean" | "caution" | "risky";
}

const verify = document.getElementById("verify-live");
if (verify) {
  const address = verify.dataset.address ?? "";
  fetch(`/api/guard/check?address=${address}`)
    .then((r) => (r.ok ? (r.json() as Promise<GuardCheck>) : Promise.reject()))
    .then((r) => {
      const verdict = {
        clean: ["No red flags in the code", "ok"],
        caution: ["A few things to check", "warn"],
        risky: ["Someone has strong control", "bad"],
      }[r.verdict];
      verify.textContent = "";
      const p = document.createElement("p");
      const b = document.createElement("strong");
      b.textContent = `${r.name ?? "Contract"}${r.symbol ? ` (${r.symbol})` : ""}`;
      const v = document.createElement("span");
      v.className = `verify-verdict verify-verdict--${verdict[1]}`;
      v.textContent = verdict[0]!;
      p.append("Live check: ", b, " · ", v);
      const small = document.createElement("p");
      small.className = "muted small";
      small.textContent = "Read just now from Robinhood Chain by Mofu's Token Scanner.";
      verify.append(p, small);
    })
    .catch(() => {
      verify.innerHTML = '<p class="muted">The live check is unavailable right now.</p>';
    });
}

interface StatsResponse {
  updatedAt: string;
  since: string | null;
  counters: Record<string, number>;
  chain: { holders: number | null; burnedPercent: number | null; top10Percent: number | null };
}

const stats = document.getElementById("stats");
if (stats) {
  fetch("/api/stats")
    .then((r) => (r.ok ? (r.json() as Promise<StatsResponse>) : Promise.reject()))
    .then((s) => {
      const c = (k: string) => s.counters[k] ?? 0;
      const groups: Array<[string, Array<[string, string, string?]>]> = [
        [
          "Using Mofu",
          [
            [
              nf.format(c("chat_free") + c("chat_holder") + c("chat_byok")),
              "Messages to Mofu",
              `${nf.format(c("chat_holder"))} from holder wallets`,
            ],
            [nf.format(c("token_scan")), "Token scans"],
            [nf.format(c("tx_explain")), "Transactions explained"],
            [
              nf.format(
                c("mcp_scan_token") + c("mcp_explain_transaction") + c("mcp_check_dependencies"),
              ),
              "MCP tool calls",
              "from AI apps like Claude and Cursor",
            ],
          ],
        ],
        [
          "Mofu Guard",
          [
            [
              nf.format(c("guard_stopped")),
              "Risky signatures stopped",
              "someone chose Don't sign on a warning",
            ],
            [nf.format(c("guard_check")), "Contract checks"],
          ],
        ],
        [
          "$MOFU holders",
          [
            [nf.format(c("holder_connect")), "Holder wallets connected"],
            [nf.format(c("vote_cast")), "Roadmap votes cast"],
            [
              s.chain.holders === null ? "—" : nf.format(s.chain.holders),
              "Holders on Robinhood Chain",
            ],
            [
              s.chain.burnedPercent === null ? "—" : `${Number(s.chain.burnedPercent.toFixed(2))}%`,
              "Supply burned",
            ],
            [
              s.chain.top10Percent === null ? "—" : `${Number(s.chain.top10Percent.toFixed(2))}%`,
              "Held by the top 10",
              "pools and the launch curve included",
            ],
          ],
        ],
      ];
      stats.textContent = "";
      for (const [title, items] of groups) {
        const h = document.createElement("h2");
        h.textContent = title;
        const grid = document.createElement("div");
        grid.className = "stat-grid";
        for (const [value, label, note] of items) {
          const card = document.createElement("div");
          card.className = "stat-card";
          const v = document.createElement("p");
          v.className = "stat-value";
          v.textContent = value;
          const l = document.createElement("p");
          l.className = "stat-label";
          l.textContent = label;
          card.append(v, l);
          if (note) {
            const n = document.createElement("p");
            n.className = "stat-note";
            n.textContent = note;
            card.append(n);
          }
          grid.append(card);
        }
        stats.append(h, grid);
      }
      const foot = document.createElement("p");
      foot.className = "muted small";
      const since = s.since
        ? new Date(s.since).toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          })
        : null;
      foot.textContent = `${since ? `Counting since ${since}. ` : ""}Updated ${new Date(s.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
      stats.append(foot);
    })
    .catch(() => {
      stats.innerHTML =
        '<p class="muted">Stats are unavailable right now. Try again in a minute.</p>';
    });
}
