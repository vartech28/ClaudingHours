// ═══════════════════════════
//  STATE
// ═══════════════════════════
let state = 'IDLE'; // 'IDLE' | 'RUNNING' | 'PAUSED'
let sessionStart = null;   // Date — wall-clock start of session
let segmentStart = null;   // Date.now() — start of current run segment
let accumulatedMs = 0;     // total elapsed ms across all run segments (excl. current)
let timerInterval = null;
let currentLabel = '';
let currentNotes = '';
let currentGoalSeconds = 14400; // 4h default, overwritten by /api/config
let sessions = [];         // loaded from /api/sessions

// ── Feature state ──────────────────────────────
let goalNotificationSent = false; // true once we fire the goal notification today
let autoPaused = false;           // true only when Rust auto-paused due to claude inactivity
let lastElapsedSecs = 0;          // updated from Rust timer-tick events in Tauri mode

// ═══════════════════════════
//  DOM REFS
// ═══════════════════════════
const timerDisplay   = document.getElementById('timer-display');
const labelInput     = document.getElementById('label-input');
const streakBadge    = document.getElementById('streak-badge');
const goalBarFill    = document.getElementById('goal-bar-fill');
const goalLabelEl    = document.getElementById('goal-label');
const notesInput     = document.getElementById('notes-input');
const btnStart       = document.getElementById('btn-start');
const btnPause       = document.getElementById('btn-pause');
const btnEnd         = document.getElementById('btn-end');
const btnLogView     = document.getElementById('btn-log-view');
const btnBack        = document.getElementById('btn-back');
const btnOverlay     = document.getElementById('btn-overlay');
const btnExportCsv    = document.getElementById('btn-export-csv');
const btnSaveGoal     = document.getElementById('btn-save-goal');
const btnEditGoal     = document.getElementById('btn-edit-goal');
const btnCancelGoal   = document.getElementById('btn-cancel-goal');
const goalInput       = document.getElementById('goal-input');
const goalDisplayRow  = document.getElementById('goal-display-row');
const goalEditRow     = document.getElementById('goal-edit-row');
const goalDisplayValue = document.getElementById('goal-display-value');
const sessionsTable  = document.getElementById('sessions-table');
const totalHoursPill = document.getElementById('total-hours-pill');
const streakPill     = document.getElementById('streak-pill');
const emptyState     = document.getElementById('empty-state');
const toast          = document.getElementById('toast');

// ═══════════════════════════
//  TIMER LOGIC
// ═══════════════════════════
function getElapsedSeconds() {
  if (window.__TAURI__) return lastElapsedSecs;
  if (state === 'IDLE') return 0;
  const running = state === 'RUNNING' ? Date.now() - segmentStart : 0;
  return Math.floor((accumulatedMs + running) / 1000);
}

function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}

function tick() {
  // Browser fallback only. In Tauri mode the Rust timer-tick event drives the display.
  timerDisplay.textContent = formatDuration(getElapsedSeconds());
  updateGoalBar();
}


function updateButtons() {
  const isIdle    = state === 'IDLE';
  const isRunning = state === 'RUNNING';
  const isPaused  = state === 'PAUSED';

  btnStart.disabled = !isIdle;
  btnPause.disabled = !(isRunning || isPaused);
  btnEnd.disabled   = !(isRunning || isPaused);
  btnPause.textContent = isPaused ? 'Resume' : 'Pause';

  timerDisplay.classList.toggle('running', isRunning);
  timerDisplay.classList.toggle('paused', isPaused);
  labelInput.disabled = !isIdle;

  // Show notes textarea only when a session is active
  if (isRunning || isPaused) {
    notesInput.classList.remove('hidden');
  } else {
    notesInput.classList.add('hidden');
  }
}

