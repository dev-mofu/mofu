/**
 * The Python side of the data sandbox and the message protocol around it.
 * Shared by the browser Web Worker and the Node worker thread, so this file
 * must not import anything (it's loaded directly by Node's type stripping).
 */

/** Runs once after pandas and matplotlib are loaded. */
export const HARNESS_PY = String.raw`
import io, json, base64, ast, contextlib, warnings, re, traceback
import pandas as pd
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
warnings.filterwarnings("ignore")

_ns = {"pd": pd, "np": np, "plt": plt}
_MAX_OUT = 6000
_MAX_CELL = 80
_DATE_RE = re.compile(r"^\s*(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})")
_DATE_PATTERNS = [
    ("YYYY-MM-DD", re.compile(r"^\d{4}-\d{1,2}-\d{1,2}")),
    ("DD/MM/YYYY or MM/DD/YYYY", re.compile(r"^\d{1,2}/\d{1,2}/\d{2,4}")),
    ("DD.MM.YYYY", re.compile(r"^\d{1,2}\.\d{1,2}\.\d{2,4}")),
    ("DD-MM-YYYY", re.compile(r"^\d{1,2}-\d{1,2}-\d{2,4}")),
]

def _trunc(text, limit=_MAX_OUT):
    text = str(text)
    return text if len(text) <= limit else text[:limit] + f"\n...[truncated {len(text) - limit} characters]"

def _cell(v):
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return None
    if isinstance(v, (pd.Timestamp,)):
        return v.isoformat()
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return float(v)
    s = str(v)
    return s if len(s) <= _MAX_CELL else s[:_MAX_CELL] + "..."

def _num(v):
    if v is None:
        return None
    try:
        f = float(v)
        return None if np.isnan(f) else round(f, 6)
    except (TypeError, ValueError):
        return None

def _is_text(s):
    # pandas 3 stores text as the "str" dtype, older versions as object.
    return s.dtype == object or pd.api.types.is_string_dtype(s)

def _load(path):
    low = path.lower()
    if low.endswith((".xlsx", ".xlsm")):
        df = pd.read_excel(path)
    elif low.endswith(".json"):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            rows = next((v for v in data.values() if isinstance(v, list)), [data])
        else:
            rows = data
        df = pd.json_normalize(rows)
    else:
        df = pd.read_csv(path, sep=None, engine="python")
    df.columns = [str(c).strip() for c in df.columns]
    for c in df.columns:
        if _is_text(df[c]):
            sample = df[c].dropna().astype(str).head(300)
            if len(sample) and sample.str.match(_DATE_RE).mean() > 0.8:
                parsed = pd.to_datetime(df[c], errors="coerce", format="mixed")
                if parsed.notna().mean() > 0.8:
                    _ns["_raw_" + c] = df[c].copy()
                    df[c] = parsed
    _ns["df"] = df
    return _profile()

def _kind(s):
    if pd.api.types.is_bool_dtype(s):
        return "boolean"
    if pd.api.types.is_numeric_dtype(s):
        return "numeric"
    if pd.api.types.is_datetime64_any_dtype(s):
        return "datetime"
    nunique = s.nunique(dropna=True)
    return "categorical" if nunique <= max(20, len(s) * 0.05) else "text"

def _profile():
    df = _ns["df"]
    cols, problems = [], []
    dup = int(df.duplicated().sum())
    if dup:
        problems.append(f"{dup} duplicate rows")
    for c in df.columns:
        s = df[c]
        info = {"name": c, "dtype": str(s.dtype), "kind": _kind(s), "nulls": int(s.isna().sum()), "unique": int(s.nunique(dropna=True))}
        if info["kind"] == "numeric":
            info.update(min=_num(s.min()), max=_num(s.max()), mean=_num(s.mean()))
            q1, q3 = s.quantile(0.25), s.quantile(0.75)
            iqr = q3 - q1
            out = 0
            if iqr and not np.isnan(iqr):
                out = int(((s < q1 - 3 * iqr) | (s > q3 + 3 * iqr)).sum())
            else:
                # Nearly constant column (IQR 0): flag values far from the median, e.g. a typo'd 950 among 9.5s.
                med = s.median()
                if med and not np.isnan(med):
                    out = int(((s - med).abs() > 10 * abs(med)).sum())
            if out:
                problems.append(f"{c}: {out} extreme outliers")
        elif info["kind"] == "datetime":
            info.update(min=_cell(s.min()), max=_cell(s.max()))
            raw = _ns.get("_raw_" + c)
            if raw is not None:
                seen = {name for name, rx in _DATE_PATTERNS if raw.dropna().astype(str).str.match(rx).any()}
                if len(seen) > 1:
                    problems.append(f"{c}: mixed date formats ({', '.join(sorted(seen))})")
        else:
            top = s.astype(str).value_counts(dropna=True).head(5)
            info["top"] = [[_cell(k), int(v)] for k, v in top.items()]
            if _is_text(s):
                numeric = pd.to_numeric(s.dropna(), errors="coerce").notna().mean() if s.notna().any() else 0
                if 0.2 < numeric < 0.95:
                    problems.append(f"{c}: mixed types ({round(numeric * 100)}% numbers, the rest text)")
        if info["nulls"]:
            pct = info["nulls"] / max(len(df), 1)
            if pct > 0.2:
                problems.append(f"{c}: {round(pct * 100)}% missing")
        cols.append(info)
    sample = [{k: _cell(v) for k, v in row.items()} for row in df.head(5).to_dict("records")]
    return json.dumps({"rows": int(len(df)), "columns": cols, "sample": sample, "problems": problems})

def _repr(v):
    if isinstance(v, np.generic):
        v = v.item()  # show 7, not np.int64(7)
    if isinstance(v, (pd.DataFrame, pd.Series)):
        return _trunc(v.to_string(max_rows=40, max_cols=20))
    return _trunc(repr(v))

def _run(code):
    out = io.StringIO()
    plt.close("all")
    result, error = None, None
    try:
        tree = ast.parse(code, mode="exec")
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            exec(compile(tree, "<analysis>", "exec"), _ns)
            if last is not None:
                value = eval(compile(last, "<analysis>", "eval"), _ns)
                if value is not None:
                    result = _repr(value)
    except Exception as e:
        tb = traceback.format_exception(type(e), e, e.__traceback__)
        error = _trunc("".join(tb[-3:]), 2000)
    figures = []
    for num in plt.get_fignums()[:4]:
        buf = io.BytesIO()
        plt.figure(num).savefig(buf, format="png", dpi=110, bbox_inches="tight")
        figures.append(base64.b64encode(buf.getvalue()).decode())
    plt.close("all")
    return json.dumps({"stdout": _trunc(out.getvalue()), "result": result, "error": error, "figures": figures})

def _export(name):
    value = _ns.get(name)
    if isinstance(value, pd.Series):
        value = value.to_frame()
    if not isinstance(value, pd.DataFrame):
        raise ValueError(f"No DataFrame named '{name}'. Create it with run_python first.")
    return value.to_csv(index=False)
`;

