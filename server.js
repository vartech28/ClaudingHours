const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3333;
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// --- File helpers ---

function readJSON(filePath, defaultValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return defaultValue;
  }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function ensureFiles() {
  if (!fs.existsSync(SESSIONS_FILE)) writeJSON(SESSIONS_FILE, []);
  if (!fs.existsSync(CONFIG_FILE)) writeJSON(CONFIG_FILE, { dailyGoalSeconds: 14400 });
}

// --- Middleware ---

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Sessions API ---

app.get('/api/sessions', (req, res) => {
  const sessions = readJSON(SESSIONS_FILE, []);
  sessions.sort((a, b) => {
    const cmp = a.date.localeCompare(b.date);
    return cmp !== 0 ? cmp : a.startTime.localeCompare(b.startTime);
  });
  res.json({ sessions });
});

app.post('/api/sessions', (req, res) => {
  const session = req.body;
  if (!session || typeof session.durationSeconds !== 'number' || session.durationSeconds <= 0) {
    return res.status(400).json({ error: 'Invalid session data' });
  }
  const sessions = readJSON(SESSIONS_FILE, []);
  sessions.push(session);
  writeJSON(SESSIONS_FILE, sessions);
  res.status(201).json({ ok: true, session });
});

app.delete('/api/sessions/:id', (req, res) => {
  const { id } = req.params;
  const sessions = readJSON(SESSIONS_FILE, []);
  const filtered = sessions.filter(s => s.id !== id);
  if (filtered.length === sessions.length) {
    return res.status(404).json({ error: 'Session not found' });
  }
  writeJSON(SESSIONS_FILE, filtered);
  res.json({ ok: true });
});

// --- Config API ---

app.get('/api/config', (req, res) => {
  const config = readJSON(CONFIG_FILE, { dailyGoalSeconds: 14400 });
  res.json(config);
});

app.post('/api/config', (req, res) => {
  const { dailyGoalSeconds } = req.body;
  if (typeof dailyGoalSeconds !== 'number' || dailyGoalSeconds <= 0) {
    return res.status(400).json({ error: 'Invalid config' });
  }
  writeJSON(CONFIG_FILE, { dailyGoalSeconds });
  res.json({ ok: true });
});

// --- Start ---

ensureFiles();

app.listen(PORT, () => {
  console.log(`\nClaudingHours running at http://localhost:${PORT}\n`);
  console.log('  Space  → pause / resume');
  console.log('  E      → end session');
  console.log('  N      → focus label input\n');

  // Auto-open browser (dynamic import for ESM-only `open` package)
  import('open').then(({ default: open }) => open(`http://localhost:${PORT}`)).catch(() => {});
});
