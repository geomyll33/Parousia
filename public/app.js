const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'parousies.token';
let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch {}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) },
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) { const e = new Error(data.error || 'Σφάλμα σύνδεσης με τον server.'); e.status = res.status; throw e; }
  return data;
}
const show = (el, html, cls) => { el.innerHTML = html ? `<div class="msg ${cls}">${html}</div>` : ''; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (iso) => new Date(iso).toLocaleString('el-GR', { dateStyle: 'medium', timeStyle: 'short' });

// Κωδικός από QR που σαρώθηκε με την κάμερα του κινητού (σύνδεσμος ?c=...)
const params = new URLSearchParams(location.search);
let pendingCode = params.get('c');
if (pendingCode) history.replaceState(null, '', location.pathname);

function extractCode(text) {
  try { const u = new URL(text); return u.searchParams.get('c'); } catch {}
  return /^[\w-]+\.\d+\.[\w-]+$/.test(text) ? text : null;
}

async function start() {
  if (!token) return showLogin();
  try {
    const me = await api('/api/student/me');
    $('login').classList.add('hidden');
    $('home').classList.remove('hidden');
    $('who').textContent = me.name || me.email;
    $('whoEmail').textContent = me.name ? me.email : '';
    renderHistory(me.courses);
    if (pendingCode) { const c = pendingCode; pendingCode = null; await checkin(c); }
  } catch (e) {
    if (e.status === 401) { try { localStorage.removeItem(TOKEN_KEY); } catch {} token = null; showLogin(e.message); }
    else { $('home').classList.remove('hidden'); show($('result'), esc(e.message), 'err'); }
  }
}
function showLogin(msg) {
  $('home').classList.add('hidden');
  $('login').classList.remove('hidden');
  if (pendingCode) show($('loginMsg'), 'Συνδεθείτε πρώτα· η παρουσία θα καταχωριστεί αμέσως μετά.', 'warn');
  else if (msg) show($('loginMsg'), esc(msg), 'warn');
}
function renderHistory(courses) {
  if (!courses.length) { $('history').textContent = 'Δεν είστε γραμμένοι σε κάποιο μάθημα.'; return; }
  $('history').innerHTML = courses.map((c) => {
    const h = c.history, n = h.filter((x) => x.present).length;
    return `<details class="course" ${courses.length === 1 ? 'open' : ''}><summary><b>${esc(c.name)}</b>
      <span class="muted">· ${h.length ? `${n} από ${h.length} παρουσίες` : 'καμία παρακολούθηση ακόμη'}</span></summary>` +
      (h.length ? '<div class="table-wrap"><table>' + h.map((x) => `<tr><td>${esc(x.title)}<div class="muted">${fmt(x.createdAt)}</div></td>
        <td style="text-align:right">${x.present ? '<span class="pill ok">Παρών</span>' : '<span class="pill no">Απών</span>'}</td></tr>`).join('') + '</table></div>' : '') +
      '</details>';
  }).join('');
}

$('loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  show($('loginMsg'), '');
  $('loginBtn').disabled = true;
  try {
    const r = await api('/api/student/register', { method: 'POST', body: JSON.stringify({ email: $('email').value }) });
    if (r.verify) {
      $('loginForm').classList.add('hidden');
      $('codeForm').classList.remove('hidden');
      $('codeEmail').textContent = r.email;
      $('code').value = '';
      $('code').focus();
    } else loggedIn(r.token);
  } catch (e) { show($('loginMsg'), esc(e.message), 'err'); }
  $('loginBtn').disabled = false;
});
$('codeForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  show($('loginMsg'), '');
  try {
    const r = await api('/api/student/verify', { method: 'POST', body: JSON.stringify({ email: $('codeEmail').textContent, code: $('code').value }) });
    $('codeForm').classList.add('hidden');
    $('loginForm').classList.remove('hidden');
    loggedIn(r.token);
  } catch (e) { show($('loginMsg'), esc(e.message), 'err'); }
});
$('codeBack').addEventListener('click', () => {
  show($('loginMsg'), '');
  $('codeForm').classList.add('hidden');
  $('loginForm').classList.remove('hidden');
});
async function loggedIn(t) {
  token = t;
  try { localStorage.setItem(TOKEN_KEY, token); } catch {}
  try { await navigator.storage?.persist?.(); } catch {}
  start();
}

async function checkin(code) {
  show($('result'), 'Καταχώριση…', 'warn');
  try {
    const r = await api('/api/student/checkin', { method: 'POST', body: JSON.stringify({ code }) });
    $('result').innerHTML = `<div class="card msg ok result-big"><span class="icon">✅</span>
      ${r.already ? 'Η παρουσία σας είχε ήδη καταχωριστεί' : 'Η παρουσία σας καταχωρίστηκε'}
      <div class="muted" style="font-weight:400">${esc(r.course)} — ${esc(r.title)} · ${fmt(r.at)}</div></div>`;
    if (navigator.vibrate) navigator.vibrate(120);
    const me = await api('/api/student/me'); renderHistory(me.courses);
  } catch (e) {
    $('result').innerHTML = `<div class="card msg err result-big"><span class="icon">⚠️</span>${esc(e.message)}</div>`;
  }
}

// ---- Σαρωτής QR ----
let stream = null, scanning = false;
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
let detector = null;
if ('BarcodeDetector' in window) { try { detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch {} }

$('scanBtn').addEventListener('click', async () => {
  show($('result'), '');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch (e) {
    show($('result'), 'Δεν δόθηκε πρόσβαση στην κάμερα. Επιτρέψτε την κάμερα στις ρυθμίσεις του browser ή σαρώστε το QR με την εφαρμογή κάμερας του κινητού.', 'err');
    return;
  }
  const v = $('video');
  v.srcObject = stream;
  await v.play();
  $('scanArea').classList.remove('hidden');
  $('scanBtn').classList.add('hidden');
  scanning = true;
  requestAnimationFrame(tick);
});
$('stopBtn').addEventListener('click', stopScan);
function stopScan() {
  scanning = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  $('scanArea').classList.add('hidden');
  $('scanBtn').classList.remove('hidden');
}
let busy = false;
async function tick() {
  if (!scanning) return;
  const v = $('video');
  if (!busy && v.readyState >= 2) {
    busy = true;
    let text = null;
    try {
      if (detector) {
        const codes = await detector.detect(v);
        text = codes[0]?.rawValue || null;
      } else {
        const w = 480, h = Math.round((v.videoHeight / v.videoWidth) * w) || 480;
        canvas.width = w; canvas.height = h;
        ctx.drawImage(v, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        text = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' })?.data || null;
      }
    } catch {}
    busy = false;
    const code = text && extractCode(text);
    if (code) { stopScan(); checkin(code); return; }
  }
  setTimeout(() => requestAnimationFrame(tick), 120);
}

// ---- Εγκατάσταση (PWA) ----
let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; $('installBtn').classList.remove('hidden'); });
$('installBtn').addEventListener('click', async () => { if (!installEvent) return; installEvent.prompt(); await installEvent.userChoice; installEvent = null; $('installBtn').classList.add('hidden'); });
if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) $('installCard').classList.add('hidden');
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

start();
