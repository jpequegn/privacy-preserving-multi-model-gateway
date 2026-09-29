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
