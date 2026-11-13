const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (iso) => new Date(iso).toLocaleString('el-GR', { dateStyle: 'medium', timeStyle: 'short' });
const time = (iso) => new Date(iso).toLocaleTimeString('el-GR', { timeStyle: 'short' });
const show = (el, html, cls) => { el.innerHTML = html ? `<div class="msg ${cls}">${html}</div>` : ''; };
const APP_URL = location.origin + '/';

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json' } });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401 && !path.endsWith('/login')) { showLogin(); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || 'Σφάλμα.');
  return data;
}

// ---- Σύνδεση ----
function showLogin() { $('app').classList.add('hidden'); $('login').classList.remove('hidden'); stopLive(); }
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('pw').value }) }); $('pw').value = ''; boot(); }
  catch (err) { show($('loginMsg'), esc(err.message), 'err'); }
});
$('logoutBtn').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST' }); showLogin(); });

// ---- Καρτέλες ----
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.tab)));
function openTab(name) {
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
  if (name === 'students') loadStudents();
  if (name === 'history') loadSessions();
}

let students = [];
let courses = [], courseId = null;
const COURSE_KEY = 'parousies.course';
const cur = () => courses.find((c) => c.id === courseId);
const cpath = (x = '') => `/api/admin/courses/${courseId}${x}`;

async function boot() {
  try { courses = await api('/api/admin/courses'); } catch { return; }
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('liveUrl').textContent = location.host;
  let saved = null;
  try { saved = localStorage.getItem(COURSE_KEY); } catch {}
  await selectCourse(courses.some((c) => c.id === saved) ? saved : courses[0]?.id || null);
}
function renderCourseSel() {
  $('courseSel').innerHTML = courses.map((c) =>
    `<option value="${c.id}">${esc(c.name)} · ${c.students} φοιτ.${c.openSessionId ? ' · ● σε εξέλιξη' : ''}</option>`).join('');
  if (courseId) $('courseSel').value = courseId;
  const has = courses.length > 0;
  $('noCourse').classList.toggle('hidden', has);
  $('courseArea').classList.toggle('hidden', !has);
  ['courseSel', 'renameCourseBtn', 'deleteCourseBtn'].forEach((id) => $(id).disabled = !has);
}
async function refreshCourses() { courses = await api('/api/admin/courses'); renderCourseSel(); }
async function selectCourse(id) {
  stopLive();
  courseId = id;
  try { id ? localStorage.setItem(COURSE_KEY, id) : localStorage.removeItem(COURSE_KEY); } catch {}
  textDirty = false;
  $('detailCard').classList.add('hidden');
  show($('startMsg'), ''); show($('studentsMsg'), ''); show($('courseMsg'), '');
  renderCourseSel();
  if (!id) return;
  students = await api(cpath('/students'));
  $('exportCsv').href = cpath('/export.csv');
  const open = cur()?.openSessionId;
  if (open) startLive(open); else showStart();
  const active = document.querySelector('[data-tab].active')?.dataset.tab || 'live';
  openTab(active);
}
$('courseSel').addEventListener('change', () => selectCourse($('courseSel').value));
async function createCourse(name) {
  name = (name || '').trim();
  if (!name) return;
  const c = await api('/api/admin/courses', { method: 'POST', body: JSON.stringify({ name }) });
  await refreshCourses();
  await selectCourse(c.id);
  openTab('students');
  show($('studentsMsg'), `Δημιουργήθηκε το μάθημα «${esc(c.name)}». Επικολλήστε τώρα τη λίστα φοιτητών.`, 'ok');
}
$('newCourseBtn').addEventListener('click', () => createCourse(prompt('Όνομα νέου μαθήματος:')).catch((e) => alert(e.message)));
$('firstCourseBtn').addEventListener('click', () => createCourse($('firstCourseName').value).catch((e) => alert(e.message)));
$('renameCourseBtn').addEventListener('click', async () => {
  const name = prompt('Νέο όνομα μαθήματος:', cur()?.name || '');
  if (!name?.trim()) return;
  await api(cpath(), { method: 'PUT', body: JSON.stringify({ name }) });
  await refreshCourses();
});
$('deleteCourseBtn').addEventListener('click', async () => {
  const c = cur();
  if (!c) return;
  const typed = prompt(`Οριστική διαγραφή του μαθήματος «${c.name}» με όλους τους φοιτητές και τις παρουσίες του (${c.sessions} παρακολουθήσεις).\n\nΚατεβάστε πρώτα το Excel αν το χρειάζεστε.\nΓια επιβεβαίωση γράψτε: ΔΙΑΓΡΑΦΗ`);
  if (typed?.trim().toUpperCase() !== 'ΔΙΑΓΡΑΦΗ') return;
  await api(cpath(), { method: 'DELETE' });
  await refreshCourses();
  await selectCourse(courses[0]?.id || null);
});

