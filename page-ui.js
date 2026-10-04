/** Import the selected MakerWorld print profile without opening the toolbar popup. */
(() => {
  const MODEL_PATH = /\/models\/\d+(?:[-/]|$)/;
  const PROFILE_HASH = /#profileId[-=](\d+)/i;
  let pageKey = '';
  let model = null;
  let requestId = 0;
  let manualChoice = false;
  let busy = false;

  const host = document.createElement('div');
  host.id = 'bambuddy-page-importer';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; position: fixed; right: 20px; bottom: 20px; z-index: 2147483646;
        font: 14px/1.4 system-ui, "Segoe UI", sans-serif; color: #f4f6f7; }
      * { box-sizing: border-box; }
      button, select { font: inherit; }
      button { cursor: pointer; }
      .launcher { display: flex; align-items: center; gap: 9px; padding: 12px 17px;
        border: 2px solid #a6ffc3; border-radius: 14px; background: #087633; color: white;
        box-shadow: 0 6px 24px #0008; font-weight: 700; }
      .launcher:hover, .launcher:focus-visible { background: #0a9140; outline: 2px solid white; }
      .mark { display: inline-grid; place-items: center; width: 22px; height: 22px;
        border-radius: 6px; background: white; color: #087633; font-weight: 900; }
      .panel { display: none; width: min(340px, calc(100vw - 24px)); margin-bottom: 10px;
        padding: 16px; border: 1px solid #4a5664; border-radius: 14px; background: #1c1f2a;
        box-shadow: 0 10px 36px #000a; }
      .panel.open { display: block; }
      .header { display: flex; align-items: center; justify-content: space-between; gap: 12px;
        margin-bottom: 12px; font-weight: 700; }
      .close { border: 0; background: transparent; color: #cbd3dd; font-size: 22px; line-height: 1; }
      label { display: block; margin-bottom: 6px; color: #d4d9e2; }
      select { width: 100%; padding: 9px 10px; border: 1px solid #677285; border-radius: 8px;
        background: #11141c; color: white; }
      .send { width: 100%; margin-top: 12px; padding: 10px; border: 0; border-radius: 8px;
        background: #1db954; color: #07140c; font-weight: 700; }
      .send:hover:not(:disabled) { background: #4bd177; }
      .send:disabled { opacity: .55; cursor: default; }
      .status { min-height: 18px; margin-top: 10px; color: #cbd3dd; overflow-wrap: anywhere; }
      .status.error { color: #ff9999; }
      .status.success { color: #86ecaa; }
      .settings, .open-file { color: #a5efc1; text-decoration: underline; }
      .settings { display: none; margin-top: 9px; border: 0; padding: 0; background: none; }
      .open-file { display: none; margin-top: 9px; }
      @media (max-width: 480px) { :host { right: 12px; bottom: 12px; } }
    </style>
    <div class="panel" id="panel" role="dialog" aria-label="Импорт в Bambuddy">
      <div class="header"><span>Импорт в Bambuddy</span><button class="close" id="close" aria-label="Закрыть">×</button></div>
      <label for="profile">Профиль печати</label>
      <select id="profile" disabled><option value="">Загрузка профилей…</option></select>
      <button class="send" id="send" disabled>Отправить в Bambuddy</button>
      <div class="status" id="status" role="status" aria-live="polite"></div>
      <button class="settings" id="settings">Открыть настройки расширения</button>
      <a class="open-file" id="open-file" target="_blank" rel="noopener noreferrer">Открыть в Bambuddy</a>
    </div>
    <button class="launcher" id="launcher" aria-label="Импортировать в Bambuddy">
      <span class="mark" aria-hidden="true">B</span><span>В Bambuddy</span>
    </button>`;

  const $ = id => shadow.getElementById(id);
  const panel = $('panel');
  const select = $('profile');
  const send = $('send');
  const status = $('status');
  const settings = $('settings');
  const openFile = $('open-file');

  function setStatus(message, type = '') {
    status.textContent = message;
    status.className = `status ${type}`;
  }

  function selectedIdFromPage() {
    const match = location.hash.match(PROFILE_HASH);
    if (match) return Number(match[1]);
    const active = document.querySelector('[data-profile-id].active, [data-profile-id][aria-selected="true"]');
    const id = Number(active?.getAttribute('data-profile-id'));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  function syncSiteSelection() {
    if (!model || manualChoice || busy) return;
    const id = selectedIdFromPage();
    if (!id) return;
    const option = [...select.options].find(item => item.dataset.profileId === String(id));
    if (option && select.value !== option.value) {
      select.value = option.value;
      send.disabled = false;
      setStatus('');
    } else if (!option) {
      // Never import a previously selected profile when the site points at another ID.
      select.value = '';
      send.disabled = true;
      setStatus('Выберите профиль перед отправкой.');
    }
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

  async function loadProfiles() {
    const currentRequest = ++requestId;
    model = null;
    manualChoice = false;
    select.replaceChildren(new Option('Загрузка профилей…', ''));
    select.disabled = true;
    send.disabled = true;
    settings.style.display = 'none';
    openFile.style.display = 'none';
    setStatus('');

    const { bambuddyUrl } = await chrome.storage.local.get('bambuddyUrl');
    if (currentRequest !== requestId) return;
    if (!bambuddyUrl) {
      select.replaceChildren(new Option('Настройте Bambuddy', ''));
      setStatus('Сначала укажите адрес Bambuddy и API-ключ.', 'error');
      settings.style.display = 'block';
      return;
    }

    try {
      const data = await sendToBackground({ action: 'resolve', url: location.href });
      if (currentRequest !== requestId) return;
      const sourceProfiles = data.design?.instances?.length ? data.design.instances : (data.instances ?? []);
      const profiles = sourceProfiles
        .filter(item => Number.isSafeInteger(item.id) && Number.isSafeInteger(item.profileId));
      if (!data.model_id || profiles.length === 0) {
        throw new Error('Для этой модели не найдены профили печати.');
      }
      model = data;
      select.replaceChildren(new Option('Выберите профиль…', ''));
      for (const profile of profiles) {
        const option = new Option(profile.title || `Профиль ${profile.profileId}`, `${profile.id}:${profile.profileId}`);
        option.dataset.profileId = String(profile.profileId);
        select.add(option);
      }
      select.disabled = false;
      const pageProfileId = selectedIdFromPage() ?? data.profile_id;
      const matched = profiles.find(item => item.profileId === pageProfileId);
      const fallback = pageProfileId == null
        ? (profiles.length === 1 ? profiles[0] : profiles.find(item => item.isDefault === true))
        : null;
      const chosen = matched ?? fallback;
      if (chosen) select.value = `${chosen.id}:${chosen.profileId}`;
      send.disabled = !select.value;
      if (!chosen) setStatus('Выберите профиль перед отправкой.');
    } catch (error) {
      if (currentRequest !== requestId) return;
      select.replaceChildren(new Option('Не удалось загрузить профили', ''));
      setStatus(error.message || 'Не удалось загрузить профили.', 'error');
      settings.style.display = 'block';
    }
  }

  async function importSelected() {
    if (!model || !select.value || busy) return;
    const [instanceId, profileId] = select.value.split(':').map(Number);
    if (!Number.isSafeInteger(instanceId) || !Number.isSafeInteger(profileId)) return;
    busy = true;
    send.disabled = true;
    openFile.style.display = 'none';
    setStatus('Отправляем выбранный профиль…');
    const currentRequest = requestId;
    try {
      const result = await sendToBackground({
        action: 'import', model_id: model.model_id,
        instance_id: instanceId, profile_id: profileId
      });
      if (currentRequest !== requestId) return;
      setStatus(result.was_existing ? 'Этот профиль уже есть в библиотеке.' : 'Профиль сохранён в Bambuddy.', 'success');
      const { bambuddyUrl } = await chrome.storage.local.get('bambuddyUrl');
      if (currentRequest !== requestId) return;
      if (bambuddyUrl) {
        const url = new URL('/files', bambuddyUrl);
        if (result.folder_id != null) url.searchParams.set('folder', result.folder_id);
        openFile.href = url.href;
        openFile.style.display = 'inline-block';
      }
    } catch (error) {
      if (currentRequest === requestId) {
        const message = error.message || 'Не удалось импортировать профиль.';
        const duplicate = /already/i.test(message);
        setStatus(duplicate ? 'Этот профиль уже есть в библиотеке.' : message, duplicate ? 'success' : 'error');
      }
    } finally {
      busy = false;
      send.disabled = !select.value;
    }
  }

  $('launcher').addEventListener('click', () => {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) loadProfiles();
  });
  $('close').addEventListener('click', () => panel.classList.remove('open'));
  $('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  select.addEventListener('change', () => {
    manualChoice = true;
    send.disabled = !select.value || busy;
    openFile.style.display = 'none';
    setStatus('');
  });
  send.addEventListener('click', importSelected);
  window.addEventListener('hashchange', syncSiteSelection);

  function updatePage() {
    const onModel = MODEL_PATH.test(location.pathname);
    host.style.display = onModel ? '' : 'none';
    const nextKey = onModel ? `${location.pathname}${location.search}` : '';
    if (nextKey !== pageKey) {
      pageKey = nextKey;
      ++requestId;
      model = null;
      panel.classList.remove('open');
    }
    if (onModel && panel.classList.contains('open')) syncSiteSelection();
  }

  (document.body || document.documentElement).appendChild(host);
  updatePage();
  // MakerWorld uses client-side routing; pushState does not fire popstate.
  setInterval(updatePage, 1000);
})();
