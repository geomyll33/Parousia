// Παρουσίες με QR — server (Node.js ≥ 20).
// Ρυθμίσεις μέσω μεταβλητών περιβάλλοντος:
//   ADMIN_PASSWORD  κωδικός καθηγητή (υποχρεωτικός, τουλάχιστον 10 χαρακτήρες)
//   PORT            θύρα (προεπιλογή 3000)
//   DATA_DIR        φάκελος δεδομένων (προεπιλογή ./data)
//   QR_SECONDS      κάθε πόσα δευτερόλεπτα αλλάζει το QR (προεπιλογή 10)
//   TRUST_PROXY     1 όταν τρέχει πίσω από HTTPS proxy (Render, Fly, nginx)
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
//                   αποστολή κωδικού επιβεβαίωσης στο email του φοιτητή.
//                   Με SMTP_HOST=stdout οι κωδικοί τυπώνονται στην κονσόλα (μόνο για δοκιμές).
//   EMAIL_CODE      0 = σύνδεση φοιτητή χωρίς κωδικό email (δεν συνιστάται)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const QR_SECONDS = Math.max(5, Number(process.env.QR_SECONDS) || 10);
const QR_GRACE_SLOTS = 2; // δεκτά και τα 2 προηγούμενα QR (καθυστέρηση σάρωσης)
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUPS_KEPT = 30;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SMTP_HOST = process.env.SMTP_HOST || '';
const EMAIL_CODE = SMTP_HOST !== '' && process.env.EMAIL_CODE !== '0';

if (ADMIN_PASSWORD.length < 10) {
  console.error('Ορίστε ισχυρό κωδικό καθηγητή (τουλάχιστον 10 χαρακτήρες): ADMIN_PASSWORD=... node server.js');
  process.exit(1);
}
if (!SMTP_HOST) {
  console.warn('ΠΡΟΣΟΧΗ: δεν έχει οριστεί SMTP_HOST — οι φοιτητές συνδέονται χωρίς κωδικό επιβεβαίωσης email.');
}

// ---------- Αποστολή email ----------
let mailer = null;
if (SMTP_HOST && SMTP_HOST !== 'stdout') {
  const nodemailer = require('nodemailer');
  const port = Number(process.env.SMTP_PORT) || 465;
  mailer = nodemailer.createTransport({
    host: SMTP_HOST, port, secure: port === 465, requireTLS: port !== 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
  });
}
async function sendMail(to, subject, text) {
  if (SMTP_HOST === 'stdout') { console.log(`[email] to=${to} subject=${subject}\n${text}`); return; }
  await mailer.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
}

// ---------- Αποθήκευση (αρχείο JSON) ----------
// db = { secret, devices: { email: { deviceHash, registeredAt } },
//        courses: [{ id, name, createdAt, students: { email: { email, name } }, sessions: [...] }] }
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = {};
if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
db.secret ||= crypto.randomBytes(32).toString('hex');
db.devices ||= {};
db.courses ||= [];
if (db.students || db.sessions) {
  // Μετατροπή από την έκδοση με ένα μάθημα.
  const students = {};
  for (const [email, s] of Object.entries(db.students || {})) {
    students[email] = { email, name: s.name || '' };
    if (s.deviceHash) db.devices[email] = { deviceHash: s.deviceHash, registeredAt: s.registeredAt };
  }
  if (Object.keys(students).length || (db.sessions || []).length) {
    db.courses.push({ id: newId(), name: 'Μάθημα 1', createdAt: new Date().toISOString(), students, sessions: db.sessions || [] });
  }
  delete db.students; delete db.sessions;
}
function newId() { return crypto.randomBytes(6).toString('base64url'); }
function save() {
  // Ασφαλής εγγραφή: προσωρινό αρχείο → fsync → μετονομασία.
  const tmp = DB_FILE + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(db)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, DB_FILE);
}
save();

