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

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  setTimeout(() => t.classList.add("hidden"), 3500);
}

// Navigation Tabs
document.querySelectorAll(".nav-tabs .tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-tabs .tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
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
    .map((k) => `<label>${k}<input name="params.${k}" type="number" step="any" placeholder="0"></label>`)
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
    renderParams();
    toast("✨ Bot başarıyla oluşturuldu");
    poll();
  } catch (e) { toast(`⚠️ ${e.message}`); }
});

// Emergency Stop Button
$("#btn-emergency").addEventListener("click", async () => {
  if (!confirm("⚠️ PANİK DURDURMA: Tüm botlar durdurulacak, açık emirler iptal edilecek ve pozisyonlar kapatılacaktır. Emin misiniz?")) {
    return;
  }
  try {
    const res = await api("/emergency-stop", { method: "POST" });
    toast(`🚨 Acil Durum Çalıştırıldı: Botlar=${res.stoppedBotsCount}, Emirler=${res.cancelledOrdersCount}`);
    poll();
  } catch (e) {
    toast(`❌ Acil Durum Hatası: ${e.message}`);
  }
});

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

let watchlist = [];
let watchlistLoaded = false;

async function loadWatchlist() {
  const res = await api("/watchlist");
  watchlistLoaded = true;
  watchlist = res.persisted ? res.symbols : DEFAULT_WATCHLIST;
  if (!res.persisted) await api("/watchlist", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbols: watchlist }) });
  return watchlist;
}

async function addSymbol() {
  const raw = $("#watch-input").value.trim().toUpperCase();
  if (!raw) return;
  if (!/^[A-Z0-9.\-]{1,20}$/.test(raw)) { toast("Geçersiz sembol biçimi"); return; }
  if (watchlist.includes(raw)) { toast(`${raw} zaten listenizde ekli`); return; }
  watchlist.push(raw);
  try { await saveWatchlist(); } catch (e) { watchlist.pop(); toast(e.message); return; }
  $("#watch-input").value = "";
  toast(`➕ ${raw} izleme listesine eklendi`);
  poll();
}

async function removeSymbol(sym) {
  const prev = watchlist;
  watchlist = watchlist.filter((s) => s !== sym);
  try { await saveWatchlist(); } catch (e) { watchlist = prev; toast(e.message); return; }
  toast(`🗑️ ${sym} listeden çıkarıldı`);
  poll();
}

async function saveWatchlist() {
  await api("/watchlist", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbols: watchlist }) });
}

async function action(id, verb) {
  try {
    await api(`/bots/${id}/${verb}`, { method: "POST" });
    toast(`Bot ${verb === "start" ? "başlatıldı" : "durduruldu"}`);
    poll();
  } catch (e) { toast(e.message); }
}

async function del(id) {
  if (!confirm("Bu botu silmek istediğinize emin misiniz?")) return;
  try {
    await api(`/bots/${id}`, { method: "DELETE" });
    toast("Bot silindi");
    poll();
  } catch (e) { toast(e.message); }
}

