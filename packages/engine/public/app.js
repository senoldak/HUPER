const $ = (sel) => document.querySelector(sel);
const paramsDefs = {
  grid: { levels: "number", spacingPct: "number", orderSize: "number" },
  dca: { stepPct: "number", takeProfitPct: "number", totalSteps: "number", baseSize: "number", sizeMultiplier: "number" },
  trend: { fastEma: "number", slowEma: "number", orderSize: "number", rsiPeriod: "number", oversold: "number", overbought: "number", stopLossPct: "number", takeProfitPct: "number" },
};
const STATUS_CLASS = { running: "status-running", stopped: "status-stopped", error: "status-error" };

let detailId = null;

function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden"); setTimeout(() => t.classList.add("hidden"), 3000); }

// Tabs
document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
    $(`#${btn.dataset.tab}`).classList.remove("hidden");
    detailId = null;
    poll();
  });
});

// Dynamic params form
function renderParams() {
  const strat = $("#strategy-select").value;
  $("#params").innerHTML = Object.keys(paramsDefs[strat])
    .map((k) => `<label>${k}<input name="params.${k}" type="number" step="any"></label>`)
    .join("");
}
$("#strategy-select").addEventListener("change", renderParams);
renderParams();

$("#new-bot").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const params = {};
  Object.keys(paramsDefs[$("#strategy-select").value]).forEach((k) => {
    const v = fd.get(`params.${k}`);
    if (v !== null && v !== "") params[k] = Number(v);
  });
  const body = { name: fd.get("name"), strategy: fd.get("strategy"), symbol: fd.get("symbol").toUpperCase(), params };
  try {
    const res = await fetch("/bots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || res.statusText); }
    ev.target.reset();
    toast("Bot oluşturuldu");
    poll();
  } catch (e) { toast(e.message); }
});

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

async function action(id, verb) {
  try { await api(`/bots/${id}/${verb}`, { method: "POST" }); poll(); }
  catch (e) { toast(e.message); }
}

async function del(id) {
  try { await api(`/bots/${id}`, { method: "DELETE" }); poll(); }
  catch (e) { toast(e.message); }
}

// Equity chart (canvas line)
function drawEquity(rows) {
  const canvas = $("#equity-chart");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (rows.length < 2) { ctx.fillStyle = "#9aa0a6"; ctx.font = "13px sans-serif"; ctx.fillText("Yeterli veri yok", 8, 20); return; }
  const w = canvas.width, h = canvas.height;
  const xs = rows.map((r) => r.ts), ys = rows.map((r) => r.value);
  const min = Math.min(...ys), max = Math.max(...ys);
  const span = max - min || 1;
  ctx.strokeStyle = "#2ecc71"; ctx.lineWidth = 2; ctx.beginPath();
  for (let i = 0; i < rows.length; i++) {
    const px = 8 + ((xs[i] - xs[0]) / (xs[xs.length - 1] - xs[0])) * (w - 16);
    const py = h - 8 - ((ys[i] - min) / span) * (h - 16);
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.stroke();
  $("#equity-last").textContent = `$${ys[ys.length - 1].toFixed(2)}`;
}

function setTable(id, rows, columns, cell) {
  const tbody = document.querySelector(`#${id} tbody`);
  if (!tbody) return;
  tbody.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    columns.forEach((c, i) => { const td = document.createElement("td"); td.innerHTML = cell(row, c, i); tr.appendChild(td); });
    tbody.appendChild(tr);
  }
}

async function poll() {
  try {
    const [balances, positions, bots, equity] = await Promise.all([
      api("/balances"), api("/positions"), api("/bots"), api("/equity?limit=200"),
    ]);
    $("#mode").textContent = balances[0]?.asset || "—";
    $("#balance").textContent = `$${Number(balances[0]?.total ?? 0).toFixed(2)}`;
    drawEquity(equity);

    setTable("positions", positions, ["symbol", "side", "size", "avgEntry", "markPrice"],
      (r, c) => (r[c] ?? "—"));

    // Prices: unique symbols from bots + positions
    const syms = [...new Set([...positions.map((p) => p.symbol), ...bots.map((b) => b.symbol)])];
    const ticks = await Promise.all(syms.map((s) => api(`/ticks/${s}`)));
    setTable("prices", syms.map((s, i) => ({ symbol: s, tick: ticks[i].tick })), ["symbol", "bid", "ask", "mid"],
      (r, c) => c === "symbol" ? r.symbol : (r.tick ? Number(r.tick[c]).toFixed(2) : "—"));

    setTable("bots", bots, ["name", "strategy", "symbol", "status", "actions"],
      (r, c) => {
        if (c === "status") return `<span class="${STATUS_CLASS[r.status]}">${r.status}</span>`;
        if (c === "actions") {
          const stop = r.status === "running" ? `<button data-act="stop" data-id="${r.id}">Durdur</button>` : `<button data-act="start" data-id="${r.id}">Başlat</button>`;
          return `${stop} <button data-act="detail" data-id="${r.id}">Detay</button> <button data-act="del" data-id="${r.id}" class="danger">Sil</button>`;
        }
        return r[c] ?? "—";
      });

    // Delegated action buttons (event delegation)
    document.querySelectorAll("#bots [data-act]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const act = btn.dataset.act, id = btn.dataset.id;
        if (act === "start" || act === "stop") return action(id, act);
        if (act === "del") return del(id);
        if (act === "detail") { detailId = id; await showDetail(id); }
      });
    });

    if (detailId) await showDetail(detailId);
  } catch { /* silent — next poll retries */ }
}

async function showDetail(id) {
  try {
    const d = await api(`/bots/${id}`);
    $("#detail").classList.remove("hidden");
    document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
    $("#detail").classList.remove("hidden");
    $("#detail-name").textContent = `${d.name} (${d.status})`;
    setTable("detail-orders", d.orders || [], ["id", "side", "price", "size", "status", "filled_size"],
      (r, c) => (r[c] ?? "—"));
    setTable("detail-positions", d.positions || [], ["symbol", "side", "size", "avg_entry", "closed_at"],
      (r, c) => (c === "closed_at" ? (r[c] ? new Date(r[c]).toLocaleString() : "açık") : (r[c] ?? "—")));
    setTable("detail-runs", d.runs || [], ["mode", "started_at", "stopped_at", "stop_reason"],
      (r, c) => (c === "started_at" || c === "stopped_at") ? (r[c] ? new Date(r[c]).toLocaleString() : "—") : (r[c] ?? "—"));
  } catch (e) { toast(e.message); }
}

$("#back").addEventListener("click", () => { detailId = null; document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden")); $("#overview").classList.remove("hidden"); poll(); });

poll();
setInterval(poll, 2000);
