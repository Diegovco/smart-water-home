/* =========================================================
   1. UTILIDADES
   ========================================================= */
const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, "0");
const hhmm = sec => pad(Math.floor(sec / 3600) % 24) + ":" + pad(Math.floor(sec / 60) % 60);
const toMin = txt => { const p = txt.split(":"); return (+p[0]) * 60 + (+p[1]); };
const rnd = (a, b) => a + Math.random() * (b - a);
const sum = arr => arr.reduce((a, b) => a + b, 0);
const money = n => "$" + Math.round(n).toLocaleString("es-MX");
const DIAS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const KEY = "smartwater-v2";   // nombre en localStorage

/* =========================================================
   2. MODELO DE CONSUMO
   ========================================================= */
// Tipos de uso: flujo (L/min) y duración (segundos). "c" = color en gráficas.
const TIPOS = {
  regadera: { n: "Regadera",   i: "🚿", f: [8, 10], d: [300, 660], c: "--c1" },
  wc:       { n: "Sanitario",  i: "🚽", f: [5, 7],  d: [50, 80],   c: "--c2" },
  grifo:    { n: "Lavabo",     i: "🚰", f: [4, 7],  d: [15, 90],   c: "--c3" },
  trastes:  { n: "Fregadero",  i: "🍽", f: [4, 6],  d: [180, 480], c: "--c4" },
  lavadora: { n: "Lavadora",   i: "🧺", f: [9, 12], d: [480, 720], c: "--c5" },
  fuga:     { n: "Fuga / no identificado", i: "💧", c: "--c6" }
};
const CONSEJOS = {
  regadera: "Bañarte 2 minutos menos ahorra cerca de 18 L por persona al día.",
  wc: "Un sanitario ahorrador (4.8 L por descarga) reduce mucho este consumo.",
  grifo: "Cierra la llave mientras te lavas los dientes o te enjabonas las manos.",
  trastes: "Enjabona todos los trastes primero y enjuágalos juntos.",
  lavadora: "Usa la lavadora solo con carga completa.",
  fuga: "Hay flujo que no corresponde a ningún aparato: revisa tuberías y el sanitario."
};
// Probabilidad de que empiece un uso en cada minuto, según la hora del día
const PERFIL = [0,0,0,0,0,.005,.04,.06,.05,.025,.02,.02,.025,.03,.02,.015,.015,.02,.04,.05,.045,.03,.015,.005];
const SPEEDS = [[0, "Pausa"], [1, "1×"], [60, "60×"], [600, "600×"], [3600, "3600×"]];

/* =========================================================
   3. ESTADO
   ========================================================= */
function defaultCfg() {
  return {
    house: "Casa principal", people: 4, meter: "SW-0001",
    goal: 300, auto: true, detectMin: 15,
    schedOn: false, schedFrom: "01:00", schedTo: "05:00",
    tariff: "escalonada", rate: 71,
    // Valores de ejemplo: cámbialos por los de tu organismo de agua
    tiers: [{ hasta: 10, precio: 15 }, { hasta: 20, precio: 22 }, { hasta: 30, precio: 35 }, { hasta: null, precio: 55 }],
    theme: "auto", notif: false, sound: true
  };
}
function emptyTypes() { return { regadera: 0, wc: 0, grifo: 0, trastes: 0, lavadora: 0, fuga: 0 }; }

const S = {
  cfg: defaultCfg(),
  view: "dash", range: "week", speed: 60,
  t: 0, date: new Date(),
  consumed: 0, hours: Array(24).fill(0), byType: emptyTypes(), history: [],
  flow: 0, valve: true, leak: 0, cont: 0, leakAlerted: false, leakFound: false,
  over: false, schedClosed: false, events: [], alerts: [], unread: 0, quiet: true
};

/* =========================================================
   4. GUARDAR / CARGAR (localStorage)
   ========================================================= */
let canSave = true;
function save() {
  if (!canSave) return;
  const data = {
    cfg: S.cfg, speed: S.speed, t: S.t, date: S.date.getTime(),
    consumed: S.consumed, hours: S.hours, byType: S.byType, history: S.history,
    valve: S.valve, leak: S.leak, leakFound: S.leakFound, over: S.over,
    schedClosed: S.schedClosed, alerts: S.alerts, unread: S.unread
  };
  try { localStorage.setItem(KEY, JSON.stringify(data)); }
  catch (e) { canSave = false; $("#saveTxt").textContent = "Este navegador no permite guardar datos; se perderán al recargar."; }
}
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (!d) return false;
    Object.assign(S, d);
    S.cfg = Object.assign(defaultCfg(), d.cfg);
    S.date = new Date(d.date);
    return true;
  } catch (e) { return false; }
}
function askClear() {
  modal("🗑", "¿Borrar todos los datos?", "Se eliminará el historial, las alertas y los ajustes guardados.", [
    { t: "Borrar todo", cls: "red", fn: () => { try { localStorage.removeItem(KEY); } catch (e) {} canSave = false; location.reload(); } },
    { t: "Cancelar", cls: "ghost" }
  ]);
}

