/**
 * Options page script.
 * Handles saving/loading settings and the test-connection flow.
 */

const STORAGE_KEYS = {
  BAMBUDDY_URL:     'bambuddyUrl',
  API_KEY:          'apiKey',
  AUTO_CLOSE:       'autoClose',
  AUTO_CLOSE_DELAY: 'autoCloseDelay',
  SHOW_OPEN_BTN:    'showOpenBtn'
};

// ─── DOM ─────────────────────────────────────────────────────────────────────

const urlInput       = document.getElementById('bambuddy-url');
const keyInput       = document.getElementById('api-key');
const btnSave        = document.getElementById('btn-save');
const btnTest        = document.getElementById('btn-test');
const btnToggle      = document.getElementById('btn-toggle-key');
const statusEl       = document.getElementById('conn-status');
const versionEl      = document.getElementById('version-tag');
const autoCloseChk   = document.getElementById('auto-close');
const autoCloseDelay = document.getElementById('auto-close-delay');
const delayRow       = document.getElementById('delay-row');
const showOpenBtnChk = document.getElementById('show-open-btn');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setStatus(type, html) {
  const iconMap = {
    success: '<polyline points="20 6 9 17 4 12"/>',
    error:   '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
    info:    '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'
  };
  statusEl.className = `status-bar ${type}`;
  statusEl.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round">${iconMap[type] ?? ''}</svg>
    <span>${html}</span>
  `;
  statusEl.style.display = 'flex';
}

function clearStatus() { statusEl.style.display = 'none'; }

function sendToBackground(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response.success) {
        reject(new Error(response.error ?? 'Неизвестная ошибка'));
        return;
      }
      resolve(response.data);
    });
  });
}

// ─── Load saved settings ──────────────────────────────────────────────────────

async function loadSettings() {
  const stored = await new Promise(res =>
    chrome.storage.local.get(Object.values(STORAGE_KEYS), res)
  );
  urlInput.value       = stored[STORAGE_KEYS.BAMBUDDY_URL]     ?? '';
  keyInput.value       = stored[STORAGE_KEYS.API_KEY]          ?? '';
  autoCloseChk.checked = stored[STORAGE_KEYS.AUTO_CLOSE]       ?? false;
  autoCloseDelay.value = stored[STORAGE_KEYS.AUTO_CLOSE_DELAY] ?? 3;
  showOpenBtnChk.checked = stored[STORAGE_KEYS.SHOW_OPEN_BTN]  ?? true;
  delayRow.style.display = autoCloseChk.checked ? '' : 'none';
}

// ─── Save ─────────────────────────────────────────────────────────────────────

async function save() {
  clearStatus();
  const url   = urlInput.value.trim().replace(/\/+$/, '');
  const key   = keyInput.value.trim();
  const delay = Math.min(30, Math.max(1, parseInt(autoCloseDelay.value, 10) || 3));

  if (!url) {
    setStatus('error', 'Укажите адрес Bambuddy.');
    urlInput.focus();
    return;
  }

  let parsedUrl;
  try { parsedUrl = new URL(url); }
  catch {
    setStatus('error', 'Введите корректный адрес, например <code>http://192.168.1.100:8000</code>.');
    urlInput.focus();
    return;
  }

  // Request host permission for this specific Bambuddy origin.
  // This replaces the old broad <all_urls> host permission — the browser will
  // prompt once and remember the choice. Without this, background fetch calls
  // to the Bambuddy instance will be blocked.
  const origin  = parsedUrl.origin;
  const pattern = `${origin}/*`;

  const alreadyGranted = await new Promise(res =>
    chrome.permissions.contains({ origins: [pattern] }, res)
  );

  if (!alreadyGranted) {
    statusEl.className = 'status-bar info';
    statusEl.innerHTML = `<span class="spinner"></span><span>Запрашиваем доступ к <code>${origin}</code>…</span>`;
    statusEl.style.display = 'flex';

    const granted = await new Promise(res =>
      chrome.permissions.request({ origins: [pattern] }, res)
    );

    if (!granted) {
      setStatus('error',
        `Доступ к <code>${origin}</code> не разрешён. ` +
        'Без него расширение не сможет подключиться к Bambuddy.'
      );
      return;
    }
  }

  await new Promise(res =>
    chrome.storage.local.set({
      [STORAGE_KEYS.BAMBUDDY_URL]:     url,
      [STORAGE_KEYS.API_KEY]:          key,
      [STORAGE_KEYS.AUTO_CLOSE]:       autoCloseChk.checked,
      [STORAGE_KEYS.AUTO_CLOSE_DELAY]: delay,
      [STORAGE_KEYS.SHOW_OPEN_BTN]:    showOpenBtnChk.checked
    }, res)
  );

  setStatus('success', `Настройки сохранены. Доступ к <code>${origin}</code> разрешён.`);
}

// ─── Test connection ──────────────────────────────────────────────────────────

async function testConnection() {
  clearStatus();
  const url = urlInput.value.trim();
  const key = keyInput.value.trim();

  if (!url) {
    setStatus('error', 'Сначала укажите адрес Bambuddy.');
    return;
  }

  // Temporarily store values for the background script to use
  await new Promise(res =>
    chrome.storage.local.set({
      [STORAGE_KEYS.BAMBUDDY_URL]: url.replace(/\/+$/, ''),
      [STORAGE_KEYS.API_KEY]:      key
    }, res)
  );

  statusEl.className = 'status-bar info';
  statusEl.innerHTML = `<span class="spinner"></span><span>Подключаемся к Bambuddy…</span>`;
  statusEl.style.display = 'flex';
  btnTest.disabled = true;

  try {
    const data = await sendToBackground({ action: 'testConnection' });

    // Version from GET /api/v1/system/info
    const version = data.version ? ` ${data.version}` : '';
    let msg = `Подключено к Bambuddy${version}.`;

    // Cloud token status from GET /api/v1/makerworld/status (best-effort)
    if (data.mw_status) {
      const cloudOk = data.mw_status.has_cloud_token ?? data.mw_status.cloud_token_present ?? false;
      const region  = data.mw_status.region ?? data.mw_status.host ?? '';
      if (cloudOk) {
        msg += ` Токен Bambu Cloud найден${region ? ` (${region})` : ''}.`;
        setStatus('success', msg);
      } else {
        msg += ' ⚠ Токен Bambu Cloud не найден. Перед импортом подключите учётную запись в разделе «Настройки → Bambu Cloud».';
        setStatus('info', msg);
      }
    } else if (data.mw_error) {
      // MakerWorld status endpoint returned an error — likely missing permissions
      // or the feature isn't enabled. The core connection is still fine.
      msg += ` API-ключ действителен. ⚠ Не удалось проверить состояние MakerWorld: ${data.mw_error}. Убедитесь, что у ключа есть разрешения <strong>Manage Library</strong> и <strong>Allow cloud access</strong>.`;
      setStatus('info', msg);
    } else {
      setStatus('success', msg);
    }
  } catch (err) {
    if (err.message === 'UNCONFIGURED') {
      setStatus('error', 'Адрес Bambuddy не задан.');
    } else {
      setStatus('error', `Не удалось подключиться: ${err.message}`);
    }
  } finally {
    btnTest.disabled = false;
  }
}

// ─── Show/hide API key ────────────────────────────────────────────────────────

function toggleKeyVisibility() {
  const isHidden = keyInput.type === 'password';
  keyInput.type = isHidden ? 'text' : 'password';
  const eyeIcon = document.getElementById('eye-icon');
  eyeIcon.innerHTML = isHidden
    ? `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
       <line x1="1" y1="1" x2="23" y2="23"/>`
    : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
       <circle cx="12" cy="12" r="3"/>`;
}

// ─── Version ──────────────────────────────────────────────────────────────────

function loadVersion() {
  const manifest = chrome.runtime.getManifest();
  versionEl.textContent = `v${manifest.version}`;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

btnSave.addEventListener('click', save);
btnTest.addEventListener('click', testConnection);
btnToggle.addEventListener('click', toggleKeyVisibility);
autoCloseChk.addEventListener('change', () => {
  delayRow.style.display = autoCloseChk.checked ? '' : 'none';
});

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  loadVersion();
});