// ---------- Αυτόματα αντίγραφα ασφαλείας (ένα την ημέρα, κρατούνται 30) ----------
function backup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const name = `db-${new Date().toISOString().slice(0, 10)}.json`;
    fs.copyFileSync(DB_FILE, path.join(BACKUP_DIR, name));
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - BACKUPS_KEPT))) fs.unlinkSync(path.join(BACKUP_DIR, f));
  } catch (e) { console.error('Αποτυχία αντιγράφου ασφαλείας:', e.message); }
}
backup();
setInterval(backup, 3600 * 1000).unref();

// ---------- Όριο αιτημάτων (προστασία από δοκιμές κωδικών / spam) ----------
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  return ++b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60000).unref();
const clientIp = (req) => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
const isHttps = (req) => TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').includes('https');

// ---------- Κωδικοί επιβεβαίωσης email (στη μνήμη, ισχύουν 10′) ----------
const pendingCodes = new Map(); // email → { hash, exp, tries }

const hmac = (s) => crypto.createHmac('sha256', db.secret).update(s).digest('base64url');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const normEmail = (e) => String(e || '').trim().toLowerCase();
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const findCourse = (id) => db.courses.find((c) => c.id === id);
function findSession(id) {
  for (const c of db.courses) {
    const s = c.sessions.find((x) => x.id === id);
    if (s) return { course: c, session: s };
  }
  return {};
}
const nameOf = (email) => {
  for (const c of db.courses) if (c.students[email]?.name) return c.students[email].name;
  return '';
};
const enrolled = (email) => db.courses.filter((c) => c.students[email]);

// ---------- QR που αλλάζει ----------
const slotNow = () => Math.floor(Date.now() / 1000 / QR_SECONDS);
const qrCode = (sessionId, slot) => `${sessionId}.${slot}.${hmac(`qr|${sessionId}|${slot}`).slice(0, 16)}`;
function checkQr(code) {
  const [sessionId, slotStr, sig] = String(code || '').split('.');
  const slot = Number(slotStr);
  if (!sessionId || !Number.isInteger(slot) || !sig) return { error: 'Μη έγκυρο QR.' };
  if (!safeEq(qrCode(sessionId, slot), code)) return { error: 'Μη έγκυρο QR.' };
  const { course, session } = findSession(sessionId);
  if (!session) return { error: 'Η παρακολούθηση δεν υπάρχει.' };
  if (session.closed) return { error: 'Η παρακολούθηση έχει κλείσει.' };
  const now = slotNow();
  if (slot > now + 1 || slot < now - QR_GRACE_SLOTS) {
    return { error: 'Το QR έληξε. Σαρώστε το τρέχον QR στην οθόνη του καθηγητή.' };
  }
  return { course, session };
}

// ---------- Συνεδρία καθηγητή (υπογεγραμμένο cookie) ----------
const ADMIN_TTL = 12 * 3600 * 1000;
function adminCookie() {
  const exp = Date.now() + ADMIN_TTL;
  return `adm=${exp}.${hmac(`admin|${exp}|${sha(ADMIN_PASSWORD)}`)}`;
}
function isAdmin(req) {
  const m = /(?:^|;\s*)adm=(\d+)\.([\w-]+)/.exec(req.headers.cookie || '');
  if (!m || Number(m[1]) < Date.now()) return false;
  return safeEq(m[2], hmac(`admin|${m[1]}|${sha(ADMIN_PASSWORD)}`));
}

// ---------- Βοηθητικά HTTP ----------
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad json')); }
    });
  });
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/teacher' || pathname === '/kathigitis') pathname = '/teacher.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Δεν βρέθηκε');
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(buf);
  });
}

// ---------- Δεδομένα για απαντήσεις ----------
const studentList = (c) => Object.values(c.students).sort((a, b) =>
  (a.name || a.email).localeCompare(b.name || b.email, 'el'));
