import { z } from "zod";
import {
  CountryInput,
  fetchCountries,
  fetchFxRates,
  fetchHolidays,
  fetchIndicator,
  fetchWeather,
  FxRatesInput,
  HolidaysInput,
  IndicatorInput,
  WeatherInput,
  type EnrichmentResult,
} from "./enrich.js";
import type { HttpOptions } from "../deps/http.js";

/**
 * Data Analyst tools. The web server declares them without an `execute`
 * (the browser runs them); the CLI binds them to a Node sandbox.
 */

export const RunPythonInput = z.object({
  code: z
    .string()
    .min(1)
    .max(20_000)
    .describe(
      "Python code. The dataset is the pandas DataFrame `df`. The value of the last line is shown.",
    ),
});

export const ExportCsvInput = z.object({
  variable: z
    .string()
    .regex(/^[A-Za-z_]\w*$/)
    .default("df")
    .describe("Name of the DataFrame to export."),
  filename: z
    .string()
    .regex(/^[\w.-]{1,80}$/)
    .describe("e.g. 'cleaned_sales.csv'"),
});

export interface DataToolSpec {
  name: string;
  description: string;
  inputSchema: z.ZodType;
}

export const RUN_PYTHON_SPEC: DataToolSpec = {
  name: "run_python",
  description:
    "Run Python in the data sandbox (pandas as pd, numpy as np, matplotlib.pyplot as plt; no internet, no pip). " +
    "The user's dataset is `df`. Variables persist between calls. Returns printed output, the value of the last " +
    "line (truncated), errors, and how many charts were made; charts are shown to the user automatically. " +
    "Keep outputs small: print aggregates, head() or describe(), never the whole table.",
  inputSchema: RunPythonInput,
};

export const EXPORT_CSV_SPEC: DataToolSpec = {
  name: "export_csv",
  description:
    "Give the user a DataFrame from the sandbox as a CSV file (e.g. cleaned or aggregated data). Returns the file name and row count.",
  inputSchema: ExportCsvInput,
};

interface EnrichmentSpec extends DataToolSpec {
  fetch: (input: never, http: HttpOptions) => Promise<EnrichmentResult>;
}

export const ENRICHMENT_SPECS: EnrichmentSpec[] = [
  {
    name: "fx_rates",
    description:
      "Fetch daily ECB exchange rates for a date range into /data/fx_<BASE>.csv, e.g. to convert a price column using each row's date.",
    inputSchema: FxRatesInput,
    fetch: fetchFxRates as EnrichmentSpec["fetch"],
  },
  {
    name: "public_holidays",
    description:
      "Fetch public holidays for a country and years into /data/holidays_<CC>.csv, e.g. to check whether sales dips fall on holidays.",
    inputSchema: HolidaysInput,
    fetch: fetchHolidays as EnrichmentSpec["fetch"],
  },
  {
    name: "historical_weather",
    description:
      "Fetch daily historical weather (mean/max/min temperature, precipitation) for a place and date range into /data/weather_<place>.csv.",
    inputSchema: WeatherInput,
    fetch: fetchWeather as EnrichmentSpec["fetch"],
  },
  {
    name: "country_info",
    description:
      "Fetch country names, regions, income levels, capitals and population for ISO codes into /data/countries.csv.",
    inputSchema: CountryInput,
    fetch: fetchCountries as EnrichmentSpec["fetch"],
  },
  {
    name: "economic_indicator",
    description:
      "Fetch a World Bank indicator (GDP, inflation, population…) per country and year into /data/wb_<indicator>.csv.",
    inputSchema: IndicatorInput,
    fetch: fetchIndicator as EnrichmentSpec["fetch"],
  },
];

/** Every Data Analyst tool, for declaring them to the model. */
export const DATA_TOOL_SPECS: DataToolSpec[] = [
  RUN_PYTHON_SPEC,
  ...ENRICHMENT_SPECS,
  EXPORT_CSV_SPEC,
];

/** Result of run_python as the sandbox returns it. Figures are base64 PNGs. */
export interface PythonRun {
  stdout: string;
  result: string | null;
  error: string | null;
  figures: string[];
}

/** What the model gets back from run_python: no image data, just a count. */
export function runResultForModel(run: PythonRun, figureNames: string[]) {
  return {
    ...(run.stdout && { stdout: run.stdout }),
    ...(run.result !== null && { result: run.result }),
    ...(run.error && { error: run.error }),
    ...(figureNames.length && {
      charts: `${figureNames.length} chart(s) shown to the user: ${figureNames.join(", ")}`,
    }),
  };
}

// ---------- Profile ----------

export interface ColumnProfile {
  name: string;
  dtype: string;
  kind: "numeric" | "datetime" | "categorical" | "text" | "boolean";
  nulls: number;
  unique: number;
  min?: number | string | null;
  max?: number | string | null;
  mean?: number | null;
  top?: Array<[string | number | null, number]>;
}

export interface DatasetProfile {
  rows: number;
  columns: ColumnProfile[];
  sample: Array<Record<string, unknown>>;
  problems: string[];
}

const MAX_PROFILE_CHARS = 12_000;

/** Compact profile text for the model (first thing it sees about the data). */
export function formatProfileForModel(fileName: string, p: DatasetProfile): string {
  const lines = [
    `# Dataset: ${fileName}`,
    `${p.rows} rows × ${p.columns.length} columns`,
    "",
    "## Columns",
  ];
  for (const c of p.columns) {
    const stats =
      c.kind === "numeric"
        ? `min ${c.min}, max ${c.max}, mean ${c.mean}`
        : c.kind === "datetime"
          ? `from ${c.min} to ${c.max}`
          : c.top
            ? `top: ${c.top.map(([v, n]) => `${v} (${n})`).join(", ")}`
            : "";
    lines.push(
      `- ${c.name} [${c.kind}, ${c.dtype}] nulls ${c.nulls}, unique ${c.unique}${stats ? `; ${stats}` : ""}`,
    );
  }
  lines.push(
    "",
    "## First rows",
    "```json",
    JSON.stringify(p.sample, null, 0).replace(/},{/g, "},\n{"),
    "```",
  );
  if (p.problems.length) lines.push("", "## Possible problems", ...p.problems.map((x) => `- ${x}`));
  const text = lines.join("\n");
  return text.length > MAX_PROFILE_CHARS ? `${text.slice(0, MAX_PROFILE_CHARS)}\n…` : text;
}

/** Starter questions from the profile, without a model call. */
export function suggestQuestions(p: DatasetProfile): string[] {
  const numeric = p.columns.filter((c) => c.kind === "numeric");
  const date = p.columns.find((c) => c.kind === "datetime");
  const category = p.columns.find((c) => c.kind === "categorical");
  const out: string[] = [];
  if (date && numeric[0]) out.push(`Chart ${numeric[0].name} by month`);
  if (category && numeric[0])
    out.push(`Which ${category.name} has the highest total ${numeric[0].name}?`);
  if (p.problems.length) out.push("Clean up the problems in this data and export a CSV");
  if (numeric.length >= 2) out.push(`How are ${numeric[0]!.name} and ${numeric[1]!.name} related?`);
  out.push("Summarize this dataset");
  return out.slice(0, 4);
}