function resetToIdle() {
  if (window.__TAURI__) {
    window.__TAURI__.core.invoke('reset_timer').catch(() => {});
  } else {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  state           = 'IDLE';
  sessionStart    = null;
  segmentStart    = null;
  accumulatedMs   = 0;
  lastElapsedSecs = 0;
  currentLabel    = '';
  currentNotes    = '';
  notesInput.value = '';
  autoPaused      = false;
  document.body.classList.remove('auto-paused');
  document.title = 'ClaudingHours';
  hideToast();
  if (window.__TAURI__) {
    window.__TAURI__.core.invoke('clear_draft').catch(() => {});
  }
  timerDisplay.textContent = '00:00:00';
  timerDisplay.classList.remove('running', 'paused');
  labelInput.value    = '';
  labelInput.disabled = false;
  updateButtons();
  updateGoalBar();
  updateStreak();
}

// ═══════════════════════════
//  SESSION ACTIONS
// ═══════════════════════════
function startSession() {
  if (state !== 'IDLE') return;
  currentLabel    = labelInput.value.trim();
  sessionStart    = new Date();
  lastElapsedSecs = 0;
  state = 'RUNNING';
  updateButtons();
  if (window.__TAURI__) {
    window.__TAURI__.core.invoke('start_timer').catch(() => {});
  } else {
    segmentStart  = Date.now();
    accumulatedMs = 0;
    timerInterval = setInterval(tick, 1000);
    tick();
  }
  saveDraftSoon();
}

function pauseSession() {
  if (state === 'RUNNING') {
    if (window.__TAURI__) {
      window.__TAURI__.core.invoke('pause_timer').catch(() => {});
    } else {
      clearInterval(timerInterval);
      timerInterval  = null;
      accumulatedMs += Date.now() - segmentStart;
      segmentStart   = null;
    }
    state = 'PAUSED';
    updateButtons();
  } else if (state === 'PAUSED') {
    if (window.__TAURI__) {
      window.__TAURI__.core.invoke('resume_timer').catch(() => {});
    } else {
      segmentStart  = Date.now();
      timerInterval = setInterval(tick, 1000);
      tick();
    }
    state = 'RUNNING';
    autoPaused = false;
    document.body.classList.remove('auto-paused');
    document.title = 'ClaudingHours';
    hideToast();
    updateButtons();
  }
}

async function endSession() {
  if (state !== 'RUNNING' && state !== 'PAUSED') return;

  // In Tauri mode `lastElapsedSecs` only updates on timer-tick events, which
  // stop firing while paused. Pull the authoritative count from Rust so we
  // don't lose up to ~1s when ending a paused session.
  if (window.__TAURI__) {
    try {
      lastElapsedSecs = await window.__TAURI__.core.invoke('get_elapsed_secs');
    } catch {}
  }
  const durationSeconds = getElapsedSeconds();

  if (durationSeconds < 5) {
    showToast('Session too short — not saved.', 'error');
    resetToIdle();
    return;
  }

  const now = new Date();
  const session = {
    id: crypto.randomUUID(),
    date: toLocalDateString(sessionStart),
    startTime: toLocalTimeString(sessionStart),
    endTime: toLocalTimeString(now),
    durationSeconds,
    label: currentLabel,
    goalSeconds: currentGoalSeconds,
    notes: notesInput.value.trim(),
  };

  try {
    if (window.__TAURI__) {
      await window.__TAURI__.core.invoke('add_session', { session });
    } else {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(session),
      });
      if (!res.ok) throw new Error('Server error');
    }
    sessions.push(session);
    showToast('Session saved', 'success');
  } catch {
    showToast('Error saving session', 'error');
  }

  resetToIdle();
}

// ═══════════════════════════
//  DATE/TIME HELPERS
// ═══════════════════════════
function toLocalDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toLocalTimeString(date) {
  return date.toTimeString().split(' ')[0]; // HH:MM:SS
}

function todayString() {
  return toLocalDateString(new Date());
}

