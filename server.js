import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

// =============================
// 1. API KEY CHECK
// =============================
app.use((req, res, next) => {
  const provided = req.headers["x-api-key"];
  if (!provided || provided !== process.env.API_KEY) {
    return res.status(403).json({ error: "Invalid API Key" });
  }
  next();
});

// =============================
// 2. ENHANCED DATA FETCHER (Yahoo Finance - more complete data)
// =============================
async function getStockData(symbols) {
  try {
    // Yahoo Finance can fetch multiple symbols at once
    const symbolList = symbols.join(",");
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbolList}`;

    const response = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });

    const results = response.data.quoteResponse.result || [];

    return results.map(quote => ({
      symbol: quote.symbol,
      close: quote.regularMarketPrice || null,
      open: quote.regularMarketOpen || null,
      high: quote.regularMarketDayHigh || null,
      low: quote.regularMarketDayLow || null,
      volume: quote.regularMarketVolume || 0,
      avgVolume: quote.averageDailyVolume3Month || 0,
      week52High: quote.fiftyTwoWeekHigh || null,
      week52Low: quote.fiftyTwoWeekLow || null,
      marketCap: quote.marketCap || 0,
      currency: quote.currency || "USD",

      // Determine asset type
      is_etf: quote.quoteType === "ETF",
      asset_type: quote.quoteType === "ETF" ? "etf" : "equity",

      // Price vs 52-week range (for "near" calculations)
      pct_from_52w_high: quote.fiftyTwoWeekHigh
        ? ((quote.regularMarketPrice / quote.fiftyTwoWeekHigh) * 100).toFixed(2)
        : null,
      pct_from_52w_low: quote.fiftyTwoWeekLow
        ? ((quote.regularMarketPrice / quote.fiftyTwoWeekLow) * 100).toFixed(2)
        : null,

      // Volume analysis (simple contraction check)
      volume_vs_avg: quote.averageDailyVolume3Month
        ? (quote.regularMarketVolume / quote.averageDailyVolume3Month).toFixed(2)
        : null,
      volume_contraction: quote.averageDailyVolume3Month
        ? quote.regularMarketVolume < quote.averageDailyVolume3Month * 0.7
        : false,

      // Additional useful fields
      name: quote.shortName || quote.longName || quote.symbol,
      exchange: quote.exchange,

      // Assume tradable on T212 CFD for major US stocks (you can refine this)
      tradable_on_t212_cfd: ["USD", "EUR", "GBP"].includes(quote.currency || "USD")
    }));

  } catch (err) {
    console.error("Yahoo Finance error:", err.message);
    return [];
  }
}

// Fallback: Fetch individual stock via Finnhub if Yahoo fails
async function getStockDataFinnhub(symbol) {
  try {
    const [quoteRes, profileRes] = await Promise.all([
      axios.get(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${process.env.FINNHUB_KEY}`),
      axios.get(`https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${process.env.FINNHUB_KEY}`)
    ]);

    const quote = quoteRes.data;
    const profile = profileRes.data;

    if (!quote || !quote.c) return null;

    return {
      symbol,
      close: quote.c,
      open: quote.o,
      high: quote.h,
      low: quote.l,
      volume: null, // Finnhub quote doesn't include volume
      week52High: null,
      week52Low: null,
      currency: profile.currency || "USD",
      is_etf: false,
      asset_type: "equity",
      name: profile.name || symbol,
      tradable_on_t212_cfd: true
    };
  } catch (err) {
    return null;
  }
}

// =============================
// 3. ENHANCED CONDITION FILTER ENGINE
// =============================
function applyConditions(universe, conditions) {
  if (!conditions || conditions.length === 0) {
    return universe; // No conditions = return all
  }

  return universe.filter((item) => {
    return conditions.every((c) => {
      const left = item[c.left];

      // Skip condition if field doesn't exist
      if (left === undefined || left === null) {
        // For certain fields, treat missing as "doesn't match"
        if (["volume", "close", "week52High", "week52Low"].includes(c.left)) {
          return false;
        }
        return true; // Skip unknown fields
      }

      switch (c.operation) {
        case "equal":
          return left === c.right;

        case "greater":
          return Number(left) > Number(c.right);

        case "less":
          return Number(left) < Number(c.right);

        case "in":
          return Array.isArray(c.right) && c.right.includes(left);

        case "near":
          // Near 52-week high: within 5%
          if (c.left === "52_week_high") {
            return item.close && item.week52High &&
                   item.close >= item.week52High * 0.95;
          }
          // Near 52-week low: within 5%
          if (c.left === "52_week_low") {
            return item.close && item.week52Low &&
                   item.close <= item.week52Low * 1.05;
          }
          return false;

        default:
          return true;
      }
    });
  });
}

// =============================
// 4. SCREEN ENDPOINT
// =============================
app.post("/screen", async (req, res) => {
  try {
    const { action, universe, conditions } = req.body;

    if (action !== "screen") {
      return res.status(400).json({ error: "Invalid action" });
    }

    if (!Array.isArray(universe) || universe.length === 0) {
      return res.status(400).json({ error: "Universe must be a non-empty array" });
    }

    console.log(`Screening ${universe.length} symbols...`);

    // Batch fetch from Yahoo (more efficient)
    // Yahoo supports up to ~200 symbols per request
    const batchSize = 100;
    let allStockData = [];

    for (let i = 0; i < universe.length; i += batchSize) {
      const batch = universe.slice(i, i + batchSize);
      const batchData = await getStockData(batch);
      allStockData = allStockData.concat(batchData);
    }

    // Filter out stocks with no price data
    const valid = allStockData.filter((x) => x.close !== null);
    console.log(`Got data for ${valid.length} symbols`);

    // Apply conditions
    const results = applyConditions(valid, conditions || []);
    console.log(`${results.length} symbols passed conditions`);

    return res.json({
      count: results.length,
      universe_size: universe.length,
      valid_data: valid.length,
      results
    });

  } catch (err) {
    console.error("Screen error:", err);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
});

// =============================
// 5. HEALTH CHECK ENDPOINT
// =============================
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// =============================
// 6. START SERVER
// =============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Enhanced screener backend running on port ${PORT}`));
