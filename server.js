import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const FINNHUB_KEY = process.env.FINNHUB_KEY;

// DEBUG: Log env var status on startup
console.log("=== ENVIRONMENT CHECK ===");
console.log("FINNHUB_KEY defined:", !!FINNHUB_KEY);
console.log("FINNHUB_KEY length:", FINNHUB_KEY ? FINNHUB_KEY.length : 0);
console.log("FINNHUB_KEY preview:", FINNHUB_KEY ? FINNHUB_KEY.substring(0, 8) + "..." : "MISSING");
console.log("=========================");

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
// 2. HELPER FUNCTIONS
// =============================
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function calculateSMA(prices, period) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calculateTrend(prices, period = 20) {
  if (prices.length < period + 5) return "unknown";
  const recentMA = calculateSMA(prices.slice(-5), 5);
  const olderMA = calculateSMA(prices.slice(-(period + 5), -5), 5);
  if (recentMA > olderMA * 1.02) return "up";
  if (recentMA < olderMA * 0.98) return "down";
  return "sideways";
}

// =============================
// 3. ENHANCED DATA FETCHER
// =============================
async function getStockDataWithTrend(symbol) {
  try {
    // Get current quote
    const quoteRes = await axios.get(
      `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_KEY}`
    );
    const quote = quoteRes.data;

    if (!quote || quote.c === 0 || quote.c === null) {
      console.log(`No quote data for ${symbol}`);
      return null;
    }

    // Get historical daily candles (last 300 days for 200MA calculation)
    const now = Math.floor(Date.now() / 1000);
    const from = now - (300 * 24 * 60 * 60); // 300 days ago (enough for 200MA + buffer)

    const candleRes = await axios.get(
      `https://finnhub.io/api/v1/stock/candle?symbol=${symbol}&resolution=D&from=${from}&to=${now}&token=${FINNHUB_KEY}`
    );
    const candles = candleRes.data;

    let ma20 = null;
    let ma50 = null;
    let ma200 = null;
    let dailyTrend = "unknown";
    let weeklyTrend = "unknown";
    let aboveMA20 = null;
    let aboveMA50 = null;
    let aboveMA200 = null;
    let week52High = null;
    let week52Low = null;

    if (candles && candles.s === "ok" && candles.c && candles.c.length > 0) {
      const closePrices = candles.c;

      // Calculate moving averages
      ma20 = calculateSMA(closePrices, 20);
      ma50 = calculateSMA(closePrices, 50);
      ma200 = calculateSMA(closePrices, 200);

      // Calculate trends
      dailyTrend = calculateTrend(closePrices, 20);

      // Weekly trend (using 5-day intervals as proxy)
      if (closePrices.length >= 25) {
        const weeklyPrices = [];
        for (let i = 0; i < closePrices.length; i += 5) {
          weeklyPrices.push(closePrices[i]);
        }
        weeklyTrend = calculateTrend(weeklyPrices, 4);
      }

      // Price vs MA
      aboveMA20 = ma20 ? quote.c > ma20 : null;
      aboveMA50 = ma50 ? quote.c > ma50 : null;
      aboveMA200 = ma200 ? quote.c > ma200 : null;

      // 52-week high/low (use available data, may be less than 52 weeks)
      week52High = Math.max(...closePrices);
      week52Low = Math.min(...closePrices);
    }

    // Get volume data from candles if available
    let volume = null;
    let avgVolume = null;
    if (candles && candles.v && candles.v.length > 0) {
      volume = candles.v[candles.v.length - 1];
      avgVolume = calculateSMA(candles.v, 20);
    }

    const close = quote.c;

    return {
      symbol,
      close,
      open: quote.o,
      high: quote.h,
      low: quote.l,
      prevClose: quote.pc,
      change: close - quote.pc,
      changePercent: quote.pc ? ((close - quote.pc) / quote.pc * 100).toFixed(2) : 0,

      // Volume data
      volume,
      avgVolume,
      volumeRatio: avgVolume ? (volume / avgVolume).toFixed(2) : null,
      volumeContraction: avgVolume ? volume < avgVolume * 0.7 : null,

      // 52-week data
      week52High,
      week52Low,
      pctFrom52High: week52High ? ((close / week52High) * 100).toFixed(1) : null,
      pctFrom52Low: week52Low ? ((close / week52Low - 1) * 100).toFixed(1) : null,
      nearWeek52High: week52High ? close >= week52High * 0.95 : null,
      nearWeek52Low: week52Low ? close <= week52Low * 1.05 : null,

      // Moving averages
      ma20: ma20 ? ma20.toFixed(2) : null,
      ma50: ma50 ? ma50.toFixed(2) : null,
      ma200: ma200 ? ma200.toFixed(2) : null,
      aboveMA20,
      aboveMA50,
      aboveMA200,

      // Trend analysis
      dailyTrend,
      weeklyTrend,

      // Setup quality indicators
      trendAlignment: (dailyTrend === "up" && weeklyTrend === "up") ? "bullish" :
                      (dailyTrend === "down" && weeklyTrend === "down") ? "bearish" : "mixed",

      // Metadata
      currency: "USD",
      is_etf: ["SPY", "QQQ", "IWM", "DIA", "XLF", "XLE", "XLK", "XLV", "XLI", "XLP", "XLY", "XLB", "XLU", "XLRE", "XLC", "VTI", "VOO", "EWG", "EWQ", "FEZ", "VGK"].includes(symbol),
      tradable_on_t212_cfd: true,
      name: symbol
    };

  } catch (err) {
    console.error(`Error fetching ${symbol}:`, err.message);
    if (err.response) {
      console.error(`  Status: ${err.response.status}`);
      console.error(`  Response: ${JSON.stringify(err.response.data)}`);
      console.error(`  URL attempted: https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_KEY ? FINNHUB_KEY.substring(0,8) + '...' : 'MISSING'}`);
    }
    return null;
  }
}

