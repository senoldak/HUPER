const $ = (sel) => document.querySelector(sel);

function escapeHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const DEFAULT_WATCHLIST = ["BTC", "ETH", "SOL", "DOGE", "LINK", "AVAX", "XRP", "BNB"];
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

let watchlist = [];
async function loadWatchlist() {
  const res = await api("/watchlist");
  watchlist = res.symbols && res.symbols.length ? res.symbols : DEFAULT_WATCHLIST;
  if (!res.symbols || !res.symbols.length) await api("/watchlist", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbols: watchlist }) });
  return watchlist;
}
async function addSymbol() {
  const raw = $("#watch-input").value.trim().toUpperCase();
  if (!raw) return;
  if (watchlist.includes(raw)) { toast(`${raw} zaten listede`); return; }
  watchlist.push(raw);
  try { await saveWatchlist(); } catch (e) { watchlist.pop(); toast(e.message); return; }
  $("#watch-input").value = "";
  toast(`${raw} eklendi`);
  poll();
}
async function removeSymbol(sym) {
  const prev = watchlist;
  watchlist = watchlist.filter((s) => s !== sym);
  try { await saveWatchlist(); } catch (e) { watchlist = prev; toast(e.message); return; }
  toast(`${sym} kaldırıldı`);
  poll();
}
async function saveWatchlist() {
  await api("/watchlist", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbols: watchlist }) });
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

function emptyRow(tbodyId, columns, message) {
  const tbody = document.querySelector(`#${tbodyId} tbody`);
  if (tbody && tbody.childElementCount === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = columns.length;
    td.className = "empty";
    td.textContent = message;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

async function poll() {
  try {
    if (watchlist.length === 0) await loadWatchlist();
    const [balances, positions, bots, equity] = await Promise.all([
      api("/balances"), api("/positions"), api("/bots"), api("/equity?limit=200"),
    ]);
    $("#mode").textContent = balances[0]?.asset || "—";
    $("#balance").textContent = `$${Number(balances[0]?.total ?? 0).toFixed(2)}`;
    drawEquity(equity);

    setTable("positions", positions, ["symbol", "side", "size", "avgEntry", "markPrice"],
      (r, c) => escapeHtml(r[c] ?? "—"));

    // Prices: unique symbols from watchlist + bots + positions
    const syms = [...new Set([...watchlist, ...positions.map((p) => p.symbol), ...bots.map((b) => b.symbol)])];
    const ticks = await Promise.all(syms.map((s) => api(`/ticks/${s}`)));
    setTable("prices", syms.map((s, i) => ({ symbol: s, tick: ticks[i].tick })), ["symbol", "bid", "ask", "mid", ""],
      (r, c) => {
        if (c === "") return `<button data-rm="${escapeHtml(r.symbol)}">Kaldır</button>`;
        if (c === "symbol") return escapeHtml(r.symbol);
        return r.tick ? Number(r.tick[c]).toFixed(2) : "—";
      });

    document.querySelectorAll("#prices [data-rm]").forEach((btn) => {
      btn.addEventListener("click", () => removeSymbol(btn.dataset.rm));
    });

    setTable("bots", bots, ["name", "strategy", "symbol", "status", "actions"],
      (r, c) => {
        if (c === "status") return `<span class="${escapeHtml(STATUS_CLASS[r.status] || "")}">${escapeHtml(r.status)}</span>`;
        if (c === "actions") {
          const verb = r.status === "running" ? "stop" : "start";
          const label = r.status === "running" ? "Durdur" : "Başlat";
          return `<button data-act="${verb}" data-id="${escapeHtml(r.id)}">${label}</button>
                  <button data-act="detail" data-id="${escapeHtml(r.id)}">Detay</button>
                  <button data-act="del" data-id="${escapeHtml(r.id)}" class="danger">Sil</button>`;
        }
        return escapeHtml(r[c] ?? "—");
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
    emptyRow("positions", ["symbol", "side", "size", "avgEntry", "markPrice"], "Henüz açık pozisyon yok");
    emptyRow("prices", ["symbol", "bid", "ask", "mid", ""], "Sembol eklemek için yukarıdaki input'u kullanın");
    emptyRow("bots", ["name", "strategy", "symbol", "status", "actions"], "Bot eklemek için yeni bot formunu kullanın");
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
      (r, c) => escapeHtml(r[c] ?? "—"));
    setTable("detail-positions", d.positions || [], ["symbol", "side", "size", "avg_entry", "closed_at"],
      (r, c) => (c === "closed_at" ? escapeHtml(r[c] ? new Date(r[c]).toLocaleString() : "açık") : escapeHtml(r[c] ?? "—")));
    setTable("detail-runs", d.runs || [], ["mode", "started_at", "stopped_at", "stop_reason"],
      (r, c) => (c === "started_at" || c === "stopped_at") ? escapeHtml(r[c] ? new Date(r[c]).toLocaleString() : "—") : escapeHtml(r[c] ?? "—"));
    emptyRow("detail-orders", ["id", "side", "price", "size", "status", "filled_size"], "Kayıt yok");
    emptyRow("detail-positions", ["symbol", "side", "size", "avg_entry", "closed_at"], "Kayıt yok");
    emptyRow("detail-runs", ["mode", "started_at", "stopped_at", "stop_reason"], "Kayıt yok");
  } catch (e) { toast(e.message); }
}

$("#back").addEventListener("click", () => { detailId = null; document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden")); $("#overview").classList.remove("hidden"); poll(); });

$("#watch-add").addEventListener("click", addSymbol);

poll();
setInterval(poll, 2000);