// Enhanced Equity Chart Canvas Renderer
function drawEquity(rows) {
  const canvas = $("#equity-chart");
  if (!canvas) return;
  
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = (rect.width || 800) * dpr;
  canvas.height = (rect.height || 220) * dpr;

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const w = rect.width || 800;
  const h = rect.height || 220;

  ctx.clearRect(0, 0, w, h);

  if (rows.length < 2) {
    ctx.fillStyle = "#64748b";
    ctx.font = "500 13px Inter, sans-serif";
    ctx.fillText("Equity verisi henüz yetersiz...", 16, 32);
    $("#equity-last").textContent = "$0.00";
    return;
  }

  const paddingLeft = 12, paddingRight = 12, paddingTop = 16, paddingBottom = 16;
  const graphWidth = w - paddingLeft - paddingRight;
  const graphHeight = h - paddingTop - paddingBottom;

  const xs = rows.map((r) => r.ts);
  const ys = rows.map((r) => r.value);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = max - min || 1;

  // Background Grid Lines
  ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i++) {
    const yGrid = paddingTop + (graphHeight / 4) * i;
    ctx.beginPath();
    ctx.moveTo(paddingLeft, yGrid);
    ctx.lineTo(w - paddingRight, yGrid);
    ctx.stroke();
  }

  // Linear Line Points calculation
  const points = rows.map((r, i) => {
    const px = paddingLeft + ((xs[i] - xs[0]) / (xs[xs.length - 1] - xs[0])) * graphWidth;
    const py = paddingTop + graphHeight - ((ys[i] - min) / span) * graphHeight;
    return { x: px, y: py };
  });

  // Area Fill Gradient
  const gradient = ctx.createLinearGradient(0, paddingTop, 0, h - paddingBottom);
  gradient.addColorStop(0, "rgba(6, 182, 212, 0.25)");
  gradient.addColorStop(1, "rgba(6, 182, 212, 0.0)");

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.lineTo(points[points.length - 1].x, h - paddingBottom);
  ctx.lineTo(points[0].x, h - paddingBottom);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Line Stroke
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.strokeStyle = "#06b6d4";
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Last Point Pulse Dot
  const lastP = points[points.length - 1];
  ctx.beginPath();
  ctx.arc(lastP.x, lastP.y, 4, 0, Math.PI * 2);
  ctx.fillStyle = "#10b981";
  ctx.fill();

  const lastVal = ys[ys.length - 1];
  $("#equity-last").textContent = `$${lastVal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
    if (!watchlistLoaded) await loadWatchlist();
    const [balances, positions, bots, equity] = await Promise.all([
      api("/balances"), api("/positions"), api("/bots"), api("/equity?limit=200"),
    ]);

    const mode = balances[0]?.asset || "PAPER";
    $("#mode").textContent = mode;
    $("#balance").textContent = `$${Number(balances[0]?.total ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    $("#active-positions-count").textContent = positions.length;
    $("#active-bots-count").textContent = bots.filter((b) => b.status === "running").length;

    drawEquity(equity);

    setTable("positions", positions, ["symbol", "side", "size", "avgEntry", "markPrice"], (r, c) => {
      if (c === "side") {
        const color = r.side === "LONG" || r.side === "buy" ? "var(--green-emerald)" : "var(--red-rose)";
        return `<span style="color: ${color}; font-weight: 600;">${escapeHtml(r.side)}</span>`;
      }
      return escapeHtml(r[c] ?? "—");
    });

    // Prices table
    const syms = [...new Set([...watchlist, ...positions.map((p) => p.symbol), ...bots.map((b) => b.symbol)])];
    const ticks = await Promise.all(syms.map((s) => api(`/ticks/${s}`)));
    setTable("prices", syms.map((s, i) => ({ symbol: s, tick: ticks[i].tick })), ["symbol", "bid", "ask", "mid", ""], (r, c) => {
      if (c === "") return `<button data-rm="${escapeHtml(r.symbol)}" class="btn btn-sm btn-danger">Kaldır</button>`;
      if (c === "symbol") return `<strong style="color: var(--text-main);">${escapeHtml(r.symbol)}</strong>`;
      return r.tick ? Number(r.tick[c]).toFixed(2) : "—";
    });

    document.querySelectorAll("#prices [data-rm]").forEach((btn) => {
      btn.addEventListener("click", () => removeSymbol(btn.dataset.rm));
    });

    setTable("bots", bots, ["name", "strategy", "symbol", "status", "actions"], (r, c) => {
      if (c === "status") return `<span class="${escapeHtml(STATUS_CLASS[r.status] || "")}">${escapeHtml(r.status)}</span>`;
      if (c === "actions") {
        const verb = r.status === "running" ? "stop" : "start";
        const label = r.status === "running" ? "Durdur" : "Başlat";
        const btnClass = r.status === "running" ? "btn-danger" : "btn-primary";
        return `<button data-act="${verb}" data-id="${escapeHtml(r.id)}" class="btn btn-sm ${btnClass}">${label}</button>
                <button data-act="detail" data-id="${escapeHtml(r.id)}" class="btn btn-sm">Detay</button>
                <button data-act="del" data-id="${escapeHtml(r.id)}" class="btn btn-sm btn-danger">Sil</button>`;
      }
      return escapeHtml(r[c] ?? "—");
    });

    document.querySelectorAll("#bots [data-act]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const act = btn.dataset.act, id = btn.dataset.id;
        if (act === "start" || act === "stop") return action(id, act);
        if (act === "del") return del(id);
        if (act === "detail") { detailId = id; await showDetail(id); }
      });
    });

    if (detailId) await showDetail(detailId);
    emptyRow("positions", ["symbol", "side", "size", "avgEntry", "markPrice"], "Henüz açık bir pozisyon bulunmuyor");
    emptyRow("prices", ["symbol", "bid", "ask", "mid", ""], "Sembol eklemek için yukarıdaki kutuyu kullanabilirsiniz");
    emptyRow("bots", ["name", "strategy", "symbol", "status", "actions"], "Kayıtlı bot yok. 'Yeni Bot Oluştur' sekmesinden ekleyebilirsiniz.");
  } catch { /* retry on next cycle */ }
}

async function showDetail(id) {
  try {
    const d = await api(`/bots/${id}`);
    document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
    $("#detail").classList.remove("hidden");
    $("#detail-name").textContent = `${d.name} (${d.strategy.toUpperCase()}) — ${d.status.toUpperCase()}`;

    setTable("detail-orders", d.orders || [], ["id", "side", "price", "size", "status", "filled_size"],
      (r, c) => escapeHtml(r[c] ?? "—"));
    setTable("detail-positions", d.positions || [], ["symbol", "side", "size", "avg_entry", "closed_at"],
      (r, c) => (c === "closed_at" ? escapeHtml(r[c] ? new Date(r[c]).toLocaleString() : "Açık Pozisyon") : escapeHtml(r[c] ?? "—")));
    setTable("detail-runs", d.runs || [], ["mode", "started_at", "stopped_at", "stop_reason"],
      (r, c) => (c === "started_at" || c === "stopped_at") ? escapeHtml(r[c] ? new Date(r[c]).toLocaleString() : "—") : escapeHtml(r[c] ?? "—"));

    emptyRow("detail-orders", ["id", "side", "price", "size", "status", "filled_size"], "Henüz verilmiş bir emir yok");
    emptyRow("detail-positions", ["symbol", "side", "size", "avg_entry", "closed_at"], "Pozisyon geçmişi bulunmuyor");
    emptyRow("detail-runs", ["mode", "started_at", "stopped_at", "stop_reason"], "Çalıştırma kaydı yok");
  } catch (e) { toast(e.message); }
}

$("#back").addEventListener("click", () => {
  detailId = null;
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  $("#overview").classList.remove("hidden");
  poll();
});

$("#watch-add").addEventListener("click", addSymbol);
$("#watch-input").addEventListener("keypress", (e) => { if (e.key === "Enter") addSymbol(); });

window.addEventListener("resize", () => {
  api("/equity?limit=200").then((equity) => drawEquity(equity)).catch(() => {});
});

poll();
setInterval(poll, 2500);

