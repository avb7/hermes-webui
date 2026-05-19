/**
 * Browser panel — minimal in-app web view for previewing sandbox-local apps.
 *
 * URLs of the form `localhost:N`, `127.0.0.1:N`, or bare `:N` get auto-rewritten
 * to `https://N-<sandbox-id>.e2b.app` (E2B's per-port public URL convention)
 * so apps you run inside the sandbox can be previewed in the panel without
 * an SSH tunnel. Bare domains get `https://` prepended; anything else is
 * routed through DuckDuckGo as a search query.
 *
 * State (tabs + active tab) is persisted in localStorage so reloads survive.
 *
 * Limitations:
 *  - Sites that send `X-Frame-Options: DENY` or strict frame-ancestors CSPs
 *    will refuse to render in the iframe — use the "Open in Firefox" button
 *    which opens the noVNC desktop in a new browser tab so you can paste the
 *    URL into the desktop's Firefox.
 *  - The panel lives in the WebUI sidebar (narrow). Use "Pop out" to open the
 *    current tab's URL in a full browser window.
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'hermes-browser-state-v1';

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* fall through to default */ }
    return {
      tabs: [{ id: newTabId(), title: 'New tab', url: '' }],
      activeTabId: null,
    };
  }

  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  function newTabId() {
    return 't' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  }

  const state = loadState();
  if (!state.activeTabId && state.tabs.length > 0) {
    state.activeTabId = state.tabs[0].id;
  }

  function getSandboxId() {
    // E2B's per-port hostname format: <port>-<sandbox-id>.e2b.{app,dev}
    const m = location.host.match(/^(\d+)-([a-z0-9]+)\.e2b\.(app|dev)$/i);
    return m ? m[2] : null;
  }

  function rewriteUrl(input) {
    const sid = getSandboxId();
    const raw = String(input || '').trim();
    if (!raw) return '';

    // Plain port number → preview that port on the sandbox
    if (/^\d{2,5}$/.test(raw) && sid) {
      return `https://${raw}-${sid}.e2b.app`;
    }

    // localhost:N / 127.0.0.1:N / :N (with optional scheme and path)
    const localRe = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|)\s*:(\d+)(\/.*)?$/i;
    const lm = raw.match(localRe);
    if (lm && sid) {
      const port = lm[1];
      const path = lm[2] || '';
      return `https://${port}-${sid}.e2b.app${path}`;
    }

    // Already has http:// or https://
    if (/^https?:\/\//i.test(raw)) return raw;

    // Looks like a domain (has a dot, no spaces) → assume https
    if (/\./.test(raw) && !/\s/.test(raw)) {
      return `https://${raw}`;
    }

    // Anything else → search
    return `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`;
  }

  function getActiveTab() {
    return state.tabs.find(t => t.id === state.activeTabId) || state.tabs[0];
  }

  function escapeHtml(s) {
    return String(s).replace(/[<>&"']/g, c => ({
      '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  // ---------- render ----------

  function _renderTabsInto(strip, opts = {}) {
    if (!strip) return;
    strip.innerHTML = '';

    state.tabs.forEach(tab => {
      const btn = document.createElement('button');
      btn.className = 'browser-tab' + (tab.id === state.activeTabId ? ' active' : '');
      btn.title = tab.url || 'New tab';

      const title = document.createElement('span');
      title.className = 'browser-tab-title';
      title.textContent = tab.title || 'New tab';
      btn.appendChild(title);

      if (state.tabs.length > 1) {
        const close = document.createElement('span');
        close.className = 'browser-tab-close';
        close.textContent = '×';
        close.title = 'Close tab';
        close.addEventListener('click', e => {
          e.stopPropagation();
          closeTab(tab.id);
        });
        btn.appendChild(close);
      }

      btn.addEventListener('click', () => switchTab(tab.id));
      strip.appendChild(btn);
    });

    if (!opts.skipAddButton) {
      const add = document.createElement('button');
      add.className = 'browser-tab-add';
      add.textContent = '+';
      add.title = 'New tab';
      add.addEventListener('click', addTab);
      strip.appendChild(add);
    }
  }

  function renderTabs() {
    // Main tab strip (top of #mainBrowser, has the + button).
    _renderTabsInto(document.getElementById('browserTabs'));
    // Sidebar list (in #panelBrowser, no + button — use the + in panel-head).
    _renderTabsInto(document.getElementById('browserSidebarTabs'), { skipAddButton: true });
  }

  function renderUrlBar() {
    const input = document.getElementById('browserUrlInput');
    if (!input) return;
    const tab = getActiveTab();
    input.value = tab ? (tab.url || '') : '';
  }

  function renderIframe() {
    const wrap = document.getElementById('browserIframeWrap');
    if (!wrap) return;
    wrap.innerHTML = '';

    const tab = getActiveTab();
    if (!tab || !tab.url) {
      const empty = document.createElement('div');
      empty.className = 'browser-empty';
      empty.innerHTML =
        '<div><strong>Preview anything from your sandbox.</strong></div>' +
        '<div>Type <code>3000</code>, <code>localhost:8000</code>, or any URL.</div>' +
        '<div style="margin-top:8px">Sites that block iframes (Google, GitHub, etc.) won\'t load here — use <em>Open in Firefox</em> below.</div>';
      wrap.appendChild(empty);
      return;
    }

    const iframe = document.createElement('iframe');
    iframe.src = tab.url;
    iframe.referrerPolicy = 'no-referrer';
    iframe.allow =
      'autoplay; clipboard-read; clipboard-write; encrypted-media; ' +
      'picture-in-picture; fullscreen';
    iframe.sandbox =
      'allow-same-origin allow-scripts allow-forms allow-popups ' +
      'allow-popups-to-escape-sandbox allow-downloads allow-modals';
    iframe.addEventListener('load', () => {
      try {
        const doc = iframe.contentDocument;
        if (doc && doc.title) {
          tab.title = doc.title;
          saveState();
          renderTabs();
        }
      } catch (e) { /* cross-origin: leave title as-is */ }
    });
    wrap.appendChild(iframe);
  }

  function renderAll() {
    renderTabs();
    renderUrlBar();
    renderIframe();
  }

  // ---------- actions ----------

  function navigate(rawInput) {
    const tab = getActiveTab();
    if (!tab) return;
    const url = rewriteUrl(rawInput);
    tab.url = url;
    if (url) {
      try {
        tab.title = new URL(url).hostname;
      } catch (e) {
        tab.title = url.slice(0, 24);
      }
    } else {
      tab.title = 'New tab';
    }
    saveState();
    renderAll();
  }

  function switchTab(id) {
    state.activeTabId = id;
    saveState();
    renderAll();
  }

  function addTab() {
    const id = newTabId();
    state.tabs.push({ id, title: 'New tab', url: '' });
    state.activeTabId = id;
    saveState();
    renderAll();
    setTimeout(() => {
      const input = document.getElementById('browserUrlInput');
      if (input) input.focus();
    }, 50);
  }

  function closeTab(id) {
    const idx = state.tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
    state.tabs.splice(idx, 1);
    if (state.tabs.length === 0) {
      state.tabs.push({ id: newTabId(), title: 'New tab', url: '' });
    }
    if (state.activeTabId === id) {
      const newIdx = Math.max(0, Math.min(idx, state.tabs.length - 1));
      state.activeTabId = state.tabs[newIdx].id;
    }
    saveState();
    renderAll();
  }

  function reloadActiveTab() {
    const tab = getActiveTab();
    if (!tab || !tab.url) return;
    renderIframe();
  }

  function popOutActiveTab() {
    const tab = getActiveTab();
    if (tab && tab.url) window.open(tab.url, '_blank', 'noopener');
  }

  function openInDesktopFirefox() {
    const sid = getSandboxId();
    const tab = getActiveTab();
    if (tab && tab.url) {
      // Best-effort: copy the URL so the user can paste it into Firefox.
      try { navigator.clipboard.writeText(tab.url); } catch (e) {}
    }
    if (sid) {
      window.open(`https://6080-${sid}.e2b.app`, '_blank', 'noopener');
    }
  }

  // ---------- wire up ----------

  function init() {
    const panel = document.getElementById('panelBrowser');
    if (!panel) return;
    renderAll();

    const input = document.getElementById('browserUrlInput');
    if (input) {
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          navigate(input.value);
        }
      });
    }
  }

  // ---- Terminal (right aside) -------------------------------------------
  // Uses the existing /api/terminal/* endpoints (start, input, resize,
  // close + SSE output stream). Each chat session has at most one terminal;
  // multi-terminal would require a `terminal_id` param in the backend.

  const TERMINAL = {
    term: null,
    fitAddon: null,
    sessionId: null,
    sse: null,
    resizeObserver: null,
  };

  function _ttySid() {
    return (
      (window.S && window.S.session && window.S.session.session_id) || null
    );
  }

  function _ttyEls() {
    return {
      container: document.getElementById('browserTerminalContainer'),
      empty: document.getElementById('browserTerminalEmpty'),
      xterm: document.getElementById('browserTerminalXterm'),
      status: document.getElementById('browserTerminalStatus'),
    };
  }

  function _xtermReady() {
    return typeof window.Terminal === 'function';
  }

  function _ensureTerm() {
    const { xterm } = _ttyEls();
    if (TERMINAL.term || !xterm || !_xtermReady()) return TERMINAL.term;
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
    if (window.WebLinksAddon) {
      term.loadAddon(new window.WebLinksAddon.WebLinksAddon());
    }
    term.open(xterm);
    if (fit) {
      try { fit.fit(); } catch (e) {}
    }
    term.onData(data => {
      if (!TERMINAL.sessionId) return;
      fetch('api/terminal/input', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: TERMINAL.sessionId, data }),
      }).catch(() => {});
    });
    TERMINAL.term = term;
    TERMINAL.fitAddon = fit;
    if (window.ResizeObserver && !TERMINAL.resizeObserver) {
      TERMINAL.resizeObserver = new ResizeObserver(() => {
        try { fit && fit.fit(); } catch (e) {}
        _resizeRemote();
      });
      TERMINAL.resizeObserver.observe(xterm);
    }
    return term;
  }

  async function _resizeRemote() {
    if (!TERMINAL.term || !TERMINAL.sessionId) return;
    const { rows, cols } = TERMINAL.term;
    try {
      await fetch('api/terminal/resize', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: TERMINAL.sessionId, rows, cols }),
      });
    } catch (e) {}
  }

  function _setStatus(s) {
    const { status } = _ttyEls();
    if (status) status.textContent = s || '';
  }

  function _disconnectSse() {
    if (TERMINAL.sse) {
      try { TERMINAL.sse.close(); } catch (e) {}
      TERMINAL.sse = null;
    }
  }

  function _connectSse(sid) {
    _disconnectSse();
    const url = 'api/terminal/output?session_id=' + encodeURIComponent(sid);
    const source = new EventSource(url, { withCredentials: true });
    TERMINAL.sse = source;
    source.addEventListener('terminal_data', ev => {
      try {
        const payload = JSON.parse(ev.data);
        if (payload.data && TERMINAL.term) TERMINAL.term.write(payload.data);
      } catch (e) {}
    });
    source.addEventListener('terminal_exit', () => {
      _setStatus('terminal exited');
    });
    source.addEventListener('terminal_error', ev => {
      let msg = 'terminal error';
      try { msg = (JSON.parse(ev.data) || {}).error || msg; } catch (e) {}
      _setStatus(msg);
    });
    source.onerror = () => _setStatus('disconnected — will reconnect');
    source.onopen = () => _setStatus('connected to session ' + sid.slice(0, 8));
  }

  async function initBrowserTerminal(opts = {}) {
    const { empty, xterm } = _ttyEls();
    const sid = _ttySid();
    if (!sid) {
      if (empty) empty.style.display = 'flex';
      if (xterm) xterm.classList.remove('active');
      _disconnectSse();
      TERMINAL.sessionId = null;
      _setStatus('');
      return;
    }
    if (empty) empty.style.display = 'none';
    if (xterm) xterm.classList.add('active');

    if (!_xtermReady()) {
      _setStatus('xterm.js still loading...');
      setTimeout(() => initBrowserTerminal(opts), 250);
      return;
    }

    const term = _ensureTerm();
    if (!term) return;

    // Re-attach if session changed
    const restart = opts.restart || TERMINAL.sessionId !== sid;
    if (restart) {
      TERMINAL.sessionId = sid;
      try {
        await fetch('api/terminal/start', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: sid,
            rows: term.rows,
            cols: term.cols,
            restart: !!opts.restart,
          }),
        });
      } catch (e) {
        _setStatus('start failed: ' + e.message);
        return;
      }
      _connectSse(sid);
      if (TERMINAL.fitAddon) {
        try { TERMINAL.fitAddon.fit(); } catch (e) {}
      }
      _resizeRemote();
    }
  }

  function browserTerminalRestart() {
    initBrowserTerminal({ restart: true });
  }

  // ---- Wire panel-switch hook -------------------------------------------
  // Only initialize sessions + terminal when the Browser panel actually
  // becomes active, and tear down terminal SSE when the user leaves.

  const _origSwitchPanel = window.switchPanel;
  if (typeof _origSwitchPanel === 'function') {
    window.switchPanel = async function (name, opts) {
      const result = await _origSwitchPanel(name, opts);
      document.body.classList.toggle('on-browser-view', name === 'browser');
      if (name === 'browser') {
        // Force the sidebar panel-view to be the chat session list so the
        // user can switch sessions even though the rail-button stays on
        // Browser. The original switchPanel only activates the matching
        // panel-view; we hide #panelBrowser via CSS and promote #panelChat
        // to active here.
        const panels = document.querySelectorAll('.panel-view');
        panels.forEach(p => p.classList.remove('active'));
        const chatPanel = document.getElementById('panelChat');
        if (chatPanel) chatPanel.classList.add('active');
        initBrowserTerminal();
      }
      return result;
    };
  }

  // Re-bind the terminal whenever the active chat session changes, so
  // clicking a session in the sidebar (which calls loadSession) makes the
  // terminal pane attach to the right PTY.
  const _origLoadSession = window.loadSession;
  if (typeof _origLoadSession === 'function') {
    window.loadSession = async function (sid) {
      const result = await _origLoadSession(sid);
      if (document.body.classList.contains('on-browser-view')) {
        setTimeout(() => initBrowserTerminal(), 100);
      }
      return result;
    };
  }

  // ---- Expose globals + init --------------------------------------------

  window.browserNavigate = navigate;
  window.browserAddTab = addTab;
  window.browserReload = reloadActiveTab;
  window.browserPopOut = popOutActiveTab;
  window.browserOpenInDesktopFirefox = openInDesktopFirefox;
  window.browserTerminalRestart = browserTerminalRestart;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
