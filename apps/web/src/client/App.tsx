import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from "ai";
import {
  AVAILABLE_MODES,
  BYOK_HEADER,
  MODEL_HEADER,
  MODE_LABELS,
  MODES,
  parseApiError,
  type ChatContext,
  type Mode,
  type PublicConfig,
  type UsageInfo,
} from "../shared/api.js";
import { createSession, fetchConfig, fetchUsage } from "./lib/api.js";
import { GitHubError, loadGitHubRepo, type LoadedRepo } from "./lib/github.js";
import { RepoPanel } from "./components/RepoPanel.js";
import { DepsPanel } from "./components/DepsPanel.js";
import { ScanResults } from "./components/ScanResults.js";
import {
  findUnverifiedReferences,
  formatProfileForModel,
  formatScanForModel,
  suggestQuestions,
  type PythonSandbox,
  type ScanReport,
} from "@mofu/core/web";
import { DataPanel, MAX_DATA_BYTES, type LoadedDataset } from "./components/DataPanel.js";
import {
  CLIENT_TOOL_NAMES,
  createBrowserSandbox,
  downloadText,
  runClientTool,
  type Artifacts,
} from "./lib/data-tools.js";
import {
  addMemoryItem,
  loadMemory,
  loadSettings,
  saveMemory,
  saveSettings,
  type MemoryItem,
  type Settings,
} from "./lib/storage.js";
import { Composer } from "./components/Composer.js";
import { Mascot, type MascotState } from "./components/Mascot.js";
import { MemoryDialog } from "./components/MemoryDialog.js";
import { MessageView } from "./components/MessageView.js";
import { SettingsDialog } from "./components/SettingsDialog.js";
import { VerifyDialog } from "./components/VerifyDialog.js";

const SUGGESTIONS = [
  "Explain photosynthesis simply, using Wikipedia",
  "What does “serendipity” mean?",
  "Remember that I prefer short answers",
];

const REPORT_PROMPT =
  "Write a short Markdown report of this analysis: the questions asked, the key findings with the exact numbers from the Python results, the charts made (refer to them as Chart 1, Chart 2…), and caveats about the data.";

const DEPS_SUGGESTIONS = [
  "Give me a prioritized upgrade plan",
  "Which issue should I fix first, and why?",
  "Explain the worst vulnerability in plain language",
];

const DEV_SUGGESTIONS = [
  "Explain this repository",
  "How do I run it and its tests?",
  "Where should a new contributor start?",
];

function useSystemDark(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", notify);
      return () => mq.removeEventListener("change", notify);
    },
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function shortModel(id: string): string {
  return id.split("/").pop() ?? id;
}

