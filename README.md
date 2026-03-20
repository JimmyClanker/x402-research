# 🔍 Clawnkers Crypto Research Agent

AI-powered crypto research API. Pay per query in USDC — no API keys, no subscriptions, no KYC.

## How It Works

1. **Buy credits**: [Get 100 queries for 1 USDC](https://nevermined.app/checkout/plan/54250839092590488094557289937292598069305499079785004548382308387019941581147)
2. **Send requests** with your `payment-signature` header
3. **Get results** — real-time neural web search via [Exa](https://exa.ai)

## Endpoints

| Endpoint | Cost | Description |
|----------|------|-------------|
| `GET /research?q=query` | 1 credit ($0.01) | AI web search — returns 5 curated results with highlights |
| `GET /fetch?url=https://...` | 1 credit ($0.01) | Extract readable content from any URL |
| `GET /` | Free | Service info + checkout link |

## Try It

```bash
# Health check (free)
curl https://x402-research.onrender.com/

# Research (needs payment-signature from Nevermined)
curl -H "payment-signature: YOUR_TOKEN" \
  "https://x402-research.onrender.com/research?q=solana+defi+trends"
```

Without a valid token, protected endpoints return `402 Payment Required` with a checkout link.

## For AI Agents

This service is designed for **agent-to-agent commerce**. Any AI agent with USDC on Base can:

1. Purchase a plan programmatically via [Nevermined SDK](https://nevermined.ai/docs)
2. Get a payment token
3. Query crypto intelligence at $0.01/request

```typescript
import { Payments } from '@nevermined-io/payments'

const payments = Payments.getInstance({
  nvmApiKey: process.env.NVM_API_KEY,
  environment: 'live'
})

// Purchase credits
const order = await payments.plans.purchase({
  planId: '54250839092590488094557289937292598069305499079785004548382308387019941581147'
})

// Use the token to query
const res = await fetch('https://x402-research.onrender.com/research?q=bitcoin+etf', {
  headers: { 'payment-signature': order.token }
})
```

## Pricing

- **1 USDC** = 100 credits (100 queries)
- **$0.01 per query** — neural web search with AI-curated results
- Payment: USDC on Base (crypto) via [Nevermined](https://nevermined.app)
- No Stripe, no credit card, no KYC

## Stack

- **Runtime**: Node.js + Express on [Render](https://render.com) (free tier)
- **Search**: [Exa AI](https://exa.ai) neural search
- **Payments**: [Nevermined](https://nevermined.ai) — agent-to-agent payment rails
- **Network**: Base (USDC)

## Links

- 🛒 [Buy Credits](https://nevermined.app/checkout/plan/54250839092590488094557289937292598069305499079785004548382308387019941581147)
- 📊 [Service Health](https://x402-research.onrender.com/)
- 📖 [Nevermined Docs](https://nevermined.ai/docs)

---

Built by [Clawnkers](https://github.com/JimmyClanker) 🦊
