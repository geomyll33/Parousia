// Γρήγορος έλεγχος της ροής: npm test
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;

let outbox = '';
function startServer(dataDir, smtp = '') {
  outbox = '';
  const p = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT, ADMIN_PASSWORD: 'test-password-123', DATA_DIR: dataDir, QR_SECONDS: '5', SMTP_HOST: smtp },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  p.stdout.on('data', (d) => { outbox += d; });
  return p;
}
async function waitUp() {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
}
async function call(p, { method = 'GET', body, cookie, token, headers = {} } = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
}
async function login() {
  const r = await call('/api/admin/login', { method: 'POST', body: { password: 'test-password-123' } });
  return r.headers.get('set-cookie').split(';')[0];
}

async function mainFlow(dataDir) {
  assert.equal((await call('/api/admin/courses')).status, 401);
  assert.equal((await call('/api/admin/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  const cookie = await login();

  // Δύο μαθήματα
  const db1 = (await call('/api/admin/courses', { method: 'POST', cookie, body: { name: 'Βάσεις Δεδομένων' } })).data;
  const net = (await call('/api/admin/courses', { method: 'POST', cookie, body: { name: 'Δίκτυα' } })).data;
  assert.equal((await call('/api/admin/courses', { method: 'POST', cookie, body: { name: ' ' } })).status, 400);

  const put = await call(`/api/admin/courses/${db1.id}/students`, { method: 'PUT', cookie, body: { text: 'Μαρία Παππά, Maria@Uni.gr\nnikos@uni.gr\nάκυρη γραμμή' } });
  assert.deepEqual([put.data.total, put.data.added], [2, 2]);
  await call(`/api/admin/courses/${net.id}/students`, { method: 'PUT', cookie, body: { text: 'maria@uni.gr\neleni@uni.gr' } });
  const list = (await call('/api/admin/courses', { cookie })).data;
  assert.deepEqual(list.map((c) => [c.name, c.students]), [['Βάσεις Δεδομένων', 2], ['Δίκτυα', 2]]);

  // Εγγραφή φοιτητή: μία φορά για όλα τα μαθήματα
  assert.equal((await call('/api/student/register', { method: 'POST', body: { email: 'xenos@uni.gr' } })).status, 403);
  const reg = await call('/api/student/register', { method: 'POST', body: { email: ' maria@uni.gr ' } });
  assert.equal(reg.status, 200);
  assert.equal(reg.data.name, 'Μαρία Παππά');
  const token = reg.data.token;
  assert.equal((await call('/api/student/register', { method: 'POST', body: { email: 'maria@uni.gr' } })).status, 409, 'δεύτερη συσκευή απορρίπτεται');
  const nikos = (await call('/api/student/register', { method: 'POST', body: { email: 'nikos@uni.gr' } })).data.token;

  // Παρακολουθήσεις σε δύο μαθήματα ταυτόχρονα
  const s1 = (await call(`/api/admin/courses/${db1.id}/sessions`, { method: 'POST', cookie, body: { title: 'Διάλεξη 1' } })).data;
  const n1 = (await call(`/api/admin/courses/${net.id}/sessions`, { method: 'POST', cookie, body: { title: 'Εργαστήριο 1' } })).data;
  assert.equal(s1.courseName, 'Βάσεις Δεδομένων');
  const qr1 = (await call(`/api/admin/sessions/${s1.id}/qr`, { cookie })).data.code;
  const qrN = (await call(`/api/admin/sessions/${n1.id}/qr`, { cookie })).data.code;
  assert.equal((await call(`/api/admin/sessions/${s1.id}`, { cookie })).data.closed, false, 'το άλλο μάθημα δεν κλείνει την παρακολούθηση');

  assert.equal((await call('/api/student/checkin', { method: 'POST', token, body: { code: qr1.slice(0, -1) + 'x' } })).status, 400, 'πλαστό QR');
  const ok = await call('/api/student/checkin', { method: 'POST', token, body: { code: qr1 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.course, 'Βάσεις Δεδομένων');
  assert.equal(ok.data.already, undefined);
  assert.equal((await call('/api/student/checkin', { method: 'POST', token, body: { code: qr1 } })).data.already, true);
  assert.equal((await call('/api/student/checkin', { method: 'POST', token, body: { code: qrN } })).status, 200);
  const wrong = await call('/api/student/checkin', { method: 'POST', token: nikos, body: { code: qrN } });
  assert.equal(wrong.status, 403, 'φοιτητής εκτός μαθήματος');
  assert.match(wrong.data.error, /Δίκτυα/);

  // Παλιό QR (πριν από πολλά «slots») απορρίπτεται
  const [id, slot] = qr1.split('.');
  const secret = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8')).secret;
  const old = `${id}.${slot - 10}.${crypto.createHmac('sha256', secret).update(`qr|${id}|${slot - 10}`).digest('base64url').slice(0, 16)}`;
  const oldR = await call('/api/student/checkin', { method: 'POST', token, body: { code: old } });
  assert.equal(oldR.status, 400);
  assert.match(oldR.data.error, /έληξε/);

  // Νέα παρακολούθηση στο ίδιο μάθημα: το QR της παλιάς δεν ισχύει
  const s2 = (await call(`/api/admin/courses/${db1.id}/sessions`, { method: 'POST', cookie, body: { title: 'Διάλεξη 2' } })).data;
  assert.match((await call('/api/student/checkin', { method: 'POST', token, body: { code: qr1 } })).data.error, /κλείσει/);
  const qr2 = (await call(`/api/admin/sessions/${s2.id}/qr`, { cookie })).data.code;
  assert.notEqual(qr2, qr1);

  // Χειροκίνητη σήμανση, μόνο για φοιτητές του μαθήματος
  assert.equal((await call(`/api/admin/sessions/${s2.id}/mark`, { method: 'POST', cookie, body: { email: 'nikos@uni.gr', present: true } })).data.count, 1);
  assert.equal((await call(`/api/admin/sessions/${s2.id}/mark`, { method: 'POST', cookie, body: { email: 'eleni@uni.gr', present: true } })).status, 404);

  const me = (await call('/api/student/me', { token })).data;
  assert.deepEqual(me.courses.map((c) => [c.name, c.history.map((h) => h.present)]),
    [['Βάσεις Δεδομένων', [false, true]], ['Δίκτυα', [true]]]);

  const csv = await call(`/api/admin/courses/${db1.id}/export.csv`, { cookie });
  assert.match(csv.data, /Μαρία Παππά/);
  assert.match(csv.data, /"Π";"Α";"1"/);
  assert.doesNotMatch(csv.data, /eleni/);

  // Επαναφορά συσκευής
  await call('/api/admin/devices/maria%40uni.gr/reset', { method: 'POST', cookie });
  assert.equal((await call('/api/student/me', { token })).status, 401);
  assert.equal((await call('/api/student/register', { method: 'POST', body: { email: 'maria@uni.gr' } })).status, 200);

  // Μετονομασία και διαγραφή μαθήματος
  assert.equal((await call(`/api/admin/courses/${net.id}`, { method: 'PUT', cookie, body: { name: 'Δίκτυα Η/Υ' } })).data.name, 'Δίκτυα Η/Υ');
  await call(`/api/admin/courses/${net.id}`, { method: 'DELETE', cookie });
  assert.equal((await call('/api/admin/courses', { cookie })).data.length, 1);
  assert.equal((await call('/api/student/register', { method: 'POST', body: { email: 'eleni@uni.gr' } })).status, 403, 'η Ελένη ήταν μόνο στο διαγραμμένο μάθημα');
}

// Επιβεβαίωση email με κωδικό και μέτρα ασφαλείας.
async function securityFlow() {
  const cookie = await login();
  const c = (await call('/api/admin/courses', { method: 'POST', cookie, body: { name: 'Μάθημα' } })).data;
  await call(`/api/admin/courses/${c.id}/students`, { method: 'PUT', cookie, body: { text: 'a@uni.gr\nb@uni.gr' } });
  assert.equal((await call('/api/config')).data.emailCode, true);

  const r = await call('/api/student/register', { method: 'POST', body: { email: 'a@uni.gr' } });
  assert.deepEqual(r.data, { verify: true, email: 'a@uni.gr' });
  assert.equal(r.data.token, undefined, 'χωρίς κωδικό δεν δίνεται πρόσβαση');
  await new Promise((res) => setTimeout(res, 200));
  const code = /Κωδικός σύνδεσης: (\d{6})/.exec(outbox)[1];
  const bad = String((Number(code) + 1) % 1e6).padStart(6, '0');
  assert.match((await call('/api/student/verify', { method: 'POST', body: { email: 'a@uni.gr', code: bad } })).data.error, /Λάθος κωδικός/);
  assert.equal((await call('/api/student/verify', { method: 'POST', body: { email: 'b@uni.gr', code } })).status, 400, 'κωδικός άλλου email');
  const ok = await call('/api/student/verify', { method: 'POST', body: { email: 'a@uni.gr', code } });
  assert.ok(ok.data.token);
  assert.equal((await call('/api/student/verify', { method: 'POST', body: { email: 'a@uni.gr', code } })).status, 400, 'ο κωδικός χρησιμοποιείται μία φορά');
  assert.equal((await call('/api/student/me', { token: ok.data.token })).status, 200);

  // Μέχρι 5 προσπάθειες ανά κωδικό
  await call('/api/student/register', { method: 'POST', body: { email: 'b@uni.gr' } });
  for (let i = 0; i < 5; i++) await call('/api/student/verify', { method: 'POST', body: { email: 'b@uni.gr', code: '000000' } });
  await new Promise((res) => setTimeout(res, 200));
  const codeB = [...outbox.matchAll(/Κωδικός σύνδεσης: (\d{6})/g)].pop()[1];
  assert.match((await call('/api/student/verify', { method: 'POST', body: { email: 'b@uni.gr', code: codeB } })).data.error, /Ζητήστε νέο/);

  // Κεφαλίδες ασφαλείας, CSRF, όριο προσπαθειών σύνδεσης καθηγητή
  const page = await fetch(BASE + '/');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal((await call('/healthz')).data, 'ok');
  assert.equal((await call(`/api/admin/courses`, { method: 'POST', cookie, body: { name: 'x' }, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('/api/admin/backup.json', { cookie })).data.courses.length, 1);
  assert.equal((await call('/api/admin/backup.json')).status, 401);
  let st;
  for (let i = 0; i < 12; i++) st = (await call('/api/admin/login', { method: 'POST', body: { password: 'wrong-guess' } })).status;
  assert.equal(st, 429);
}

// Δεδομένα από την πρώτη έκδοση (ένα μάθημα) μεταφέρονται σε «Μάθημα 1».
async function migrationFlow() {
  const cookie = await login();
  const courses = (await call('/api/admin/courses', { cookie })).data;
  assert.equal(courses.length, 1);
  assert.equal(courses[0].name, 'Μάθημα 1');
  assert.equal(courses[0].sessions, 1);
  const st = (await call(`/api/admin/courses/${courses[0].id}/students`, { cookie })).data;
  assert.deepEqual(st.map((s) => [s.email, s.registered, s.present]), [['a@uni.gr', true, 1]]);
  const me = await call('/api/student/me', { token: 'oldtoken' });
  assert.equal(me.data.courses[0].history[0].present, true);
}

(async () => {
  const dirs = [];
  let srv;
  try {
    const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'parousies-')); dirs.push(d1);
    srv = startServer(d1); await waitUp();
    await mainFlow(d1);
    srv.kill();

    const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'parousies-')); dirs.push(d3);
    srv = startServer(d3, 'stdout'); await new Promise((r) => setTimeout(r, 300)); await waitUp();
    await securityFlow();
    assert.ok(fs.existsSync(path.join(d3, 'backups')), 'αυτόματο αντίγραφο ασφαλείας');
    srv.kill();

    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'parousies-')); dirs.push(d2);
    const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
    fs.writeFileSync(path.join(d2, 'db.json'), JSON.stringify({
      secret: 'x'.repeat(64),
      students: { 'a@uni.gr': { email: 'a@uni.gr', name: 'Άλφα', deviceHash: sha('oldtoken'), registeredAt: '2026-01-01T00:00:00Z' } },
      sessions: [{ id: 'old1', title: 'Παλιά', createdAt: '2026-01-01T00:00:00Z', closed: true, attendance: { 'a@uni.gr': { at: '2026-01-01T00:01:00Z' } } }],
    }));
    srv = startServer(d2); await new Promise((r) => setTimeout(r, 300)); await waitUp();
    await migrationFlow();
    console.log('✔ Όλοι οι έλεγχοι πέρασαν');
  } catch (e) {
    console.error(e); process.exitCode = 1;
  } finally {
    srv?.kill();
    dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
})();
