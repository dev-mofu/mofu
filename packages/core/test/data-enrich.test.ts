import { describe, expect, it } from "vitest";
import {
  fetchCountries,
  fetchFxRates,
  fetchHolidays,
  fetchIndicator,
  fetchWeather,
  formatProfileForModel,
  runResultForModel,
  suggestQuestions,
  type DatasetProfile,
} from "../src/index.js";

/** Routes URLs to canned JSON by substring. */
function fakeFetch(routes: Record<string, unknown>): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fn = (async (url: string) => {
    urls.push(url);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    return hit ? new Response(JSON.stringify(hit[1])) : new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: fn, urls };
}

describe("enrichment sources", () => {
  it("fx_rates writes one row per date and currency", async () => {
    const { fetch, urls } = fakeFetch({
      "api.frankfurter.dev": {
        rates: { "2024-01-02": { EUR: 0.91, JPY: 141.2 }, "2024-01-03": { EUR: 0.92, JPY: 142 } },
      },
    });
    const r = await fetchFxRates(
      { base: "usd", symbols: ["eur", "jpy"], start: "2024-01-01", end: "2024-01-03" },
      { fetch },
    );
    // A week of lookback so the first days can be forward-filled.
    expect(urls[0]).toBe(
      "https://api.frankfurter.dev/v1/2023-12-25..2024-01-03?base=USD&symbols=EUR,JPY",
    );
    expect(r.path).toBe("/data/fx_USD.csv");
    expect(r.csv.split("\n")[0]).toBe("date,base,currency,rate");
    expect(r.rows).toBe(4);
    expect(r.summary).toMatch(/never back-fill/);
  });

  it("rejects bad or too long date ranges", async () => {
    const { fetch } = fakeFetch({});
    await expect(
      fetchFxRates(
        { base: "USD", symbols: ["EUR"], start: "2020-01-01", end: "2024-01-01" },
        { fetch },
      ),
    ).rejects.toThrow(/3 years/);
    await expect(
      fetchFxRates(
        { base: "USD", symbols: ["EUR"], start: "2024-02-01", end: "2024-01-01" },
        { fetch },
      ),
    ).rejects.toThrow(/on or after/);
  });

  it("public_holidays covers each year and quotes commas", async () => {
    const { fetch, urls } = fakeFetch({
      "PublicHolidays/2023/DE": [
        { date: "2023-12-25", name: "Christmas Day", localName: "Weihnachtstag", global: true },
      ],
      "PublicHolidays/2024/DE": [
        { date: "2024-10-03", name: "Day of Unity, German", localName: "Tag", global: true },
      ],
    });
    const r = await fetchHolidays({ country: "de", years: [2024, 2023] }, { fetch });
    expect(urls).toHaveLength(2);
    expect(r.csv).toContain('"Day of Unity, German"');
    expect(r.rows).toBe(2);
  });

  it("historical_weather geocodes a place name first", async () => {
    const { fetch, urls } = fakeFetch({
      "geocoding-api.open-meteo.com": {
        results: [{ latitude: 52.52, longitude: 13.41, name: "Berlin", country: "Germany" }],
      },
      "archive-api.open-meteo.com": {
        daily: {
          time: ["2024-01-01"],
          temperature_2m_mean: [1.5],
          temperature_2m_max: [3],
          temperature_2m_min: [0],
          precipitation_sum: [null],
        },
      },
    });
    const r = await fetchWeather(
      { place: "Berlin", start: "2024-01-01", end: "2024-01-01" },
      { fetch },
    );
    expect(urls[1]).toContain("latitude=52.52&longitude=13.41");
    expect(r.path).toBe("/data/weather_berlin.csv");
    expect(r.csv.trim().split("\n")[1]).toBe("2024-01-01,1.5,3,0,");
    expect(r.summary).toMatch(/Berlin, Germany/);
  });

  it("country_info merges World Bank countries with population", async () => {
    const { fetch } = fakeFetch({
      "indicator/SP.POP.TOTL": [
        { pages: 1, total: 1 },
        [{ countryiso3code: "DEU", value: 83_000_000 }],
      ],
      "/country/DE;FR?": [
        { pages: 1, total: 2 },
        [
          {
            id: "DEU",
            iso2Code: "DE",
            name: "Germany",
            region: { value: "Europe & Central Asia " },
            incomeLevel: { value: "High income" },
            capitalCity: "Berlin",
          },
          {
            id: "FRA",
            iso2Code: "FR",
            name: "France",
            region: { value: "Europe & Central Asia" },
            incomeLevel: { value: "High income" },
            capitalCity: "Paris",
          },
        ],
      ],
    });
    const r = await fetchCountries({ codes: ["de", "fr"] }, { fetch });
    expect(r.csv.split("\n").slice(1, 3)).toEqual([
      "DE,DEU,Germany,Europe & Central Asia,High income,Berlin,83000000",
      "FR,FRA,France,Europe & Central Asia,High income,Paris,",
    ]);
  });

  it("economic_indicator reports when there's no data", async () => {
    const { fetch } = fakeFetch({ "indicator/NY.GDP.MKTP.CD": [{ pages: 0, total: 0 }, null] });
    await expect(
      fetchIndicator(
        { indicator: "NY.GDP.MKTP.CD", countries: ["XX"], startYear: 2020, endYear: 2021 },
        { fetch },
      ),
    ).rejects.toThrow(/no data/);
  });
});

const profile: DatasetProfile = {
  rows: 120,
  columns: [
    {
      name: "order_date",
      dtype: "datetime64[ns]",
      kind: "datetime",
      nulls: 0,
      unique: 90,
      min: "2024-01-01",
      max: "2024-06-30",
    },
    {
      name: "region",
      dtype: "str",
      kind: "categorical",
      nulls: 0,
      unique: 4,
      top: [["North", 40]],
    },
    {
      name: "revenue",
      dtype: "float64",
      kind: "numeric",
      nulls: 2,
      unique: 110,
      min: 5,
      max: 900,
      mean: 120.5,
    },
    {
      name: "units",
      dtype: "int64",
      kind: "numeric",
      nulls: 0,
      unique: 30,
      min: 1,
      max: 40,
      mean: 8,
    },
  ],
  sample: [{ order_date: "2024-01-01T00:00:00", region: "North", revenue: 10, units: 1 }],
  problems: ["revenue: 3 extreme outliers"],
};

describe("profile helpers", () => {
  it("formats the profile for the model", () => {
    const text = formatProfileForModel("sales.csv", profile);
    expect(text).toContain("120 rows × 4 columns");
    expect(text).toContain(
      "- revenue [numeric, float64] nulls 2, unique 110; min 5, max 900, mean 120.5",
    );
    expect(text).toContain("## Possible problems\n- revenue: 3 extreme outliers");
  });

  it("suggests questions from the columns", () => {
    expect(suggestQuestions(profile)).toEqual([
      "Chart revenue by month",
      "Which region has the highest total revenue?",
      "Clean up the problems in this data and export a CSV",
      "How are revenue and units related?",
    ]);
  });

  it("never sends chart images to the model", () => {
    const out = runResultForModel(
      { stdout: "ok", result: "3", error: null, figures: ["iVBORw0KGgo..."] },
      ["figure-1.png"],
    );
    expect(JSON.stringify(out)).not.toContain("iVBOR");
    expect(out).toEqual({
      stdout: "ok",
      result: "3",
      charts: "1 chart(s) shown to the user: figure-1.png",
    });
  });
});
