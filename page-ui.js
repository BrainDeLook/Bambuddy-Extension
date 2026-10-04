/** One-click import of the profile selected on the MakerWorld page. */
(() => {
  const MODEL_PATH = /\/models\/\d+(?:[-/]|$)/;
  const PROFILE_HASH = /#profileId[-=](\d+)/i;
  let pageKey = '';
  let busy = false;
  let notificationTimer;

  const host = document.createElement('div');
  host.id = 'bambuddy-page-importer';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; position: fixed; right: 20px; bottom: 20px; z-index: 2147483646;
        font: 14px/1.4 system-ui, "Segoe UI", sans-serif; color: #f4f6f7; }
      * { box-sizing: border-box; }
      .notice { display: none; max-width: min(340px, calc(100vw - 24px)); margin-bottom: 10px;
        padding: 10px 13px; border: 1px solid #536072; border-radius: 10px;
        background: #1c1f2a; box-shadow: 0 5px 20px #0008; overflow-wrap: anywhere; }
      .notice.visible { display: block; }
      .notice.success { border-color: #1db954; }
      .notice.error { border-color: #e97171; }
      .launcher { display: flex; align-items: center; gap: 9px; padding: 12px 17px;
        border: 2px solid #a6ffc3; border-radius: 14px; background: #087633; color: white;
        box-shadow: 0 6px 24px #0008; font: 700 14px/1.4 system-ui, "Segoe UI", sans-serif;
        cursor: pointer; }
      .launcher:hover:not(:disabled), .launcher:focus-visible { background: #0a9140; outline: 2px solid white; }
      .launcher:disabled { opacity: .75; cursor: wait; }
      .mark { display: inline-grid; place-items: center; width: 22px; height: 22px;
        border-radius: 6px; background: white; color: #087633; font-weight: 900; }
      @media (max-width: 480px) { :host { right: 12px; bottom: 12px; } }
    </style>
    <div class="notice" id="notice" role="status" aria-live="polite"></div>
    <button class="launcher" id="import" aria-label="Импортировать выбранный профиль в Bambuddy">
      <span class="mark" aria-hidden="true">B</span><span>Импорт в Bambuddy</span>
    </button>`;

  const button = shadow.getElementById('import');
  const notice = shadow.getElementById('notice');

  function notify(message, kind = '', timeout = 0) {
    clearTimeout(notificationTimer);
    notice.textContent = message;
    notice.className = `notice visible ${kind}`;
    if (timeout) notificationTimer = setTimeout(() => notice.className = 'notice', timeout);
  }

  function selectedInstanceId() {
    const match = location.hash.match(PROFILE_HASH);
    if (match) return Number(match[1]);
    // MakerWorld calls the fragment "profileId", but its value is instances[].id.
    const active = document.querySelector('[data-instance-id].active, [data-instance-id][aria-selected="true"]');
    const id = Number(active?.getAttribute('data-instance-id'));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  function sendToBackground(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!response?.success) return reject(new Error(response?.error || 'Неизвестная ошибка'));
        resolve(response.data);
      });
    });
  }

  async function importCurrentProfile() {
    if (busy || !MODEL_PATH.test(location.pathname)) return;
    const clickedPage = `${location.pathname}${location.search}`;
    const clickedUrl = location.href;
    const clickedInstanceId = selectedInstanceId();
    busy = true;
    button.disabled = true;
    notify('Определяем выбранный профиль…');

    try {
      const { bambuddyUrl } = await chrome.storage.local.get('bambuddyUrl');
      if (!bambuddyUrl) throw new Error('Сначала укажите адрес Bambuddy и API-ключ в настройках расширения.');

      const data = await sendToBackground({ action: 'resolve', url: clickedUrl });
      if (`${location.pathname}${location.search}` !== clickedPage) return;

      const sourceProfiles = data.design?.instances?.length ? data.design.instances : (data.instances ?? []);
      const profiles = sourceProfiles.filter(item => Number.isSafeInteger(item.id) && Number.isSafeInteger(item.profileId));
      if (!data.model_id || profiles.length === 0) throw new Error('Для этой модели не найдены профили печати.');

      // With no fragment, MakerWorld selects the model's default instance.
      const defaultInstanceId = Number(data.design?.defaultInstanceId);
      const selectedId = clickedInstanceId ?? (Number.isSafeInteger(defaultInstanceId) && defaultInstanceId > 0 ? defaultInstanceId : null);
      const chosen = selectedId != null
        ? profiles.find(item => item.id === selectedId)
        : (profiles.length === 1 ? profiles[0] : null);
      if (!chosen) throw new Error('Не удалось определить выбранный профиль. Выберите его на MakerWorld и повторите.');

      const profileName = chosen.title || `Профиль ${chosen.profileId}`;
      notify(`Импортируется профиль «${profileName}»…`);
      const result = await sendToBackground({
        action: 'import', model_id: data.model_id,
        instance_id: chosen.id, profile_id: chosen.profileId
      });
      if (`${location.pathname}${location.search}` !== clickedPage) return;
      notify(result.was_existing
        ? `Профиль «${profileName}» уже есть в Bambuddy.`
        : `Профиль «${profileName}» импортирован в Bambuddy.`, 'success', 6500);
    } catch (error) {
      if (`${location.pathname}${location.search}` !== clickedPage) return;
      const message = error.message || 'Не удалось импортировать профиль.';
      notify(/already/i.test(message) ? 'Этот профиль уже есть в Bambuddy.' : message,
        /already/i.test(message) ? 'success' : 'error', 8000);
    } finally {
      busy = false;
      button.disabled = false;
    }
  }

  button.addEventListener('click', importCurrentProfile);

  function updatePage() {
    const onModel = MODEL_PATH.test(location.pathname);
    host.style.display = onModel ? '' : 'none';
    const nextKey = onModel ? `${location.pathname}${location.search}` : '';
    if (nextKey !== pageKey) {
      pageKey = nextKey;
      clearTimeout(notificationTimer);
      notice.className = 'notice';
    }
  }

  (document.body || document.documentElement).appendChild(host);
  updatePage();
  // MakerWorld can navigate between models with pushState, without a page reload.
  setInterval(updatePage, 1000);
})();