// Batch fetch with rate limiting (Finnhub free: 60 calls/min)
// Each stock needs 2 calls (quote + candles), so ~30 stocks/min
async function getStockDataBatch(symbols) {
  const results = [];

  for (let i = 0; i < symbols.length; i++) {
    console.log(`Fetching ${symbols[i]} (${i + 1}/${symbols.length})...`);
    const data = await getStockDataWithTrend(symbols[i]);
    if (data) {
      results.push(data);
    }

    // Rate limit: 2 API calls per stock, 60 calls/min = 30 stocks/min
    // ~2 second delay between stocks to be safe
    if (i < symbols.length - 1) {
      await delay(2000);
    }
  }

  return results;
}

// =============================
// 4. CONDITION FILTER ENGINE
// =============================
function applyConditions(universe, conditions) {
  if (!conditions || conditions.length === 0) {
    return universe;
  }

  return universe.filter((item) => {
    return conditions.every((c) => {
      const left = item[c.left];

      if (left === undefined || left === null) {
        if (["close", "open", "high", "low"].includes(c.left)) {
          return false;
        }
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
          if (c.left === "52_week_high") {
            return item.nearWeek52High === true;
          }
          if (c.left === "52_week_low") {
            return item.nearWeek52Low === true;
          }
          return false;

        default:
          return true;
      }
    });
  });
}

// =============================
// 5. SCREEN ENDPOINT
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

    // Limit to 25 stocks to stay within rate limits (takes ~50 seconds)
    const limitedUniverse = universe.slice(0, 25);
    if (universe.length > 25) {
      console.log(`Warning: Limited universe from ${universe.length} to 25 stocks due to API rate limits`);
    }

    console.log(`Screening ${limitedUniverse.length} symbols with trend data...`);

    const stockData = await getStockDataBatch(limitedUniverse);
    console.log(`Got enriched data for ${stockData.length}/${limitedUniverse.length} symbols`);

    const results = applyConditions(stockData, conditions || []);
    console.log(`${results.length} symbols passed conditions`);

    return res.json({
      count: results.length,
      universe_size: universe.length,
      screened_size: limitedUniverse.length,
      valid_data: stockData.length,
      note: universe.length > 25 ? "Limited to 25 stocks due to API rate limits. For more stocks, consider Finnhub premium." : null,
      results
    });

  } catch (err) {
    console.error("Screen error:", err);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
});

// =============================
// 6. HEALTH CHECK
// =============================
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    finnhub_configured: !!FINNHUB_KEY,
    features: ["quote", "historical_candles", "moving_averages", "trend_analysis"]
  });
});

// =============================
// 7. START SERVER
// =============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Enhanced screener with trend analysis running on port ${PORT}`));
