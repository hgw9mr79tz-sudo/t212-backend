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
// 2. PRICE FETCHER (Finnhub + Yahoo fallback)
// =============================
async function getPrice(symbol) {
  try {
    // Finnhub quote
    const r1 = await axios.get(
      `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${process.env.FINNHUB_KEY}`
    );
    if (r1.data && r1.data.c) return r1.data.c;

    // Yahoo fallback
    const r2 = await axios.get(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbol}`
    );
    return r2.data.quoteResponse.result[0]?.regularMarketPrice || null;

  } catch (err) {
    return null;
  }
}

// =============================
// 3. CONDITION FILTER ENGINE
// =============================
function applyConditions(universe, conditions) {
  return universe.filter((item) => {
    return conditions.every((c) => {
      const left = item[c.left];

      switch (c.operation) {
        case "equal":
          return left === c.right;

        case "greater":
          return left > c.right;

        case "less":
          return left < c.right;

        case "in":
          return Array.isArray(c.right) && c.right.includes(left);

        case "near":
          if (c.left === "52_week_high") {
            return item.close >= item.week52High * 0.95;
          }
          if (c.left === "52_week_low") {
            return item.close <= item.week52Low * 1.05;
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

    // Fetch prices for dynamic universe
    const priced = await Promise.all(
      universe.map(async (symbol) => {
        const price = await getPrice(symbol);
        return {
          symbol,
          close: price,
          currency: "USD" // assume USD; bot provides additional metadata if needed
        };
      })
    );

    const valid = priced.filter((x) => x.close !== null);

    const results = applyConditions(valid, conditions);

    return res.json({
      count: results.length,
      results
    });

  } catch (err) {
    console.error("Screen error:", err);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
});

// =============================
// 5. START SERVER
// =============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dynamic universe backend running on port ${PORT}`));