export function App() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [memory, setMemory] = useState<MemoryItem[]>(loadMemory);
  const [mode, setMode] = useState<Mode>("general");
  const [files, setFiles] = useState<File[]>([]);
  const [dialog, setDialog] = useState<"settings" | "memory" | null>(null);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const systemDark = useSystemDark();

  const sessionExpiry = useRef(0);
  const verifyResolver = useRef<((ok: boolean) => void) | null>(null);
  const threadEnd = useRef<HTMLDivElement>(null);

  const [repo, setRepo] = useState<LoadedRepo | null>(null);
  const [repoLoading, setRepoLoading] = useState(false);
  const [repoError, setRepoError] = useState<GitHubError | null>(null);

  // The transport reads the latest settings through a ref, so it's created once.
  const [devTool, setDevTool] = useState<"repo" | "deps">("repo");
  const [depScan, setDepScan] = useState<{ report: ScanReport; source: string } | null>(null);
  const [scanning, setScanning] = useState(false);

  const [dataset, setDataset] = useState<LoadedDataset | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataProgress, setDataProgress] = useState("");
  const [dataError, setDataError] = useState<string | null>(null);

  const latest = useRef({ settings, memory, mode, repo, devTool, depScan, dataset });
  latest.current = { settings, memory, mode, repo, devTool, depScan, dataset };

  const effectiveTheme =
    settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;
  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === "system") delete root.dataset.theme;
    else root.dataset.theme = settings.theme;
  }, [settings.theme]);

  useEffect(() => saveMemory(memory), [memory]);

  const refreshUsage = useCallback(() => {
    if (latest.current.settings.byokKey) return;
    fetchUsage()
      .then(setUsage)
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchConfig()
      .then(setConfig)
      .catch(() => {});
    refreshUsage();
  }, [refreshUsage]);

  const captureMemory = useCallback((message: UIMessage) => {
    for (const part of message.parts) {
      if (!isToolUIPart(part) || getToolName(part) !== "save_memory") continue;
      if (part.state !== "output-available") continue;
      const output = part.output as { status?: string; fact?: string };
      if (output.status === "saved" && output.fact) {
        setMemory((items) => addMemoryItem(items, output.fact ?? "", part.toolCallId));
      }
    }
  }, []);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: "/api/chat",
        credentials: "same-origin",
        headers: (): Record<string, string> => {
          const s = latest.current.settings;
          if (!s.byokKey) return {};
          return { [BYOK_HEADER]: s.byokKey, ...(s.byokModel && { [MODEL_HEADER]: s.byokModel }) };
        },
        body: () => {
          const { mode: m, memory: mem, repo: r, devTool: tool, depScan: scan } = latest.current;
          let context: ChatContext | undefined;
          if (m === "dev" && tool === "repo" && r) {
            context = { kind: "github-repo", title: r.fullName, text: r.contextText };
          } else if (m === "dev" && tool === "deps" && scan) {
            context = {
              kind: "dep-scan",
              title: "dependency scan",
              text: formatScanForModel(scan.report),
            };
          } else if (m === "data" && latest.current.dataset) {
            const d = latest.current.dataset;
            context = {
              kind: "dataset",
              title: d.name,
              text: formatProfileForModel(d.name, d.profile),
            };
          }
          return { mode: m, memory: mem.map((x) => x.text), ...(context && { context }) };
        },
      }),
    [],
  );

  // --- Data Analyst: Python runs in a Web Worker in this browser ------------------
  const sandboxRef = useRef<PythonSandbox | null>(null);
  const artifactsRef = useRef<Artifacts>({ figures: new Map(), exports: new Map() });
  const [, setArtifactsVersion] = useState(0);
  const [toolsRunning, setToolsRunning] = useState(0);
  const addToolOutputRef = useRef<
    ((arg: { tool: string; toolCallId: string; output: unknown }) => unknown) | null
  >(null);

  const {
    messages,
    sendMessage,
    status,
    stop,
    error,
    regenerate,
    clearError,
    setMessages,
    addToolOutput,
  } = useChat({
    transport,
    // Browser-run tools: when every tool call has a result, send them back automatically.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onToolCall: async ({ toolCall }) => {
      if (toolCall.dynamic || !CLIENT_TOOL_NAMES.has(toolCall.toolName)) return;
      const sandbox = sandboxRef.current;
      setToolsRunning((n) => n + 1);
      let output: unknown;
      try {
        if (!sandbox || !latest.current.dataset)
          throw new Error("No file is loaded. Ask the user to load one.");
        output = await runClientTool(
          toolCall.toolName,
          toolCall.toolCallId,
          toolCall.input,
          sandbox,
          artifactsRef.current,
        );
        setArtifactsVersion((v) => v + 1);
      } catch (err) {
        output = { error: err instanceof Error ? err.message : String(err) };
      } finally {
        setToolsRunning((n) => n - 1);
      }
      // Not awaited, as the AI SDK docs advise, to avoid deadlocks.
      void addToolOutputRef.current?.({
        tool: toolCall.toolName,
        toolCallId: toolCall.toolCallId,
        output,
      });
    },
    onFinish: ({ message, isError, isAbort }) => {
      captureMemory(message);
      refreshUsage();
      if (!isError && !isAbort) {
        setCelebrating(true);
        window.setTimeout(() => setCelebrating(false), 2500);
      }
    },
  });
  addToolOutputRef.current = addToolOutput as unknown as typeof addToolOutputRef.current;

  const busy = status === "submitted" || status === "streaming" || toolsRunning > 0;

  const loadDataset = async (file: File) => {
    if (file.size > MAX_DATA_BYTES) {
      setDataError(
        `That file is ${Math.round(file.size / 1e6)} MB; the limit here is 20 MB. The CLI (npx mofu analyze) handles bigger files.`,
      );
      return;
    }
    setDataError(null);
    setDataLoading(true);
    try {
      sandboxRef.current ??= createBrowserSandbox(setDataProgress);
      const profile = await sandboxRef.current.load(
        file.name,
        new Uint8Array(await file.arrayBuffer()),
      );
      artifactsRef.current = { figures: new Map(), exports: new Map() };
      setDataset({ name: file.name, profile });
      if (messages.length > 0) {
        if (busy) void stop();
        clearError();
        setMessages([]);
      }
      setCelebrating(true);
      window.setTimeout(() => setCelebrating(false), 2500);
    } catch (err) {
      setDataError(
        `Couldn't read ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setDataLoading(false);
      setDataProgress("");
    }
  };

  /** The latest answer plus every chart, as one Markdown file. */
  const downloadReport = () => {
    const charts = [...artifactsRef.current.figures.values()].flat();
    const text = [
      `# Analysis of ${dataset?.name ?? "dataset"}`,
      "",
      lastAssistantText ?? "",
      ...(charts.length
        ? [
            "",
            "## Charts",
            "",
            ...charts.map((png, i) => `![Chart ${i + 1}](data:image/png;base64,${png})`),
          ]
        : []),
      "",
      "_Generated by Mofu. Numbers come from Python run on your file in the browser._",
    ].join("\n");
    downloadText(
      `${(dataset?.name ?? "data").replace(/\.\w+$/, "")}-report.md`,
      text,
      "text/markdown",
    );
  };

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    threadEnd.current?.scrollIntoView({ block: "end", behavior: reduce ? "auto" : "smooth" });
  }, [messages, status]);

  // --- Turnstile session -------------------------------------------------

  const ensureSession = useCallback(async (): Promise<boolean> => {
    if (sessionExpiry.current > Date.now() + 60_000) return true;
    setVerifyOpen(true);
    return new Promise<boolean>((resolve) => {
      verifyResolver.current = resolve;
    });
  }, []);

  const finishVerify = useCallback((ok: boolean) => {
    setVerifyOpen(false);
    verifyResolver.current?.(ok);
    verifyResolver.current = null;
  }, []);

  const onToken = useCallback(
    (token: string) => {
      createSession(token)
        .then((s) => {
          sessionExpiry.current = Date.parse(s.expiresAt);
          finishVerify(true);
        })
        .catch(() => finishVerify(false));
    },
    [finishVerify],
  );

  // --- Sending -------------------------------------------------------------

  const send = async (text: string) => {
    clearError();
    if (!(await ensureSession())) return;
    void sendMessage({ text });
  };

  const retry = async () => {
    if (parseApiError(error)?.code === "session_required") sessionExpiry.current = 0;
    if (!(await ensureSession())) return;
    clearError();
    void regenerate();
  };

  const loadRepo = async (url: string) => {
    setRepoLoading(true);
    setRepoError(null);
    try {
      const loaded = await loadGitHubRepo(url);
      setRepo(loaded);
      // Answers about the previous repository would be misleading now.
      if (messages.length > 0) {
        if (busy) void stop();
        clearError();
        setMessages([]);
      }
    } catch (err) {
      setRepoError(
        err instanceof GitHubError
          ? err
          : new GitHubError("Couldn't read that repository.", "network"),
      );
    } finally {
      setRepoLoading(false);
    }
  };

  const newChat = () => {
    if (busy) void stop();
    clearError();
    setMessages([]);
  };

  // --- Derived UI state ------------------------------------------------------

  const apiError = parseApiError(error);
  const led =
    toolsRunning > 0 || dataLoading
      ? "ANALYZING"
      : busy
        ? "THINKING"
        : repoLoading || scanning
          ? "SCANNING"
          : error
            ? "ERROR"
            : celebrating
              ? "DONE"
              : "READY";
  const mascotState: MascotState =
    busy || repoLoading || scanning || dataLoading ? "focus" : celebrating ? "found" : "ready";

  const depsMode = mode === "dev" && devTool === "deps";
  const dataMode = mode === "data";
  const toolArtifacts = dataMode
    ? {
        ...artifactsRef.current,
        download: (name: string, text: string) => downloadText(name, text),
      }
    : undefined;
  const lastAssistantText =
    messages
      .filter((m) => m.role === "assistant")
      .at(-1)
      ?.parts.map((p) => (p.type === "text" ? p.text : ""))
      .join("") ?? null;
  const verifyAgainstScan =
    depsMode && depScan
      ? (text: string) => findUnverifiedReferences(text, depScan.report)
      : undefined;

  const emptyCopy = dataMode
    ? dataset
      ? {
          title: `Ask about ${dataset.name}`,
          body: "Every number comes from Python run on your file, right here in the browser. Charts appear in the chat.",
          suggestions: suggestQuestions(dataset.profile),
        }
      : {
          title: "Analyze a spreadsheet",
          body: "Drop a CSV, Excel or JSON file above. Mofu profiles it, answers questions with real calculations, draws charts and can pull in exchange rates, holidays, weather or World Bank data.",
          suggestions: [],
        }
    : depsMode
      ? depScan
        ? {
            title: "Ask about this scan",
            body: "Mofu explains the findings and plans the upgrades. To apply them on a branch and run your tests, use the CLI: npx mofu deps --fix.",
            suggestions: DEPS_SUGGESTIONS,
          }
        : {
            title: "Scan your dependencies",
            body: "Paste a public GitHub URL or upload package.json, package-lock.json, requirements.txt or pyproject.toml. Mofu checks every package against OSV and deps.dev, right in your browser.",
            suggestions: [],
          }
      : mode === "dev"
        ? repo
          ? {
              title: `Ask about ${repo.fullName}`,
              body: 'Mofu has a map of the repository and its key files. To change code, open a pull request or run tests, use the CLI: npx mofu task "…".',
              suggestions: DEV_SUGGESTIONS,
            }
          : {
              title: "Explain any public GitHub repository",
              body: "Paste a GitHub URL above. Mofu reads its structure, manifests and key files in your browser, then explains how it works.",
              suggestions: [],
            }
        : {
            title: "What can I help with?",
            body: "Mofu can look things up on Wikipedia, define words and remember your preferences. Analyze a spreadsheet in Data Analyst, or explain a repository and scan dependencies in Dev Tools. Study Buddy is on the way.",
            suggestions: SUGGESTIONS,
          };

  const usageLabel = settings.byokKey
    ? `Your key · ${shortModel(settings.byokModel || config?.defaultModel || "")}`
    : usage && !usage.freeTierEnabled
      ? "Free tier paused"
      : usage
        ? `${usage.remaining} of ${usage.limit} free messages left today`
        : "";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Mascot state={mascotState} px={2} />
          <span className="wordmark">mofu</span>
          <span className={`led led--${led.toLowerCase()}`} role="status" aria-live="polite">
            {led}
          </span>
        </div>
        <div className="topbar-actions">
          {usageLabel && <span className="usage">{usageLabel}</span>}
          <button
            type="button"
            className="ghost-button"
            onClick={newChat}
            disabled={messages.length === 0}
          >
            New chat
          </button>
          <button type="button" className="ghost-button" onClick={() => setDialog("memory")}>
            Memory{memory.length > 0 && <span className="count">{memory.length}</span>}
          </button>
          <button type="button" className="ghost-button" onClick={() => setDialog("settings")}>
            Settings
          </button>
        </div>
      </header>

      <nav className="modes" aria-label="Modes">
        {MODES.map((m) => {
          const available = AVAILABLE_MODES.includes(m);
          return (
            <button
              key={m}
              type="button"
              className={`mode${mode === m ? " mode--active" : ""}`}
              aria-pressed={mode === m}
              disabled={!available}
              onClick={() => setMode(m)}
            >
              {MODE_LABELS[m]}
              {!available && <span className="soon">Soon</span>}
            </button>
          );
        })}
      </nav>

      {/* Always rendered (empty outside Dev Tools) so the grid rows stay stable. */}
      <div className="repo-bar">
        {mode === "data" && (
          <DataPanel
            dataset={dataset}
            loading={dataLoading}
            progress={dataProgress}
            error={dataError}
            busy={busy}
            canDownloadReport={Boolean(lastAssistantText)}
            onFile={(f) => void loadDataset(f)}
            onClear={() => {
              setDataset(null);
              if (messages.length > 0) newChat();
            }}
            onReport={() => void send(REPORT_PROMPT)}
            onDownloadReport={downloadReport}
          />
        )}
        {mode === "dev" && (
          <>
            <div className="segmented dev-tabs" role="tablist" aria-label="Dev Tools">
              {(["repo", "deps"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={devTool === t}
                  className={devTool === t ? "active" : ""}
                  onClick={() => setDevTool(t)}
                >
                  {t === "repo" ? "Explain a repo" : "Scan dependencies"}
                </button>
              ))}
            </div>
            {devTool === "repo" ? (
              <RepoPanel
                repo={repo}
                loading={repoLoading}
                error={repoError}
                onLoad={(url) => void loadRepo(url)}
                onClear={() => {
                  setRepo(null);
                  setRepoError(null);
                }}
              />
            ) : (
              !depScan && (
                <DepsPanel
                  scanning={scanning}
                  onScanStart={() => setScanning(true)}
                  onError={() => setScanning(false)}
                  onScanned={(report, source) => {
                    setScanning(false);
                    setDepScan({ report, source });
                    if (messages.length > 0) {
                      if (busy) void stop();
                      clearError();
                      setMessages([]);
                    }
                    setCelebrating(true);
                    window.setTimeout(() => setCelebrating(false), 2500);
                  }}
                />
              )
            )}
          </>
        )}
      </div>

      <main className="thread" aria-live="polite">
        {depsMode && depScan && (
          <ScanResults
            report={depScan.report}
            source={depScan.source}
            summary={lastAssistantText}
            busy={busy}
            onAskPlan={() => void send("Give me a prioritized upgrade plan for these findings.")}
            onClear={() => {
              setDepScan(null);
              if (messages.length > 0) newChat();
            }}
          />
        )}
        {messages.length === 0 ? (
          <section className="empty">
            <Mascot state={mascotState} px={7} className="empty-mascot" />
            <h1>{emptyCopy.title}</h1>
            <p className="muted">{emptyCopy.body}</p>
            <div className="suggestions">
              {emptyCopy.suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="suggestion"
                  onClick={() => void send(s)}
                  disabled={busy}
                >
                  {s}
                </button>
              ))}
            </div>
          </section>
        ) : (
          messages.map((m) => (
            <MessageView
              key={m.id}
              message={m}
              {...(verifyAgainstScan && status !== "streaming" && { verify: verifyAgainstScan })}
              {...(toolArtifacts && { artifacts: toolArtifacts })}
            />
          ))
        )}
        {status === "submitted" && <div className="thinking">Mofu is thinking…</div>}

        {error && (
          <div className="error-banner" role="alert">
            {apiError?.code === "daily_limit" ? (
              <>
                <p>
                  {apiError.message}
                  {apiError.resetAt && ` They reset at ${formatTime(apiError.resetAt)}.`} Add your
                  own OpenRouter key to keep going.
                </p>
                <button type="button" className="pill-button" onClick={() => setDialog("settings")}>
                  Use my own key
                </button>
              </>
            ) : apiError?.code === "free_tier_disabled" ? (
              <>
                <p>{apiError.message}</p>
                <button type="button" className="pill-button" onClick={() => setDialog("settings")}>
                  Use my own key
                </button>
              </>
            ) : apiError?.code === "invalid_key" ? (
              <>
                <p>{apiError.message}</p>
                <button type="button" className="pill-button" onClick={() => setDialog("settings")}>
                  Open settings
                </button>
              </>
            ) : (
              <>
                <p>{apiError?.message ?? error.message ?? "Something went wrong."}</p>
                <button type="button" className="pill-button" onClick={() => void retry()}>
                  {apiError?.code === "session_required" ? "Verify and retry" : "Retry"}
                </button>
              </>
            )}
          </div>
        )}
        <div ref={threadEnd} />
      </main>

      <footer className="composer-wrap">
        <Composer
          busy={busy}
          disabled={!config}
          onSend={(t) => void send(t)}
          onStop={() => void stop()}
          files={files}
          onFilesChange={setFiles}
        />
      </footer>

      <SettingsDialog
        open={dialog === "settings"}
        settings={settings}
        defaultModel={config?.defaultModel ?? ""}
        ensureSession={ensureSession}
        onClose={() => setDialog(null)}
        onSave={(next) => {
          setSettings(next);
          saveSettings(next);
          setDialog(null);
          clearError();
          if (!next.byokKey) refreshUsage();
        }}
      />
      <MemoryDialog
        open={dialog === "memory"}
        items={memory}
        onClose={() => setDialog(null)}
        onChange={setMemory}
      />
      <VerifyDialog
        open={verifyOpen}
        siteKey={config?.turnstileSiteKey ?? ""}
        theme={effectiveTheme}
        onToken={onToken}
        onCancel={() => finishVerify(false)}
      />
    </div>
  );
}
