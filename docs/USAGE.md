# Gateway usage

## What it does

The gateway accepts text prompts on loopback, routes them through a configured model catalog, streams answers, retries an eligible backup before output begins, and stores metadata-only receipts. The dashboard shows model selection, attempts, cost, latency, request frequency, feedback, and an evidence-aware leaderboard. Compare mode runs two eligible models and shows their answers side by side. It does not merge them or claim a confidence score.

## Start with the offline demo

Run `npm ci && npm run demo`, then open `http://127.0.0.1:8787`. The default three models are deterministic fakes. Submit the same prompt under cost and quality policies to inspect different routes. Use Compare two to see separate receipts. Mark an answer useful or not useful; at least five ratings for one model are required before feedback changes its soft quality score. Click Clear history to delete local receipts and feedback.

For API use:

```sh
curl -s http://127.0.0.1:8787/api/generate \
  -H 'content-type: application/json' \
  -d '{"prompt":"Summarize this note","privacy":"local_only","policy":"balanced"}'

curl -N http://127.0.0.1:8787/api/generate/stream \
  -H 'content-type: application/json' \
  -d '{"prompt":"Summarize this note"}'

curl -s http://127.0.0.1:8787/api/compare \
  -H 'content-type: application/json' \
  -d '{"prompt":"Compare these approaches","privacy":"local_only","policy":"quality"}'
```

The streaming API sends `chunk` events and a final `done` receipt. A provider failure after the first chunk ends with an `interrupted` receipt; the gateway never splices in another model's text. The compare response contains `primary`, `alternative`, and `disagreement`. `disagreement` is only an exact normalized text comparison.

## Use a real local model

Copy `config/models.example.json` to `config/models.local.json`. Set the Ollama entry's `modelName` to one returned by `ollama list`, and update pricing and quality priors for your environment. Then run:

```sh
GATEWAY_MODELS_FILE=config/models.local.json npm run demo
```

The Ollama adapter uses local `/api/chat` streaming. The hosted entry is omitted without its API key. To enable it, set the environment variable named by `apiKeyEnv` and include the endpoint hostname in `GATEWAY_REMOTE_ALLOWLIST`. The request still defaults to local-only. Remote routing requires an explicit `remote_allowed` choice for that request. Providers can retain data under their own policies; the gateway cannot enforce their retention rules.

## Practical patterns

- Use local-only quality routing for sensitive drafting when multiple local models are configured.
- Use cost routing with a ceiling for routine prompts, then switch to quality routing for important work.
- Use compare mode to inspect disagreement on a consequential answer before you choose which to trust.
- Export metadata receipts for offline analysis; never treat demo costs or user ratings as verified model quality.

## Extensions

- Add task-class labels and held-out eval sets before using feedback as a stronger routing signal.
- Add provider-specific price and token-limit discovery so the budget can be enforced against current prices.
- Add a human-approved fusion workflow that cites which model contributed each claim, then measure it against single-model baselines.
- Add encrypted, explicit opt-in answer retention for users who need longitudinal correction analysis.

## Limits and checks

Run `npm run check` for typecheck and tests. Run `npm run benchmark` for a deterministic routing decision p50, failover success under injected outages, and synthetic cost comparison. On the development machine on 2026-09-29, the benchmark measured a 0.0011 ms routing-decision p50, 100/100 synthetic failovers, and 85.0% modeled savings for cost-first versus quality-first routing. Rerun it on your own machine; these are not provider performance claims.

The benchmark does not measure real model quality, provider latency, or billing accuracy. Cost ceilings use configured prices and token estimates before provider calls; actual tokenization and provider billing can differ. If reported usage exceeds the estimate, the receipt is marked interrupted with `budget_exceeded` and no further provider call is started, but the charge already incurred cannot be reversed. Comparison mode records two model runs, so request counts in analytics count model executions rather than unique human submissions. Receipts are local JSONL metadata with 30-day retention, not an encrypted multi-user audit database. The server is designed for a single operator on loopback, without account authentication or billing.