/* =========================================================
   5. SIMULACIÓN (1 paso = 1 segundo simulado)
   ========================================================= */
function pickType(h) {
  const w = {
    grifo: .45, wc: .35,
    trastes: (h >= 13 && h <= 15) || (h >= 20 && h <= 21) ? .2 : .06,
    regadera: (h >= 6 && h <= 8) || (h >= 19 && h <= 21) ? .3 : .03,
    lavadora: h >= 9 && h <= 18 ? .04 : 0
  };
  let r = Math.random() * sum(Object.values(w));
  for (const k in w) { r -= w[k]; if (r <= 0) return k; }
  return "grifo";
}

function startEvent(k, manual) {
  if (!S.valve) { if (manual) toast("La válvula está cerrada; ábrela primero."); return; }
  const T = TIPOS[k];
  S.events.push({ k, f: rnd(T.f[0], T.f[1]), left: Math.round(rnd(T.d[0], T.d[1])) });
  if (manual) refresh();
}

function checkSchedule() {
  if (!S.cfg.schedOn) return;
  const min = S.t / 60;
  const rango = `${S.cfg.schedFrom}–${S.cfg.schedTo}`;
  if (min === toMin(S.cfg.schedFrom) && S.valve) {
    closeValve(`Cierre programado (${rango}).`, "i");
    S.schedClosed = true;
  } else if (min === toMin(S.cfg.schedTo) && S.schedClosed && !S.valve) {
    S.schedClosed = false;
    openValve("Apertura programada: válvula abierta.");
  }
}

function step() {
  const h = Math.floor(S.t / 3600);
  if (S.t % 60 === 0) {
    checkSchedule();
    if (Math.random() < PERFIL[h]) startEvent(pickType(h));
  }

  let f = 0;
  if (S.valve) {
    for (const e of S.events) {
      f += e.f; e.left--;
      S.byType[e.k] += e.f / 60;
    }
    S.events = S.events.filter(e => e.left > 0);
    f += S.leak;
    S.byType.fuga += S.leak / 60;
  }
  S.flow = f;
  S.consumed += f / 60;
  S.hours[h] += f / 60;

  // Detección de fuga: el flujo nunca baja a cero durante X minutos
  if (f > 0) S.cont++; else { S.cont = 0; S.leakAlerted = false; }
  if (!S.quiet && !S.leakAlerted && S.cont >= S.cfg.detectMin * 60) leakDetected();

  if (!S.over && S.consumed >= S.cfg.goal) {
    S.over = true;
    addAlert(`Meta diaria superada (${S.cfg.goal} L) a las ${hhmm(S.t)}.`, "w");
  }

  S.t++;
  if (S.t >= 86400) newDay();
}

function leakDetected() {
  S.leakAlerted = true; S.leakFound = true;
  const msg = `Flujo continuo por ${S.cfg.detectMin} min (${S.flow.toFixed(1)} L/min).`;
  if (S.cfg.auto) {
    addAlert(msg + " Posible fuga.", "w", true);
    closeValve("Cierre automático ejecutado por posible fuga.", "w", true);
    modal("🛑", "Válvula cerrada automáticamente", msg + " Se cerró la válvula para evitar pérdidas. Revisa la instalación antes de abrirla.", [
      { t: "Entendido", cls: "blu" },
      { t: "Abrir válvula de todos modos", cls: "ghost", fn: () => openValve() }
    ]);
  } else {
    addAlert(msg + " Posible fuga. ¿Cerrar válvula?", "w", true);
    modal("💧", "Posible fuga detectada", msg + " ¿Quieres cerrar la válvula principal?", [
      { t: "Cerrar válvula", cls: "red", fn: () => closeValve("Válvula cerrada por el usuario ante posible fuga.", "i") },
      { t: "Ignorar", cls: "ghost", fn: () => addAlert("Alerta de fuga ignorada por el usuario.", "i") }
    ]);
  }
}

function newDay() {
  const total = Math.round(S.consumed);
  S.history.push(total);
  if (S.history.length > 29) S.history.shift();
  addAlert(`Día cerrado: ${total} L consumidos (${total <= S.cfg.goal ? "dentro" : "fuera"} de la meta).`, "i");
  S.t = 0; S.consumed = 0; S.hours = Array(24).fill(0); S.byType = emptyTypes(); S.over = false;
  S.date = new Date(S.date.getTime() + 86400000);
  if (S.view === "stats") render();
}

/* =========================================================
   6. ACCIONES DEL USUARIO
   ========================================================= */
