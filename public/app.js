const WA_LABEL = {
  starting: 'Startet',
  qr: 'QR-Code scannen',
  authenticated: 'Wird geladen',
  ready: 'Verbunden',
  disconnected: 'Getrennt',
  auth_failure: 'Anmeldung fehlgeschlagen',
  error: 'Fehler',
};

const STATUS_LABEL = {
  queued: 'Warteschlange',
  sent: 'Gesendet',
  failed: 'Fehlgeschlagen',
};

const state = {
  needsSetup: false,
  authenticated: false,
  username: '',
  view: 'status',
  wa: null,
  meta: null,
  endpoints: [],
  events: [],
  editing: null,
  chats: [],
  chatsInfo: '',
  chatsError: '',
  tokenReveal: null,
  error: '',
  notice: '',
  busy: false,
};

const app = document.getElementById('app');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso || '');
  return date.toLocaleString('de-DE');
}

function formatWid(wid) {
  return String(wid || '').replace(/@.*$/, '');
}

async function api(path, options = {}) {
  const opts = { credentials: 'same-origin', ...options };
  const headers = { ...(options.headers || {}) };
  if (options.body) headers['Content-Type'] = 'application/json';
  opts.headers = headers;
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    const err = new Error('Server nicht erreichbar');
    err.status = 0;
    throw err;
  }
  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: 'Unerwartete Antwort' };
    }
  }
  if (!res.ok) {
    const err = new Error(data.error || 'Anfrage fehlgeschlagen');
    err.status = res.status;
    throw err;
  }
  return data;
}

function bannerHtml() {
  if (state.error) return `<div class="banner error">${esc(state.error)}</div>`;
  if (state.notice) return `<div class="banner ok">${esc(state.notice)}</div>`;
  return '';
}

function setupHtml() {
  return `
    <div class="auth">
      <section class="card auth-card">
        <h1>Konto anlegen</h1>
        <p class="lead">Der erste Benutzer verwaltet WhatsApp und die Webhooks.</p>
        ${bannerHtml()}
        <form class="stack" data-action="setup" autocomplete="off">
          <label>Benutzername
            <input name="username" autocomplete="username" required maxlength="64">
          </label>
          <label>Passwort
            <input name="password" type="password" autocomplete="new-password" required minlength="8">
          </label>
          <label>Passwort wiederholen
            <input name="passwordConfirm" type="password" autocomplete="new-password" required minlength="8">
          </label>
          <button type="submit" ${state.busy ? 'disabled' : ''}>Konto anlegen</button>
        </form>
      </section>
    </div>`;
}

function loginHtml() {
  return `
    <div class="auth">
      <section class="card auth-card">
        <h1>Anmelden</h1>
        <p class="lead">WhatsApp-Monitor</p>
        ${bannerHtml()}
        <form class="stack" data-action="login">
          <label>Benutzername
            <input name="username" autocomplete="username" required>
          </label>
          <label>Passwort
            <input name="password" type="password" autocomplete="current-password" required>
          </label>
          <button type="submit" ${state.busy ? 'disabled' : ''}>Anmelden</button>
        </form>
      </section>
    </div>`;
}

function paintPill() {
  const pill = document.getElementById('conn-pill');
  if (!pill || !state.wa) return;
  pill.className = `pill pill-${state.wa.status}`;
  pill.textContent = WA_LABEL[state.wa.status] || state.wa.status;
}

function statusPanelInnerHtml() {
  const wa = state.wa || { status: 'starting', queueCount: 0 };
  const queueText = wa.queueCount
    ? `${wa.queueCount} Sendung${wa.queueCount === 1 ? '' : 'en'} in der Warteschlange`
    : 'Keine Sendungen in der Warteschlange';
  const who = wa.info
    ? `Verbunden als ${wa.info.pushname || 'WhatsApp'}${wa.info.wid ? ` (${formatWid(wa.info.wid)})` : ''}`
    : '';
  let body = '';
  if (wa.status === 'qr' && wa.qr) {
    body = `
      <div class="qr-frame"><img src="${esc(wa.qr)}" alt="WhatsApp QR-Code"></div>
      <p>WhatsApp auf dem Telefon öffnen, unter Einstellungen → Verknüpfte Geräte ein Gerät hinzufügen und diesen Code scannen.</p>`;
  } else if (wa.status === 'qr') {
    body = '<p>QR-Code wird erzeugt …</p>';
  } else if (wa.status === 'ready') {
    body = `<p>${esc(who)}</p>`;
  } else if (wa.status === 'starting' || wa.status === 'authenticated') {
    body = '<p>Client wird gestartet …</p>';
  } else {
    body = '<p>WhatsApp ist nicht verbunden.</p>';
  }
  const error = wa.lastError ? `<div class="banner error">${esc(wa.lastError)}</div>` : '';
  return `
    ${error}
    <h1>Status</h1>
    ${body}
    <p class="muted">${esc(queueText)}</p>
    <div class="actions">
      <button type="button" class="secondary" data-action="wa-restart" ${state.busy ? 'disabled' : ''}>Erneut verbinden</button>
      <button type="button" class="danger" data-action="wa-logout" ${state.busy ? 'disabled' : ''}>WhatsApp abmelden</button>
    </div>`;
}

