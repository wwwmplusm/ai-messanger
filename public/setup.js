const get = (id) => document.getElementById(id);
const notice = get('notice');
const profile = get('profile');
const verify = get('verify');
const back = get('back');
let polling;
let busy = false;

async function api(method, path, data) {
  const response = await fetch(`/api/setup/${path}`, {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : undefined,
    body: data && JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  return body;
}

function tell(message, error = false) {
  notice.textContent = message;
  notice.classList.toggle('error', error);
}

function show(auth) {
  clearTimeout(polling);
  const connected = auth.status === 'connected';
  const pending = auth.status === 'pending';
  profile.hidden = pending;
  verify.hidden = !pending;
  back.hidden = !connected || !back.href;
  get('reconnect').hidden = !connected;
  get('connect').dataset.mode = connected ? 'save' : 'connect';
  get('connect').textContent = connected ? 'Сохранить профиль' : 'Подключить Codex';
  if (connected) tell('Codex подключён. Агент готов к запуску из Telegram.');
  if (auth.status === 'idle') tell('Подключение аккаунта');
  if (auth.status === 'failed' || auth.status === 'expired') {
    tell('Вход не завершён. Получи новый код и попробуй ещё раз.', true);
  }
  if (pending) {
    get('device-code').textContent = auth.code;
    get('device-url').href = auth.url;
    tell('Ожидаем подтверждение от OpenAI.');
    polling = setTimeout(check, 2000);
  }
}

async function check() {
  try {
    show((await api('GET', 'status')).auth);
  } catch (error) {
    tell(error.message, true);
    if (!verify.hidden) polling = setTimeout(check, 5000);
  }
}

async function update(mode) {
  if (busy || !profile.reportValidity()) return;
  busy = true;
  clearTimeout(polling);
  const buttons = [get('connect'), get('reconnect'), get('new-code')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const { auth } = await api('POST', 'profile', {
      name: get('agent-name').value, instructions: get('instructions').value, mode,
    });
    show(auth);
  } catch (error) {
    tell(error.message, true);
  } finally {
    busy = false;
    buttons.forEach((button) => { button.disabled = false; });
  }
}

profile.addEventListener('submit', (event) => {
  event.preventDefault();
  void update(get('connect').dataset.mode);
});
get('reconnect').addEventListener('click', () => void update('restart'));
get('new-code').addEventListener('click', () => void update('restart'));
get('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(get('device-code').textContent);
    get('copy').textContent = 'Скопировано';
    setTimeout(() => { get('copy').textContent = 'Копировать'; }, 2000);
  } catch {
    const range = document.createRange();
    range.selectNodeContents(get('device-code'));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
});

try {
  const code = location.hash.slice(1);
  if (code) {
    await api('POST', 'claim', { code });
    history.replaceState(null, '', location.pathname);
  }
  const state = await api('GET', 'status');
  get('owner').textContent = state.profile.telegramName;
  get('agent-name').value = state.profile.name;
  get('instructions').value = state.profile.instructions;
  back.href = state.telegram;
  show(state.auth);
} catch (error) {
  tell(error.message, true);
}