function closeValve(msg, type, silent) {
  S.valve = false; S.flow = 0; S.events = []; S.cont = 0;
  addAlert(msg, type || "i", silent);
  if (!S.quiet) render();
}
function openValve(msg) {
  S.valve = true; S.schedClosed = false;
  addAlert(msg || "Válvula abierta.", "i");
  if (!S.quiet) render();
}
function toggleValve() { S.valve ? closeValve("Válvula cerrada manualmente.") : openValve(); }
function emergency() {
  if (S.valve) closeValve("PARO DE EMERGENCIA: válvula cerrada.", "w");
  else toast("La válvula ya está cerrada.");
}
function setLeak(v) {
  if (v === 0) {
    if (S.leak) addAlert("Fuga reparada.", "i");
    S.leak = 0; S.leakFound = false;
  } else {
    S.leak = v;
    if (!S.valve) toast("Fuga activa, pero la válvula está cerrada: no saldrá agua hasta abrirla.");
  }
  render();
}
function skip(sec) { for (let i = 0; i < sec; i++) step(); refresh(); }
function resetDay() {
  S.t = 0; S.consumed = 0; S.hours = Array(24).fill(0); S.byType = emptyTypes(); S.over = false;
  S.events = []; S.cont = 0; S.leak = 0; S.leakFound = false; S.valve = true; S.alerts = []; S.unread = 0;
  render(); save();
}
function setSpeed(v) { S.speed = v; renderSpeeds(); save(); }

/* Cambiar un ajuste. "redraw" = volver a dibujar la pantalla */
function setCfg(key, value, redraw) {
  S.cfg[key] = value;
  if (key === "goal") S.over = S.consumed >= value;
  if (key === "theme") applyTheme();
  if (key === "house") $("#house").textContent = value || "Smart Water Home";
  save();
  if (redraw) render();
}
function setTier(i, value) { S.cfg.tiers[i].precio = Math.max(0, +value || 0); save(); refresh(); }

/* =========================================================
   7. TEMA Y NOTIFICACIONES
   ========================================================= */
function applyTheme() {
  if (S.cfg.theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", S.cfg.theme);
}

/* Revisa si se pueden usar las notificaciones y, si no, explica por qué */
function notifProblem() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  let enIframe = false;
  try { enIframe = window.self !== window.top; } catch (e) { enIframe = true; }
  if (location.protocol === "file:")
    return "Abriste el archivo directo desde la carpeta (file://) y el navegador bloquea los avisos ahí. Ábrelo con un servidor local, por ejemplo la extensión Live Server de VS Code (clic derecho → Open with Live Server).";
  if (enIframe)
    return "La página está dentro de una vista previa (iframe) y ahí los avisos están bloqueados. Ábrela en su propia pestaña.";
  if (!window.isSecureContext)
    return "Los avisos solo funcionan en páginas https:// o en localhost.";
  if (!("Notification" in window))
    return ios ? "En iPhone solo funcionan si agregas la página a la pantalla de inicio (iOS 16.4 o más reciente)."
               : "Este navegador no soporta notificaciones.";
  if (Notification.permission === "denied")
    return "Bloqueaste los avisos para esta página. Da clic en el candado o el ícono junto a la dirección → Notificaciones → Permitir, y recarga la página.";
  return "";
}

function toggleNotif(on) {
  if (!on) { setCfg("notif", false, true); return; }
  const problema = notifProblem();
  if (problema) { setCfg("notif", false, true); modal("🔕", "No se pueden activar los avisos", problema, [{ t: "Entendido", cls: "blu" }]); return; }
  try {
    // Algunos navegadores viejos usan callback en lugar de promesa
    const r = Notification.requestPermission(p => resultado(p));
    if (r && r.then) r.then(resultado);
  } catch (e) {
    setCfg("notif", false, true);
    toast("El navegador no permitió pedir el permiso.");
  }
  function resultado(p) {
    if (resultado.listo) return;
    resultado.listo = true;
    setCfg("notif", p === "granted", true);
    if (p === "granted") notify("Notificaciones activadas. Te avisaremos de fugas y metas superadas.");
    else modal("🔕", "Permiso no concedido", notifProblem() || "No diste permiso. Puedes intentarlo de nuevo.", [{ t: "Entendido", cls: "blu" }]);
  }
}

function testAlert() { addAlert("Prueba de alerta: así se verá un aviso de fuga.", "w"); }

/* Sonido de alerta (respaldo que funciona aunque no haya notificaciones) */
let audioCtx = null;
document.addEventListener("click", () => {
  if (!audioCtx && (window.AudioContext || window.webkitAudioContext)) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
});
function beep() {
  if (!S.cfg.sound || !audioCtx) return;
  [0, 0.25].forEach(delay => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880; o.type = "sine";
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime + delay);
    g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + delay + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + delay + 0.18);
    o.connect(g).connect(audioCtx.destination);
    o.start(audioCtx.currentTime + delay); o.stop(audioCtx.currentTime + delay + 0.2);
  });
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
}
function notify(text) {
  if (!S.cfg.notif || !("Notification" in window) || Notification.permission !== "granted") return;
  try { new Notification("Smart Water Home", { body: text }); } catch (e) {}
}

/* =========================================================
   8. ALERTAS, AVISOS Y MODAL
   ========================================================= */
function addAlert(t, type, silent) {
  if (S.quiet) return;
  S.alerts.unshift({ t, type, h: DIAS[S.date.getDay()] + " " + hhmm(S.t) });
  if (S.alerts.length > 60) S.alerts.pop();
  if (S.view !== "alerts") S.unread++;
  if (type === "w") { notify(t); beep(); if (!silent) toast(t); }
  if (S.view === "alerts" || S.view === "dash") render(); else renderNav();
  save();
}

