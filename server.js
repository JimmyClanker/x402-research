import express from "express";
import { Payments, buildPaymentRequired } from "@nevermined-io/payments";

const app = express();
const PORT = process.env.PORT || 4021;

// Nevermined config
const NVM_API_KEY = process.env.NVM_API_KEY;
const NVM_PLAN_ID = process.env.NVM_PLAN_ID;
const NVM_AGENT_ID = process.env.NVM_AGENT_ID;
const NVM_ENV = process.env.NVM_ENV || "sandbox";

// Cast Trading Wallet — receives payments
const PAY_TO = "0x4bDE6B11Df6C0F0f5351e6fB0E7Bdc40eAa0cb4D";

// Exa API for research
const EXA_API_KEY = process.env.EXA_API_KEY || "9275664f-b823-4699-ab44-137bae9d0de4";

// Initialize Nevermined
let payments;
if (NVM_API_KEY) {
  payments = Payments.getInstance({
    nvmApiKey: NVM_API_KEY,
    environment: NVM_ENV,
  });
  console.log(`Nevermined initialized (${NVM_ENV})`);
} else {
  console.warn("NVM_API_KEY not set — endpoints will be OPEN (no payment required)");
}

// Nevermined payment middleware
async function nvmPaymentCheck(req, res, next) {
  if (!payments || !NVM_PLAN_ID || !NVM_AGENT_ID) {
    // No NVM configured — pass through (dev mode)
    return next();
  }

  const paymentRequired = buildPaymentRequired(NVM_PLAN_ID, {
    endpoint: req.originalUrl,
    agentId: NVM_AGENT_ID,
    httpVerb: req.method,
  });

  const x402Token = req.headers["payment-signature"];

  if (!x402Token) {
    const prBase64 = Buffer.from(JSON.stringify(paymentRequired)).toString("base64");
    return res.status(402).setHeader("payment-required", prBase64).json({
      error: "Payment Required",
      message: "Include a payment-signature header. Buy credits at the checkout link.",
      checkout: `https://nevermined.app/checkout/plan/${NVM_PLAN_ID}`,
      price: "$0.01 per request (100 requests = $1 USD)",
    });
  }

  try {
    // Verify permissions (does NOT burn credits yet)
    const verification = await payments.facilitator.verifyPermissions({
      paymentRequired,
      x402AccessToken: x402Token,
      maxAmount: 1n,
    });

    if (!verification.isValid) {
      return res.status(402).json({
        error: "Invalid payment",
        reason: verification.invalidReason,
        checkout: `https://nevermined.app/checkout/plan/${NVM_PLAN_ID}`,
      });
    }

    // Store token for settlement after response
    req._nvmPaymentRequired = paymentRequired;
    req._nvmToken = x402Token;
    next();
  } catch (err) {
    console.error("NVM verify error:", err.message);
    return res.status(500).json({ error: "Payment verification failed" });
  }
}

// Settle credits after successful response
async function nvmSettle(req) {
  if (!payments || !req._nvmPaymentRequired || !req._nvmToken) return;
  try {
    await payments.facilitator.settlePermissions({
      paymentRequired: req._nvmPaymentRequired,
      x402AccessToken: req._nvmToken,
      maxAmount: 1n,
    });
  } catch (err) {
    console.error("NVM settle error:", err.message);
  }
}

// Health check (free)
app.get("/", (req, res) => {
  res.json({
    service: "Clawnkers Crypto Research",
    version: "3.0.0",
    pricing: "$0.01/query via Nevermined (100 queries = $1 USD)",
    checkout: NVM_PLAN_ID
      ? `https://nevermined.app/checkout/plan/${NVM_PLAN_ID}`
      : "not configured",
    endpoints: {
      "/research?q=your+query": "$0.01 — AI web research (Exa neural search)",
      "/fetch?url=https://...": "$0.01 — URL content extraction",
    },
    payTo: PAY_TO,
    environment: NVM_ENV,
  });
});

// Research endpoint — Exa neural search (paid)
app.get("/research", nvmPaymentCheck, async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: "Missing ?q= parameter" });
  }

  try {
    const response = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "x-api-key": EXA_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        type: "auto",
        numResults: 5,
        highlights: { maxCharacters: 500 },
        useAutoprompt: true,
      }),
    });

    const data = await response.json();
    const result = {
      query,
      results: (data.results || []).map((r) => ({
        title: r.title,
        url: r.url,
        highlights: r.highlights || [],
        publishedDate: r.publishedDate,
      })),
      timestamp: new Date().toISOString(),
    };

    res.json(result);

    // Settle credits after successful delivery
    await nvmSettle(req);
  } catch (err) {
    res.status(500).json({ error: "Search failed", details: err.message });
  }
});

// Fetch endpoint — URL content extraction (paid)
app.get("/fetch", nvmPaymentCheck, async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ error: "Missing ?url= parameter" });
  }

  try {
    const response = await fetch("https://api.exa.ai/contents", {
      method: "POST",
      headers: {
        "x-api-key": EXA_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        urls: [url],
        text: { maxCharacters: 5000 },
      }),
    });

    const data = await response.json();
    const result = data.results?.[0] || {};
    res.json({
      url,
      title: result.title,
      text: result.text,
      timestamp: new Date().toISOString(),
    });

    // Settle credits after successful delivery
    await nvmSettle(req);
  } catch (err) {
    res.status(500).json({ error: "Fetch failed", details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Clawnkers Crypto Research listening on port ${PORT}`);
  console.log(`Payments go to: ${PAY_TO}`);
  console.log(`Environment: ${NVM_ENV}`);
});