// ═══════════════════════════
//  GOAL BAR
// ═══════════════════════════
function updateGoalBar() {
  const today = todayString();
  const todayPastSeconds = sessions
    .filter(s => s.date === today)
    .reduce((sum, s) => sum + s.durationSeconds, 0);
  const inProgressSeconds = state === 'IDLE' ? 0 : getElapsedSeconds();
  const totalSeconds = todayPastSeconds + inProgressSeconds;

  const pct = currentGoalSeconds > 0
    ? (totalSeconds / currentGoalSeconds) * 100
    : 0;

  goalBarFill.style.width = Math.min(100, pct) + '%';
  goalBarFill.classList.toggle('complete', pct >= 100);

  const hGoal = Math.floor(currentGoalSeconds / 3600);
  const hDone = Math.floor(totalSeconds / 3600);
  const mDone = Math.floor((totalSeconds % 3600) / 60);
  goalLabelEl.textContent = `${hDone}h ${mDone}m / ${hGoal}h today`;

  // Fire goal notification the first time we cross the threshold today
  if (pct >= 100 && !goalNotificationSent) {
    goalNotificationSent = true;
    fireGoalNotification(hGoal);
  }
  if (pct < 100) {
    goalNotificationSent = false; // reset if goal changes or sessions deleted
  }
}

function fireGoalNotification(hGoal) {
  if (!('Notification' in window)) return;
  const send = () => new Notification('ClaudingHours', {
    body: `Daily goal of ${hGoal}h reached — great work!`,
    silent: false,
  });
  if (Notification.permission === 'granted') {
    send();
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(p => { if (p === 'granted') send(); });
  }
}

