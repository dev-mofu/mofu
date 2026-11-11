import "./landing.css";
import "./docs.css";
import { $$, initCommon } from "./common.js";

initCommon();

// Highlight the section you're reading in the table of contents.
const links = new Map(
  $$<HTMLAnchorElement>(".docs-toc a").map((a) => [a.getAttribute("href")!.slice(1), a]),
);
const current = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      links.forEach((a) => a.removeAttribute("aria-current"));
      links.get(e.target.id)?.setAttribute("aria-current", "true");
    }
  },
  { rootMargin: "-30% 0px -60% 0px" },
);
$$(".docs-content section[id]").forEach((s) => current.observe(s));

// The contents start closed (no layout shift on phones). In the side column on wide
// screens they're opened; on phones they close again after you pick a section.
const toc = document.querySelector<HTMLDetailsElement>(".docs-toc details");
if (toc && !window.matchMedia("(max-width: 900px)").matches) toc.open = true;
links.forEach((a) =>
  a.addEventListener("click", () => {
    if (toc && window.matchMedia("(max-width: 900px)").matches) toc.open = false;
  }),
);