// ---- Ζωντανή παρακολούθηση ----
let liveId = null, qrTimer = null, listTimer = null, lastCode = '';
function showStart() { $('startCard').classList.remove('hidden'); $('liveCard').classList.add('hidden'); }
$('startBtn').addEventListener('click', async () => {
  if (!students.length) { show($('startMsg'), 'Προσθέστε πρώτα τη λίστα φοιτητών στην καρτέλα «Φοιτητές».', 'warn'); return; }
  const s = await api(cpath('/sessions'), { method: 'POST', body: JSON.stringify({ title: $('title').value }) });
  $('title').value = '';
  startLive(s.id);
  refreshCourses();
});
function drawQr(canvas, text) {
  const q = qrcode(0, 'M');
  q.addData(text); q.make();
  const n = q.getModuleCount(), quiet = 4, scale = 12, size = (n + quiet * 2) * scale;
  canvas.width = canvas.height = size;
  const c = canvas.getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, size, size);
  c.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) c.fillRect((k + quiet) * scale, (r + quiet) * scale, scale, scale);
}
async function startLive(id) {
  liveId = id;
  $('startCard').classList.add('hidden');
  $('liveCard').classList.remove('hidden');
  await refreshList();
  refreshQr();
  clearInterval(listTimer);
  listTimer = setInterval(refreshList, 3000);
}
function stopLive() { liveId = null; clearTimeout(qrTimer); clearInterval(listTimer); $('fs').classList.add('hidden'); }
async function refreshQr() {
  clearTimeout(qrTimer);
  if (!liveId) return;
  try {
    const r = await api(`/api/admin/sessions/${liveId}/qr`);
    const text = APP_URL + '?c=' + r.code;
    if (text !== lastCode) { lastCode = text; drawQr($('qr'), text); drawQr($('qrFs'), text); }
    $('fsCount').textContent = r.count;
    animateBar(r.nextIn, r.seconds * 1000);
    qrTimer = setTimeout(refreshQr, Math.max(300, r.nextIn + 150));
  } catch { qrTimer = setTimeout(refreshQr, 2000); }
}
let barRaf;
function animateBar(remaining, total) {
  cancelAnimationFrame(barRaf);
  const end = performance.now() + remaining;
  const step = () => {
    const pct = Math.max(0, (end - performance.now()) / total * 100) + '%';
    $('bar').style.width = pct; $('barFs').style.width = pct;
    if (performance.now() < end) barRaf = requestAnimationFrame(step);
  };
  step();
}
async function refreshList() {
  if (!liveId) return;
  try {
    const s = await api(`/api/admin/sessions/${liveId}`);
    if (s.closed) { stopLive(); showStart(); return; }
    $('liveTitle').textContent = `${s.courseName} — ${s.title}`;
    $('liveCount').textContent = s.count;
    $('fsCount').textContent = s.count;
    $('liveTotal').textContent = s.attendees.length + s.absent.length;
    $('liveList').innerHTML = '<table>' + s.attendees.slice().reverse().map((a) =>
      `<tr><td>${esc(a.name || a.email)}${a.name ? `<div class="muted">${esc(a.email)}</div>` : ''}</td><td class="muted" style="text-align:right">${time(a.at)}${a.manual ? ` <span class="pill gray">χειρ.</span> <button class="danger small" data-live-mark="${esc(a.email)}" data-present="0" title="Αναίρεση">✕</button>` : ''}</td></tr>`).join('') + '</table>' +
      (s.count ? '' : '<p class="muted">Αναμονή για σαρώσεις…</p>');
    liveAbsent = s.absent;
    renderAbsent();
  } catch {}
}
let liveAbsent = [];
const norm = (x) => String(x).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function renderAbsent() {
  const q = norm($('manualSearch').value.trim());
  const list = liveAbsent.filter((a) => !q || norm(a.name + ' ' + a.email).includes(q));
  $('absentList').innerHTML = !liveAbsent.length ? '<p class="muted">Όλοι οι φοιτητές είναι παρόντες.</p>'
    : !list.length ? '<p class="muted">Δεν βρέθηκε απών φοιτητής.</p>'
    : '<table>' + list.map((a) => `<tr><td>${esc(a.name || a.email)}${a.name ? `<div class="muted">${esc(a.email)}</div>` : ''}</td>
        <td style="text-align:right"><button class="small" data-live-mark="${esc(a.email)}" data-present="1">✓ Παρών</button></td></tr>`).join('') + '</table>';
}
$('manualSearch').addEventListener('input', renderAbsent);
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-live-mark]');
  if (!b || !liveId) return;
  b.disabled = true;
  try {
    await api(`/api/admin/sessions/${liveId}/mark`, { method: 'POST', body: JSON.stringify({ email: b.dataset.liveMark, present: b.dataset.present === '1' }) });
  } catch (err) { alert(err.message); }
  await refreshList();
});
$('closeBtn').addEventListener('click', async () => {
  if (!confirm('Τέλος παρακολούθησης; Μετά δεν θα γίνονται δεκτές σαρώσεις.')) return;
  await api(`/api/admin/sessions/${liveId}/close`, { method: 'POST' });
  stopLive(); showStart(); refreshCourses();
});
$('fsBtn').addEventListener('click', () => { $('fs').classList.remove('hidden'); document.documentElement.requestFullscreen?.().catch(() => {}); });
$('fs').addEventListener('click', () => { $('fs').classList.add('hidden'); if (document.fullscreenElement) document.exitFullscreen(); });

