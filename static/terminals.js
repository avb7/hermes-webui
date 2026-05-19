/**
 * Terminal panel — Cursor/VSCode-style multi-tab terminal dock.
 *
 * Each tab is a real xterm.js Terminal bound to a unique `terminal_id` on
 * the backend. The backend speaks /api/terminals/* (plural) which is the
 * fork-only multi-terminal API — it reuses the existing PTY machinery but
 * keys terminals by a frontend-generated id instead of chat session_id, so
 * you can run as many simultaneous terminals as you like.
 *
 * Public API (used by inline onclick handlers in index.html):
 *   toggleTerminalPanel(force)   — open / close
 *   terminalMaximizeToggle()     — full takeover toggle
 *   terminalAddTab()             — open a new terminal in a new tab
 *
 * State (terminal_id list + active tab + open/maximized/width) is
 * persisted to localStorage so reloads keep the same set.
 */

(function () {
  'use strict';

  const STORAGE_TABS = 'hermes-terminals-state-v1';
  const STORAGE_OPEN = 'hermes-terminal-panel-open';
  const STORAGE_WIDTH = 'hermes-terminal-panel-width';
  const STORAGE_MAX = 'hermes-terminal-panel-maximized';

  // tabs: [{ terminal_id, title, term?, fitAddon?, sse? }, ...]
  // (term + fitAddon + sse are runtime-only, never persisted)
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_TABS);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          tabs: (parsed.tabs || []).map(t => ({
            terminal_id: t.terminal_id,
            title: t.title || 'Terminal',
          })),
          activeId: parsed.activeId || null,
        };
      }
    } catch (e) {}
    return { tabs: [], activeId: null };
  }

  function saveState() {
    try {
      const serializable = {
        activeId: state.activeId,
        tabs: state.tabs.map(t => ({
          terminal_id: t.terminal_id,
          title: t.title,
        })),
      };
      localStorage.setItem(STORAGE_TABS, JSON.stringify(serializable));
    } catch (e) {}
  }

  const state = loadState();

  // ── helpers ──────────────────────────────────────────────────────────────

  function newTerminalId() {
    return 'mt-' + Date.now() + '-' + Math.floor(Math.random() * 100000).toString(36);
  }

  function _panel() {
    return document.getElementById('terminalPanel');
  }

  function _body() {
    return document.getElementById('terminalBody');
  }

  function _xtermReady() {
    return typeof window.Terminal === 'function';
  }

  function _setStatus(s) {
    const el = document.getElementById('terminalStatus');
    if (el) el.textContent = s || '';
  }

  function _activeTab() {
    return state.tabs.find(t => t.terminal_id === state.activeId) || state.tabs[0];
  }

  // ── tab strip render ─────────────────────────────────────────────────────

  function renderTabs() {
    const strip = document.getElementById('terminalTabs');
    if (!strip) return;
    strip.innerHTML = '';
    state.tabs.forEach((tab, idx) => {
      const btn = document.createElement('button');
      btn.className =
        'browser-tab' + (tab.terminal_id === state.activeId ? ' active' : '');
      btn.title = tab.terminal_id;
      const title = document.createElement('span');
      title.className = 'browser-tab-title';
      title.textContent = tab.title || `Terminal ${idx + 1}`;
      btn.appendChild(title);
      const close = document.createElement('span');
      close.className = 'browser-tab-close';
      close.textContent = '×';
      close.title = 'Close terminal';
      close.addEventListener('click', e => {
        e.stopPropagation();
        closeTab(tab.terminal_id);
      });
      btn.appendChild(close);
      btn.addEventListener('click', () => switchTab(tab.terminal_id));
      strip.appendChild(btn);
    });
  }

  // ── terminal instance render ────────────────────────────────────────────

  function _ensureInstanceContainer(terminal_id) {
    let el = document.getElementById('term-inst-' + terminal_id);
    if (el) return el;
    el = document.createElement('div');
    el.className = 'terminal-instance';
    el.id = 'term-inst-' + terminal_id;
    _body().appendChild(el);
    return el;
  }

  async function _bootInstance(tab) {
    if (tab.term) return;
    const container = _ensureInstanceContainer(tab.terminal_id);

    const term = new window.Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: { background: '#0a0a0e', foreground: '#e6e6f0' },
      scrollback: 5000,
      convertEol: true,
    });
    const fit = window.FitAddon ? new window.FitAddon.FitAddon() : null;
    if (fit) term.loadAddon(fit);
    if (window.WebLinksAddon) term.loadAddon(new window.WebLinksAddon.WebLinksAddon());
    term.open(container);
    if (fit) {
      try { fit.fit(); } catch (e) {}
    }

    term.onData(data => {
      fetch('api/terminals/input', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terminal_id: tab.terminal_id, data }),
      }).catch(() => {});
    });

    tab.term = term;
    tab.fitAddon = fit;

    // Start backend PTY
    try {
      await fetch('api/terminals/start', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          terminal_id: tab.terminal_id,
          rows: term.rows,
          cols: term.cols,
        }),
      });
    } catch (e) {
      _setStatus('start failed: ' + e.message);
      return;
    }

    // Subscribe to output SSE
    const url = 'api/terminals/output?terminal_id=' + encodeURIComponent(tab.terminal_id);
    const sse = new EventSource(url, { withCredentials: true });
    tab.sse = sse;
    sse.addEventListener('terminal_data', ev => {
      try {
        const payload = JSON.parse(ev.data);
        if (payload.data) term.write(payload.data);
      } catch (e) {}
    });
    sse.addEventListener('terminal_closed', () => {
      _setStatus('terminal exited');
    });
    sse.onopen = () => _setStatus('terminal ' + tab.terminal_id.slice(-6));
    sse.onerror = () => _setStatus('reconnecting…');

    // Resize on container changes
    if (window.ResizeObserver) {
      tab._resizeObserver = new ResizeObserver(() => {
        if (!tab.term || tab.term !== term) return;
        try { fit && fit.fit(); } catch (e) {}
        _resizeRemote(tab);
      });
      tab._resizeObserver.observe(container);
    }
  }

  async function _resizeRemote(tab) {
    if (!tab.term) return;
    const { rows, cols } = tab.term;
    try {
      await fetch('api/terminals/resize', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terminal_id: tab.terminal_id, rows, cols }),
      });
    } catch (e) {}
  }

  function _showActiveInstance() {
    const body = _body();
    if (!body) return;
    Array.from(body.querySelectorAll('.terminal-instance')).forEach(el => {
      el.classList.toggle('active', el.id === 'term-inst-' + state.activeId);
    });
    const tab = _activeTab();
    if (tab && tab.fitAddon) {
      setTimeout(() => {
        try { tab.fitAddon.fit(); } catch (e) {}
        _resizeRemote(tab);
      }, 50);
    }
  }

  function renderAll() {
    renderTabs();
    _showActiveInstance();
  }

  // ── tab actions ──────────────────────────────────────────────────────────

  async function addTab() {
    if (!_xtermReady()) {
      setTimeout(addTab, 200);
      return;
    }
    const tab = {
      terminal_id: newTerminalId(),
      title: `T${state.tabs.length + 1}`,
    };
    state.tabs.push(tab);
    state.activeId = tab.terminal_id;
    saveState();
    renderTabs();
    await _bootInstance(tab);
    _showActiveInstance();
    if (tab.term) tab.term.focus();
  }

  function switchTab(terminal_id) {
    state.activeId = terminal_id;
    saveState();
    renderTabs();
    _showActiveInstance();
    const tab = _activeTab();
    if (tab && tab.term) tab.term.focus();
  }

  async function closeTab(terminal_id) {
    const idx = state.tabs.findIndex(t => t.terminal_id === terminal_id);
    if (idx < 0) return;
    const tab = state.tabs[idx];
    // Tear down runtime resources
    try { if (tab.sse) tab.sse.close(); } catch (e) {}
    try { if (tab._resizeObserver) tab._resizeObserver.disconnect(); } catch (e) {}
    try { if (tab.term) tab.term.dispose(); } catch (e) {}
    const el = document.getElementById('term-inst-' + terminal_id);
    if (el) el.remove();
    // Tell backend to kill the PTY
    fetch('api/terminals/close', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal_id }),
    }).catch(() => {});
    state.tabs.splice(idx, 1);
    if (state.activeId === terminal_id) {
      const next = state.tabs[Math.max(0, idx - 1)] || null;
      state.activeId = next ? next.terminal_id : null;
    }
    saveState();
    renderTabs();
    _showActiveInstance();
  }

  // ── panel open / close / maximize ────────────────────────────────────────

  function isOpen() {
    const p = _panel();
    return !!(p && !p.hidden);
  }

  function setOpen(open) {
    const p = _panel();
    if (!p) return;
    p.hidden = !open;
    document.body.classList.toggle('terminal-panel-open', !!open);
    if (open) {
      const w = parseInt(localStorage.getItem(STORAGE_WIDTH) || '', 10);
      if (w > 0 && !isMaximized()) p.style.width = w + 'px';
      // Boot any terminals from the persisted tab list that don't have a
      // runtime term instance yet — lazy-create on first open.
      state.tabs.forEach(t => { if (!t.term) _bootInstance(t); });
      if (state.tabs.length === 0) {
        // First open ever: spawn one terminal to get the user going.
        addTab();
      } else {
        renderAll();
      }
    }
    try { localStorage.setItem(STORAGE_OPEN, open ? '1' : '0'); } catch (e) {}
  }

  function toggleTerminalPanel(force) {
    const next = typeof force === 'boolean' ? force : !isOpen();
    setOpen(next);
  }

  function isMaximized() {
    return document.body.classList.contains('terminal-panel-maximized');
  }

  function setMaximized(max) {
    document.body.classList.toggle('terminal-panel-maximized', !!max);
    const btn = document.getElementById('terminalMaximizeBtn');
    if (btn) {
      btn.title = max ? 'Restore' : 'Maximize';
      btn.setAttribute('aria-label', max ? 'Restore' : 'Maximize');
      btn.innerHTML = max
        ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>'
        : '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    }
    try { localStorage.setItem(STORAGE_MAX, max ? '1' : '0'); } catch (e) {}
    // Resize the active terminal after the layout change
    setTimeout(() => {
      const t = _activeTab();
      if (t && t.fitAddon) {
        try { t.fitAddon.fit(); } catch (e) {}
        _resizeRemote(t);
      }
    }, 80);
  }

  function terminalMaximizeToggle() {
    if (!isOpen()) setOpen(true);
    setMaximized(!isMaximized());
  }

  // ── resize handle ────────────────────────────────────────────────────────

  function initResize() {
    const handle = document.getElementById('terminalPanelResize');
    const panel = _panel();
    if (!handle || !panel) return;
    let startX = 0, startW = 0, dragging = false;
    function onMove(e) {
      if (!dragging) return;
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      const dx = startX - x;
      const next = Math.min(window.innerWidth * 0.9, Math.max(360, startW + dx));
      panel.style.width = next + 'px';
      const t = _activeTab();
      if (t && t.fitAddon) {
        try { t.fitAddon.fit(); } catch (e) {}
      }
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchend', onUp);
      try { localStorage.setItem(STORAGE_WIDTH, String(panel.offsetWidth)); } catch (e) {}
      const t = _activeTab();
      if (t) _resizeRemote(t);
    }
    function onDown(e) {
      if (isMaximized()) return;
      dragging = true;
      startX = e.touches ? e.touches[0].clientX : e.clientX;
      startW = panel.offsetWidth;
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('mouseup', onUp);
      document.addEventListener('touchend', onUp);
      e.preventDefault();
    }
    handle.addEventListener('mousedown', onDown);
    handle.addEventListener('touchstart', onDown, { passive: false });
  }

  // ── boot ─────────────────────────────────────────────────────────────────

  function init() {
    if (!document.getElementById('terminalPanel')) return;
    initResize();
    const wasOpen = localStorage.getItem(STORAGE_OPEN) === '1';
    const wasMax = localStorage.getItem(STORAGE_MAX) === '1';
    if (wasOpen) setOpen(true);
    if (wasMax) setMaximized(true);
  }

  window.toggleTerminalPanel = toggleTerminalPanel;
  window.terminalMaximizeToggle = terminalMaximizeToggle;
  window.terminalAddTab = addTab;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