let toastTimer;
function toast(t) {
  const e = $("#toast");
  e.textContent = "⚠ " + t;
  e.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => e.classList.remove("show"), 4000);
}

let modalBtns = [];
function modal(icon, title, text, buttons) {
  modalBtns = buttons;
  $("#mbox").innerHTML = `<div class="mi">${icon}</div><h3>${title}</h3><p>${text}</p>` +
    buttons.map((b, i) => `<button class="btn ${b.cls}" onclick="closeModal(${i})">${b.t}</button>`).join("");
  $("#modal").classList.add("show");
}
function closeModal(i) {
  $("#modal").classList.remove("show");
  const b = modalBtns[i];
  if (b && b.fn) b.fn();
}

/* =========================================================
   9. CÁLCULOS
   ========================================================= */
function costo(m3) {
  if (S.cfg.tariff === "fija") return m3 * S.cfg.rate;
  let total = 0, anterior = 0;
  for (const t of S.cfg.tiers) {
    const tope = t.hasta === null ? Infinity : t.hasta;
    if (m3 > anterior) total += (Math.min(m3, tope) - anterior) * t.precio;
    anterior = tope;
  }
  return total;
}
function last30() { return sum(S.history.slice(-29)) + S.consumed; }

// Qué fracción del consumo diario suele llevarse a esta hora (según PERFIL)
function dayFraction() {
  const h = Math.floor(S.t / 3600), m = (S.t % 3600) / 3600;
  return (sum(PERFIL.slice(0, h)) + PERFIL[h] * m) / sum(PERFIL);
}
function compareToday() {
  const avg = sum(S.history.slice(-7)) / Math.max(1, S.history.slice(-7).length);
  const normal = avg * dayFraction();
  return { avg, normal, pct: normal > 0 ? (S.consumed / normal - 1) * 100 : 0 };
}

function weekData() {
  const data = S.history.slice(-6).concat(Math.round(S.consumed));
  const labels = data.map((_, i) => DIAS[new Date(S.date.getTime() - (data.length - 1 - i) * 86400000).getDay()]);
  labels[labels.length - 1] = "Hoy";
  return [data, labels];
}
function monthData() {
  const data = S.history.slice(-29).concat(Math.round(S.consumed));
  const labels = data.map((_, i) => {
    const d = new Date(S.date.getTime() - (data.length - 1 - i) * 86400000).getDate();
    return i % 5 === 4 || i === data.length - 1 ? d : "";
  });
  return [data, labels];
}

/* =========================================================
   10. GRÁFICAS (SVG)
   ========================================================= */
function gauge() {
  return `<svg viewBox="0 0 200 150" aria-label="Consumo de hoy">
    <path d="M30 128 A80 80 0 1 1 170 128" fill="none" stroke="var(--lt)" stroke-width="16" stroke-linecap="round" pathLength="100"/>
    <path id="gArc" d="M30 128 A80 80 0 1 1 170 128" fill="none" stroke="var(--pri)" stroke-width="16" stroke-linecap="round" pathLength="100" stroke-dasharray="0 100"/>
    <text x="100" y="62" text-anchor="middle" class="gl1">CONSUMO DE HOY</text>
    <text x="100" y="96" text-anchor="middle" class="gv" id="gVal">0 L</text>
    <text x="100" y="116" text-anchor="middle" class="gl2" id="gGoal"></text>
  </svg>`;
}

function bars(data, labels, hi, goal) {
  const W = 320, H = 170, L = 30, B = 18, T = 8, ph = H - B - T;
  const mx = Math.max(...data, goal || 0, 1) * 1.1;
  const bw = (W - L) / data.length;
  let s = `<svg viewBox="0 0 ${W} ${H}" class="chart">`;
  for (let k = 0; k <= 3; k++) {
    const y = T + ph - ph * k / 3;
    s += `<line x1="${L}" x2="${W}" y1="${y}" y2="${y}" class="gl"/><text x="${L - 4}" y="${y + 3}" text-anchor="end">${Math.round(mx * k / 3)}</text>`;
  }
  data.forEach((v, i) => {
    const bh = Math.max(v / mx * ph, v > 0 ? 1 : 0), x = L + i * bw + bw * .15;
    const cls = goal && v > goal ? "b2" : i === hi ? "b1" : "b0";
    s += `<rect x="${x.toFixed(1)}" y="${(T + ph - bh).toFixed(1)}" width="${(bw * .7).toFixed(1)}" height="${bh.toFixed(1)}" rx="2" class="${cls}"><title>${Math.round(v)} L</title></rect>`;
    if (labels[i] !== "") s += `<text x="${(x + bw * .35).toFixed(1)}" y="${H - 4}" text-anchor="middle">${labels[i]}</text>`;
  });
  if (goal) { const y = T + ph - goal / mx * ph; s += `<line x1="${L}" x2="${W}" y1="${y}" y2="${y}" class="goal"/>`; }
  return s + "</svg>";
}

