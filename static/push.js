/**
 * Web Push subscribe / unsubscribe flow (fork-only).
 *
 * Exposes a small floating "Enable notifications" pill in the bottom-right
 * corner the first time the user visits in a browser/PWA that supports push
 * AND hasn't yet decided permission. Once the user grants permission the
 * pill disappears; once they subscribe the subscription is POSTed to the
 * backend (api/push/subscribe). A separate "Test notification" button is
 * available from the same pill once subscribed, useful for verifying the
 * end-to-end delivery path on a new device.
 *
 * iOS specifics: Safari only honours Web Push for PWAs installed via Add to
 * Home Screen, on iOS >= 16.4. We surface a clear message in that case.
 */

(function () {
  'use strict';

  const STORAGE_ASK_DISMISSED = 'hermes-push-ask-dismissed';
  const STORAGE_LAST_ENDPOINT = 'hermes-push-last-endpoint';

  // ── Capability checks ───────────────────────────────────────────────────

  function pushSupported() {
    return (
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      typeof Notification !== 'undefined' &&
      typeof window.fetch === 'function'
    );
  }

  function isIos() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent || '');
  }

  function isStandalonePwa() {
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    if (typeof window.navigator.standalone === 'boolean') return window.navigator.standalone;
    return false;
  }

  // ── b64url helpers (VAPID public key arrives as URL-safe base64) ───────

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  // ── Backend calls ──────────────────────────────────────────────────────

  async function fetchPublicKey() {
    const r = await fetch('api/push/public-key', { credentials: 'same-origin' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.public_key) {
      throw new Error(data.error || ('HTTP ' + r.status));
    }
    return data.public_key;
  }

  async function postSubscription(sub) {
    const r = await fetch('api/push/subscribe', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: {
          endpoint: sub.endpoint,
          keys: sub.toJSON ? sub.toJSON().keys : sub.keys,
        },
      }),
    });
    if (!r.ok) throw new Error('subscribe HTTP ' + r.status);
    return r.json().catch(() => ({}));
  }

  async function postUnsubscribe(endpoint) {
    const r = await fetch('api/push/unsubscribe', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
    return r.ok;
  }

  async function postTest() {
    const r = await fetch('api/push/test', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    return r.json().catch(() => ({}));
  }

  // ── Subscribe / unsubscribe ────────────────────────────────────────────

  async function ensureSubscribed() {
    if (!pushSupported()) throw new Error('Push not supported on this browser.');
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      try { localStorage.setItem(STORAGE_LAST_ENDPOINT, existing.endpoint); } catch (e) {}
      // Re-post to backend in case server was wiped or this is a fresh device.
      try { await postSubscription(existing); } catch (e) {}
      return existing;
    }
    const publicKey = await fetchPublicKey();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    try { localStorage.setItem(STORAGE_LAST_ENDPOINT, sub.endpoint); } catch (e) {}
    await postSubscription(sub);
    return sub;
  }

  async function unsubscribe() {
    if (!pushSupported()) return false;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return false;
    const endpoint = sub.endpoint;
    try { await sub.unsubscribe(); } catch (e) {}
    try { await postUnsubscribe(endpoint); } catch (e) {}
    try { localStorage.removeItem(STORAGE_LAST_ENDPOINT); } catch (e) {}
    return true;
  }

  // ── Floating pill UI ───────────────────────────────────────────────────

  function injectPill() {
    if (document.getElementById('hermesPushPill')) return;
    const pill = document.createElement('div');
    pill.id = 'hermesPushPill';
    pill.className = 'hermes-push-pill';
    pill.innerHTML = `
      <div class="hermes-push-pill-body">
        <span class="hermes-push-pill-title">Notify me when agents finish</span>
        <span class="hermes-push-pill-sub" id="hermesPushPillSub">Get a native notification even with the tab closed.</span>
      </div>
      <div class="hermes-push-pill-actions">
        <button class="hermes-push-pill-btn" id="hermesPushPillEnable">Enable</button>
        <button class="hermes-push-pill-btn hermes-push-pill-btn--ghost" id="hermesPushPillDismiss">Later</button>
      </div>
    `;
    document.body.appendChild(pill);

    document.getElementById('hermesPushPillDismiss').addEventListener('click', () => {
      try { localStorage.setItem(STORAGE_ASK_DISMISSED, '1'); } catch (e) {}
      pill.remove();
    });
    document.getElementById('hermesPushPillEnable').addEventListener('click', async () => {
      const sub = document.getElementById('hermesPushPillSub');
      sub.textContent = 'Requesting permission…';
      try {
        if (isIos() && !isStandalonePwa()) {
          sub.textContent =
            'iOS Safari only supports push when this site is added to your Home Screen. ' +
            'Tap Share → Add to Home Screen, then re-open from the icon.';
          return;
        }
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') {
          sub.textContent = perm === 'denied'
            ? 'Permission denied. Enable in browser/site settings, then refresh.'
            : 'Permission not granted.';
          return;
        }
        sub.textContent = 'Subscribing…';
        await ensureSubscribed();
        sub.textContent = 'Subscribed. You can close this and check on your device.';
        // Send a test push so the user sees one immediately.
        try { await postTest(); } catch (e) {}
        setTimeout(() => pill.remove(), 4000);
      } catch (e) {
        sub.textContent = 'Failed: ' + (e && e.message || e);
      }
    });
  }

  function shouldShowPill() {
    if (!pushSupported()) return false;
    try { if (localStorage.getItem(STORAGE_ASK_DISMISSED) === '1') return false; } catch (e) {}
    if (typeof Notification === 'undefined') return false;
    if (Notification.permission === 'granted') return false;
    if (Notification.permission === 'denied') return false;
    return true;
  }

  // ── Status reconciliation ──────────────────────────────────────────────
  // If permission is granted but the subscription got lost (server wiped,
  // browser cleared service worker, etc.), silently re-subscribe so the
  // user doesn't have to click again.

  async function reconcile() {
    if (!pushSupported()) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        try { await postSubscription(sub); } catch (e) {}
      } else {
        await ensureSubscribed();
      }
    } catch (e) { /* silent */ }
  }

  // ── Public globals for console use / future Settings wiring ────────────

  window.hermesPushEnable = async () => {
    if (typeof Notification === 'undefined') return { ok: false, error: 'no Notification API' };
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return { ok: false, error: perm };
    try {
      const sub = await ensureSubscribed();
      return { ok: true, endpoint: sub.endpoint };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  };
  window.hermesPushDisable = async () => ({ ok: await unsubscribe() });
  window.hermesPushTest = async () => {
    try { return await postTest(); }
    catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  };

  // ── Init ───────────────────────────────────────────────────────────────

  function init() {
    if (!pushSupported()) return;
    // Defer pill so initial paint isn't competing with our DOM.
    setTimeout(() => {
      reconcile().catch(() => {});
      if (shouldShowPill()) injectPill();
    }, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
