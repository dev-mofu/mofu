import { z } from "zod";
import { requestJson, type HttpOptions } from "../deps/http.js";

/**
 * Keyless public data, written as CSV into the sandbox's /data folder so
 * analysis code can join it with the user's dataset.
 */

export interface EnrichmentResult {
  /** Where the CSV goes inside the sandbox, e.g. /data/fx_EUR.csv */
  path: string;
  csv: string;
  rows: number;
  /** One line for the model: what was written and how to use it. */
  summary: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 3 * 366;
const MAX_ROWS = 50_000;

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (header: string[], rows: unknown[][]) =>
  [header.join(","), ...rows.slice(0, MAX_ROWS).map((r) => r.map(csvCell).join(","))].join("\n") +
  "\n";

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40) || "data";

function checkRange(start: string, end: string): void {
  if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) throw new Error("Dates must be YYYY-MM-DD.");
  const days = (Date.parse(end) - Date.parse(start)) / 86_400_000;
  if (!(days >= 0)) throw new Error("The end date must be on or after the start date.");
  if (days > MAX_DAYS)
    throw new Error("Ranges are limited to 3 years per call; split longer ranges.");
}

// ---------- Exchange rates (Frankfurter, ECB reference rates) ----------

export const FxRatesInput = z.object({
  base: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .describe("Base currency, e.g. 'USD'."),
  symbols: z
    .array(z.string().regex(/^[A-Za-z]{3}$/))
    .min(1)
    .max(10)
    .describe("Target currencies, e.g. ['EUR','JPY']."),
  start: z.string().describe("YYYY-MM-DD"),
  end: z.string().describe("YYYY-MM-DD"),
});