function parserOptions(selected) {
  const parsers = state.meta?.parsers || [];
  return parsers.map((parser) => `
    <option value="${esc(parser.id)}" ${parser.id === selected ? 'selected' : ''}>${esc(parser.label)}</option>
  `).join('');
}

function endpointsHtml() {
  const cards = state.endpoints.length
    ? `<div class="grid endpoints">${state.endpoints.map((endpoint) => `
        <article class="card">
          <header>
            <h2>${esc(endpoint.name)}</h2>
            <span class="badge ${endpoint.enabled ? 'on' : 'off'}">${endpoint.enabled ? 'Aktiv' : 'Inaktiv'}</span>
          </header>
          <p class="muted">${esc(parserLabel(endpoint.parser))} · ${esc(endpoint.targetLabel || endpoint.targetChatId || 'Kein Zielchat')}</p>
          <button type="button" class="secondary" data-action="edit-endpoint" data-id="${endpoint.id}">Bearbeiten</button>
        </article>
      `).join('')}</div>`
    : '<p class="empty">Noch keine Endpunkte. Lege einen an und trage die Webhook-URL in aaPanel oder Proxmox ein.</p>';
  return `
    <div class="page-head">
      <h1>Endpunkte</h1>
      <button type="button" data-action="new-endpoint">Neuer Endpunkt</button>
    </div>
    ${bannerHtml()}
    ${cards}`;
}

function parserLabel(id) {
  return state.meta?.parsers?.find((parser) => parser.id === id)?.label || id;
}

function endpointFormHtml() {
  const editing = state.editing;
  const parser = state.meta?.parsers?.find((item) => item.id === editing.parser);
  const dis = state.busy ? 'disabled' : '';
  const generic = editing.parser === 'generic' ? `
    <label>Titel-Pfad
      <input name="titlePath" value="${esc(editing.titlePath)}" spellcheck="false" ${dis}>
    </label>
    <label>Text-Pfad
      <input name="messagePath" value="${esc(editing.messagePath)}" spellcheck="false" ${dis}>
    </label>` : `
    <input type="hidden" name="titlePath" value="${esc(editing.titlePath)}">
    <input type="hidden" name="messagePath" value="${esc(editing.messagePath)}">`;
  const snippet = parser?.body ? `
    <section class="panel">
      <h2>Body für ${esc(parser.label)}</h2>
      <p class="muted">${esc(parser.hint)}</p>
      <pre>${esc(parser.body)}</pre>
      <button type="button" class="secondary" data-action="copy-snippet" ${dis}>Body kopieren</button>
    </section>` : `
    <section class="panel">
      <h2>Generisches JSON</h2>
      <p class="muted">${esc(parser?.hint || '')}</p>
    </section>`;
  const extra = editing.id ? `
    <div class="actions">
      <button type="button" class="secondary" data-action="regen-token" ${dis}>Token erneuern</button>
      <button type="button" class="secondary" data-action="test-endpoint" ${dis}>Test senden</button>
      <button type="button" class="danger" data-action="delete-endpoint" ${dis}>Löschen</button>
    </div>
    <p class="muted">Der Token wird nur beim Anlegen oder Erneuern angezeigt. Danach gilt eine neue URL, die alte nicht mehr.</p>` : `
    <p class="muted">Nach dem Anlegen wird die Webhook-URL einmal angezeigt. Sie muss von aaPanel oder Proxmox aus erreichbar sein.</p>`;
  const chatOptions = state.chats.map((chat) => `
    <option value="${esc(chat.id)}" data-name="${esc(chat.name)}">${esc(chat.isGroup ? 'Gruppe' : 'Chat')}: ${esc(chat.name)}</option>
  `).join('');
  return `
    <div class="page-head">
      <h1>${editing.id ? 'Endpunkt bearbeiten' : 'Neuer Endpunkt'}</h1>
      <button type="button" class="secondary" data-action="nav" data-view="endpoints">Zurück</button>
    </div>
    ${bannerHtml()}
    <div class="split">
      <form id="endpoint-form" class="stack panel" data-action="save-endpoint" autocomplete="off">
        <label>Name
          <input name="name" value="${esc(editing.name)}" required maxlength="80" ${dis}>
        </label>
        <label class="check">
          <input type="checkbox" name="enabled" ${editing.enabled ? 'checked' : ''} ${dis}>
          Aktiv
        </label>
        <label>Parser
          <select name="parser" ${dis}>${parserOptions(editing.parser)}</select>
        </label>
        <label>Nachrichtenvorlage
          <textarea name="template" required maxlength="4000" spellcheck="false" ${dis}>${esc(editing.template)}</textarea>
        </label>
        <p class="muted">Platzhalter: {{title}}, {{message}}, {{severity}}, {{type}}, {{source}}, {{timestamp}}, {{fields}}</p>
        ${generic}
        <label>Nummer oder Chat-ID
          <input name="targetChatId" value="${esc(editing.targetChatId)}" placeholder="491701234567" spellcheck="false" ${dis}>
        </label>
        <input type="hidden" name="targetLabel" value="${esc(editing.targetLabel)}">
        <div class="row">
          <button type="button" class="secondary" data-action="load-chats" ${dis}>Chats laden</button>
          <select id="chat-pick" ${dis}>
            <option value="">Chat auswählen</option>
            ${chatOptions}
          </select>
        </div>
        <p class="muted">${esc(state.chatsError || state.chatsInfo || 'WhatsApp muss verbunden sein, um Chats zu laden. Ohne Ziel werden Meldungen nicht gesendet.')}</p>
        <button type="submit" ${dis}>Speichern</button>
        ${extra}
      </form>
      ${snippet}
    </div>`;
}

