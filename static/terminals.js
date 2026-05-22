/**
 * Right-side multi-terminal panel (fork-only).
 *
 * Reuses upstream's xterm.js setup almost verbatim:
 *  - Same Terminal({...}) options as terminal.js#_ensureXterm
 *  - Same _terminalTheme() function (if exposed; falls back to plain dark theme)
 *  - Same FitAddon + WebLinksAddon usage
 *  - SAME CSS class hierarchy: composer-terminal-viewport > composer-terminal-surface
 *    so upstream's `.xterm` / `.xterm-viewport` / `.xterm-screen` rules apply
 *    and rendering works the way it does in the composer-bottom terminal.
 *
 * Wire-up:
 *  - Each tab owns its own Terminal + PTY (frontend-generated terminal_id).
 *  - PTY managed by /api/terminals/{start,input,resize,close,output} (plural,
 *    chat-session-independent — that backend already exists in api/routes.py).
 *  - Tab list + active id + panel open/maximized/width persisted to localStorage.
 *
 * Public API (used by inline onclick handlers in index.html):
 *   toggleTerminalPanel(force)
 *   terminalMaximizeToggle()
 *   terminalAddTab()
 */

(function () {
  'use strict';

  const STORAGE_TABS = 'hermes-terminals-state-v2';
  const STORAGE_OPEN = 'hermes-terminal-panel-open';
  const STORAGE_WIDTH = 'hermes-terminal-panel-width';
  const STORAGE_MAX = 'hermes-terminal-panel-maximized';

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
      localStorage.setItem(STORAGE_TABS, JSON.stringify({
        activeId: state.activeId,
        tabs: state.tabs.map(t => ({
          terminal_id: t.terminal_id,
          title: t.title,
        })),
      }));
    } catch (e) {}
  }

  const state = loadState();

  function newTerminalId() {
    return 'mt-' + Date.now() + '-' + Math.floor(Math.random() * 1e6).toString(36);
  }

  function _xtermReady() {
    return typeof window.Terminal === 'function';
  }

  function _theme() {
    // Reuse upstream's theme function if available so colors match the
    // composer-bottom terminal exactly and follow theme/skin changes.
    if (typeof window._terminalTheme === 'function') {
      try { return window._terminalTheme(); } catch (e) {}
    }
    return { background: '#0D0D1A', foreground: '#E2E8F0' };
  }

  // ── Tab strip render ─────────────────────────────────────────────────────

  function _activeTab() {
    return state.tabs.find(t => t.terminal_id === state.activeId) || state.tabs[0];
  }

  function renderTabs() {
    const strip = document.getElementById('terminalTabs');
    if (!strip) return;
    strip.innerHTML = '';
    state.tabs.forEach((tab, idx) => {
      const btn = document.createElement('button');
      btn.className = 'browser-tab' + (tab.terminal_id === state.activeId ? ' active' : '');
      btn.title = tab.terminal_id;
      const title = document.createElement('span');
      title.className = 'browser-tab-title';
      title.textContent = tab.title || `T${idx + 1}`;
      btn.appendChild(title);
      const close = document.createElement('span');
      close.className = 'browser-tab-close';
      close.textContent = '\u00d7';
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

  // ── Per-tab DOM container + xterm boot ───────────────────────────────────
  //
  // The DOM structure mirrors index.html's composer terminal exactly:
  //   <div class="terminal-instance">
  //     <div class="composer-terminal-viewport">
  //       <div class="composer-terminal-surface"></div>   <-- term.open(this)
  //     </div>
  //   </div>

  function _ensureInstanceContainer(terminal_id) {
    let host = document.getElementById('term-inst-' + terminal_id);
    if (host) return host;
    host = document.createElement('div');
    host.id = 'term-inst-' + terminal_id;
    host.className = 'terminal-instance';
    const viewport = document.createElement('div');
    viewport.className = 'composer-terminal-viewport';
    const surface = document.createElement('div');
    surface.className = 'composer-terminal-surface';
    viewport.appendChild(surface);
    host.appendChild(viewport);
    document.getElementById('terminalBody').appendChild(host);
    return host;
  }

  function _surfaceFor(host) {
    return host.querySelector('.composer-terminal-surface');
  }

  async function _bootInstance(tab) {
    if (tab.term) return;
    if (!_xtermReady()) {
      setTimeout(() => _bootInstance(tab), 200);
      return;
    }
    const host = _ensureInstanceContainer(tab.terminal_id);
    const surface = _surfaceFor(host);

    // Mark this tab's host as the active one BEFORE term.open so the
    // surface has real layout dimensions when xterm reads them.
    Array.from(document.querySelectorAll('#terminalBody .terminal-instance'))
      .forEach(el => el.classList.toggle('active', el === host));
    // Two animation frames so the browser actually lays it out.
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const term = new window.Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      scrollback: 1000,
      convertEol: false,
      theme: _theme(),
    });
    let fit = null;
    if (window.FitAddon && window.FitAddon.FitAddon) {
      fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
    }
    if (window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon) {
      term.loadAddon(new window.WebLinksAddon.WebLinksAddon());
    }
    term.open(surface);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (fit) { try { fit.fit(); } catch (e) {} }

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
    tab.host = host;

    // Start the backend PTY.
    try {
      await fetch('api/terminals/start', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          terminal_id: tab.terminal_id,
          rows: term.rows || 24,
          cols: term.cols || 80,
        }),
      });
    } catch (e) {
      try { term.write('\r\n\x1b[31m[start failed: ' + (e && e.message) + ']\x1b[0m\r\n'); } catch (_) {}
      return;
    }

    const url = 'api/terminals/output?terminal_id=' + encodeURIComponent(tab.terminal_id);
    const sse = new EventSource(url, { withCredentials: true });
    tab.sse = sse;
    // Backend emits `output` events with {text} (see api/terminal.py
    // _reader_loop), NOT `terminal_data` with {data}. The previous attempts
    // listened for the wrong event name, so the SSE connection was open and
    // streaming but the handler ignored every message — leaving the panel
    // visually empty.
    sse.addEventListener('output', ev => {
      try {
        const payload = JSON.parse(ev.data);
        const text = payload && (payload.text || payload.data);
        if (text) term.write(text);
      } catch (e) {}
    });
    sse.addEventListener('terminal_closed', () => {
      try { term.write('\r\n\x1b[33m[terminal exited]\x1b[0m\r\n'); } catch (e) {}
    });
    sse.addEventListener('terminal_error', ev => {
      let msg = 'terminal error';
      try { msg = (JSON.parse(ev.data) || {}).error || msg; } catch (e) {}
      try { term.write('\r\n\x1b[31m[' + msg + ']\x1b[0m\r\n'); } catch (e) {}
    });

    if (window.ResizeObserver) {
      tab._resizeObserver = new ResizeObserver(() => {
        if (!tab.term || tab.term !== term) return;
        try { fit && fit.fit(); } catch (e) {}
        _resizeRemote(tab);
      });
      tab._resizeObserver.observe(surface);
    }
    term.focus();
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

  function _showActive() {
    const body = document.getElementById('terminalBody');
    if (!body) return;
    Array.from(body.querySelectorAll('.terminal-instance')).forEach(el => {
      el.classList.toggle('active', el.id === 'term-inst-' + state.activeId);
    });
    const tab = _activeTab();
    if (tab && tab.fitAddon) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        try { tab.fitAddon.fit(); } catch (e) {}
        _resizeRemote(tab);
        if (tab.term) try { tab.term.focus(); } catch (e) {}
      }));
    }
  }

  // ── Tab actions ──────────────────────────────────────────────────────────

  async function addTab() {
    if (!_xtermReady()) { setTimeout(addTab, 200); return; }
    const tab = {
      terminal_id: newTerminalId(),
      title: `T${state.tabs.length + 1}`,
    };
    state.tabs.push(tab);
    state.activeId = tab.terminal_id;
    saveState();
    renderTabs();
    _ensureInstanceContainer(tab.terminal_id);
    await _bootInstance(tab);
  }

  function switchTab(terminal_id) {
    state.activeId = terminal_id;
    saveState();
    renderTabs();
    _showActive();
  }

  function closeTab(terminal_id) {
    const idx = state.tabs.findIndex(t => t.terminal_id === terminal_id);
    if (idx < 0) return;
    const tab = state.tabs[idx];
    try { if (tab.sse) tab.sse.close(); } catch (e) {}
    try { if (tab._resizeObserver) tab._resizeObserver.disconnect(); } catch (e) {}
    try { if (tab.term) tab.term.dispose(); } catch (e) {}
    const el = document.getElementById('term-inst-' + terminal_id);
    if (el) el.remove();
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
    _showActive();
  }

  // ── Panel open / close / maximize ────────────────────────────────────────

  function _panel() { return document.getElementById('terminalPanel'); }
  function isOpen() { const p = _panel(); return !!(p && !p.hidden); }
  function isMaximized() {
    return document.body.classList.contains('terminal-panel-maximized');
  }

  // True if we're on a phone-width viewport. Mirrors the @media (max-width:
  // 640px) breakpoint in browser.css so JS and CSS agree on what "mobile"
  // means. matchMedia is cheap and reactive, so we re-query on each call
  // rather than caching (lets orientation changes / split-view resizes
  // affect behaviour correctly without a reload).
  function _isMobileViewport() {
    try {
      return !!(window.matchMedia
        && window.matchMedia('(max-width: 640px)').matches);
    } catch (e) {
      return false;
    }
  }

  async function setOpen(open) {
    const p = _panel();
    if (!p) return;
    p.hidden = !open;
    document.body.classList.toggle('terminal-panel-open', !!open);
    if (open) {
      // On phone-width viewports always open maximized: the panel covers
      // the chat anyway via mobile CSS (inset:0), and the Maximize-button
      // glyph must reflect that or it shows the wrong icon. Call
      // setMaximized() to keep the body class, button glyph, and
      // xterm-fit resize logic in sync via the existing path.
      // setMaximized writes to STORAGE_MAX — fine: when the viewport
      // grows past 640px later (rotate / split-view) the maximize state
      // restores via the same flag, which is the desired behaviour
      // ("I left it maximized last time, keep it maximized now").
      if (_isMobileViewport() && !isMaximized()) {
        setMaximized(true);
      }
      const w = parseInt(localStorage.getItem(STORAGE_WIDTH) || '', 10);
      if (w > 0 && !isMaximized()) p.style.width = w + 'px';
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (state.tabs.length === 0) {
        addTab();
      } else {
        renderTabs();
        for (const t of state.tabs) {
          if (!t.term) await _bootInstance(t);
        }
        _showActive();
      }
    }
    try { localStorage.setItem(STORAGE_OPEN, open ? '1' : '0'); } catch (e) {}
  }

  function toggleTerminalPanel(force) {
    const next = typeof force === 'boolean' ? force : !isOpen();
    if (next && typeof window.toggleBrowserPanel === 'function') {
      // Browser and terminal share the same right-side slot on narrow
      // viewports — mutually exclude so neither is hidden behind the other.
      window.toggleBrowserPanel(false);
    }
    setOpen(next);
  }

  function setMaximized(max) {
    document.body.classList.toggle('terminal-panel-maximized', !!max);
    const btn = document.getElementById('terminalMaximizeBtn');
    if (btn) {
      btn.title = max ? 'Restore' : 'Maximize';
      btn.innerHTML = max
        ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>'
        : '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    }
    try { localStorage.setItem(STORAGE_MAX, max ? '1' : '0'); } catch (e) {}
    setTimeout(() => {
      const tab = _activeTab();
      if (tab && tab.fitAddon) {
        try { tab.fitAddon.fit(); } catch (e) {}
        _resizeRemote(tab);
      }
    }, 60);
  }

  function terminalMaximizeToggle() {
    if (!isOpen()) setOpen(true);
    setMaximized(!isMaximized());
  }

  // ── Drag-resize ──────────────────────────────────────────────────────────

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
      if (t && t.fitAddon) { try { t.fitAddon.fit(); } catch (e) {} }
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
