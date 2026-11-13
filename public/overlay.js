// ═══════════════════════════════════════════════════
//  ClaudingHours — Overlay window
// ═══════════════════════════════════════════════════

const timerEl       = document.getElementById('timer');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnClose      = document.getElementById('btn-close');

let isFullscreen = false;

// ── Tauri helpers ──────────────────────────────────
const invoke = window.__TAURI__?.core?.invoke ?? (() => Promise.resolve());
const listen = window.__TAURI__?.event?.listen ?? (() => Promise.resolve());

// ── Drag ───────────────────────────────────────────
// pointerdown on the stage (not on buttons) triggers native window drag.
document.addEventListener('pointerdown', (e) => {
  if (isFullscreen) return;
  if (e.button !== 0) return;
  if (e.target.closest('button, a, input, select')) return;
  invoke('plugin:window|start_dragging').catch(() => {});
});

// ── Sync timer from Rust event ─────────────────────
listen('timer-tick', (event) => {
  const title = event.payload ?? '00:00:00';
  timerEl.textContent = title;
  timerEl.classList.toggle('paused', title === '00:00:00');
});

// ── Fullscreen ─────────────────────────────────────
async function setFullscreen(enabled) {
  isFullscreen = enabled;
  document.body.classList.toggle('is-fullscreen', enabled);
  try {
    await invoke('set_overlay_fullscreen', { fullscreen: enabled });
    if (!enabled) {
      setTimeout(() => invoke('reset_overlay_size').catch(() => {}), 380);
    }
  } catch (e) {
    console.warn('set_overlay_fullscreen failed:', e);
  }
  btnFullscreen.innerHTML = enabled ? '&#x229F; Exit Fullscreen' : '&#x26F6; Fullscreen';
  btnFullscreen.classList.toggle('active', enabled);
}

btnFullscreen.addEventListener('click', () => setFullscreen(!isFullscreen));

// ── Close ──────────────────────────────────────────
async function closeOverlay() {
  if (isFullscreen) await setFullscreen(false);
  await invoke('hide_overlay');
}

btnClose.addEventListener('click', closeOverlay);

// ── ESC: exit fullscreen first, then close ─────────
document.addEventListener('keydown', async (e) => {
  if (e.key !== 'Escape') return;
  if (isFullscreen) {
    await setFullscreen(false);
  } else {
    await closeOverlay();
  }
});