function eventsHtml() {
  if (!state.events.length) return '<p class="empty">Noch keine Meldungen.</p>';
  return state.events.map((event) => `
    <details data-id="${event.id}">
      <summary>
        <span>${esc(formatTime(event.createdAt))}</span>
        <span class="badge badge-${esc(event.status)}">${esc(STATUS_LABEL[event.status] || event.status)}</span>
        <span>${esc(event.endpointName || '')}</span>
        <span>${esc(event.summary || '')}</span>
      </summary>
      <div class="detail">
        ${event.error ? `<p class="error-text">${esc(event.error)}</p>` : ''}
        <h3>Nachricht</h3>
        <pre>${esc(event.messageText || '—')}</pre>
        <h3>Payload</h3>
        <pre>${esc(event.payload || '—')}</pre>
      </div>
    </details>
  `).join('');
}

function eventsPageHtml() {
  return `
    <div class="page-head">
      <h1>Protokoll</h1>
      <button type="button" class="secondary" data-action="refresh-events">Aktualisieren</button>
    </div>
    ${bannerHtml()}
    <div id="event-list">${eventsHtml()}</div>`;
}

function accountHtml() {
  const dis = state.busy ? 'disabled' : '';
  return `
    <div class="page-head"><h1>Konto</h1></div>
    ${bannerHtml()}
    <section class="panel" style="max-width:420px">
      <p>Angemeldet als <strong>${esc(state.username)}</strong></p>
      <form class="stack" data-action="password">
        <label>Aktuelles Passwort
          <input name="currentPassword" type="password" autocomplete="current-password" required ${dis}>
        </label>
        <label>Neues Passwort
          <input name="newPassword" type="password" autocomplete="new-password" required minlength="8" ${dis}>
        </label>
        <label>Neues Passwort wiederholen
          <input name="passwordConfirm" type="password" autocomplete="new-password" required minlength="8" ${dis}>
        </label>
        <button type="submit" ${dis}>Passwort ändern</button>
      </form>
    </section>`;
}

function viewHtml() {
  if (state.view === 'status') return `<section id="status-panel">${statusPanelInnerHtml()}</section>`;
  if (state.view === 'endpoints') return endpointsHtml();
  if (state.view === 'endpoint') return endpointFormHtml();
  if (state.view === 'events') return eventsPageHtml();
  if (state.view === 'account') return accountHtml();
  return '';
}