function courseSummary(c) {
  const open = c.sessions.find((s) => !s.closed);
  return {
    id: c.id, name: c.name, createdAt: c.createdAt,
    students: Object.keys(c.students).length, sessions: c.sessions.length,
    openSessionId: open ? open.id : null,
  };
}
function sessionSummary(s) {
  return {
    id: s.id, title: s.title, createdAt: s.createdAt, closed: !!s.closed,
    count: Object.keys(s.attendance).length,
  };
}
function sessionDetail(c, s) {
  const attendees = Object.entries(s.attendance)
    .map(([email, a]) => ({ email, name: c.students[email]?.name || '', at: a.at, manual: !!a.manual }))
    .sort((a, b) => a.at.localeCompare(b.at));
  const absent = studentList(c).filter((st) => !s.attendance[st.email])
    .map((st) => ({ email: st.email, name: st.name || '' }));
  return { ...sessionSummary(s), courseId: c.id, courseName: c.name, attendees, absent };
}
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const fmtDate = (iso) => new Date(iso).toLocaleString('el-GR', { timeZone: 'Europe/Athens' });
const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\wͰ-Ͽ-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'mathima';

// ---------- Δρομολόγηση ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  const ip = clientIp(req);
  if (m !== 'GET' && m !== 'HEAD') {
    // Αιτήματα αλλαγής δεκτά μόνο από την ίδια την εφαρμογή (προστασία CSRF).
    const origin = req.headers.origin;
    if (origin && origin !== `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`) {
      return send(res, 403, { error: 'Μη επιτρεπτή προέλευση αιτήματος.' });
    }
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      return send(res, 415, { error: 'Μη αποδεκτό αίτημα.' });
    }
  }
  if (limited(`all|${ip}`, 5000, 60000)) return send(res, 429, { error: 'Πολλά αιτήματα. Δοκιμάστε σε λίγο.' });
  const body = m === 'POST' || m === 'PUT' ? await readBody(req) : {};
  let mm;

  if (p === '/api/config' && m === 'GET') return send(res, 200, { emailCode: EMAIL_CODE });

  // ===== Φοιτητές =====
  const bindDevice = (email) => {
    const token = crypto.randomBytes(32).toString('base64url');
    db.devices[email] = { deviceHash: sha(token), registeredAt: new Date().toISOString() };
    save();
    return { token, email, name: nameOf(email) };
  };
  if (p === '/api/student/register' && m === 'POST') {
    if (limited(`reg|${ip}`, 500, 3600000)) return send(res, 429, { error: 'Πολλές προσπάθειες. Δοκιμάστε ξανά σε μία ώρα.' });
    const email = normEmail(body.email);
    if (!EMAIL_RE.test(email) || email.length > 200) return send(res, 400, { error: 'Γράψτε ένα έγκυρο email.' });
    if (!enrolled(email).length) return send(res, 403, { error: 'Το email δεν είναι στη λίστα κανενός μαθήματος. Ελέγξτε ότι το γράψατε σωστά ή επικοινωνήστε με τον καθηγητή.' });
    if (db.devices[email]) return send(res, 409, { error: 'Αυτό το email είναι ήδη συνδεδεμένο σε άλλη συσκευή. Ζητήστε από τον καθηγητή «επαναφορά συσκευής».' });
    if (!EMAIL_CODE) return send(res, 200, bindDevice(email));
    if (limited(`code|${email}`, 5, 3600000)) return send(res, 429, { error: 'Στάλθηκαν ήδη αρκετοί κωδικοί. Ελέγξτε τα εισερχόμενα και τα ανεπιθύμητα (spam) ή δοκιμάστε σε μία ώρα.' });
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    pendingCodes.set(email, { hash: sha(`${email}|${code}`), exp: Date.now() + 10 * 60000, tries: 0 });
    try {
      await sendMail(email, `Κωδικός σύνδεσης: ${code}`,
        `Ο κωδικός σύνδεσης στην εφαρμογή «Παρουσίες QR» είναι:\n\n    ${code}\n\nΙσχύει για 10 λεπτά. Αν δεν τον ζητήσατε εσείς, αγνοήστε αυτό το μήνυμα.`);
    } catch (e) {
      console.error('Αποτυχία αποστολής email:', e.message);
      pendingCodes.delete(email);
      return send(res, 502, { error: 'Δεν ήταν δυνατή η αποστολή email αυτή τη στιγμή. Δοκιμάστε ξανά σε λίγο.' });
    }
    return send(res, 200, { verify: true, email });
  }
  if (p === '/api/student/verify' && m === 'POST') {
    if (limited(`ver|${ip}`, 1000, 3600000)) return send(res, 429, { error: 'Πολλές προσπάθειες. Δοκιμάστε ξανά σε μία ώρα.' });
    const email = normEmail(body.email);
    const pc = pendingCodes.get(email);
    if (!pc || pc.exp < Date.now()) { pendingCodes.delete(email); return send(res, 400, { error: 'Ο κωδικός έληξε. Ζητήστε νέο κωδικό.' }); }
    if (++pc.tries > 5) { pendingCodes.delete(email); return send(res, 400, { error: 'Πολλές λάθος προσπάθειες. Ζητήστε νέο κωδικό.' }); }
    if (!safeEq(pc.hash, sha(`${email}|${String(body.code || '').replace(/\D/g, '')}`))) {
      return send(res, 400, { error: `Λάθος κωδικός. Απομένουν ${6 - pc.tries} προσπάθειες.` });
    }
    pendingCodes.delete(email);
    if (db.devices[email]) return send(res, 409, { error: 'Αυτό το email είναι ήδη συνδεδεμένο σε άλλη συσκευή. Ζητήστε από τον καθηγητή «επαναφορά συσκευής».' });
    return send(res, 200, bindDevice(email));
  }

  if (p.startsWith('/api/student/')) {
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const h = auth && sha(auth[1]);
    const email = h && Object.keys(db.devices).find((e) => safeEq(db.devices[e].deviceHash, h));
    if (!email) return send(res, 401, { error: 'Η συσκευή δεν είναι συνδεδεμένη. Συνδεθείτε ξανά με το email σας.' });

    if (p === '/api/student/me' && m === 'GET') {
      const courses = enrolled(email).map((c) => ({
        name: c.name,
        history: c.sessions
          .map((s) => ({ title: s.title, createdAt: s.createdAt, present: !!s.attendance[email], at: s.attendance[email]?.at || null }))
          .reverse(),
      }));
      return send(res, 200, { email, name: nameOf(email), courses });
    }
    if (p === '/api/student/checkin' && m === 'POST') {
      if (limited(`chk|${email}`, 30, 60000)) return send(res, 429, { error: 'Πολλές προσπάθειες. Δοκιμάστε σε ένα λεπτό.' });
      const r = checkQr(body.code);
      if (r.error) return send(res, 400, { error: r.error });
      const { course: c, session: s } = r;
      if (!c.students[email]) return send(res, 403, { error: `Δεν είστε γραμμένοι στο μάθημα «${c.name}». Επικοινωνήστε με τον καθηγητή.` });
      if (s.attendance[email]) {
        return send(res, 200, { ok: true, already: true, course: c.name, title: s.title, at: s.attendance[email].at });
      }
      s.attendance[email] = { at: new Date().toISOString() };
      save();
      return send(res, 200, { ok: true, course: c.name, title: s.title, at: s.attendance[email].at });
    }
    return send(res, 404, { error: 'Not found' });
  }

  // ===== Καθηγητής =====
  if (p === '/api/admin/login' && m === 'POST') {
    if (limited(`login|${ip}`, 10, 15 * 60000) || limited('login|all', 100, 15 * 60000)) {
      return send(res, 429, { error: 'Πολλές αποτυχημένες προσπάθειες. Δοκιμάστε ξανά σε 15 λεπτά.' });
    }
    if (!safeEq(sha(String(body.password || '')), sha(ADMIN_PASSWORD))) {
      console.warn(`Αποτυχημένη σύνδεση καθηγητή από ${ip}`);
      return send(res, 401, { error: 'Λάθος κωδικός.' });
    }
    const secure = isHttps(req) ? '; Secure' : '';
    return send(res, 200, { ok: true }, {
      'Set-Cookie': `${adminCookie()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ADMIN_TTL / 1000}${secure}`,
    });
  }
  if (p === '/api/admin/logout' && m === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'adm=; Path=/; Max-Age=0' });
  }
  if (!p.startsWith('/api/admin/')) return send(res, 404, { error: 'Not found' });
  if (!isAdmin(req)) return send(res, 401, { error: 'Απαιτείται σύνδεση καθηγητή.' });

  // --- Αντίγραφο ασφαλείας ---
  if (p === '/api/admin/backup.json' && m === 'GET') {
    return send(res, 200, JSON.stringify(db), {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="parousies-backup-${new Date().toISOString().slice(0, 10)}.json"`,
    });
  }

  // --- Μαθήματα ---
  if (p === '/api/admin/courses' && m === 'GET') {
    return send(res, 200, db.courses.map(courseSummary));
  }
  if (p === '/api/admin/courses' && m === 'POST') {
    const name = String(body.name || '').trim().slice(0, 120);
    if (!name) return send(res, 400, { error: 'Δώστε όνομα μαθήματος.' });
    const c = { id: newId(), name, createdAt: new Date().toISOString(), students: {}, sessions: [] };
    db.courses.push(c);
    save();
    return send(res, 200, courseSummary(c));
  }
  if ((mm = /^\/api\/admin\/courses\/([\w-]+)(\/[\w.-]+)?$/.exec(p))) {
    const c = findCourse(mm[1]);
    if (!c) return send(res, 404, { error: 'Το μάθημα δεν βρέθηκε.' });
    const action = mm[2];
    if (!action && m === 'PUT') {
      const name = String(body.name || '').trim().slice(0, 120);
      if (!name) return send(res, 400, { error: 'Δώστε όνομα μαθήματος.' });
      c.name = name; save();
      return send(res, 200, courseSummary(c));
    }
    if (!action && m === 'DELETE') {
      db.courses = db.courses.filter((x) => x !== c);
      // Συσκευές φοιτητών που δεν ανήκουν πια σε κανένα μάθημα αποσυνδέονται.
      for (const email of Object.keys(db.devices)) if (!enrolled(email).length) delete db.devices[email];
      save();
      return send(res, 200, { ok: true });
    }
    if (action === '/students' && m === 'GET') {
      return send(res, 200, studentList(c).map((s) => ({
        email: s.email, name: s.name || '', registered: !!db.devices[s.email],
        present: c.sessions.filter((x) => x.attendance[s.email]).length,
      })));
    }
    if (action === '/students' && m === 'PUT') {
      // Κάθε γραμμή: email και προαιρετικά ονοματεπώνυμο (π.χ. «Μαρία Παππά, maria@uni.gr»)
      const next = {};
      for (const line of String(body.text || '').split(/\r?\n/)) {
        const em = EMAIL_RE.exec(line);
        if (!em) continue;
        const email = normEmail(em[0]);
        const name = line.replace(em[0], '').replace(/[<>;,\t"]+/g, ' ').replace(/\s+/g, ' ').trim();
        next[email] = { email, name: name || c.students[email]?.name || '' };
      }
      const added = Object.keys(next).filter((e) => !c.students[e]).length;
      const removed = Object.keys(c.students).filter((e) => !next[e]).length;
      c.students = next;
      for (const email of Object.keys(db.devices)) if (!enrolled(email).length) delete db.devices[email];
      save();
      return send(res, 200, { ok: true, total: Object.keys(next).length, added, removed });
    }
    if (action === '/sessions' && m === 'GET') {
      return send(res, 200, c.sessions.map(sessionSummary).reverse());
    }
    if (action === '/sessions' && m === 'POST') {
      const title = String(body.title || '').trim().slice(0, 120) ||
        `Παρακολούθηση ${new Date().toLocaleDateString('el-GR', { timeZone: 'Europe/Athens' })}`;
      // Κλείνει αυτόματα όποια άλλη παρακολούθηση του ίδιου μαθήματος είναι ανοιχτή.
      c.sessions.forEach((s) => { s.closed = true; });
      const s = { id: newId(), title, createdAt: new Date().toISOString(), closed: false, attendance: {} };
      c.sessions.push(s);
      save();
      return send(res, 200, sessionDetail(c, s));
    }
    if (action === '/export.csv' && m === 'GET') {
      const rows = [['Ονοματεπώνυμο', 'Email', ...c.sessions.map((s) => `${s.title} (${fmtDate(s.createdAt)})`), 'Σύνολο παρουσιών']];
      for (const st of studentList(c)) {
        const marks = c.sessions.map((s) => (s.attendance[st.email] ? 1 : 0));
        rows.push([st.name, st.email, ...marks.map((x) => (x ? 'Π' : 'Α')), marks.reduce((a, b) => a + b, 0)]);
      }
      return sendCsv(res, `parousies-${slug(c.name)}.csv`, rows);
    }
    return send(res, 404, { error: 'Not found' });
  }

  // --- Συσκευές φοιτητών ---
  if ((mm = /^\/api\/admin\/devices\/([^/]+)\/reset$/.exec(p)) && m === 'POST') {
    delete db.devices[normEmail(decodeURIComponent(mm[1]))];
    save();
    return send(res, 200, { ok: true });
  }

  // --- Παρακολουθήσεις ---
  if ((mm = /^\/api\/admin\/sessions\/([\w-]+)(\/[\w-]+)?$/.exec(p))) {
    const { course: c, session: s } = findSession(mm[1]);
    if (!s) return send(res, 404, { error: 'Δεν βρέθηκε.' });
    const action = mm[2];
    if (!action && m === 'GET') return send(res, 200, sessionDetail(c, s));
    if (!action && m === 'DELETE') {
      c.sessions = c.sessions.filter((x) => x !== s); save();
      return send(res, 200, { ok: true });
    }
    if (action === '/qr' && m === 'GET') {
      if (s.closed) return send(res, 400, { error: 'Η παρακολούθηση έχει κλείσει.' });
      const slot = slotNow();
      const nextIn = (slot + 1) * QR_SECONDS * 1000 - Date.now();
      return send(res, 200, { code: qrCode(s.id, slot), nextIn, seconds: QR_SECONDS, count: Object.keys(s.attendance).length });
    }
    if (action === '/close' && m === 'POST') { s.closed = true; save(); return send(res, 200, sessionDetail(c, s)); }
    if (action === '/reopen' && m === 'POST') {
      c.sessions.forEach((x) => { x.closed = true; });
      s.closed = false; save(); return send(res, 200, sessionDetail(c, s));
    }
    if (action === '/mark' && m === 'POST') {
      const email = normEmail(body.email);
      if (!c.students[email]) return send(res, 404, { error: 'Ο φοιτητής δεν είναι στο μάθημα.' });
      if (body.present) s.attendance[email] ||= { at: new Date().toISOString(), manual: true };
      else delete s.attendance[email];
      save();
      return send(res, 200, sessionDetail(c, s));
    }
    if (action === '/csv' && m === 'GET') {
      const rows = [['Μάθημα', 'Ονοματεπώνυμο', 'Email', 'Παρών', 'Ώρα', 'Χειροκίνητα']];
      for (const st of studentList(c)) {
        const a = s.attendance[st.email];
        rows.push([c.name, st.name, st.email, a ? 'ΝΑΙ' : 'ΟΧΙ', a ? fmtDate(a.at) : '', a?.manual ? 'ναι' : '']);
      }
      return sendCsv(res, `parousies-${slug(c.name)}-${s.createdAt.slice(0, 10)}.csv`, rows);
    }
    return send(res, 404, { error: 'Not found' });
  }
  return send(res, 404, { error: 'Not found' });
}
function sendCsv(res, filename, rows) {
  // BOM ώστε το Excel να διαβάζει σωστά τα ελληνικά· «;» ως διαχωριστικό για ελληνικό Excel.
  const csv = '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n');
  send(res, 200, csv, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') return send(res, 200, 'ok');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, decodeURIComponent(url.pathname));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 400, { error: 'Σφάλμα αιτήματος.' });
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.listen(PORT, () => {
  console.log(`Παρουσίες: http://localhost:${PORT}  (καθηγητής: /teacher) · επιβεβαίωση email: ${EMAIL_CODE ? 'ναι' : 'όχι'}`);
});
function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
