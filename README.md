# Privacy-Preserving Multi-Model Gateway

Local-first multi-model routing with explicit privacy controls, failover, feedback, and cost visibility.

Implementation tracks [project-ideas #281](https://github.com/jpequegn/project-ideas/issues/281).

## Key-free demo

Run `npm ci && npm run demo`, then submit a prompt:

```sh
curl http://127.0.0.1:8787/api/generate \
  -H 'content-type: application/json' \
  -d '{"prompt":"Summarize this note","privacy":"local_only","policy":"balanced"}'
```

The three demo models return deterministic synthetic answers and costs. They do not call a model provider or claim to measure real model quality. The server binds to loopback only.

## Optional providers

Copy `config/models.example.json` and set `GATEWAY_MODELS_FILE` to the copy's path. Replace the model names, price estimates, and quality/latency priors for your deployment. For Ollama, install or pull the model locally and leave its URL on loopback. Hosted OpenAI-compatible endpoints require an HTTPS hostname in `GATEWAY_REMOTE_ALLOWLIST` and a server-side key named by `apiKeyEnv`. A hosted model with no key is omitted from the active catalog.

```sh
export GATEWAY_MODELS_FILE=config/models.local.json
export GATEWAY_REMOTE_ALLOWLIST=api.openai.com
export OPENAI_API_KEY=... # only when enabling the hosted entry
npm run dev
```

The request's `privacy` defaults to `local_only`. Set `remote_allowed` only when sending content to an explicitly configured hosted provider is acceptable. A remote provider can apply its own retention and training policies; this gateway cannot override them. Credentials and prompts never enter local receipts. Receipts contain only request metadata, are retained for 30 days, and can be deleted through the dashboard. Provider usage is recorded when the streaming response reports it; otherwise token counts and costs are estimates.

Adapter shapes follow the [Ollama chat API](https://docs.ollama.com/api/chat) and [OpenAI chat completion API](https://platform.openai.com/docs/api-reference/chat/create). Other OpenAI-compatible services may vary, so use the mocked contract tests or a live smoke check before relying on an endpoint.

See [the usage guide](docs/USAGE.md) for the dashboard, streaming and comparison APIs, verification commands, privacy limits, and extension ideas.