function lineChart() {
  const [d, labels] = weekData();
  const W = 320, H = 120, L = 14, R = 14, T = 12, B = 20, ph = H - T - B;
  const mx = Math.max(...d, S.cfg.goal) * 1.1;
  const n = d.length - 1;
  const pts = d.map((v, i) => [L + i * (W - L - R) / n, T + ph - v / mx * ph]);
  const gy = T + ph - S.cfg.goal / mx * ph;
  const linea = pts.map(p => p[0].toFixed(1) + "," + p[1].toFixed(1));
  return `<svg viewBox="0 0 ${W} ${H}" class="chart">
    <path d="M${linea.join(" L")} L${pts[n][0]},${T + ph} L${L},${T + ph}Z" fill="var(--lt)"/>
    <line x1="${L}" x2="${W - R}" y1="${gy}" y2="${gy}" class="goal"/>
    <polyline points="${linea.join(" ")}" fill="none" stroke="var(--pri)" stroke-width="2.5" stroke-linejoin="round"/>
    ${pts.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="${i === n ? 4.5 : 3}" fill="${d[i] > S.cfg.goal ? "var(--bad)" : "var(--pri)"}"><title>${labels[i]}: ${d[i]} L</title></circle>`).join("")}
    ${labels.map((x, i) => `<text x="${pts[i][0]}" y="${H - 5}" text-anchor="middle">${x}</text>`).join("")}
  </svg>`;
}

function donut() {
  const keys = Object.keys(TIPOS);
  const total = sum(keys.map(k => S.byType[k]));
  if (total < 1) return `<div class="empty">Todavía no hay consumo registrado hoy.</div>`;
  let svg = `<svg viewBox="0 0 120 120"><g transform="rotate(-90 60 60)">`;
  let acc = 0;
  for (const k of keys) {
    const p = S.byType[k] / total * 100;
    if (p < 0.5) continue;
    const largo = Math.max(p - 1, 0.3);   // pequeño espacio entre segmentos
    svg += `<circle class="seg" cx="60" cy="60" r="42" fill="none" stroke="var(${TIPOS[k].c})" stroke-width="18" pathLength="100"
      stroke-dasharray="${largo.toFixed(2)} ${(100 - largo).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}"><title>${TIPOS[k].n}: ${Math.round(S.byType[k])} L (${Math.round(p)} %)</title></circle>`;
    acc += p;
  }
  svg += `</g><text x="60" y="62" text-anchor="middle" class="dc1">${Math.round(total)} L</text><text x="60" y="75" text-anchor="middle" class="dc2">HOY</text></svg>`;

  const orden = keys.filter(k => S.byType[k] >= 0.5).sort((a, b) => S.byType[b] - S.byType[a]);
  const leyenda = orden.map(k => `<div><i style="background:var(${TIPOS[k].c})"></i><span>${TIPOS[k].i} ${TIPOS[k].n}</span><b>${Math.round(S.byType[k] / total * 100)} %</b></div>`).join("");
  const top = orden[0];
  const consejo = S.byType.fuga >= 1 ? "fuga" : top;
  return `<div class="donutWrap">${svg}<div class="lg">${leyenda}</div></div>
    <div class="tip">💡 <b>${TIPOS[top].n}</b> es tu mayor consumo hoy (${Math.round(S.byType[top] / total * 100)} %). ${CONSEJOS[consejo]}</div>`;
}

/* =========================================================
   11. PANTALLAS
   ========================================================= */
function valveCard() {
  return `<div class="card valve"><h4>Válvula principal</h4>
    <button class="sw ${S.valve ? "" : "off"}" onclick="toggleValve()" aria-label="Abrir o cerrar válvula"></button>
    <div class="st" style="color:var(--${S.valve ? "ok" : "bad"})">${S.valve ? "ABIERTA" : "CERRADA"}</div>
    <button class="btn ${S.valve ? "red" : "grn"} full mt" onclick="toggleValve()">${S.valve ? "CERRAR" : "ABRIR"}</button>
  </div>`;
}
function alertsList(n) {
  const a = S.alerts.slice(0, n);
  if (!a.length) return `<div class="empty">Sin alertas 👍</div>`;
  return a.map(x => `<div class="al"><span class="dot ${x.type}"></span><div>${x.t}<small>${x.h}</small></div></div>`).join("");
}
const sel = (v, opts) => opts.map(o => `<option value="${o[0]}" ${String(v) === String(o[0]) ? "selected" : ""}>${o[1]}</option>`).join("");

function go(v) { S.view = v; if (v === "alerts") S.unread = 0; render(); $("#main").scrollTop = 0; }

function render() {
  const c = S.cfg;
  let h = "";

  if (S.view === "dash") {
    h = `<div class="card gauge">${gauge()}
        <div class="flowline">FLUJO ACTUAL: <b id="flow">0.0 L/min</b></div>
        <div class="chips" id="active"></div>
      </div>
      <div class="card"><h4>Hoy vs. tu promedio</h4><div class="cmp" id="cmp"></div></div>
      <div class="grid2">${valveCard()}
        <div class="card"><h4>Últimos 30 días</h4>
          <div class="big" id="m3">0 m³</div>
          <div class="big" style="color:var(--pri)" id="cost">$0</div>
          <div class="sub mt" id="proj"></div>
        </div>
      </div>
      <div class="card"><h4>Consumo de la semana</h4><div id="week"></div>
        <div class="legend"><span>Meta diaria</span></div></div>
      <div class="card"><h4>Alertas recientes</h4>${alertsList(3)}</div>`;

  } else if (S.view === "stats") {
    h = `<div class="card"><h4>Histórico de consumo</h4>
        <div class="seg">${[["day", "Día"], ["week", "Semana"], ["month", "Mes"]].map(r =>
          `<button class="${S.range === r[0] ? "on" : ""}" onclick="S.range='${r[0]}';render()">${r[1]}</button>`).join("")}</div>
        <div id="chart"></div>
        <div class="legend" id="legend"></div>
      </div>
      <div class="grid2">
        <div class="card"><h4>Total</h4><div class="big" id="tot">0 L</div></div>
        <div class="card"><h4 id="avgT">Promedio</h4><div class="big" id="avg">0 L</div></div>
      </div>
      <div class="card"><h4>¿En qué se usa el agua? (hoy)</h4><div id="donut"></div></div>
      <div class="card"><h4>Últimos 7 días vs. 7 anteriores</h4><div class="cmp" id="wcmp"></div></div>
      <div class="card"><h4>Mayor consumo</h4><div class="big" id="peak">–</div><div class="sub" id="peakSub"></div></div>`;

  } else if (S.view === "ctl") {
    h = `<button class="btn red emerg" onclick="emergency()">🛑 PARO DE EMERGENCIA</button>
      ${valveCard()}
      <div class="card"><h4>Meta diaria: <b id="gvv">${c.goal}</b> L</h4>
        <input type="range" min="100" max="600" step="10" value="${c.goal}"
          oninput="$('#gvv').textContent=this.value" onchange="setCfg('goal',+this.value)">
        <div class="sub" style="display:flex;justify-content:space-between"><span>100 L</span><span>600 L</span></div>
      </div>
      <div class="card"><h4>Estado del sistema</h4>
        <div class="kv"><span>Electroválvula</span><b id="sV"></b></div>
        <div class="kv"><span>Sensor de flujo</span><b style="color:var(--ok)">activo</b></div>
        <div class="kv"><span>Flujo actual</span><b id="sF"></b></div>
        <div class="kv"><span>Flujo continuo</span><b id="sC"></b></div>
        <div class="kv"><span>Fugas</span><b id="sL"></b></div>
        <div class="kv"><span>Cierre automático</span><b>${c.auto ? "activado" : "desactivado"}</b></div>
        <div class="kv"><span>Cierre programado</span><b>${c.schedOn ? c.schedFrom + "–" + c.schedTo : "desactivado"}</b></div>
      </div>`;

  } else if (S.view === "alerts") {
    S.unread = 0;
    h = `<div class="card"><h4>Historial de alertas</h4>${alertsList(60)}</div>`;

  } else {
    const problema = notifProblem();
    const estado = c.notif && !problema ? `<span style="color:var(--ok)">Activados</span>`
      : problema ? `<span style="color:var(--warn)">No disponibles aquí</span>` : "Desactivados";
    h = `<div class="card"><h4>Mi casa</h4>
        <div class="kv"><span>Nombre</span><input type="text" value="${c.house.replace(/"/g, "&quot;")}" onchange="setCfg('house',this.value)"></div>
        <div class="kv"><span>Personas</span><input type="number" min="1" max="20" value="${c.people}" onchange="setCfg('people',Math.max(1,+this.value||1))"></div>
        <div class="kv"><span>Medidor</span><b>${c.meter}</b></div>
      </div>
      <div class="card"><h4>Seguridad</h4>
        <div class="kv"><span>Cierre automático ante fuga</span><input class="tg" type="checkbox" ${c.auto ? "checked" : ""} onchange="setCfg('auto',this.checked)"></div>
        <div class="kv"><span>Detectar fuga tras</span><select onchange="setCfg('detectMin',+this.value)">${sel(c.detectMin, [[5, "5 min"], [10, "10 min"], [15, "15 min"], [30, "30 min"]])}</select></div>
        <div class="kv"><span>Cierre nocturno programado</span><input class="tg" type="checkbox" ${c.schedOn ? "checked" : ""} onchange="setCfg('schedOn',this.checked,true)"></div>
        ${c.schedOn ? `<div class="kv"><span>Cerrar a las</span><input type="time" value="${c.schedFrom}" onchange="setCfg('schedFrom',this.value)"></div>
        <div class="kv"><span>Abrir a las</span><input type="time" value="${c.schedTo}" onchange="setCfg('schedTo',this.value)"></div>` : ""}
      </div>
      <div class="card"><h4>Tarifa de agua</h4>
        <div class="kv"><span>Tipo de tarifa</span><select onchange="setCfg('tariff',this.value,true)">${sel(c.tariff, [["escalonada", "Escalonada"], ["fija", "Fija"]])}</select></div>
        ${c.tariff === "fija"
          ? `<div class="kv"><span>Precio por m³</span><input type="number" min="0" step="0.5" value="${c.rate}" onchange="setCfg('rate',Math.max(0,+this.value||0))"></div>`
          : c.tiers.map((t, i) => {
              const desde = i ? c.tiers[i - 1].hasta : 0;
              const rango = t.hasta === null ? `Más de ${desde} m³` : `${desde}–${t.hasta} m³`;
              return `<div class="kv"><span>${rango} ($/m³)</span><input type="number" min="0" step="0.5" value="${t.precio}" onchange="setTier(${i},this.value)"></div>`;
            }).join("")}
        <div class="tip" id="tariffTip"></div>
      </div>
      <div class="card"><h4>Apariencia</h4>
        <div class="seg" style="margin:0">${[["auto", "Automático"], ["light", "Claro"], ["dark", "Oscuro"]].map(t =>
          `<button class="${c.theme === t[0] ? "on" : ""}" onclick="setCfg('theme','${t[0]}',true)">${t[1]}</button>`).join("")}</div>
      </div>
      <div class="card"><h4>Notificaciones</h4>
        <div class="kv"><span>Avisos del navegador<br><small class="sub">${estado}</small></span>
          <input class="tg" type="checkbox" ${c.notif && !problema ? "checked" : ""} onchange="toggleNotif(this.checked)"></div>
        ${problema ? `<div class="tip">ℹ️ ${problema}</div>` : ""}
        <div class="kv"><span>Sonido y vibración en alertas<br><small class="sub">Funciona aunque no haya avisos</small></span>
          <input class="tg" type="checkbox" ${c.sound ? "checked" : ""} onchange="setCfg('sound',this.checked)"></div>
        <button class="btn ghost full" style="margin-top:8px" onclick="testAlert()">🔔 Probar alerta</button>
      </div>
      <div class="card"><h4>Datos</h4>
        <button class="btn red full" onclick="askClear()">🗑 Borrar datos guardados</button>
      </div>`;
  }

  $("#main").innerHTML = h;
  $("#house").textContent = c.house || "Smart Water Home";
  renderNav();
  refresh();
}

function renderNav() {
  const items = [["dash", "🏠", "INICIO"], ["stats", "📊", "ESTADÍSTICAS"], ["ctl", "🎛", "CONTROL"], ["alerts", "🔔", "ALERTAS"], ["prof", "⚙", "AJUSTES"]];
  $("#nav").innerHTML = items.map(i => `<button class="${S.view === i[0] ? "on" : ""}" onclick="go('${i[0]}')"><i>${i[1]}</i>${i[2]}${i[0] === "alerts" && S.unread ? `<span class="badge">${S.unread}</span>` : ""}</button>`).join("");
}

function renderSpeeds() {
  $("#speeds").innerHTML = SPEEDS.map(s => `<button class="${S.speed === s[0] ? "on" : ""}" onclick="setSpeed(${s[0]})">${s[1]}</button>`).join("");
  const txt = { 0: "Simulación en pausa", 1: "Tiempo real", 60: "1 s real = 1 minuto simulado", 600: "1 s real = 10 minutos simulados", 3600: "1 s real = 1 hora simulada" };
  $("#speedTxt").textContent = txt[S.speed];
}

/* =========================================================
   12. ACTUALIZAR VALORES (sin redibujar botones)
   ========================================================= */
function set(id, v) { const e = document.getElementById(id); if (e) e.innerHTML = v; }

function cmpHTML(pct, titulo, detalle) {
  const cls = pct > 5 ? "up" : pct < -5 ? "dn" : "eq";
  const ico = cls === "up" ? "▲" : cls === "dn" ? "▼" : "=";
  return `<div class="ico ${cls}">${ico}</div><div><b>${titulo}</b><div class="sub">${detalle}</div></div>`;
}

function refresh() {
  const dia = DIAS[S.date.getDay()] + " " + S.date.getDate() + "/" + (S.date.getMonth() + 1);
  set("clock", `${dia} · ${hhmm(S.t)}`);
  set("pclock", `${hhmm(S.t)}<small>${dia}${S.speed ? "" : " · en pausa"}</small>`);

  if (S.view === "dash" && $("#gArc")) {
    const p = Math.min(S.consumed / S.cfg.goal, 1) * 100, arc = $("#gArc");
    arc.setAttribute("stroke-dasharray", `${p.toFixed(1)} 100`);
    arc.setAttribute("stroke", p >= 100 ? "var(--bad)" : p >= 80 ? "var(--warn)" : "var(--pri)");
    arc.style.opacity = p < 0.5 ? 0 : 1;
    set("gVal", Math.round(S.consumed) + " L");
    set("gGoal", `de ${S.cfg.goal} L (objetivo)`);
    set("flow", S.flow.toFixed(1) + " L/min");

    let chips = S.events.map(e => `<span class="chip">${TIPOS[e.k].i} ${TIPOS[e.k].n}</span>`).join("");
    if (S.valve && S.leak) chips += `<span class="chip bad">💧 Flujo no identificado</span>`;
    if (!S.valve) chips = `<span class="chip bad">Válvula cerrada</span>`;
    set("active", chips || `<span class="chip idle">Sin uso de agua</span>`);

    const cp = compareToday();
    if (cp.normal < 10) set("cmp", cmpHTML(0, "Aún es temprano para comparar", `Promedio diario: ${Math.round(cp.avg)} L`));
    else {
      const p2 = Math.round(Math.abs(cp.pct));
      const t = cp.pct > 5 ? `Vas ${p2} % arriba de lo normal` : cp.pct < -5 ? `Vas ${p2} % abajo de lo normal` : "Vas igual que siempre";
      set("cmp", cmpHTML(cp.pct, t, `A esta hora sueles llevar ${Math.round(cp.normal)} L · hoy llevas ${Math.round(S.consumed)} L`));
    }

    const m3 = last30() / 1000;
    set("m3", m3.toFixed(2) + " m³");
    set("cost", money(costo(m3)) + " MXN");
    set("proj", `Tarifa ${S.cfg.tariff} · ${Math.round(last30() / 30)} L/día`);
    set("week", lineChart());

  } else if (S.view === "stats" && $("#chart")) {
    let data, labels, hi, goal = 0, unit;
    if (S.range === "day") {
      data = S.hours; labels = data.map((_, i) => i % 3 ? "" : i + "h"); hi = Math.floor(S.t / 3600); unit = "hora";
    } else {
      [data, labels] = S.range === "week" ? weekData() : monthData();
      hi = data.length - 1; goal = S.cfg.goal; unit = "día";
    }
    const tot = sum(data);
    const n = S.range === "day" ? Math.floor(S.t / 3600) + 1 : data.length;
    const mi = data.indexOf(Math.max(...data));
    set("chart", bars(data, labels, hi, goal));
    set("legend", goal ? "<span>Meta diaria</span>" : "");
    set("tot", Math.round(tot) + " L");
    set("avgT", "Promedio por " + unit);
    set("avg", Math.round(tot / n) + " L");
    if (S.range === "day") {
      set("peak", `${pad(mi)}:00 – ${pad(mi + 1)}:00`);
      set("peakSub", Math.round(data[mi]) + " L en esa hora");
    } else {
      const d = new Date(S.date.getTime() - (data.length - 1 - mi) * 86400000);
      set("peak", DIAS[d.getDay()] + " " + d.getDate() + "/" + (d.getMonth() + 1));
      set("peakSub", Math.round(data[mi]) + " L ese día");
    }
    set("donut", donut());

    const a = sum(S.history.slice(-7)), b = sum(S.history.slice(-14, -7));
    if (S.history.length < 14) set("wcmp", cmpHTML(0, "Faltan datos", "Se necesitan 14 días de historial"));
    else {
      const pct = (a / b - 1) * 100, dif = Math.round(Math.abs(a - b));
      set("wcmp", cmpHTML(pct, pct > 0 ? `${dif} L más (${Math.round(pct)} %)` : `${dif} L menos (${Math.round(-pct)} %)`,
        `Últimos 7 días: ${a} L · semana anterior: ${b} L`));
    }

  } else if (S.view === "ctl" && $("#sV")) {
    set("sV", S.valve ? `<span style="color:var(--ok)">energizada (abierta)</span>` : `<span style="color:var(--bad)">sin energía (cerrada)</span>`);
    set("sF", S.flow.toFixed(1) + " L/min");
    set("sC", Math.floor(S.cont / 60) + " min");
    set("sL", S.leakFound ? `<span style="color:var(--bad)">detectada</span>` : `<span style="color:var(--ok)">ninguna</span>`);

  } else if (S.view === "prof" && $("#tariffTip")) {
    const m3 = last30() / 1000;
    set("tariffTip", `Últimos 30 días: <b>${m3.toFixed(2)} m³ → ${money(costo(m3))} MXN</b>.<br>` +
      (S.cfg.tariff === "escalonada" ? "Entre más consumes, más caro es cada m³. " : "") +
      "Los precios son de ejemplo: usa los de tu recibo de agua.");
  }
}

/* =========================================================
   13. ARRANQUE Y BUCLE PRINCIPAL
   ========================================================= */
if (!load()) {
  // Primera vez: historial de 29 días y simulación silenciosa hasta la hora actual
  for (let i = 0; i < 29; i++) S.history.push(Math.round(rnd(180, 320)));
  const ahora = new Date(), meta = ahora.getHours() * 3600 + ahora.getMinutes() * 60;
  while (S.t < meta) step();
  S.over = S.consumed >= S.cfg.goal;
  S.quiet = false;
  S.alerts = [{ t: "Bienvenido. Monitoreo de consumo activo.", type: "i", h: DIAS[S.date.getDay()] + " " + hhmm(S.t) }];
  S.unread = 1;
}
S.quiet = false;
applyTheme();
renderSpeeds();
render();
save();

// Cada 100 ms reales avanza (velocidad × 0.1) segundos simulados
let acc = 0, ticks = 0;
setInterval(() => {
  acc += S.speed * 0.1;
  let pasos = 0;
  while (acc >= 1) { step(); acc--; pasos++; }
  if (pasos) refresh();
  if (++ticks % 20 === 0) save();   // guarda cada 2 segundos
}, 100);
window.addEventListener("beforeunload", save);
