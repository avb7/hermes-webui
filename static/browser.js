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

  function renderTabs() {
    const strip = document.getElementById('browserTabs');
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

  // Expose for inline onclick handlers in index.html.
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