// ═══════════════════════════
//  STREAK
// ═══════════════════════════
function computeStreak(sessions) {
  const uniqueDays = [...new Set(sessions.map(s => s.date))].sort().reverse();
  if (!uniqueDays.length) return 0;

  const today = todayString();
  const yesterday = toLocalDateString(new Date(Date.now() - 86400000));

  // If most recent session day isn't today or yesterday, streak is broken
  if (uniqueDays[0] !== today && uniqueDays[0] !== yesterday) return 0;

  let streak = 1;
  for (let i = 1; i < uniqueDays.length; i++) {
    const prev = new Date(uniqueDays[i - 1]);
    const curr = new Date(uniqueDays[i]);
    const diffDays = Math.round((prev - curr) / 86400000);
    if (diffDays === 1) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

function updateStreak() {
  const streak = computeStreak(sessions);
  if (streak > 1) {
    streakBadge.textContent = `${streak}-day streak`;
    streakBadge.classList.add('has-streak');
    streakBadge.classList.remove('hidden');
  } else if (streak === 1) {
    streakBadge.textContent = 'Day 1 — keep it going!';
    streakBadge.classList.remove('has-streak', 'hidden');
  } else {
    streakBadge.classList.add('hidden');
  }
}

// ═══════════════════════════
//  WEEKLY CHART
// ═══════════════════════════
function renderWeeklyChart() {
  const chartEl = document.getElementById('weekly-chart');
  if (!chartEl) return;

  const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = new Date();
  const todayStr = toLocalDateString(today);

  // Build last-7-days map: dateStr → totalSeconds
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    days.push({
      dateStr: toLocalDateString(d),
      label: DAY_LABELS[d.getDay()],
      isToday: i === 0,
    });
  }

  const dayTotals = {};
  for (const s of sessions) {
    dayTotals[s.date] = (dayTotals[s.date] || 0) + s.durationSeconds;
  }

  const maxBarSeconds = Math.max(currentGoalSeconds, ...days.map(d => dayTotals[d.dateStr] || 0));

  chartEl.innerHTML = '';
  for (const day of days) {
    const seconds = dayTotals[day.dateStr] || 0;
    const heightPct = maxBarSeconds > 0 ? (seconds / maxBarSeconds) * 100 : 0;
    const isComplete = seconds >= currentGoalSeconds;

    const col = document.createElement('div');
    col.className = 'chart-col';

    const barWrap = document.createElement('div');
    barWrap.className = 'chart-bar-wrap';

    const bar = document.createElement('div');
    bar.className = 'chart-bar' + (isComplete ? ' complete' : '') + (day.isToday ? ' today' : '');
    bar.style.height = heightPct.toFixed(1) + '%';

    const hoursText = seconds >= 3600
      ? `${(seconds / 3600).toFixed(1)}h`
      : seconds > 0 ? `${Math.round(seconds / 60)}m` : '';
    bar.title = `${day.dateStr}: ${hoursText || 'no sessions'}`;

    barWrap.appendChild(bar);

    const label = document.createElement('div');
    label.className = 'chart-label' + (day.isToday ? ' today' : '');
    label.textContent = day.label;

    col.appendChild(barWrap);
    col.appendChild(label);
    chartEl.appendChild(col);
  }
}

// ═══════════════════════════
//  LOG VIEW
// ═══════════════════════════
function renderLogView() {
  // Total hours pill
  const totalSeconds = sessions.reduce((sum, s) => sum + s.durationSeconds, 0);
  const totalH = (totalSeconds / 3600).toFixed(1);
  totalHoursPill.textContent = `${totalH}h total`;

  // Streak pill
  const streak = computeStreak(sessions);
  if (streak > 0) {
    streakPill.textContent = streak > 1 ? `${streak}-day streak` : 'Day 1';
    streakPill.classList.add('streak-active');
    streakPill.classList.remove('hidden');
  } else {
    streakPill.classList.add('hidden');
  }

  // Goal display
  const goalHours = Math.round(currentGoalSeconds / 3600);
  goalInput.value = goalHours;
  goalDisplayValue.textContent = `${goalHours}h`;
  // Ensure display mode on every log view open
  goalDisplayRow.classList.remove('hidden');
  goalEditRow.classList.add('hidden');

  // Weekly chart
  renderWeeklyChart();

  // Table — skip the rebuild if the user is mid-edit, otherwise the input dies.
  const tbody = sessionsTable.querySelector('tbody');
  if (sessionsTable.querySelector('.inline-edit')) return;
  tbody.replaceChildren();

  if (sessions.length === 0) {
    emptyState.classList.remove('hidden');
    sessionsTable.classList.add('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  sessionsTable.classList.remove('hidden');

  const sorted = [...sessions].sort((a, b) => {
    const d = b.date.localeCompare(a.date);
    return d !== 0 ? d : b.startTime.localeCompare(a.startTime);
  });

  for (const s of sorted) {
    const tr = document.createElement('tr');
    tr.dataset.id = s.id;

    const tdDate = document.createElement('td');
    tdDate.textContent = s.date;

    const tdLabel = document.createElement('td');
    const labelSpan = document.createElement('span');
    labelSpan.className = 'editable-cell' + (!s.label ? ' muted-dash' : '');
    labelSpan.title = s.label ? 'Click to edit label' : 'Click to add label';
    labelSpan.textContent = s.label || '—';
    tdLabel.appendChild(labelSpan);

    const tdStart = document.createElement('td');
    tdStart.textContent = s.startTime;

    const tdDur = document.createElement('td');
    tdDur.textContent = formatDuration(s.durationSeconds);

    const tdNotes = document.createElement('td');
    const notesSpan = document.createElement('span');
    notesSpan.className = 'editable-cell' + (!s.notes ? ' muted-dash' : '');
    notesSpan.title = s.notes ? 'Click to edit notes' : 'Click to add notes';
    notesSpan.textContent = s.notes || '—';
    tdNotes.appendChild(notesSpan);

    const tdDel = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className = 'btn-delete';
    delBtn.dataset.id = s.id;
    delBtn.title = 'Delete session';
    delBtn.textContent = '×';
    tdDel.appendChild(delBtn);

    tr.append(tdDate, tdLabel, tdStart, tdDur, tdNotes, tdDel);
    tbody.appendChild(tr);
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ═══════════════════════════
//  INLINE SESSION EDIT
// ═══════════════════════════
function makeEditable(td, sessionId, field) {
  const span = td.querySelector('.editable-cell');
  const isDash = span && span.classList.contains('muted-dash');
  const currentVal = isDash ? '' : (span ? span.textContent : '');

  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentVal;
  input.className = 'inline-edit';
  td.textContent = '';
  td.appendChild(input);
  input.focus();
  input.select();

  let saved = false;
  function detach() {
    // Strip the input class so the renderLogView() guard against in-progress
    // edits doesn't trip on us. We're about to be replaced anyway.
    input.classList.remove('inline-edit');
  }
  async function save() {
    if (saved) return;
    saved = true;
    const newVal = input.value.trim();
    const session = sessions.find(s => s.id === sessionId);
    if (!session) { detach(); renderLogView(); return; }
    const newLabel = field === 'label' ? newVal : session.label;
    const newNotes = field === 'notes' ? newVal : session.notes;
    if (newLabel === session.label && newNotes === session.notes) {
      detach(); renderLogView();
      return;
    }
    try {
      if (window.__TAURI__) {
        await window.__TAURI__.core.invoke('update_session', {
          id: sessionId, label: newLabel, notes: newNotes,
        });
      }
      session.label = newLabel;
      session.notes = newNotes;
      detach(); renderLogView();
    } catch {
      showToast('Could not save edit', 'error');
      detach(); renderLogView();
    }
  }

  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') {
      saved = true; // prevent blur from also saving
      detach(); renderLogView();
    }
  });
}

// Delegated click handler for editable cells in the sessions table
sessionsTable.addEventListener('click', e => {
  const span = e.target.closest('.editable-cell');
  if (!span) return;
  const td = span.parentElement;
  const tr = td.parentElement;
  const sessionId = tr.dataset.id;
  if (!sessionId) return;
  const colIndex = Array.from(tr.children).indexOf(td);
  const field = colIndex === 1 ? 'label' : colIndex === 4 ? 'notes' : null;
  if (field) makeEditable(td, sessionId, field);
});

// ═══════════════════════════
//  CSV EXPORT
// ═══════════════════════════
// Quote every field, escape internal quotes, and prefix any leading =/+/-/@
// with a single quote so Excel/Numbers don't evaluate the cell as a formula
// (CSV injection — a label like "=cmd|'/c calc'!A1" would otherwise execute).
function csvField(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

function exportCSV() {
  if (!sessions.length) {
    showToast('No sessions to export', 'error');
    return;
  }
  const headers = ['Date', 'Start Time', 'End Time', 'Duration (HH:MM:SS)', 'Duration (seconds)', 'Label', 'Notes'];
  const rows = sessions.map(s => [
    csvField(s.date),
    csvField(s.startTime),
    csvField(s.endTime),
    csvField(formatDuration(s.durationSeconds)),
    csvField(s.durationSeconds),
    csvField(s.label || ''),
    csvField(s.notes || ''),
  ]);
  const csv = [headers.map(csvField), ...rows].map(r => r.join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `clauding-hours-${todayString()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('CSV exported', 'success');
}

// ═══════════════════════════
//  TOAST
// ═══════════════════════════
let toastTimeout = null;
function showToast(message, type = '') {
  clearTimeout(toastTimeout);
  toast.textContent = message;
  toast.className = 'visible' + (type ? ' ' + type : '');
  toastTimeout = setTimeout(() => {
    toast.classList.remove('visible');
  }, 2800);
}
function showStickyToast(message, type = '') {
  clearTimeout(toastTimeout);
  toastTimeout = null;
  toast.textContent = message;
  toast.className = 'visible sticky' + (type ? ' ' + type : '');
}
function hideToast() {
  clearTimeout(toastTimeout);
  toastTimeout = null;
  toast.classList.remove('visible', 'sticky', 'success', 'error');
}

// ═══════════════════════════
//  VIEW SWITCHING
// ═══════════════════════════
function showView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(viewId).classList.add('active');
  if (viewId === 'log-view') renderLogView();
}

// ═══════════════════════════
//  KEYBOARD SHORTCUTS
// ═══════════════════════════
document.addEventListener('keydown', e => {
  // Ignore when user is typing in an input
  if (e.target.tagName === 'INPUT') {
    // Allow Escape to blur the input
    if (e.key === 'Escape') e.target.blur();
    return;
  }

  if (e.key === ' ') {
    e.preventDefault();
    if (state === 'IDLE') startSession();
    else if (state === 'RUNNING' || state === 'PAUSED') {
      autoPaused = false;
      pauseSession();
    }
  } else if (e.key === 'e' || e.key === 'E') {
    if (state === 'RUNNING' || state === 'PAUSED') endSession();
  } else if (e.key === 'n' || e.key === 'N') {
    if (state === 'IDLE') {
      showView('timer-view');
      labelInput.focus();
    }
  }
});

// ═══════════════════════════
//  EVENT LISTENERS
// ═══════════════════════════
// Tell Rust not to hide the window on focus loss while the user is editing
// inside an input/textarea — protects in-flight inline edits / goal edits / notes
// from being destroyed by an OS dialog or notification permission prompt.
if (window.__TAURI__) {
  document.addEventListener('focusin', (e) => {
    if (e.target.matches('input, textarea')) {
      window.__TAURI__.core.invoke('set_focus_pin', { pinned: true }).catch(() => {});
    }
  });
  document.addEventListener('focusout', (e) => {
    if (e.target.matches('input, textarea')) {
      window.__TAURI__.core.invoke('set_focus_pin', { pinned: false }).catch(() => {});
    }
  });
}

btnStart.addEventListener('click', startSession);
btnPause.addEventListener('click', () => {
  autoPaused = false;
  pauseSession();
});
btnEnd.addEventListener('click', endSession);
btnLogView.addEventListener('click', () => showView('log-view'));
btnBack.addEventListener('click', () => showView('timer-view'));
btnOverlay.addEventListener('click', () => {
  if (window.__TAURI__) {
    window.__TAURI__.core.invoke('show_overlay').catch(() => {});
  }
});
btnExportCsv.addEventListener('click', exportCSV);

// Delete session (event delegation)
sessionsTable.addEventListener('click', async e => {
  const btn = e.target.closest('.btn-delete');
  if (!btn) return;
  const id = btn.dataset.id;
  try {
    if (window.__TAURI__) {
      await window.__TAURI__.core.invoke('delete_session', { id });
    } else {
      const res = await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
    }
    sessions = sessions.filter(s => s.id !== id);
    renderLogView();
    showToast('Session deleted', '');
  } catch {
    showToast('Error deleting session', 'error');
  }
});

// Goal: edit / cancel / save
btnEditGoal.addEventListener('click', () => {
  goalDisplayRow.classList.add('hidden');
  goalEditRow.classList.remove('hidden');
  goalInput.focus();
  goalInput.select();
});

btnCancelGoal.addEventListener('click', () => {
  goalEditRow.classList.add('hidden');
  goalDisplayRow.classList.remove('hidden');
  goalInput.value = Math.round(currentGoalSeconds / 3600);
});

btnSaveGoal.addEventListener('click', async () => {
  const hours = parseFloat(goalInput.value);
  if (!hours || hours <= 0 || hours > 24) {
    showToast('Enter a valid goal (1–24 hours)', 'error');
    return;
  }
  const dailyGoalSeconds = Math.round(hours * 3600);
  try {
    if (window.__TAURI__) {
      await window.__TAURI__.core.invoke('save_config', { dailyGoalSeconds });
    } else {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dailyGoalSeconds }),
      });
      if (!res.ok) throw new Error();
    }
    currentGoalSeconds = dailyGoalSeconds;
    goalDisplayValue.textContent = `${hours}h`;
    goalEditRow.classList.add('hidden');
    goalDisplayRow.classList.remove('hidden');
    showToast('Goal saved', 'success');
    updateGoalBar();
  } catch {
    showToast('Error saving goal', 'error');
  }
});

// ═══════════════════════════
//  INIT
// ═══════════════════════════
async function init() {
  if (window.__TAURI__) {
    // Drive timer display from the Rust background thread's timer-tick events.
    // This replaces the old JS setInterval approach, which broke when the main
    // window was hidden (WKWebView pauses JS in hidden windows).
    window.__TAURI__.event.listen('timer-tick', (event) => {
      const timeStr = event.payload ?? '00:00:00';
      timerDisplay.textContent = timeStr;
      const parts = timeStr.split(':').map(Number);
      lastElapsedSecs = parts[0] * 3600 + parts[1] * 60 + parts[2];
      updateGoalBar();
      // Persist draft every 10s so a crash during a long session loses ≤10s.
      if (lastElapsedSecs % 10 === 0 && state === 'RUNNING') saveDraftSoon();
    }).catch(() => {});

    // ⌘⌥S global hotkey emitted by Rust → start / pause timer
    window.__TAURI__.event.listen('toggle-timer', () => {
      if (state === 'IDLE') startSession();
      else if (state === 'RUNNING' || state === 'PAUSED') {
        autoPaused = false;
        pauseSession();
      }
    }).catch(() => {});

    // Rust Claude-monitor thread fires these events regardless of window visibility.
    window.__TAURI__.event.listen('auto-paused', (event) => {
      if (state !== 'RUNNING' && state !== 'PAUSED') return;
      autoPaused = true;
      state = 'PAUSED';
      updateButtons();
      timerDisplay.classList.remove('running');
      timerDisplay.classList.add('paused');
      document.body.classList.add('auto-paused');
      const mins = event.payload ?? 5;
      document.title = '⏸ PAUSED — ClaudingHours';
      showStickyToast(`⏸ Auto-paused — Claude inactive ${mins}m. Press Space or ⌘⌥S to resume.`, 'error');
    }).catch(() => {});

    window.__TAURI__.event.listen('claude-active', () => {
      if (state === 'PAUSED' && autoPaused) {
        document.title = '▶ Claude is back — ClaudingHours';
        showStickyToast('▶ Claude is active again — press Space or ⌘⌥S to resume.', 'success');
      }
    }).catch(() => {});
  }
  try {
    if (window.__TAURI__) {
      const [config, data] = await Promise.all([
        window.__TAURI__.core.invoke('get_config'),
        window.__TAURI__.core.invoke('get_sessions'),
      ]);
      currentGoalSeconds = config.dailyGoalSeconds || 14400;
      sessions = data.sessions || [];
    } else {
      const [configRes, sessionsRes] = await Promise.all([
        fetch('/api/config'),
        fetch('/api/sessions'),
      ]);
      const config = await configRes.json();
      const data = await sessionsRes.json();
      currentGoalSeconds = config.dailyGoalSeconds || 14400;
      sessions = data.sessions || [];
    }
  } catch {
    showToast('Could not connect to server', 'error');
  }

  // Restore an in-flight session if the previous run was killed mid-session.
  // Drafts are written debounced as the user types into label/notes; on End/Reset
  // they're cleared. If we find one here, restore the inputs and (if the timer
  // had elapsed time) come back PAUSED so the user can choose Resume or End.
  if (window.__TAURI__) {
    try {
      const draft = await window.__TAURI__.core.invoke('get_draft');
      if (draft && (draft.label || draft.notes || draft.elapsedSecs > 0)) {
        labelInput.value = draft.label || '';
        notesInput.value = draft.notes || '';
        currentLabel = draft.label || '';
        currentNotes = draft.notes || '';
        if (draft.elapsedSecs > 0 && draft.startedAt) {
          sessionStart = new Date(draft.startedAt);
          lastElapsedSecs = draft.elapsedSecs;
          state = 'PAUSED';
          await window.__TAURI__.core.invoke('seed_elapsed', { secs: draft.elapsedSecs });
          // Don't auto-resume the Rust timer — leave it paused; user decides.
          notesInput.classList.remove('hidden');
          timerDisplay.textContent = formatDuration(draft.elapsedSecs);
          showToast('Restored unsaved session — Resume or End it', '');
        }
      }
    } catch {}
  }

  updateButtons();
  updateGoalBar();
  updateStreak();
}

// Debounced draft autosave so quitting / crashing mid-session doesn't lose the
// user's notes, label, or elapsed time. Cleared on End / Reset.
let draftSaveTimer = null;
function saveDraftSoon() {
  if (!window.__TAURI__) return;
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    if (state === 'IDLE' && !labelInput.value && !notesInput.value) {
      window.__TAURI__.core.invoke('clear_draft').catch(() => {});
      return;
    }
    const draft = {
      label: labelInput.value || '',
      notes: notesInput.value || '',
      elapsedSecs: state === 'IDLE' ? 0 : getElapsedSeconds(),
      startedAt: sessionStart ? sessionStart.toISOString() : null,
      state,
    };
    window.__TAURI__.core.invoke('save_draft', { draft }).catch(() => {});
  }, 400);
}
labelInput.addEventListener('input', saveDraftSoon);
notesInput.addEventListener('input', saveDraftSoon);

document.addEventListener('DOMContentLoaded', init);
