const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initial default database structure
const DEFAULT_DB = {
  users: [
    { id: 'u1', username: 'mostafa', name: 'مصطفى سمير', role: 'coordinator', pin: '1234' },
    { id: 'u2', username: 'abouzeid', name: 'أبو زيد', role: 'coordinator', pin: '2345' },
    { id: 'u3', username: 'mourad', name: 'مراد', role: 'coordinator', pin: '3456' },
    { id: 'u4', username: 'admin', name: 'المدير / الأدمن', role: 'admin', pin: '9999' }
  ],
  links: [],
  activity: [],
  counter: 0
};

// Load database from file
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const content = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.error('Error reading database file, using defaults:', err);
  }
  saveDB(DEFAULT_DB);
  return JSON.parse(JSON.stringify(DEFAULT_DB));
}

// Save database to file
function saveDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving database file:', err);
  }
}

let db = loadDB();

// SSE Clients for Real-time push updates
let sseClients = [];

function notifyClients(type, payload) {
  const message = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.res.write(message);
    } catch (e) {
      // client disconnected
    }
  });
}

function logActivity(event) {
  const record = {
    id: 'act_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    at: Date.now(),
    ...event
  };
  db.activity.unshift(record);
  if (db.activity.length > 500) {
    db.activity = db.activity.slice(0, 500);
  }
  saveDB(db);
  notifyClients('activity', record);
}

// ================= API ROUTES =================

// Real-time SSE Stream
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = Date.now() + '_' + Math.random();
  sseClients.push({ id: clientId, res });

  // Keep alive comment every 25 seconds
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

// Authentication / Login
app.post('/api/login', (req, res) => {
  const { username, pin } = req.body;
  const user = db.users.find(u => (u.username === username || u.name === username) && u.pin === pin);
  if (!user) {
    return res.status(401).json({ error: 'رمز الدخول (PIN) أو المستخدم غير صحيح' });
  }

  logActivity({
    kind: 'visit',
    by: user.id,
    byName: user.name
  });

  res.json({
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role
  });
});

// Get users list (public names and roles for selection)
app.get('/api/users', (req, res) => {
  const safeUsers = db.users.map(u => ({
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role
  }));
  res.json(safeUsers);
});

// Admin add/update user
app.post('/api/users', (req, res) => {
  const { name, username, pin, role } = req.body;
  if (!name || !pin) {
    return res.status(400).json({ error: 'الاسم ورقم الـ PIN مطلوبين' });
  }
  const uName = username || name.toLowerCase().replace(/\s+/g, '_');
  const existing = db.users.find(u => u.username === uName);
  if (existing) {
    existing.name = name;
    existing.pin = pin;
    if (role) existing.role = role;
  } else {
    db.users.push({
      id: 'u_' + Date.now(),
      username: uName,
      name,
      pin,
      role: role || 'coordinator'
    });
  }
  saveDB(db);
  res.json({ success: true, users: db.users.map(u => ({ id: u.id, username: u.username, name: u.name, role: u.role })) });
});

// Get all links
app.get('/api/links', (req, res) => {
  res.json(db.links);
});

// Add a single link
app.post('/api/links', (req, res) => {
  const r = req.body;
  if (!r.siteA || !r.siteB) {
    return res.status(400).json({ error: 'يجب إدخال اسم الموقع A والموقع B' });
  }

  let maxN = 0;
  db.links.forEach(l => { if ((l.n || 0) > maxN) maxN = l.n; });
  const n = maxN + 1;
  const id = 'L' + String(n).padStart(3, '0');

  const link = {
    id,
    n,
    siteA: (r.siteA || '').trim(),
    codeA: (r.codeA || '').trim(),
    siteB: (r.siteB || '').trim(),
    codeB: (r.codeB || '').trim(),
    project: (r.project || '').trim().toUpperCase(),
    action: (r.action || '').trim(),
    coordinator: (r.coordinator || '').trim(),
    status: r.status || 'new',
    withWhom: (r.withWhom || '').trim(),
    withMe: r.withMe || '',
    stuckAt: (r.stuckAt || '').trim(),
    sentDate: r.sentDate || '',
    updatedAt: Date.now(),
    updatedByName: r.byName || ''
  };

  db.links.push(link);
  saveDB(db);

  logActivity({
    kind: 'add',
    linkId: id,
    n,
    siteA: link.siteA,
    siteB: link.siteB,
    by: r.by || null,
    byName: r.byName || 'Admin'
  });

  notifyClients('link_add', link);
  res.json(link);
});

