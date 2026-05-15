/**
 * CookieSpy — Options Page Script
 *
 * Manages the abuse.ch URLhaus Auth-Key:
 *   - loads/saves it to chrome.storage.local
 *   - lets the user test it against the live URLhaus API (via the background
 *     service worker, which owns all network calls)
 *
 * The key is the only thing CookieSpy persists to disk. It is user-supplied
 * configuration — never browsing data.
 */

const STORAGE_KEY = 'urlhausAuthKey';

// ─── DOM refs ────────────────────────────────────────────────────────────────

const elInput   = document.getElementById('auth-key');
const elToggle  = document.getElementById('toggle-visibility');
const elSave    = document.getElementById('save-key');
const elTest    = document.getElementById('test-key');
const elClear   = document.getElementById('clear-key');
const elStatus  = document.getElementById('status');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Show a status message in one of: ok | error | working | info. */
function setStatus(text, kind = 'info') {
  elStatus.textContent = text;
  elStatus.className = `status ${kind}`;
}

/** Read the current key from storage and populate the input. */
async function loadKey() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const key = result[STORAGE_KEY] || '';
  elInput.value = key;
  if (key) {
    setStatus('An Auth-Key is saved. URLhaus scoring is enabled.', 'ok');
  } else {
    setStatus('No Auth-Key saved — URLhaus scoring is disabled (DNS checks still run).', 'info');
  }
}

// ─── Actions ─────────────────────────────────────────────────────────────────

/** Persist the key currently in the input. */
async function saveKey() {
  const key = elInput.value.trim();
  await chrome.storage.local.set({ [STORAGE_KEY]: key });
  if (key) {
    setStatus('Saved. URLhaus scoring is now enabled — try the test below.', 'ok');
  } else {
    setStatus('Cleared. URLhaus scoring is disabled (DNS checks still run).', 'info');
  }
}

/** Wipe the key. */
async function clearKey() {
  elInput.value = '';
  await chrome.storage.local.set({ [STORAGE_KEY]: '' });
  setStatus('Cleared. URLhaus scoring is disabled (DNS checks still run).', 'info');
}

/**
 * Ask the background worker to validate the saved key against URLhaus.
 * The background owns the network call so this stays consistent with how
 * scoring lookups are actually performed at runtime.
 */
function testKey() {
  setStatus('Testing against URLhaus…', 'working');
  elTest.disabled = true;

  chrome.runtime.sendMessage({ type: 'selfTest' }, (res) => {
    elTest.disabled = false;

    if (chrome.runtime.lastError || !res) {
      setStatus('Could not reach the background service worker. Try reloading the extension.', 'error');
      return;
    }

    switch (res.result) {
      case 'ok':
        setStatus(`✓ Auth-Key valid — URLhaus responded (${res.detail}).`, 'ok');
        break;
      case 'no-key':
        setStatus('No Auth-Key saved. Paste one above and click Save first.', 'info');
        break;
      case 'unauthorized':
        setStatus('✗ URLhaus rejected the Auth-Key. Double-check you copied it correctly.', 'error');
        break;
      case 'network':
        setStatus('✗ Network error reaching URLhaus. Check your connection and try again.', 'error');
        break;
      default:
        setStatus(`✗ Unexpected response: ${res.detail || res.result}`, 'error');
    }
  });
}

// ─── Wire up ─────────────────────────────────────────────────────────────────

elToggle.addEventListener('click', () => {
  elInput.type = elInput.type === 'password' ? 'text' : 'password';
});

elSave.addEventListener('click', saveKey);
elClear.addEventListener('click', clearKey);
elTest.addEventListener('click', testKey);

// Enter in the input saves.
elInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveKey();
  }
});

loadKey();
