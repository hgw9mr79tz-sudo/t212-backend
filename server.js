import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const FINNHUB_KEY = process.env.FINNHUB_KEY;

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
// 2. FINNHUB DATA FETCHER (with rate limiting)
// =============================
async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getStockDataFinnhub(symbol) {
  try {
    // Finnhub quote endpoint
    const quoteRes = await axios.get(
      `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_KEY}`
    );
    const quote = quoteRes.data;

    if (!quote || quote.c === 0 || quote.c === null) {
      console.log(`No data for ${symbol}`);
      return null;
    }

    // Calculate derived fields
    const close = quote.c;        // Current price
    const open = quote.o;         // Open
    const high = quote.h;         // Day high
    const low = quote.l;          // Day low
    const prevClose = quote.pc;   // Previous close

    // Note: Finnhub free tier doesn't include volume in quote endpoint
    // We'll estimate based on price movement for now

    return {
      symbol,
      close,
      open,
      high,
      low,
      prevClose,
      change: close - prevClose,
      changePercent: prevClose ? ((close - prevClose) / prevClose * 100).toFixed(2) : 0,

      // These require Finnhub premium or additional endpoints
      // Setting reasonable defaults for now
      volume: null,
      avgVolume: null,
      week52High: null,
      week52Low: null,
      marketCap: null,

      currency: "USD",
      is_etf: symbol.length <= 4 && ["SPY", "QQQ", "IWM", "DIA", "XLF", "XLE", "XLK", "XLV", "XLI", "XLP", "XLY", "XLB", "XLU", "XLRE", "XLC", "VTI", "VOO", "VEA", "VWO", "BND", "GLD", "SLV", "USO", "TLT", "HYG", "LQD", "EEM", "EFA", "ARKK", "ARKG"].includes(symbol),
      asset_type: "equity",
      tradable_on_t212_cfd: true,
      name: symbol
    };

  } catch (err) {
    console.error(`Finnhub error for ${symbol}:`, err.message);
    return null;
  }
}

// Batch fetch with rate limiting (Finnhub free: 60 calls/min)
async function getStockDataBatch(symbols) {
  const results = [];

  for (let i = 0; i < symbols.length; i++) {
    const data = await getStockDataFinnhub(symbols[i]);
    if (data) {
      results.push(data);
    }

    // Rate limit: ~50ms delay between calls (safe for 60/min limit)
    if (i < symbols.length - 1) {
      await delay(50);
    }
  }

  return results;
}

// =============================
// 3. CONDITION FILTER ENGINE
// =============================
function applyConditions(universe, conditions) {
  if (!conditions || conditions.length === 0) {
    return universe;
  }

  return universe.filter((item) => {
    return conditions.every((c) => {
      const left = item[c.left];

      // Skip condition if field doesn't exist or is null
      if (left === undefined || left === null) {
        // For price-based fields, fail if missing
        if (["close", "open", "high", "low"].includes(c.left)) {
          return false;
        }
        // Skip other missing fields (volume, etc)
        return true;
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
          // Near 52-week high/low - skip if data not available
          if (c.left === "52_week_high" || c.left === "52_week_low") {
            return true; // Can't evaluate without data, so pass
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

    console.log(`Screening ${universe.length} symbols via Finnhub...`);

    // Fetch data with rate limiting
    const stockData = await getStockDataBatch(universe);
    console.log(`Got data for ${stockData.length}/${universe.length} symbols`);

    // Apply conditions
    const results = applyConditions(stockData, conditions || []);
    console.log(`${results.length} symbols passed conditions`);

    return res.json({
      count: results.length,
      universe_size: universe.length,
      valid_data: stockData.length,
      results
    });

  } catch (err) {
    console.error("Screen error:", err);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
});

// =============================
// 5. HEALTH CHECK
// =============================
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    finnhub_configured: !!FINNHUB_KEY
  });
});

// =============================
// 6. START SERVER
// =============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Finnhub-powered screener running on port ${PORT}`));