function modalHtml() {
  if (!state.tokenReveal) return '';
  return `
    <div class="modal-back" data-action="close-token">
      <div class="modal card" data-action="stop">
        <h2>Webhook-URL</h2>
        <p class="muted">Diese URL wird nur jetzt im Klartext gezeigt. Kopiere sie in aaPanel oder Proxmox.</p>
        <input id="webhook-url" class="url-input" readonly value="${esc(state.tokenReveal.webhookUrl)}">
        <div class="actions">
          <button type="button" data-action="copy-url">Kopieren</button>
          <button type="button" class="secondary" data-action="close-token">Schließen</button>
        </div>
      </div>
    </div>`;
}

function shellHtml() {
  const current = state.view === 'endpoint' ? 'endpoints' : state.view;
  const tab = (id, label) => `
    <button type="button" data-action="nav" data-view="${id}" ${current === id ? 'aria-current="page"' : ''}>${label}</button>`;
  return `
    <div id="shell">
      <header class="top">
        <div class="brand">
          <span class="mark" aria-hidden="true"></span>
          <div><strong>Monitor</strong><small>WhatsApp-Alarme</small></div>
        </div>
        <nav>
          ${tab('status', 'Status')}
          ${tab('endpoints', 'Endpunkte')}
          ${tab('events', 'Protokoll')}
          ${tab('account', 'Konto')}
        </nav>
        <div class="top-actions">
          <span id="conn-pill" class="pill"></span>
          <button type="button" class="secondary" data-action="logout">Abmelden</button>
        </div>
      </header>
      <main id="view">${viewHtml()}</main>
      ${modalHtml()}
    </div>`;
}

function render() {
  if (state.needsSetup && !state.authenticated) app.innerHTML = setupHtml();
  else if (!state.authenticated) app.innerHTML = loginHtml();
  else {
    app.innerHTML = shellHtml();
    paintPill();
  }
}

function editingFromEndpoint(endpoint) {
  return {
    id: endpoint.id,
    name: endpoint.name,
    enabled: endpoint.enabled,
    parser: endpoint.parser,
    template: endpoint.template,
    targetChatId: endpoint.targetChatId,
    targetLabel: endpoint.targetLabel,
    titlePath: endpoint.titlePath,
    messagePath: endpoint.messagePath,
  };
}

function blankEndpoint() {
  return {
    id: null,
    name: '',
    enabled: true,
    parser: 'generic',
    template: state.meta?.defaultTemplate || '*{{source}}* {{title}}\n\n{{message}}',
    targetChatId: '',
    targetLabel: '',
    titlePath: 'title',
    messagePath: 'message',
  };
}

function captureForm() {
  const form = document.getElementById('endpoint-form');
  if (!form || !state.editing) return;
  state.editing = {
    ...state.editing,
    name: form.name.value,
    enabled: form.enabled.checked,
    parser: form.parser.value,
    template: form.template.value,
    targetChatId: form.targetChatId.value,
    targetLabel: form.targetLabel.value,
    titlePath: form.titlePath.value,
    messagePath: form.messagePath.value,
  };
}

function endpointPayload(editing) {
  return {
    name: editing.name,
    enabled: editing.enabled,
    parser: editing.parser,
    template: editing.template,
    targetChatId: editing.targetChatId,
    targetLabel: editing.targetLabel,
    titlePath: editing.titlePath,
    messagePath: editing.messagePath,
  };
}

async function enterApp() {
  const [meta, wa] = await Promise.all([
    api('/api/meta'),
    api('/api/whatsapp/status'),
  ]);
  state.meta = meta;
  state.wa = wa;
  state.view = 'status';
  state.error = '';
  state.notice = '';
  render();
}

async function showView(view) {
  state.view = view;
  state.editing = null;
  state.error = '';
  state.notice = '';
  if (view === 'endpoints') {
    state.endpoints = (await api('/api/endpoints')).endpoints;
  }
  if (view === 'events') {
    state.events = (await api('/api/events')).events;
  }
  render();
}

async function refreshEvents() {
  const data = await api('/api/events');
  state.events = data.events;
  const box = document.getElementById('event-list');
  if (!box) {
    render();
    return;
  }
  const open = new Set([...box.querySelectorAll('details[open]')].map((node) => node.dataset.id));
  box.innerHTML = eventsHtml();
  for (const id of open) {
    const node = box.querySelector(`details[data-id="${id}"]`);
    if (node) node.open = true;
  }
}