// ---- Φοιτητές ----
let textDirty = false;
$('studentsText').addEventListener('input', () => { textDirty = true; });
async function loadStudents() {
  if (!courseId) return;
  students = await api(cpath('/students'));
  if (!textDirty) $('studentsText').value = students.map((s) => (s.name ? `${s.name}, ${s.email}` : s.email)).join('\n');
  renderStudents();
}
function renderStudents() {
  if (!students.length) { $('studentsTable').innerHTML = '<p class="muted">Η λίστα είναι κενή.</p>'; return; }
  const reg = students.filter((s) => s.registered).length;
  $('studentsTable').innerHTML = `<p class="muted">${students.length} φοιτητές · ${reg} έχουν συνδέσει την εφαρμογή</p><table>
    <tr><th>Φοιτητής</th><th>Εφαρμογή</th><th>Παρουσίες</th><th></th></tr>` +
    students.map((s) => `<tr><td>${esc(s.name || '—')}<div class="muted">${esc(s.email)}</div></td>
      <td>${s.registered ? '<span class="pill ok">Συνδεδεμένη</span>' : '<span class="pill gray">Όχι ακόμη</span>'}</td>
      <td>${s.present}</td>
      <td style="text-align:right">${s.registered ? `<button class="secondary small" data-reset="${esc(s.email)}" title="Για νέο κινητό ή αν σβήστηκε η εφαρμογή">Επαναφορά συσκευής</button>` : ''}</td></tr>`).join('') + '</table>';
}
$('studentsTable').addEventListener('click', async (e) => {
  const email = e.target.dataset.reset;
  if (!email || !confirm(`Επαναφορά συσκευής για ${email};\nΟ φοιτητής θα μπορεί να συνδεθεί ξανά από άλλο κινητό.`)) return;
  await api(`/api/admin/devices/${encodeURIComponent(email)}/reset`, { method: 'POST' });
  loadStudents();
});
$('saveStudents').addEventListener('click', async () => {
  try {
    const r = await api(cpath('/students'), { method: 'PUT', body: JSON.stringify({ text: $('studentsText').value }) });
    textDirty = false;
    show($('studentsMsg'), `Αποθηκεύτηκε: ${r.total} φοιτητές (${r.added} νέοι, ${r.removed} αφαιρέθηκαν).`, 'ok');
    loadStudents(); refreshCourses();
  } catch (e) { show($('studentsMsg'), esc(e.message), 'err'); }
});
$('inviteBtn').addEventListener('click', () => {
  if (!students.length) { show($('studentsMsg'), 'Αποθηκεύστε πρώτα τη λίστα.', 'warn'); return; }
  const subject = `Εφαρμογή παρουσιών — ${cur()?.name || 'μάθημα'}`;
  const body = `Καλησπέρα σας,\n\nΟι παρουσίες στο μάθημα «${cur()?.name || ''}» θα καταγράφονται με QR.\n\n1. Ανοίξτε στο κινητό σας: ${APP_URL}\n2. Εγκαταστήστε την εφαρμογή (Android: μενού ⋮ → «Εγκατάσταση εφαρμογής» · iPhone/Safari: Κοινοποίηση → «Προσθήκη στην οθόνη Αφετηρίας»).\n3. Συνδεθείτε με αυτό το email (μία φορά).\n4. Σε κάθε μάθημα πατήστε «Σάρωση QR παρουσίας» και σαρώστε το QR στην οθόνη.\n\nΚαλή συνέχεια!`;
  location.href = `mailto:?bcc=${encodeURIComponent(students.map((s) => s.email).join(','))}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
});
$('copyLinkBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(APP_URL); show($('studentsMsg'), `Αντιγράφηκε: ${esc(APP_URL)}`, 'ok'); }
  catch { show($('studentsMsg'), `Σύνδεσμος: ${esc(APP_URL)}`, 'ok'); }
});

// ---- Ιστορικό ----
let detailId = null;
async function loadSessions() {
  if (!courseId) return;
  const list = await api(cpath('/sessions'));
  const total = students.length;
  $('sessionsTable').innerHTML = list.length ? '<table><tr><th>Παρακολούθηση</th><th>Παρόντες</th><th></th></tr>' +
    list.map((s) => `<tr><td>${esc(s.title)}<div class="muted">${fmt(s.createdAt)}</div></td>
      <td>${s.count} / ${total} ${s.closed ? '' : '<span class="pill ok">σε εξέλιξη</span>'}</td>
      <td style="text-align:right"><button class="secondary small" data-open="${s.id}">Προβολή</button></td></tr>`).join('') + '</table>'
    : '<p class="muted">Δεν υπάρχουν ακόμη παρακολουθήσεις.</p>';
}
$('sessionsTable').addEventListener('click', (e) => { if (e.target.dataset.open) openDetail(e.target.dataset.open); });
async function openDetail(id) {
  detailId = id;
  renderDetail(await api(`/api/admin/sessions/${id}`));
  $('detailCard').classList.remove('hidden');
  $('detailCard').scrollIntoView({ behavior: 'smooth' });
}
function renderDetail(s) {
  $('detailTitle').textContent = `${s.title} — ${s.count} παρόντες`;
  $('detailCsv').href = `/api/admin/sessions/${s.id}/csv`;
  $('reopenBtn').classList.toggle('hidden', !s.closed);
  const rows = [...s.attendees.map((a) => ({ ...a, present: true })), ...s.absent.map((a) => ({ ...a, present: false }))]
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email, 'el'));
  $('detailTable').innerHTML = '<table><tr><th>Φοιτητής</th><th>Κατάσταση</th><th>Ώρα</th></tr>' + rows.map((r) =>
    `<tr><td>${esc(r.name || '—')}<div class="muted">${esc(r.email)}</div></td>
     <td><button class="small ${r.present ? '' : 'danger'}" data-mark="${esc(r.email)}" data-present="${r.present ? 0 : 1}">${r.present ? 'Παρών' : 'Απών'}</button></td>
     <td class="muted">${r.present ? time(r.at) + (r.manual ? ' (χειρ.)' : '') : ''}</td></tr>`).join('') + '</table>';
}
$('detailTable').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-mark]');
  if (!b) return;
  renderDetail(await api(`/api/admin/sessions/${detailId}/mark`, { method: 'POST', body: JSON.stringify({ email: b.dataset.mark, present: b.dataset.present === '1' }) }));
  loadSessions();
});
$('reopenBtn').addEventListener('click', async () => {
  await api(`/api/admin/sessions/${detailId}/reopen`, { method: 'POST' });
  openTab('live'); startLive(detailId); refreshCourses();
});
$('deleteBtn').addEventListener('click', async () => {
  if (!confirm('Οριστική διαγραφή αυτής της παρακολούθησης;')) return;
  await api(`/api/admin/sessions/${detailId}`, { method: 'DELETE' });
  $('detailCard').classList.add('hidden'); loadSessions(); refreshCourses();
});

boot().catch(showLogin);
