const $ = (id) => document.getElementById(id);
const money = (value) => `$${Number(value ?? 0).toFixed(6)}`;
const milliseconds = (value) => `${Math.round(Number(value ?? 0))} ms`;
let currentReceiptId;

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

function cell(row, value) {
  const td = document.createElement("td");
  td.textContent = String(value);
  row.append(td);
}

function table(id, rows, columns) {
  const body = $(id);
  body.replaceChildren();
  for (const item of rows) {
    const row = document.createElement("tr");
    for (const column of columns) cell(row, column(item));
    body.append(row);
  }
}

function bars(id, entries, format) {
  const root = $(id);
  root.replaceChildren();
  if (!entries.length) {
    root.textContent = "No activity yet";
    return;
  }
  const largest = Math.max(0.000001, ...entries.map(([, value]) => value));
  for (const [label, value] of entries) {
    const row = document.createElement("div");
    row.className = "bar-row";
    const name = document.createElement("span");
    name.textContent = label;
    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = `${Math.max(2, (value / largest) * 100)}%`;
    track.append(fill);
    const amount = document.createElement("strong");
    amount.textContent = format(value);
    row.append(name, track, amount);
    root.append(row);
  }
}

async function refresh() {
  const [metrics, leaderboard, receipts] = await Promise.all([
    api("/api/metrics"),
    api("/api/leaderboard"),
    api("/api/receipts"),
  ]);
  $("metric-requests").textContent = String(metrics.requests);
  $("metric-cost").textContent = money(metrics.totalCostUsd);
  $("metric-latency").textContent = milliseconds(metrics.latencyMs.p50);
  $("metric-decision").textContent = milliseconds(metrics.decisionMs.p50);
  bars(
    "cost-chart",
    Object.entries(metrics.perModel).map(([name, data]) => [
      name,
      data.costUsd,
    ]),
    money,
  );
  bars(
    "frequency-chart",
    Object.entries(metrics.frequency)
      .slice(-6)
      .map(([hour, count]) => [hour.slice(11, 16), count]),
    String,
  );
  table("leaderboard", leaderboard.models, [
    (model) => model.modelId,
    (model) => model.requests,
    (model) => model.ratings,
    (model) =>
      model.positiveRate === null
        ? "Not enough data"
        : `${Math.round(model.positiveRate * 100)}%`,
    (model) =>
      model.qualityEvidence === "user_feedback"
        ? "User feedback"
        : "Insufficient",
  ]);
  table("receipts", receipts.receipts.slice(0, 10), [
    (receipt) => new Date(receipt.createdAt).toLocaleString(),
    (receipt) => receipt.modelId ?? "Unserved",
    (receipt) => receipt.outcome,
    (receipt) => money(receipt.costUsd),
    (receipt) => milliseconds(receipt.elapsedMs),
  ]);
}

function renderResult(data) {
  const { receipt } = data;
  currentReceiptId = receipt.outcome === "completed" ? receipt.id : undefined;
  $("empty-result").hidden = true;
  $("result").hidden = false;
  $("model-name").textContent = receipt.modelId ?? "Unserved";
  $("outcome").textContent = receipt.outcome;
  $("answer").textContent = data.answer || "No answer returned.";
  $("cost").textContent = `${money(receipt.costUsd)} ${receipt.costKind} cost`;
  $("latency").textContent = milliseconds(receipt.elapsedMs);
  $("feedback-state").textContent = "";
  $("rate-up").disabled = !currentReceiptId;
  $("rate-down").disabled = !currentReceiptId;
  const attempts = $("attempts");
  attempts.replaceChildren();
  for (const attempt of receipt.attempts) {
    const item = document.createElement("li");
    item.textContent = `${attempt.modelId}: ${attempt.status} (${milliseconds(attempt.elapsedMs)})`;
    attempts.append(item);
  }
}

$("prompt-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("send").disabled = true;
  $("request-state").textContent = "Routing...";
  try {
    const budget = $("budget").value;
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: $("prompt").value,
        policy: $("policy").value,
        privacy: $("remote").checked ? "remote_allowed" : "local_only",
        ...(budget === "" ? {} : { maxCostUsd: Number(budget) }),
      }),
    });
    const data = await response.json();
    if (!response.ok && !data.receipt) throw new Error(data.error ?? `HTTP ${response.status}`);
    renderResult(data);
    $("request-state").textContent = data.receipt.outcome === "completed" ? "Complete" : "Interrupted";
    await refresh();
  } catch (error) {
    $("request-state").textContent = error.message;
  } finally {
    $("send").disabled = false;
  }
});

for (const [id, rating] of [
  ["rate-up", "up"],
  ["rate-down", "down"],
]) {
  $(id).addEventListener("click", async () => {
    if (!currentReceiptId) return;
    try {
      await api("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: currentReceiptId,
          rating,
          corrected: false,
        }),
      });
      $("feedback-state").textContent = "Saved";
      await refresh();
    } catch (error) {
      $("feedback-state").textContent = error.message;
    }
  });
}

$("clear-history").addEventListener("click", async () => {
  if (!window.confirm("Delete all local receipts and feedback?")) return;
  await api("/api/receipts", { method: "DELETE" });
  currentReceiptId = undefined;
  $("result").hidden = true;
  $("empty-result").hidden = false;
  await refresh();
});

api("/api/health")
  .then(async () => {
    $("connection").textContent = "Local gateway online";
    const models = await api("/api/models");
    $("remote").disabled = !models.models.some((model) => model.locality === "remote");
    if (!models.synthetic)
      $("data-note").textContent = "Costs use provider token counts when reported, otherwise estimates. User ratings are not verified model quality.";
    return refresh();
  })
  .catch(() => {
    $("connection").textContent = "Gateway unavailable";
  });
