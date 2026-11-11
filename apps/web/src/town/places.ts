/** The buildings of Mofu Town and where each one leads. */
export interface Place {
  id: "data" | "study" | "dev" | "scanner" | "holder" | "mcp";
  name: string;
  kicker: string;
  body: string;
  href: string;
  /** Neon color of the sign and lights. */
  color: string;
  /** Wall color. */
  wall: string;
}

export const PLACES: Place[] = [
  {
    id: "data",
    name: "Data Lab",
    kicker: "DATA ANALYST",
    body: "Drop a spreadsheet. Mofu runs real Python on it and draws the charts.",
    href: "/app/?mode=data",
    color: "#4fd1c5",
    wall: "#2a3a40",
  },
  {
    id: "study",
    name: "Library",
    kicker: "STUDY BUDDY",
    body: "Summaries, flashcards and quizzes from your PDFs and notes.",
    href: "/app/?mode=study",
    color: "#b48cff",
    wall: "#33294a",
  },
  {
    id: "dev",
    name: "Workshop",
    kicker: "DEV TOOLS",
    body: "Explain a repo, scan dependencies, work with an API spec.",
    href: "/app/?mode=dev&tool=repo",
    color: "#f2b84b",
    wall: "#43352a",
  },
  {
    id: "scanner",
    name: "Scanner Tower",
    kicker: "TOKEN SCANNER",
    body: "Check what any Robinhood Chain token contract can do.",
    href: "/app/?mode=dev&tool=token",
    color: "#ff4f9a",
    wall: "#3f2433",
  },
  {
    id: "holder",
    name: "Holder Club",
    kicker: "$MOFU HOLDER PERKS",
    body: "Connect your wallet: 30 messages and 50 scans a day for holders.",
    href: "/app/?open=holder",
    color: "#ffd166",
    wall: "#3d3522",
  },
  {
    id: "mcp",
    name: "MCP Station",
    kicker: "MOFU IN YOUR AI",
    body: "Plug Mofu into Claude, Cursor or VS Code with one URL.",
    href: "/docs/#mcp",
    color: "#6ea8ff",
    wall: "#232f48",
  },
];
