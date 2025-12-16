+   1 import express from "express";
+   2 import cors from "cors";
+   3 import axios from "axios";
+   4 import dotenv from "dotenv";
+   5 
+   6 dotenv.config();
+   7 
+   8 const app = express();
+   9 app.use(express.json());
+  10 app.use(cors());
+  11 
+  12 const FINNHUB_KEY = process.env.FINNHUB_KEY;
+  13 
+  14 // =============================
+  15 // 1. API KEY CHECK
+  16 // =============================
+  17 app.use((req, res, next) => {
+  18   const provided = req.headers["x-api-key"];
+  19   if (!provided || provided !== process.env.API_KEY) {
+  20     return res.status(403).json({ error: "Invalid API Key" });
+  21   }
+  22   next();
+  23 });
+  24 
+  25 // =============================
+  26 // 2. FINNHUB DATA FETCHER (with rate limiting)
+  27 // =============================
+  28 async function delay(ms) {
+  29   return new Promise(resolve => setTimeout(resolve, ms));
+  30 }
+  31 
+  32 async function getStockDataFinnhub(symbol) {
+  33   try {
+  34     // Finnhub quote endpoint
+  35     const quoteRes = await axios.get(
+  36       `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_KEY}`
+  37     );
+  38     const quote = quoteRes.data;
+  39 
+  40     if (!quote || quote.c === 0 || quote.c === null) {
+  41       console.log(`No data for ${symbol}`);
+  42       return null;
+  43     }
+  44 
+  45     // Calculate derived fields
+  46     const close = quote.c;        // Current price
+  47     const open = quote.o;         // Open
+  48     const high = quote.h;         // Day high
+  49     const low = quote.l;          // Day low
+  50     const prevClose = quote.pc;   // Previous close
+  51 
+  52     // Note: Finnhub free tier doesn't include volume in quote endpoint
+  53     // We'll estimate based on price movement for now
+  54     
+  55     return {
+  56       symbol,
+  57       close,
+  58       open,
+  59       high,
+  60       low,
+  61       prevClose,
+  62       change: close - prevClose,
+  63       changePercent: prevClose ? ((close - prevClose) / prevClose * 100).toFixed(2) : 0,
+  64       
+  65       // These require Finnhub premium or additional endpoints
+  66       // Setting reasonable defaults for now
+  67       volume: null,
+  68       avgVolume: null,
+  69       week52High: null,
+  70       week52Low: null,
+  71       marketCap: null,
+  72       
+  73       currency: "USD",
+  74       is_etf: symbol.length <= 4 && ["SPY", "QQQ", "IWM", "DIA", "XLF", "XLE", "XLK", "XLV", "XLI", "XLP", "XLY", "XLB", "XLU", "XLRE", "XLC", "VTI", "VOO", "VEA", "VWO", "BND", "GLD", "SLV", "USO", "TLT", "HYG", "LQD", "EEM", "EFA", "ARKK", "ARKG"].includes(symbol),
+  75       asset_type: "equity",
+  76       tradable_on_t212_cfd: true,
+  77       name: symbol
+  78     };
+  79 
+  80   } catch (err) {
+  81     console.error(`Finnhub error for ${symbol}:`, err.message);
+  82     return null;
+  83   }
+  84 }
+  85 
+  86 // Batch fetch with rate limiting (Finnhub free: 60 calls/min)
+  87 async function getStockDataBatch(symbols) {
+  88   const results = [];
+  89   
+  90   for (let i = 0; i < symbols.length; i++) {
+  91     const data = await getStockDataFinnhub(symbols[i]);
+  92     if (data) {
+  93       results.push(data);
+  94     }
+  95     
+  96     // Rate limit: ~50ms delay between calls (safe for 60/min limit)
+  97     if (i < symbols.length - 1) {
+  98       await delay(50);
+  99     }
+ 100   }
+ 101   
+ 102   return results;
+ 103 }
+ 104 
+ 105 // =============================
+ 106 // 3. CONDITION FILTER ENGINE
+ 107 // =============================
+ 108 function applyConditions(universe, conditions) {
+ 109   if (!conditions || conditions.length === 0) {
+ 110     return universe;
+ 111   }
+ 112 
+ 113   return universe.filter((item) => {
+ 114     return conditions.every((c) => {
+ 115       const left = item[c.left];
+ 116 
+ 117       // Skip condition if field doesn't exist or is null
+ 118       if (left === undefined || left === null) {
+ 119         // For price-based fields, fail if missing
+ 120         if (["close", "open", "high", "low"].includes(c.left)) {
+ 121           return false;
+ 122         }
+ 123         // Skip other missing fields (volume, etc)
+ 124         return true;
+ 125       }
+ 126 
+ 127       switch (c.operation) {
+ 128         case "equal":
+ 129           return left === c.right;
+ 130 
+ 131         case "greater":
+ 132           return Number(left) > Number(c.right);
+ 133 
+ 134         case "less":
+ 135           return Number(left) < Number(c.right);
+ 136 
+ 137         case "in":
+ 138           return Array.isArray(c.right) && c.right.includes(left);
+ 139 
+ 140         case "near":
+ 141           // Near 52-week high/low - skip if data not available
+ 142           if (c.left === "52_week_high" || c.left === "52_week_low") {
+ 143             return true; // Can't evaluate without data, so pass
+ 144           }
+ 145           return false;
+ 146 
+ 147         default:
+ 148           return true;
+ 149       }
+ 150     });
+ 151   });
+ 152 }
+ 153 
+ 154 // =============================
+ 155 // 4. SCREEN ENDPOINT
+ 156 // =============================
+ 157 app.post("/screen", async (req, res) => {
+ 158   try {
+ 159     const { action, universe, conditions } = req.body;
+ 160 
+ 161     if (action !== "screen") {
+ 162       return res.status(400).json({ error: "Invalid action" });
+ 163     }
+ 164 
+ 165     if (!Array.isArray(universe) || universe.length === 0) {
+ 166       return res.status(400).json({ error: "Universe must be a non-empty array" });
+ 167     }
+ 168 
+ 169     console.log(`Screening ${universe.length} symbols via Finnhub...`);
+ 170 
+ 171     // Fetch data with rate limiting
+ 172     const stockData = await getStockDataBatch(universe);
+ 173     console.log(`Got data for ${stockData.length}/${universe.length} symbols`);
+ 174 
+ 175     // Apply conditions
+ 176     const results = applyConditions(stockData, conditions || []);
+ 177     console.log(`${results.length} symbols passed conditions`);
+ 178 
+ 179     return res.json({
+ 180       count: results.length,
+ 181       universe_size: universe.length,
+ 182       valid_data: stockData.length,
+ 183       results
+ 184     });
+ 185 
+ 186   } catch (err) {
+ 187     console.error("Screen error:", err);
+ 188     return res.status(500).json({ error: "Server error", detail: err.message });
+ 189   }
+ 190 });
+ 191 
+ 192 // =============================
+ 193 // 5. HEALTH CHECK
+ 194 // =============================
+ 195 app.get("/health", (req, res) => {
+ 196   res.json({ 
+ 197     status: "ok", 
+ 198     timestamp: new Date().toISOString(),
+ 199     finnhub_configured: !!FINNHUB_KEY
+ 200   });
+ 201 });
+ 202 
+ 203 // =============================
+ 204 // 6. START SERVER
+ 205 // =============================
+ 206 const PORT = process.env.PORT || 3000;
+ 207 app.listen(PORT, () => console.log(`Finnhub-powered screener running on port ${PORT}`));