// Update link
app.put('/api/links/:id', (req, res) => {
  const id = req.params.id;
  const patch = req.body;
  const index = db.links.findIndex(l => l.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'اللينك غير موجود' });
  }

  const cur = db.links[index];
  const changes = [];
  const fields = ['status', 'withWhom', 'withMe', 'stuckAt', 'sentDate', 'coordinator', 'project', 'action', 'siteA', 'codeA', 'siteB', 'codeB'];

  fields.forEach(f => {
    if (patch[f] !== undefined && (cur[f] || '') !== (patch[f] || '')) {
      changes.push({ f, from: cur[f] || '', to: patch[f] || '' });
      cur[f] = patch[f];
    }
  });

  cur.updatedAt = Date.now();
  if (patch.byName) cur.updatedByName = patch.byName;
  if (patch.by) cur.updatedBy = patch.by;

  saveDB(db);

  if (changes.length > 0) {
    logActivity({
      kind: 'edit',
      linkId: id,
      n: cur.n || 0,
      siteA: cur.siteA,
      siteB: cur.siteB,
      changes,
      by: patch.by || null,
      byName: patch.byName || 'Unknown'
    });
  }

  notifyClients('link_update', cur);
  res.json(cur);
});

// Delete link
app.delete('/api/links/:id', (req, res) => {
  const id = req.params.id;
  const index = db.links.findIndex(l => l.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'اللينك غير موجود' });
  }

  const deleted = db.links.splice(index, 1)[0];
  saveDB(db);

  logActivity({
    kind: 'delete',
    linkId: id,
    n: deleted.n || 0,
    siteA: deleted.siteA,
    siteB: deleted.siteB,
    by: req.query.by || null,
    byName: req.query.byName || 'Admin'
  });

  notifyClients('link_delete', { id });
  res.json({ success: true, id });
});

// Bulk assign coordinator
app.post('/api/links/bulk-assign', (req, res) => {
  const { ids, coordinator, by, byName } = req.body;
  if (!Array.isArray(ids) || !ids.length || !coordinator) {
    return res.status(400).json({ error: 'بيانات غير مكتملة' });
  }

  let count = 0;
  ids.forEach(id => {
    const item = db.links.find(l => l.id === id);
    if (item) {
      item.coordinator = coordinator;
      item.updatedAt = Date.now();
      item.updatedByName = byName || 'Admin';
      count++;
    }
  });

  saveDB(db);

  logActivity({
    kind: 'bulk_assign',
    count,
    coordinator,
    by: by || null,
    byName: byName || 'Admin'
  });

  notifyClients('links_bulk_update', { ids, coordinator });
  res.json({ success: true, count });
});

// Bulk import from Sheet / Excel
app.post('/api/links/bulk-import', (req, res) => {
  const { items, fileName, by, byName } = req.body;
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'لا توجد بيانات للاستيراد' });
  }

  let maxN = 0;
  db.links.forEach(l => { if ((l.n || 0) > maxN) maxN = l.n; });

  const added = [];
  items.forEach(r => {
    maxN++;
    const id = 'L' + String(maxN).padStart(3, '0');
    const link = {
      id,
      n: maxN,
      siteA: (r.siteA || '').trim(),
      codeA: (r.codeA || '').trim(),
      siteB: (r.siteB || '').trim(),
      codeB: (r.codeB || '').trim(),
      project: (r.project || '').trim().toUpperCase(),
      action: (r.action || '').trim(),
      coordinator: (r.coordinator || '').trim(),
      status: 'new',
      withWhom: '',
      withMe: '',
      stuckAt: '',
      sentDate: '',
      updatedAt: Date.now(),
      updatedByName: byName || 'Admin'
    };
    db.links.push(link);
    added.push(link);
  });

  saveDB(db);

  logActivity({
    kind: 'import',
    count: added.length,
    file: fileName || 'Sheet File',
    by: by || null,
    byName: byName || 'Admin'
  });

  notifyClients('links_reload', {});
  res.json({ success: true, count: added.length });
});

// Get recent activity
app.get('/api/activity', (req, res) => {
  res.json(db.activity || []);
});

// Fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`🚀 Smart System for RFA is running!`);
  console.log(`🌐 Local URL: http://localhost:${PORT}`);
  console.log(`===============================================`);
});
