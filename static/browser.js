/**
 * Browser panel — toggleable right-side column for previewing sandbox-local
 * apps and any iframe-friendly site. Lives alongside the chat (not as a
 * separate rail "view"), so the user can chat AND browse simultaneously.
 *
 * Public API (used by inline onclick handlers in index.html):
 *   toggleBrowserPanel(force)        — open/close the panel
 *   browserMaximizeToggle()          — toggle full-takeover maximize
 *   browserNavigate(rawUrl)          — load a URL in the active tab
 *   browserReload()                  — reload active tab
 *   browserAddTab()                  — open a new blank tab
 *   browserPopOut()                  — open active tab's URL in a new window
 *   browserOpenInDesktopFirefox()    — copy URL + open noVNC desktop
 *
 * URL rewriting: `3000`, `localhost:3000`, `:3000`, `127.0.0.1:3000` →
 * `https://3000-<sandbox-id>.e2b.app` (E2B's per-port subdomain). Anything
 * else with a dot gets `https://` prepended; pure search terms route through
 * DuckDuckGo. Sites that block iframing (X-Frame-Options/frame-ancestors)
 * will refuse to render — use the Firefox button to handoff to noVNC.
 *
 * Persistence: tabs in `hermes-browser-state-v1`, panel open/closed/width/
 * maximized in `hermes-browser-panel-*`.
 */

