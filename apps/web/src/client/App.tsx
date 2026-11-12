import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  LIMITS,
  MODEL_HEADER,
  MODE_LABELS,
  MODES,
  parseApiError,
  type ChatContext,
  type Mode,
  type PublicConfig,
  type UsageInfo,
} from "../shared/api.js";
import {
  ApiRequestError,
  createSession,
  fetchConfig,
  fetchPage,
  fetchUsage,
  scanTokenAddress,
  explainTx,
  checkWallet,
} from "./lib/api.js";
import { TokenPanel, TokenReport, TxReportView } from "./components/TokenScan.js";
import { WalletHealthView } from "./components/WalletHealth.js";
import {
  formatTokenScanForModel,
  formatTxForModel,
  formatWalletForModel,
} from "../shared/token-scan-text.js";
import type { TokenScanReport, TxReport, WalletReport } from "../shared/api.js";
import { walletAccount, WalletError } from "./lib/wallet.js";
import { StudyPanel } from "./components/StudyPanel.js";
import { ApiPanel } from "./components/ApiPanel.js";
import { ApiResults } from "./components/ApiResults.js";
import {
  apiContextText,
  diffApis,
  MAX_SPEC_BYTES,
  parseApi,
  SpecError,
  type ApiDiffState,
  type LoadedApi,
} from "./lib/apiforge.js";
import type { SpecProblem } from "@mofu/core/apiforge";
import {
  documentFromPage,
  loadStudyFile,
  runStudyTool,
  STUDY_TOOLS,
  type LoadedDocument,
} from "./lib/study.js";
import { GitHubError, loadGitHubRepo, type LoadedRepo } from "./lib/github.js";
import { BuilderPanel } from "./components/BuilderPanel.js";
import { RepoPanel } from "./components/RepoPanel.js";
import { DepsPanel } from "./components/DepsPanel.js";
import { ScanResults } from "./components/ScanResults.js";
import {
  API_TOOL_NAMES,
  documentOutline,
  findUnverifiedReferences,
  ScannedPdfError,
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
import { VoteDialog } from "./components/VoteDialog.js";
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
  const [dialog, setDialog] = useState<"settings" | "memory" | "vote" | null>(null);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [celebrating, setCelebrating] = useState(false);

  const sessionExpiry = useRef(0);
  const verifyResolver = useRef<((ok: boolean) => void) | null>(null);
  const threadEnd = useRef<HTMLDivElement>(null);

  const [repo, setRepo] = useState<LoadedRepo | null>(null);
  const [repoLoading, setRepoLoading] = useState(false);
  const [repoError, setRepoError] = useState<GitHubError | null>(null);

  // The transport reads the latest settings through a ref, so it's created once.
  const [devTool, setDevTool] = useState<"repo" | "deps" | "api" | "token" | "audit" | "secrets">(
    "repo",
  );
  const [tokenScan, setTokenScan] = useState<{
    report: TokenScanReport;
    remaining: number | null;
  } | null>(null);
  const [txScan, setTxScan] = useState<{ report: TxReport; remaining: number | null } | null>(null);
  const [walletScan, setWalletScan] = useState<{
    report: WalletReport;
    remaining: number | null;
  } | null>(null);
  const [tokenScanning, setTokenScanning] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [depScan, setDepScan] = useState<{ report: ScanReport; source: string } | null>(null);
  const [scanning, setScanning] = useState(false);

  const [dataset, setDataset] = useState<LoadedDataset | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataProgress, setDataProgress] = useState("");
  const [dataError, setDataError] = useState<string | null>(null);

  const [study, setStudy] = useState<LoadedDocument | null>(null);
  const [studyLoading, setStudyLoading] = useState(false);
  const [studyError, setStudyError] = useState<string | null>(null);

  // APIForge: the spec is parsed in the browser; apiContext is the text sent to the model.
  const [api, setApi] = useState<LoadedApi | null>(null);
  const [apiDiff, setApiDiff] = useState<ApiDiffState | null>(null);
  const [apiContext, setApiContext] = useState("");
  const [apiLoading, setApiLoading] = useState(false);
  const [specError, setSpecError] = useState<{ message: string; problems: SpecProblem[] } | null>(
    null,
  );
  const [apiVersion, setApiVersion] = useState(0);

  const latest = useRef({
    walletScan,
    txScan,
    tokenScan,
    settings,
    memory,
    mode,
    repo,
    devTool,
    depScan,
    dataset,
    study,
    api,
    apiContext,
  });
  latest.current = {
    walletScan,
    txScan,
    tokenScan,
    settings,
    memory,
    mode,
    repo,
    devTool,
    depScan,
    dataset,
    study,
    api,
    apiContext,
  };

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
          } else if (m === "dev" && tool === "api" && latest.current.api) {
            context = {
              kind: "api-spec",
              title: latest.current.api.index.title,
              text: latest.current.apiContext,
            };
          } else if (m === "dev" && tool === "token" && latest.current.walletScan) {
            const w = latest.current.walletScan.report;
            context = {
              kind: "wallet",
              title: w.address.slice(0, 42),
              text: formatWalletForModel(w),
            };
          } else if (m === "dev" && tool === "token" && latest.current.txScan) {
            const tx = latest.current.txScan.report;
            context = { kind: "tx", title: tx.hash.slice(0, 18), text: formatTxForModel(tx) };
          } else if (m === "dev" && tool === "token" && latest.current.tokenScan) {
            const rep = latest.current.tokenScan.report;
            context = {
              kind: "token-scan",
              title: (rep.token.symbol ?? rep.address).slice(0, 100),
              text: formatTokenScanForModel(rep),
            };
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
          } else if (m === "study" && latest.current.study) {
            const doc = latest.current.study.doc;
            context = { kind: "document", title: doc.title, text: documentOutline(doc) };
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
      if (toolCall.dynamic) return;
      if (API_TOOL_NAMES.has(toolCall.toolName)) {
        let output: unknown;
        try {
          const workspace = latest.current.api?.workspace;
          if (!workspace) throw new Error("No spec is loaded. Ask the user to load one.");
          output = workspace.run(toolCall.toolName, toolCall.input);
          setApiVersion((v) => v + 1);
        } catch (err) {
          output = { error: err instanceof Error ? err.message : String(err) };
        }
        void addToolOutputRef.current?.({
          tool: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
          output,
        });
        return;
      }
      if (STUDY_TOOLS.has(toolCall.toolName)) {
        let output: unknown;
        try {
          const doc = latest.current.study?.doc;
          if (!doc) throw new Error("No document is loaded. Ask the user to load one.");
          output = runStudyTool(toolCall.toolName, toolCall.input, doc);
        } catch (err) {
          // Validation errors go back to the model so it can fix the cards or questions.
          output = { error: err instanceof Error ? err.message : String(err) };
        }
        void addToolOutputRef.current?.({
          tool: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
          output,
        });
        return;
      }
      if (!CLIENT_TOOL_NAMES.has(toolCall.toolName)) return;
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
        `That file is ${Math.round(file.size / 1e6)} MB; the limit here is 20 MB. The CLI (npx mofu-cli analyze) handles bigger files.`,
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

  // --- Study Buddy: documents are read in the browser ----------------------
  const docLimits = settings.byokKey
    ? { pages: LIMITS.byokDocPages, chars: LIMITS.byokDocChars }
    : { pages: LIMITS.freeDocPages, chars: LIMITS.freeDocChars };

  const openStudy = async (load: () => Promise<LoadedDocument>) => {
    setStudyError(null);
    setStudyLoading(true);
    try {
      const loaded = await load();
      if (!loaded.doc.parts.length) throw new Error("No readable text was found.");
      setStudy(loaded);
      if (messages.length > 0) {
        if (busy) void stop();
        clearError();
        setMessages([]);
      }
      setCelebrating(true);
      window.setTimeout(() => setCelebrating(false), 2500);
    } catch (err) {
      setStudyError(
        err instanceof ScannedPdfError
          ? "This PDF looks scanned (images of pages), so there's no text to read. Try a PDF with selectable text."
          : err instanceof ApiRequestError
            ? err.error.message
            : `Couldn't read that: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setStudyLoading(false);
    }
  };

  // --- APIForge ---------------------------------------------------------------
  const apiFailure = (err: unknown) =>
    setSpecError(
      err instanceof SpecError
        ? { message: err.message, problems: err.problems }
        : {
            message:
              err instanceof ApiRequestError
                ? err.error.message
                : `Couldn't read that spec: ${err instanceof Error ? err.message : String(err)}`,
            problems: [],
          },
    );

  const loadApiText = async (name: string, text: string) => {
    if (text.length > MAX_SPEC_BYTES) {
      setSpecError({
        message:
          "That spec is over 2 MB. The CLI handles bigger files: npx mofu-cli api docs <file>.",
        problems: [],
      });
      return;
    }
    setSpecError(null);
    setApiLoading(true);
    try {
      const loaded = await parseApi(name, text);
      setApiContext(await apiContextText(loaded, null));
      setApi(loaded);
      setApiDiff(null);
      if (messages.length > 0) {
        if (busy) void stop();
        clearError();
        setMessages([]);
      }
      setCelebrating(true);
      window.setTimeout(() => setCelebrating(false), 2500);
    } catch (err) {
      apiFailure(err);
    } finally {
      setApiLoading(false);
    }
  };

  const loadApiUrl = async (url: string) => {
    if (!(await ensureSession())) return;
    setApiLoading(true);
    try {
      const page = await fetchPage(url, "document");
      await loadApiText(page.title, page.text);
    } catch (err) {
      apiFailure(err);
    } finally {
      setApiLoading(false);
    }
  };

  const compareApi = async (name: string, text: string) => {
    if (!api) return;
    setSpecError(null);
    setApiLoading(true);
    try {
      const diff = await diffApis(api, name, text);
      setApiContext(await apiContextText(api, diff));
      setApiDiff(diff);
    } catch (err) {
      apiFailure(err);
    } finally {
      setApiLoading(false);
    }
  };

  const generateApi = (what: "tests" | "docs") => {
    if (!api) return;
    const groups = api.workspace.groups.join(", ");
    void send(
      what === "tests"
        ? `Generate test cases for every endpoint group (${groups}), one group at a time.`
        : `Write endpoint descriptions for every group (${groups}), one group at a time.`,
    );
  };

  const loadStudyUrl = async (url: string) => {
    if (!(await ensureSession())) return;
    await openStudy(async () => documentFromPage(await fetchPage(url), docLimits));
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

  const scanToken = async (address: string) => {
    setTokenError(null);
    if (!(await ensureSession())) return;
    setTokenScanning(true);
    try {
      const res = await scanTokenAddress(address);
      if (!res.report.isContract) {
        // A wallet, not a contract: show its approvals and holdings instead.
        setTokenScanning(false);
        await runWalletCheck(address);
        return;
      }
      setTxScan(null);
      setWalletScan(null);
      setTokenScan({ report: res.report, remaining: res.remaining });
      // Show the report from its top, also on small screens where the thread scrolls.
      window.setTimeout(() => {
        document.querySelector(".token-report")?.scrollIntoView({ block: "start" });
      }, 50);
      if (messages.length > 0) {
        if (busy) void stop();
        clearError();
        setMessages([]);
      }
      setCelebrating(true);
      window.setTimeout(() => setCelebrating(false), 2500);
      const url = new URL(location.href);
      url.searchParams.delete("tx");
      url.searchParams.set("scan", res.report.address);
      history.replaceState(null, "", url);
    } catch (err) {
      setTokenError(
        err instanceof ApiRequestError ? err.message : "Couldn't scan that address. Try again.",
      );
    } finally {
      setTokenScanning(false);
    }
  };

  const explainTransaction = async (hash: string) => {
    setTokenError(null);
    if (!(await ensureSession())) return;
    setTokenScanning(true);
    try {
      const res = await explainTx(hash);
      setTokenScan(null);
      setWalletScan(null);
      setTxScan({ report: res.report, remaining: res.remaining });
      window.setTimeout(() => {
        document.querySelector(".token-report")?.scrollIntoView({ block: "start" });
      }, 50);
      if (messages.length > 0) {
        if (busy) void stop();
        clearError();
        setMessages([]);
      }
      const url = new URL(location.href);
      url.searchParams.delete("scan");
      url.searchParams.set("tx", res.report.hash);
      history.replaceState(null, "", url);
    } catch (err) {
      setTokenError(
        err instanceof ApiRequestError ? err.message : "Couldn't read that transaction. Try again.",
      );
    } finally {
      setTokenScanning(false);
    }
  };

  const runWalletCheck = async (address: string) => {
    setTokenError(null);
    if (!(await ensureSession())) return;
    setTokenScanning(true);
    try {
      const res = await checkWallet(address);
      setTokenScan(null);
      setTxScan(null);
      setWalletScan({ report: res.report, remaining: res.remaining });
      window.setTimeout(() => {
        document.querySelector(".token-report")?.scrollIntoView({ block: "start" });
      }, 50);
      if (messages.length > 0) {
        if (busy) void stop();
        clearError();
        setMessages([]);
      }
      const url = new URL(location.href);
      url.searchParams.delete("tx");
      url.searchParams.set("scan", res.report.address);
      history.replaceState(null, "", url);
    } catch (err) {
      setTokenError(
        err instanceof ApiRequestError ? err.message : "Couldn't check that wallet. Try again.",
      );
    } finally {
      setTokenScanning(false);
    }
  };

  const checkMyWallet = async () => {
    setTokenError(null);
    try {
      await runWalletCheck(await walletAccount());
    } catch (err) {
      setTokenError(
        err instanceof WalletError
          ? err.kind === "no-wallet"
            ? "No wallet found in this browser. Paste your wallet address instead."
            : err.message
          : "Couldn't read your wallet. Paste your address instead.",
      );
    }
  };

  // A shared link (/app/?scan=0x…) opens the scanner and runs it.
  const deepLinkDone = useRef(false);
  useEffect(() => {
    if (deepLinkDone.current || !config) return;
    deepLinkDone.current = true;
    const params = new URLSearchParams(location.search);
    const target = params.get("scan");
    if (target && /^0x[0-9a-fA-F]{40}$/.test(target)) {
      setMode("dev");
      setDevTool("token");
      void scanToken(target);
      return;
    }
    const txHash = params.get("tx");
    if (txHash && /^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      setMode("dev");
      setDevTool("token");
      void explainTransaction(txHash);
      return;
    }
    // Links from Mofu Town and elsewhere: ?mode=data|study|dev, ?tool=…, ?open=holder.
    const m = params.get("mode");
    if (m && (MODES as readonly string[]).includes(m)) setMode(m as Mode);
    const tool = params.get("tool");
    if (
      tool === "repo" ||
      tool === "deps" ||
      tool === "api" ||
      tool === "token" ||
      tool === "audit" ||
      tool === "secrets"
    )
      setDevTool(tool);
    if (params.get("open") === "holder") setDialog("settings");
    if (params.get("open") === "vote") setDialog("vote");
  }, [config]);

  const newChat = () => {
    if (busy) void stop();
    clearError();
    setMessages([]);
  };

  // --- Derived UI state ------------------------------------------------------

  const apiError = parseApiError(error);
  const led =
    mode === "study" && (busy || studyLoading)
      ? "STUDYING"
      : toolsRunning > 0 || dataLoading
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
    busy || repoLoading || scanning || tokenScanning || dataLoading || studyLoading
      ? "focus"
      : celebrating
        ? "found"
        : "ready";

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

  const apiMode = mode === "dev" && devTool === "api";
  const tokenMode = mode === "dev" && devTool === "token";
  const emptyCopy = tokenMode
    ? walletScan
      ? {
          title: "Ask about this wallet",
          body: "Mofu explains which approvals matter and how revoking works. It never asks for your seed phrase.",
          suggestions: ["Which approval should I revoke first?", "What is an unlimited approval?"],
        }
      : txScan
        ? {
            title: "Ask about this transaction",
            body: "Mofu explains what happened and what any approval allows. It won't tell you to buy or sell.",
            suggestions: ["Is any approval here risky?", "Explain this like I'm new to crypto"],
          }
        : tokenScan
          ? {
              title: "Ask about this token",
              body: "Mofu explains what the contract can and can't do. It won't tell you to buy or sell.",
              suggestions: [
                "What's the biggest risk in this contract?",
                "Explain these findings like I'm new to crypto",
              ],
            }
          : {
              title: "Scan a token, a wallet or a transaction",
              body: "Paste a token address to see what its contract can do, whether it can be sold and who holds it; a wallet address to see its approvals and revoke risky ones; or a transaction hash to see in plain English what it did. Everything is read from Robinhood Chain.",
              suggestions: [],
            }
    : apiMode
      ? api
        ? {
            title: `Work with ${api.index.title}`,
            body: "Generate test cases or docs, compare with another version, or ask anything about the API. Tables and downloads appear above.",
            suggestions: [
              "Which endpoints need authentication?",
              "Summarize this API in a paragraph",
            ],
          }
        : {
            title: "Understand an API from its spec",
            body: "Load an OpenAPI or Swagger spec above. Mofu validates it, lists every endpoint, writes test cases and docs, and finds breaking changes between versions. Running tests against your server is in the CLI: npx mofu-cli api test.",
            suggestions: [],
          }
      : mode === "study"
        ? study
          ? {
              title: `Study ${study.doc.title}`,
              body: "Pick an action above or ask anything. Mofu reads the pages it needs and cites them, so you can check every answer.",
              suggestions: [],
            }
          : {
              title: "Study anything",
              body: "Upload a PDF or notes, or paste an article link. Mofu summarizes at three levels, makes flashcards you can export to Anki and quizzes you, citing the pages.",
              suggestions: [],
            }
        : dataMode
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
                  body: "Mofu explains the findings and plans the upgrades. To apply them on a branch and run your tests, use the CLI: npx mofu-cli deps --fix.",
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
                    body: 'Mofu has a map of the repository and its key files. To change code, open a pull request or run tests, use the CLI: npx mofu-cli task "…".',
                    suggestions: DEV_SUGGESTIONS,
                  }
                : {
                    title: "Explain any public GitHub repository",
                    body: "Paste a GitHub URL above. Mofu reads its structure, manifests and key files in your browser, then explains how it works.",
                    suggestions: [],
                  }
              : {
                  title: "What can I help with?",
                  body: "Mofu can look things up on Wikipedia, define words and remember your preferences. Study a PDF or article in Study Buddy, analyze a spreadsheet in Data Analyst, or explain a repository and scan dependencies in Dev Tools.",
                  suggestions: SUGGESTIONS,
                };

  const usageLabel = settings.byokKey
    ? `Your key · ${shortModel(settings.byokModel || config?.defaultModel || "")}`
    : usage && !usage.freeTierEnabled
      ? "Free tier paused"
      : usage
        ? `${usage.remaining} of ${usage.limit} ${usage.holder?.eligible ? "holder" : "free"} messages left today`
        : "";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Mascot state={mascotState} px={2} />
          <a className="wordmark" href="/" title="Mofu home">
            Mofu
          </a>
          <span className={`led led--${led.toLowerCase()}`} role="status" aria-live="polite">
            {led}
          </span>
        </div>
        <div className="topbar-actions">
          {usageLabel &&
            (config?.holder && !settings.byokKey ? (
              <button
                type="button"
                className="usage usage-button"
                title="Daily limit and $MOFU holder perks"
                onClick={() => setDialog("settings")}
              >
                {usageLabel}
              </button>
            ) : (
              <span className="usage">{usageLabel}</span>
            ))}
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
        {mode === "study" && (
          <StudyPanel
            // Remount on load/clear so the link field and page range start fresh.
            key={study ? "loaded" : "empty"}
            loaded={study}
            loading={studyLoading}
            error={studyError}
            busy={busy}
            maxPages={docLimits.pages}
            onFile={(f, range) => void openStudy(() => loadStudyFile(f, docLimits, range))}
            onUrl={(u) => void loadStudyUrl(u)}
            onAction={(p) => void send(p)}
            onClear={() => {
              setStudy(null);
              if (messages.length > 0) newChat();
            }}
          />
        )}
        {mode === "dev" && (
          <>
            <div className="segmented dev-tabs" role="tablist" aria-label="Dev Tools">
              {(["repo", "deps", "api", "token", "audit", "secrets"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={devTool === t}
                  className={devTool === t ? "active" : ""}
                  onClick={() => setDevTool(t)}
                >
                  {t === "repo"
                    ? "Explain a repo"
                    : t === "deps"
                      ? "Scan dependencies"
                      : t === "api"
                        ? "API spec"
                        : t === "token"
                          ? "Scan a token"
                          : t === "audit"
                            ? "Audit contract"
                            : "Find secrets"}
                </button>
              ))}
            </div>
            {devTool === "audit" || devTool === "secrets" ? (
              <BuilderPanel key={devTool} tool={devTool} />
            ) : devTool === "token" ? (
              !tokenScan &&
              !txScan &&
              !walletScan && (
                <TokenPanel
                  scanning={tokenScanning}
                  error={tokenError}
                  onScan={(a) => void scanToken(a)}
                  onTx={(h) => void explainTransaction(h)}
                  onMyWallet={() => void checkMyWallet()}
                />
              )
            ) : devTool === "api" ? (
              <ApiPanel
                api={api}
                loading={apiLoading}
                error={specError}
                busy={busy}
                onText={(n, t) => void loadApiText(n, t)}
                onUrl={(u) => void loadApiUrl(u)}
                onGenerate={generateApi}
                onCompare={(n, t) => void compareApi(n, t)}
                onClear={() => {
                  setApi(null);
                  setApiDiff(null);
                  setSpecError(null);
                  if (messages.length > 0) newChat();
                }}
              />
            ) : devTool === "repo" ? (
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
        {apiMode && api && (
          <ApiResults
            api={api}
            diff={apiDiff}
            busy={busy}
            version={apiVersion}
            onExplainDiff={() =>
              void send(
                "Explain the impact of the breaking changes in the diff for API consumers, and write a short migration note.",
              )
            }
            onClearDiff={() => {
              setApiDiff(null);
              void apiContextText(api, null).then(setApiContext);
            }}
          />
        )}
        {tokenMode && tokenScan && (
          <TokenReport
            report={tokenScan.report}
            remaining={tokenScan.remaining}
            busy={busy}
            onExplain={() =>
              void send(
                "Explain this token scan in plain language: what can this contract do, which findings matter most, and what the scan can't see.",
              )
            }
            onClear={() => {
              setTokenScan(null);
              setTokenError(null);
              const url = new URL(location.href);
              url.searchParams.delete("scan");
              history.replaceState(null, "", url);
              if (messages.length > 0) newChat();
            }}
            onUnlock={() => setDialog("settings")}
            onScanOther={(a) => void scanToken(a)}
          />
        )}
        {tokenMode && walletScan && (
          <WalletHealthView
            report={walletScan.report}
            remaining={walletScan.remaining}
            busy={busy || tokenScanning}
            onExplain={() =>
              void send(
                "Explain this wallet check in plain language: which approvals matter most, why, and which ones I should revoke.",
              )
            }
            onRecheck={() => void runWalletCheck(walletScan.report.address)}
            onClear={() => {
              setWalletScan(null);
              setTokenError(null);
              const url = new URL(location.href);
              url.searchParams.delete("scan");
              history.replaceState(null, "", url);
              if (messages.length > 0) newChat();
            }}
            onScanToken={(a) => void scanToken(a)}
          />
        )}
        {tokenMode && txScan && (
          <TxReportView
            report={txScan.report}
            remaining={txScan.remaining}
            busy={busy}
            onExplain={() =>
              void send(
                "Explain this transaction in plain language: what happened, who received what, and whether any approval in it is risky.",
              )
            }
            onClear={() => {
              setTxScan(null);
              setTokenError(null);
              const url = new URL(location.href);
              url.searchParams.delete("tx");
              history.replaceState(null, "", url);
              if (messages.length > 0) newChat();
            }}
          />
        )}
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
              {...(mode === "study" && { study: { busy, onAsk: (t: string) => void send(t) } })}
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
        holderPerks={config?.holder ?? null}
        holder={usage?.holder ?? null}
        freeDailyLimit={config?.freeDailyLimit ?? 10}
        onOpenVote={() => setDialog("vote")}
        onHolderChange={() => {
          fetchUsage()
            .then(setUsage)
            .catch(() => {});
        }}
        onClose={() => setDialog(null)}
        onSave={(next) => {
          setSettings(next);
          saveSettings(next);
          setDialog(null);
          clearError();
          if (!next.byokKey) refreshUsage();
        }}
      />
      <VoteDialog
        open={dialog === "vote"}
        onClose={() => setDialog(null)}
        ensureSession={ensureSession}
        onConnect={() => setDialog("settings")}
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
        theme="dark"
        onToken={onToken}
        onCancel={() => finishVerify(false)}
      />
    </div>
  );
}