/** Requests the host sends to the worker. */
export type WorkerRequest =
  | { id: number; type: "init" }
  | { id: number; type: "load"; name: string; bytes: Uint8Array }
  | { id: number; type: "run"; code: string }
  | { id: number; type: "write"; path: string; text: string }
  | { id: number; type: "export"; variable: string };

/** A request without its id (the host assigns ids). */
export type WorkerRequestBody = WorkerRequest extends infer R
  ? R extends WorkerRequest
    ? Omit<R, "id">
    : never
  : never;

export type WorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string }
  | { id: -1; progress: string };

/** The subset of the Pyodide API the handler uses. */
export interface PyodideLike {
  loadPackage(
    names: string[],
    options?: { messageCallback?: (m: string) => void },
  ): Promise<unknown>;
  runPythonAsync(code: string): Promise<unknown>;
  pyimport(name: string): { install(name: string): Promise<unknown> };
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: string | Uint8Array): void;
  };
  globals: { get(name: string): (...args: unknown[]) => unknown };
}

export const DATA_DIR = "/data";

/**
 * Handles one request. `lockNetwork` runs after packages (and openpyxl, if
 * needed) are installed, so model-written Python can't reach the network.
 */
export async function handleWorkerRequest(
  py: PyodideLike,
  req: WorkerRequest,
  state: { ready: boolean; networkLocked: boolean },
  lockNetwork: () => void,
  progress: (message: string) => void,
): Promise<unknown> {
  if (req.type === "init" || !state.ready) {
    if (!state.ready) {
      progress("Loading pandas and matplotlib…");
      await py.loadPackage(["pandas", "matplotlib", "micropip"]);
      await py.runPythonAsync(HARNESS_PY);
      py.FS.mkdirTree(DATA_DIR);
      state.ready = true;
    }
    if (req.type === "init") return true;
  }
  const call = (fn: string, ...args: unknown[]) => py.globals.get(fn)(...args);
  switch (req.type) {
    case "load": {
      if (/\.xlsx?m?$/i.test(req.name) && !state.networkLocked) {
        progress("Installing Excel support…");
        await py.pyimport("micropip").install("openpyxl");
      }
      lockNetwork();
      state.networkLocked = true;
      const safe = req.name.replace(/[^\w.-]+/g, "_").slice(-100) || "data.csv";
      const path = `${DATA_DIR}/${safe}`;
      py.FS.writeFile(path, req.bytes);
      progress("Profiling the data…");
      return JSON.parse(String(call("_load", path)));
    }
    case "run":
      return JSON.parse(String(call("_run", req.code)));
    case "write": {
      if (!/^\/data\/[\w.-]+$/.test(req.path))
        throw new Error("Files can only be written to /data/.");
      py.FS.writeFile(req.path, req.text);
      return true;
    }
    case "export":
      return String(call("_export", req.variable));
  }
}