(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────────

  const STORAGE_TABS = 'hermes-browser-state-v1';
  const STORAGE_OPEN = 'hermes-browser-panel-open';
  const STORAGE_WIDTH = 'hermes-browser-panel-width';
  const STORAGE_MAX = 'hermes-browser-panel-maximized';

  // The "Computer" tab is always pinned as the first tab. It links to the
  // sandbox's noVNC desktop. URL is computed on the fly from the current
  // hostname so it stays correct even if the user creates a fresh sandbox.
  const PINNED_COMPUTER_ID = 'pinned-computer';

  function getSandboxId() {
    const m = location.host.match(/^(\d+)-([a-z0-9]+)\.e2b\.(app|dev)$/i);
    return m ? m[2] : null;
  }

  function getDesktopUrl() {
    const sid = getSandboxId();
    return sid ? `https://6080-${sid}.e2b.app` : '';
  }

  function newTabId() {
    return 't' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  }

  function ensurePinnedTab(s) {
    // Drop any stale pinned-id tabs (e.g. from format migrations) and
    // prepend a fresh one. We refresh the URL here AND on every render
    // so it tracks the active sandbox.
    s.tabs = (s.tabs || []).filter(t => t.id !== PINNED_COMPUTER_ID);
    s.tabs.unshift({
      id: PINNED_COMPUTER_ID,
      title: 'Computer',
      url: getDesktopUrl(),
      pinned: true,
    });
    return s;
  }

  function loadTabsState() {
    let s = null;
    try {
      const raw = localStorage.getItem(STORAGE_TABS);
      if (raw) s = JSON.parse(raw);
    } catch (e) {}
    if (!s || !Array.isArray(s.tabs)) {
      s = {
        tabs: [{ id: newTabId(), title: 'New tab', url: '' }],
        activeTabId: null,
      };
    }
    return ensurePinnedTab(s);
  }

  function saveTabsState() {
    try { localStorage.setItem(STORAGE_TABS, JSON.stringify(state)); } catch (e) {}
  }

  const state = loadTabsState();
  if (!state.activeTabId && state.tabs.length > 0) {
    // Default to the pinned Computer tab on first ever open.
    state.activeTabId = state.tabs[0].id;
  }

  // ── URL helpers ──────────────────────────────────────────────────────────

  function rewriteUrl(input) {
    const sid = getSandboxId();
    const raw = String(input || '').trim();
    if (!raw) return '';
    if (/^\d{2,5}$/.test(raw) && sid) {
      return `https://${raw}-${sid}.e2b.app`;
    }
    const localRe = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|)\s*:(\d+)(\/.*)?$/i;
    const lm = raw.match(localRe);
    if (lm && sid) {
      const port = lm[1];
      const path = lm[2] || '';
      return `https://${port}-${sid}.e2b.app${path}`;
    }
    if (/^https?:\/\//i.test(raw)) return raw;
    if (/\./.test(raw) && !/\s/.test(raw)) return `https://${raw}`;
    return `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`;
  }

  function getActiveTab() {
    const tab = state.tabs.find(t => t.id === state.activeTabId) || state.tabs[0];
    // Refresh the pinned tab's URL from the current host every read so a
    // sandbox-id change (e.g. after a kill/recreate) still resolves
    // correctly without rewriting localStorage.
    if (tab && tab.pinned && tab.id === PINNED_COMPUTER_ID) {
      tab.url = getDesktopUrl();
    }
    return tab;
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  function renderTabs() {
    const strip = document.getElementById('browserTabs');
    if (!strip) return;
    strip.innerHTML = '';

    state.tabs.forEach(tab => {
      const btn = document.createElement('button');
      btn.className =
        'browser-tab' +
        (tab.id === state.activeTabId ? ' active' : '') +
        (tab.pinned ? ' pinned' : '');
      btn.title = tab.pinned ? 'Pinned · sandbox desktop' : (tab.url || 'New tab');

      if (tab.pinned) {
        // Small monitor icon so the pinned tab is recognizable.
        const icon = document.createElement('span');
        icon.className = 'browser-tab-icon';
        icon.innerHTML =
          '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
        btn.appendChild(icon);
      }

      const title = document.createElement('span');
      title.className = 'browser-tab-title';
      title.textContent = tab.title || 'New tab';
      btn.appendChild(title);

      // Close button: never on the pinned tab; otherwise only when there
      // is at least one other closable tab to fall back to.
      const closableCount = state.tabs.filter(t => !t.pinned).length;
      if (!tab.pinned && closableCount > 1) {
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

    const add = document.createElement('button');
    add.className = 'browser-tab-add';
    add.textContent = '+';
    add.title = 'New tab';
    add.addEventListener('click', addTab);
    strip.appendChild(add);
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
        '<div style="margin-top:8px">Sites that block iframes (Google, GitHub, banks) won\'t load here — use <em>Open in Firefox</em> in the URL bar.</div>';
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
      // Don't let the pinned Computer tab rename itself from the iframe's
      // <title>. Other tabs auto-rename to the page title when same-origin.
      if (tab.pinned) return;
      try {
        const doc = iframe.contentDocument;
        if (doc && doc.title) {
          tab.title = doc.title;
          saveTabsState();
          renderTabs();
        }
      } catch (e) {}
    });
    wrap.appendChild(iframe);
  }

  function renderAll() {
    renderTabs();
    renderUrlBar();
    renderIframe();
  }

  // ── Tab actions ──────────────────────────────────────────────────────────

  function navigate(rawInput) {
    let tab = getActiveTab();
    if (!tab) return;
    // The pinned Computer tab is always pointed at the noVNC desktop.
    // If the user types a URL while on it, spawn a new tab instead of
    // hijacking the pinned one.
    if (tab.pinned) {
      addTab();
      tab = getActiveTab();
      if (!tab) return;
    }
    const url = rewriteUrl(rawInput);
    tab.url = url;
    if (url) {
      try { tab.title = new URL(url).hostname; }
      catch (e) { tab.title = url.slice(0, 24); }
    } else {
      tab.title = 'New tab';
    }
    saveTabsState();
    renderAll();
  }

  function switchTab(id) {
    state.activeTabId = id;
    saveTabsState();
    renderAll();
  }

  function addTab() {
    const id = newTabId();
    state.tabs.push({ id, title: 'New tab', url: '' });
    state.activeTabId = id;
    saveTabsState();
    renderAll();
    setTimeout(() => {
      const input = document.getElementById('browserUrlInput');
      if (input) input.focus();
    }, 50);
  }

  function closeTab(id) {
    const idx = state.tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
    const target = state.tabs[idx];
    if (target.pinned) return; // pinned tabs can't be closed
    state.tabs.splice(idx, 1);
    // Guarantee the pinned tab still exists; add a fresh blank if the user
    // somehow ended up with only the pinned tab and just closed everything.
    if (!state.tabs.some(t => !t.pinned)) {
      state.tabs.push({ id: newTabId(), title: 'New tab', url: '' });
    }
    if (state.activeTabId === id) {
      const newIdx = Math.max(0, Math.min(idx, state.tabs.length - 1));
      state.activeTabId = state.tabs[newIdx].id;
    }
    saveTabsState();
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
      try { navigator.clipboard.writeText(tab.url); } catch (e) {}
    }
    if (sid) window.open(`https://6080-${sid}.e2b.app`, '_blank', 'noopener');
  }

  // ── Panel open / close / maximize ────────────────────────────────────────

  function _panel() {
    return document.getElementById('browserPanel');
  }

  function isOpen() {
    const p = _panel();
    return !!(p && !p.hidden);
  }

  function setOpen(open) {
    const p = _panel();
    if (!p) return;
    p.hidden = !open;
    document.body.classList.toggle('browser-panel-open', !!open);
    if (open) {
      // Apply saved width
      const w = parseInt(localStorage.getItem(STORAGE_WIDTH) || '', 10);
      if (w > 0 && !isMaximized()) p.style.width = w + 'px';
      renderAll();
      // Focus the URL bar so the user can just type to navigate
      setTimeout(() => {
        const input = document.getElementById('browserUrlInput');
        if (input) input.focus();
      }, 50);
    }
    try { localStorage.setItem(STORAGE_OPEN, open ? '1' : '0'); } catch (e) {}
  }

  function toggleBrowserPanel(force) {
    const next = typeof force === 'boolean' ? force : !isOpen();
    if (next && typeof window.toggleTerminalPanel === 'function') {
      // Mutual exclusion: the viewport almost never has room for both
      // a 520px browser panel AND a 560px terminal panel at once. Close
      // the terminal so the user actually sees the panel they just opened.
      window.toggleTerminalPanel(false);
    }
    setOpen(next);
  }

  function isMaximized() {
    return document.body.classList.contains('browser-panel-maximized');
  }

  function setMaximized(max) {
    document.body.classList.toggle('browser-panel-maximized', !!max);
    const btn = document.getElementById('browserMaximizeBtn');
    if (btn) {
      btn.title = max ? 'Restore' : 'Maximize';
      btn.setAttribute('aria-label', max ? 'Restore' : 'Maximize');
      // Swap the SVG between maximize and minimize glyphs
      btn.innerHTML = max
        ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>'
        : '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    }
    try { localStorage.setItem(STORAGE_MAX, max ? '1' : '0'); } catch (e) {}
  }

  function browserMaximizeToggle() {
    if (!isOpen()) setOpen(true);
    setMaximized(!isMaximized());
  }

  // ── Resize (drag the left edge) ──────────────────────────────────────────

  function initResize() {
    const handle = document.getElementById('browserPanelResize');
    const panel = _panel();
    if (!handle || !panel) return;
    let startX = 0;
    let startW = 0;
    let dragging = false;

    function onMove(e) {
      if (!dragging) return;
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      const dx = startX - x;
      const next = Math.min(window.innerWidth * 0.9, Math.max(320, startW + dx));
      panel.style.width = next + 'px';
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

  // ── URL bar input wiring ─────────────────────────────────────────────────

  function initUrlBar() {
    const input = document.getElementById('browserUrlInput');
    if (!input) return;
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        navigate(input.value);
      }
    });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────

  function init() {
    if (!document.getElementById('browserPanel')) return;
    initResize();
    initUrlBar();
    // Restore prior state
    const wasOpen = localStorage.getItem(STORAGE_OPEN) === '1';
    const wasMax = localStorage.getItem(STORAGE_MAX) === '1';
    if (wasOpen) setOpen(true);
    if (wasMax) setMaximized(true);
  }

  window.toggleBrowserPanel = toggleBrowserPanel;
  window.browserMaximizeToggle = browserMaximizeToggle;
  window.browserNavigate = navigate;
  window.browserAddTab = addTab;
  window.browserReload = reloadActiveTab;
  window.browserPopOut = popOutActiveTab;
  window.browserOpenInDesktopFirefox = openInDesktopFirefox;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
