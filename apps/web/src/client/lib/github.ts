import { buildRepoOverview, formatOverview, type RepoOverview } from "@mofu/core/web";

/**
 * Reads a public GitHub repository straight from the browser, so GitHub's
 * anonymous limit (60 API requests/hour) applies per user, not to our server.
 * File contents come from raw.githubusercontent.com, which doesn't count
 * against that limit; one repository costs two API requests.
 */

export interface RepoRef {
  owner: string;
  repo: string;
  ref?: string;
}

export interface LoadedRepo {
  fullName: string;
  url: string;
  description: string | null;
  stars: number;
  branch: string;
  overview: RepoOverview;
  /** Overview plus key file excerpts, sent to the model. */
  contextText: string;
  truncatedTree: boolean;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly kind: "not_found" | "rate_limit" | "network" | "bad_url",
    readonly resetAt?: Date,
  ) {
    super(message);
  }
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
export const MAX_CONTEXT_CHARS = 15_000;
const MAX_RAW_READS = 12;
const MAX_RAW_BYTES = 200_000;
const KEY_FILE_CHARS = 2_000;
const MAX_KEY_FILES = 4;

/** Accepts github.com URLs (with or without /tree/<branch>), "owner/repo", and .git suffixes. */
export function parseGitHubUrl(input: string): RepoRef | null {
  const text = input
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const url = text.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/?#]+)(?:\/tree\/([^?#]+))?/i,
  );
  const short = text.match(/^([^/\s]+)\/([^/\s]+)$/);
  const m = url ?? short;
  if (!m) return null;
  const [, owner, repo, ref] = m;
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo)) return null;
  return { owner, repo, ...(ref && { ref: decodeURIComponent(ref) }) };
}

async function githubApi<T>(path: string, fetchFn: typeof fetch): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(`https://api.github.com${path}`, {
      headers: { Accept: "application/vnd.github+json" },
    });
  } catch {
    throw new GitHubError("Couldn't reach GitHub. Check your connection.", "network");
  }
  if (res.status === 404) {
    throw new GitHubError(
      "Repository not found. It may be private or the URL may be wrong.",
      "not_found",
    );
  }
  if (
    (res.status === 403 || res.status === 429) &&
    res.headers.get("x-ratelimit-remaining") === "0"
  ) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    throw new GitHubError(
      "GitHub's limit for anonymous requests (60 per hour) is used up.",
      "rate_limit",
      Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : undefined,
    );
  }
  if (!res.ok) throw new GitHubError(`GitHub returned an error (HTTP ${res.status}).`, "network");
  return (await res.json()) as T;
}

interface RepoResponse {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  default_branch: string;
}

interface TreeResponse {
  truncated: boolean;
  tree: Array<{ path: string; type: string }>;
}

const IGNORED = /(^|\/)(node_modules|\.git|dist|build|vendor|\.next|coverage|__pycache__)\//;

export async function loadGitHubRepo(
  input: string,
  fetchFn: typeof fetch = fetch,
): Promise<LoadedRepo> {
  const ref = parseGitHubUrl(input);
  if (!ref) throw new GitHubError("That doesn't look like a GitHub repository URL.", "bad_url");
  const repo = await githubApi<RepoResponse>(`/repos/${ref.owner}/${ref.repo}`, fetchFn);
  const branch = ref.ref ?? repo.default_branch;
  const tree = await githubApi<TreeResponse>(
    `/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    fetchFn,
  );
  const files = tree.tree
    .filter((e) => e.type === "blob" && !IGNORED.test(e.path))
    .map((e) => e.path);

  let reads = 0;
  const readFile = async (path: string): Promise<string | null> => {
    if (!files.includes(path) || reads >= MAX_RAW_READS) return null;
    reads++;
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    try {
      const res = await fetchFn(
        `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${encodeURIComponent(branch)}/${encoded}`,
      );
      if (!res.ok) return null;
      const text = await res.text();
      return text.length > MAX_RAW_BYTES ? null : text;
    } catch {
      return null;
    }
  };

  const overview = await buildRepoOverview({ name: repo.full_name, files, readFile });

  // A few entry points give the model real code to point at.
  const excerpts: string[] = [];
  for (const path of overview.entryPoints.slice(0, MAX_KEY_FILES)) {
    const text = await readFile(path);
    if (!text) continue;
    const body = text.length > KEY_FILE_CHARS ? `${text.slice(0, KEY_FILE_CHARS)}\n…` : text;
    excerpts.push(`### ${path}\n\`\`\`\n${body}\n\`\`\``);
  }

  let contextText = [
    formatOverview(overview),
    repo.description ? `\nDescription: ${repo.description}` : "",
    tree.truncated
      ? "\nNote: GitHub truncated the file list; this is a very large repository."
      : "",
    excerpts.length ? `\n## Key files (excerpts)\n${excerpts.join("\n\n")}` : "",
  ].join("\n");
  if (contextText.length > MAX_CONTEXT_CHARS)
    contextText = `${contextText.slice(0, MAX_CONTEXT_CHARS)}\n…`;

  return {
    fullName: repo.full_name,
    url: repo.html_url,
    description: repo.description,
    stars: repo.stargazers_count,
    branch,
    overview,
    contextText,
    truncatedTree: tree.truncated,
  };
}

export interface GitHubFiles {
  fullName: string;
  branch: string;
  files: Array<{ path: string; text: string }>;
}

/**
 * Fetches files matching `pattern` from a public repository (2 API calls,
 * contents from raw.githubusercontent.com). Used for dependency manifests.
 */
export async function fetchGitHubFiles(
  input: string,
  pattern: RegExp,
  maxFiles = 20,
  fetchFn: typeof fetch = fetch,
): Promise<GitHubFiles> {
  const ref = parseGitHubUrl(input);
  if (!ref) throw new GitHubError("That doesn't look like a GitHub repository URL.", "bad_url");
  const repo = await githubApi<RepoResponse>(`/repos/${ref.owner}/${ref.repo}`, fetchFn);
  const branch = ref.ref ?? repo.default_branch;
  const tree = await githubApi<TreeResponse>(
    `/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    fetchFn,
  );
  const paths = tree.tree
    .filter((e) => e.type === "blob" && !IGNORED.test(e.path) && pattern.test(e.path))
    .map((e) => e.path)
    .slice(0, maxFiles);
  const files: Array<{ path: string; text: string }> = [];
  // A few at a time: raw.githubusercontent.com is quick, but hundreds in a row add up.
  for (let i = 0; i < paths.length; i += 8) {
    const batch = await Promise.all(
      paths.slice(i, i + 8).map(async (path) => {
        const encoded = path.split("/").map(encodeURIComponent).join("/");
        try {
          const res = await fetchFn(
            `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${encodeURIComponent(branch)}/${encoded}`,
          );
          return res.ok ? { path, text: await res.text() } : null;
        } catch {
          return null; // skip unreadable files; the scan reports what it got
        }
      }),
    );
    for (const f of batch) if (f) files.push(f);
  }
  return { fullName: repo.full_name, branch, files };
}