export async function fetchFxRates(
  input: z.infer<typeof FxRatesInput>,
  http: HttpOptions = {},
): Promise<EnrichmentResult> {
  checkRange(input.start, input.end);
  const base = input.base.toUpperCase();
  const symbols = input.symbols.map((s) => s.toUpperCase()).filter((s) => s !== base);
  // ECB publishes no rate on weekends and holidays (e.g. Jan 1). Start a week early so the
  // first days of the range can be forward-filled from the last real rate before them.
  const lookback = new Date(Date.parse(input.start) - FX_LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const data = await requestJson(
    `https://api.frankfurter.dev/v1/${lookback}..${input.end}?base=${base}&symbols=${symbols.join(",")}`,
    z.object({ rates: z.record(z.string(), z.record(z.string(), z.number())) }),
    http,
  );
  if (!data) throw new Error(`Frankfurter doesn't have rates for ${base}.`);
  const rows = Object.entries(data.rates).flatMap(([date, rates]) =>
    Object.entries(rates).map(([currency, rate]) => [date, base, currency, rate]),
  );
  return {
    path: `/data/fx_${base}.csv`,
    csv: toCsv(["date", "base", "currency", "rate"], rows),
    rows: rows.length,
    summary: `Wrote ${rows.length} rows (date, base, currency, rate: 1 ${base} = rate units of currency) to /data/fx_${base}.csv, starting ${FX_LOOKBACK_DAYS} days before ${input.start}. ECB rates exist for working days only: reindex to every calendar day and forward-fill (never back-fill) so each date uses the last published rate on or before it.`,
  };
}

const FX_LOOKBACK_DAYS = 7;

// ---------- Public holidays (Nager.Date) ----------

export const HolidaysInput = z.object({
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .describe("ISO 3166-1 alpha-2 country code, e.g. 'DE'."),
  years: z.array(z.number().int().min(1975).max(2100)).min(1).max(5),
});

export async function fetchHolidays(
  input: z.infer<typeof HolidaysInput>,
  http: HttpOptions = {},
): Promise<EnrichmentResult> {
  const cc = input.country.toUpperCase();
  const Holiday = z.object({
    date: z.string(),
    name: z.string(),
    localName: z.string().optional(),
    global: z.boolean().optional(),
  });
  const rows: unknown[][] = [];
  for (const year of [...new Set(input.years)].sort()) {
    const list = await requestJson(
      `https://date.nager.at/api/v3/PublicHolidays/${year}/${cc}`,
      z.array(Holiday),
      http,
    );
    if (!list) throw new Error(`No holiday data for country code ${cc}.`);
    for (const h of list) rows.push([h.date, h.name, h.localName ?? "", h.global ?? true]);
  }
  return {
    path: `/data/holidays_${cc}.csv`,
    csv: toCsv(["date", "name", "local_name", "nationwide"], rows),
    rows: rows.length,
    summary: `Wrote ${rows.length} public holidays (date, name, local_name, nationwide) for ${cc} to /data/holidays_${cc}.csv.`,
  };
}

// ---------- Historical weather (Open-Meteo archive + geocoding) ----------

export const WeatherInput = z.object({
  place: z
    .string()
    .max(100)
    .optional()
    .describe("City name, e.g. 'Berlin'. Or give latitude/longitude."),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  start: z.string().describe("YYYY-MM-DD"),
  end: z.string().describe("YYYY-MM-DD"),
});

export async function fetchWeather(
  input: z.infer<typeof WeatherInput>,
  http: HttpOptions = {},
): Promise<EnrichmentResult> {
  checkRange(input.start, input.end);
  let { latitude, longitude } = input;
  let label = `${latitude},${longitude}`;
  if (latitude === undefined || longitude === undefined) {
    if (!input.place) throw new Error("Give a place name or latitude and longitude.");
    const geo = await requestJson(
      `https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(input.place)}`,
      z.object({
        results: z
          .array(
            z.object({
              latitude: z.number(),
              longitude: z.number(),
              name: z.string(),
              country: z.string().optional(),
            }),
          )
          .optional(),
      }),
      http,
    );
    const hit = geo?.results?.[0];
    if (!hit) throw new Error(`Couldn't find a place called "${input.place}".`);
    ({ latitude, longitude } = hit);
    label = `${hit.name}${hit.country ? `, ${hit.country}` : ""}`;
  }
  const daily = [
    "temperature_2m_mean",
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_sum",
  ];
  const data = await requestJson(
    `https://archive-api.open-meteo.com/v1/archive?latitude=${latitude}&longitude=${longitude}&start_date=${input.start}&end_date=${input.end}&daily=${daily.join(",")}&timezone=auto`,
    z.object({
      daily: z.object({ time: z.array(z.string()) }).catchall(z.array(z.number().nullable())),
    }),
    http,
  );
  if (!data) throw new Error("Open-Meteo had no data for that place and range.");
  const d = data.daily as unknown as Record<string, Array<number | string | null>>;
  const rows = (d.time ?? []).map((t, i) => [t, ...daily.map((k) => d[k]?.[i] ?? "")]);
  const file = `/data/weather_${slug(input.place ?? label)}.csv`;
  return {
    path: file,
    csv: toCsv(["date", "temp_mean_c", "temp_max_c", "temp_min_c", "precipitation_mm"], rows),
    rows: rows.length,
    summary: `Wrote ${rows.length} days of weather for ${label} (date, temp_mean_c, temp_max_c, temp_min_c, precipitation_mm) to ${file}. Data: Open-Meteo (non-commercial use).`,
  };
}

// ---------- Countries and indicators (World Bank) ----------

const WB = "https://api.worldbank.org/v2";
const WbPage = z.tuple([
  z.object({ pages: z.number(), total: z.number() }).passthrough(),
  z.array(z.unknown()).nullable(),
]);
const codes = (list: string[]) => [...new Set(list.map((c) => c.toUpperCase()))].join(";");

export const CountryInput = z.object({
  codes: z
    .array(z.string().regex(/^[A-Za-z]{2,3}$/))
    .min(1)
    .max(60)
    .describe("ISO alpha-2 or alpha-3 codes."),
});

export async function fetchCountries(
  input: z.infer<typeof CountryInput>,
  http: HttpOptions = {},
): Promise<EnrichmentResult> {
  const Country = z.object({
    id: z.string(),
    iso2Code: z.string(),
    name: z.string(),
    region: z.object({ value: z.string() }),
    incomeLevel: z.object({ value: z.string() }),
    capitalCity: z.string(),
  });
  const page = await requestJson(
    `${WB}/country/${codes(input.codes)}?format=json&per_page=100`,
    WbPage,
    http,
  );
  const countries = z.array(Country).parse(page?.[1] ?? []);
  if (!countries.length) throw new Error("World Bank didn't recognize those country codes.");
  const pop = await requestJson(
    `${WB}/country/${codes(input.codes)}/indicator/SP.POP.TOTL?format=json&mrnev=1&per_page=100`,
    WbPage,
    http,
  ).catch(() => null);
  const popByIso3 = new Map<string, number>();
  for (const row of (pop?.[1] ?? []) as Array<{
    countryiso3code?: string;
    value?: number | null;
  }>) {
    if (row.countryiso3code && typeof row.value === "number")
      popByIso3.set(row.countryiso3code, row.value);
  }
  const rows = countries.map((c) => [
    c.iso2Code,
    c.id,
    c.name,
    c.region.value.trim(),
    c.incomeLevel.value,
    c.capitalCity,
    popByIso3.get(c.id) ?? "",
  ]);
  return {
    path: "/data/countries.csv",
    csv: toCsv(["iso2", "iso3", "name", "region", "income_level", "capital", "population"], rows),
    rows: rows.length,
    summary: `Wrote ${rows.length} countries (iso2, iso3, name, region, income_level, capital, population) to /data/countries.csv. Source: World Bank.`,
  };
}

export const IndicatorInput = z.object({
  indicator: z
    .string()
    .regex(/^[A-Z0-9.]{3,40}$/i)
    .describe(
      "World Bank indicator code, e.g. NY.GDP.MKTP.CD (GDP, US$), FP.CPI.TOTL.ZG (inflation %), SP.POP.TOTL (population).",
    ),
  countries: z
    .array(z.string().regex(/^[A-Za-z]{2,3}$/))
    .min(1)
    .max(20),
  startYear: z.number().int().min(1960).max(2100),
  endYear: z.number().int().min(1960).max(2100),
});

export async function fetchIndicator(
  input: z.infer<typeof IndicatorInput>,
  http: HttpOptions = {},
): Promise<EnrichmentResult> {
  if (input.endYear < input.startYear) throw new Error("endYear must be on or after startYear.");
  const Row = z.object({
    indicator: z.object({ value: z.string() }),
    country: z.object({ value: z.string() }),
    countryiso3code: z.string(),
    date: z.string(),
    value: z.number().nullable(),
  });
  const page = await requestJson(
    `${WB}/country/${codes(input.countries)}/indicator/${input.indicator}?format=json&date=${input.startYear}:${input.endYear}&per_page=1000`,
    WbPage,
    http,
  );
  const data = z.array(Row).parse(page?.[1] ?? []);
  if (!data.length)
    throw new Error(
      `World Bank has no data for ${input.indicator} with those countries and years.`,
    );
  const name = data[0]?.indicator.value ?? input.indicator;
  const rows = data.map((r) => [r.countryiso3code, r.country.value, Number(r.date), r.value ?? ""]);
  const file = `/data/wb_${slug(input.indicator)}.csv`;
  return {
    path: file,
    csv: toCsv(["iso3", "country", "year", "value"], rows),
    rows: rows.length,
    summary: `Wrote ${rows.length} rows of "${name}" (iso3, country, year, value) to ${file}. Source: World Bank.`,
  };
}