async function copyFrom(text, button) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Kopiert';
  } catch {
    const input = document.getElementById('webhook-url');
    if (input) {
      input.focus();
      input.select();
    }
    button.textContent = 'Manuell kopieren';
  }
  setTimeout(() => {
    if (button.isConnected) button.textContent = original;
  }, 1500);
}

async function submitSetup(form) {
  state.busy = true;
  state.error = '';
  render();
  try {
    const data = await api('/api/setup', {
      method: 'POST',
      body: JSON.stringify({
        username: form.username.value,
        password: form.password.value,
        passwordConfirm: form.passwordConfirm.value,
      }),
    });
    state.needsSetup = false;
    state.authenticated = true;
    state.username = data.username;
    state.busy = false;
    await enterApp();
  } catch (err) {
    state.error = err.message;
    state.busy = false;
    render();
  }
}

async function submitLogin(form) {
  state.busy = true;
  state.error = '';
  render();
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        username: form.username.value,
        password: form.password.value,
      }),
    });
    state.authenticated = true;
    state.username = data.username;
    state.busy = false;
    await enterApp();
  } catch (err) {
    state.error = err.message;
    state.busy = false;
    render();
  }
}

async function submitPassword(form) {
  state.busy = true;
  state.error = '';
  state.notice = '';
  render();
  try {
    await api('/api/account/password', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword: form.currentPassword.value,
        newPassword: form.newPassword.value,
        passwordConfirm: form.passwordConfirm.value,
      }),
    });
    state.notice = 'Passwort geändert';
  } catch (err) {
    state.error = err.message;
  } finally {
    state.busy = false;
    render();
  }
}

async function saveEndpoint() {
  captureForm();
  state.busy = true;
  state.error = '';
  state.notice = '';
  render();
  try {
    const creating = !state.editing.id;
    const data = await api(creating ? '/api/endpoints' : `/api/endpoints/${state.editing.id}`, {
      method: creating ? 'POST' : 'PUT',
      body: JSON.stringify(endpointPayload(state.editing)),
    });
    if (data.token) {
      state.tokenReveal = { webhookUrl: `${location.origin}${data.webhookPath}` };
      state.editing = null;
      state.view = 'endpoints';
      state.endpoints = (await api('/api/endpoints')).endpoints;
    } else {
      state.notice = 'Gespeichert';
      state.editing = editingFromEndpoint(data.endpoint);
    }
  } catch (err) {
    state.error = err.message;
  } finally {
    state.busy = false;
    render();
  }
}

app.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.action) return;
  event.preventDefault();
  if (state.busy) return;
  if (form.dataset.action === 'setup') void submitSetup(form);
  if (form.dataset.action === 'login') void submitLogin(form);
  if (form.dataset.action === 'password') void submitPassword(form);
  if (form.dataset.action === 'save-endpoint') void saveEndpoint();
});

app.addEventListener('change', (event) => {
  const el = event.target;
  if (!(el instanceof HTMLElement)) return;
  if (el instanceof HTMLSelectElement && el.name === 'parser') {
    captureForm();
    state.editing.parser = el.value;
    state.error = '';
    render();
  }
  if (el.id === 'chat-pick' && el instanceof HTMLSelectElement) {
    const form = document.getElementById('endpoint-form');
    const option = el.selectedOptions[0];
    if (!form || !option || !option.value) return;
    form.targetChatId.value = option.value;
    form.targetLabel.value = option.dataset.name || '';
  }
  if (el instanceof HTMLInputElement && el.name === 'targetChatId' && el.form) {
    el.form.targetLabel.value = '';
  }
});

app.addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest('[data-action]') : null;
  if (!button || button.tagName === 'FORM' || button.type === 'submit') return;
  const action = button.dataset.action;
  if (action === 'stop') return;
  if (action === 'close-token') {
    state.tokenReveal = null;
    render();
    return;
  }
  if (action === 'nav') {
    void showView(button.dataset.view).catch((err) => {
      state.error = err.message;
      render();
    });
    return;
  }
  if (action === 'logout') {
    void api('/api/logout', { method: 'POST', body: '{}' }).finally(() => {
      state.authenticated = false;
      state.wa = null;
      state.tokenReveal = null;
      state.error = '';
      state.notice = '';
      render();
    });
    return;
  }
  if (action === 'new-endpoint') {
    state.editing = blankEndpoint();
    state.view = 'endpoint';
    state.error = '';
    state.notice = '';
    state.chatsInfo = '';
    state.chatsError = '';
    render();
    return;
  }
  if (action === 'edit-endpoint') {
    const endpoint = state.endpoints.find((item) => String(item.id) === button.dataset.id);
    if (!endpoint) return;
    state.editing = editingFromEndpoint(endpoint);
    state.view = 'endpoint';
    state.error = '';
    state.notice = '';
    render();
    return;
  }
  if (action === 'copy-url') {
    const input = document.getElementById('webhook-url');
    if (input) void copyFrom(input.value, button);
    return;
  }
  if (action === 'copy-snippet') {
    const parser = state.meta?.parsers?.find((item) => item.id === state.editing?.parser);
    if (parser?.body) void copyFrom(parser.body, button);
    return;
  }
  if (action === 'load-chats') {
    captureForm();
    state.busy = true;
    render();
    void api('/api/whatsapp/chats?refresh=1')
      .then((data) => {
        state.chats = data.chats;
        state.chatsError = '';
        state.chatsInfo = `${data.chats.length} Chats geladen`;
      })
      .catch((err) => {
        state.chatsError = err.message;
        state.chatsInfo = '';
      })
      .finally(() => {
        state.busy = false;
        render();
      });
    return;
  }
  if (action === 'regen-token') {
    if (!state.editing?.id || !window.confirm('Neuen Token erzeugen? Die bisherige Webhook-URL funktioniert danach nicht mehr.')) return;
    captureForm();
    void api(`/api/endpoints/${state.editing.id}/token`, { method: 'POST', body: '{}' })
      .then((data) => {
        state.tokenReveal = { webhookUrl: `${location.origin}${data.webhookPath}` };
        render();
      })
      .catch((err) => {
        state.error = err.message;
        render();
      });
    return;
  }
  if (action === 'test-endpoint') {
    if (!state.editing?.id) return;
    captureForm();
    void api(`/api/endpoints/${state.editing.id}/test`, { method: 'POST', body: '{}' })
      .then(() => {
        state.notice = 'Test wurde in die Warteschlange gelegt';
        state.error = '';
        render();
      })
      .catch((err) => {
        state.error = err.message;
        state.notice = '';
        render();
      });
    return;
  }
  if (action === 'delete-endpoint') {
    if (!state.editing?.id || !window.confirm('Endpunkt wirklich löschen?')) return;
    void api(`/api/endpoints/${state.editing.id}`, { method: 'DELETE' })
      .then(() => showView('endpoints'))
      .catch((err) => {
        state.error = err.message;
        render();
      });
    return;
  }
  if (action === 'refresh-events') {
    void refreshEvents().catch((err) => {
      state.error = err.message;
      render();
    });
    return;
  }
  if (action === 'wa-restart' || action === 'wa-logout') {
    if (action === 'wa-logout' && !window.confirm('WhatsApp auf diesem Server abmelden? Der nächste Start zeigt einen neuen QR-Code.')) return;
    state.busy = true;
    render();
    const path = action === 'wa-logout' ? '/api/whatsapp/logout' : '/api/whatsapp/restart';
    void api(path, { method: 'POST', body: '{}' })
      .then((wa) => {
        state.wa = wa;
        state.error = '';
      })
      .catch((err) => {
        state.error = err.message;
      })
      .finally(() => {
        state.busy = false;
        render();
      });
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.tokenReveal) {
    state.tokenReveal = null;
    render();
  }
});

async function pollStatus() {
  if (!state.authenticated) return;
  try {
    const wa = await api('/api/whatsapp/status');
    const previous = JSON.stringify(state.wa);
    state.wa = wa;
    paintPill();
    if (JSON.stringify(wa) !== previous && state.view === 'status' && !state.busy) {
      const panel = document.getElementById('status-panel');
      if (panel) panel.innerHTML = statusPanelInnerHtml();
    }
  } catch (err) {
    if (err.status === 401) {
      state.authenticated = false;
      render();
    }
  }
}

async function pollEvents() {
  if (!state.authenticated || state.view !== 'events' || state.busy) return;
  try {
    await refreshEvents();
  } catch (err) {
    if (err.status === 401) {
      state.authenticated = false;
      render();
    }
  }
}

async function boot() {
  try {
    const data = await api('/api/bootstrap');
    state.needsSetup = data.needsSetup;
    state.authenticated = data.authenticated;
    state.username = data.username || '';
    if (data.authenticated) await enterApp();
    else render();
  } catch (err) {
    app.textContent = err.message;
  }
}

setInterval(() => { void pollStatus(); }, 2000);
setInterval(() => { void pollEvents(); }, 5000);
void boot();
