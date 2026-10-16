const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const RESTART_WINDOW_MS = 10 * 60 * 1000;
const RESTART_LIMIT = 5;

function createWhatsApp({ dataDir, onReady }) {
  const sessionPath = path.join(dataDir, 'session');
  let client = null;
  let generation = 0;
  let intentionalStop = false;
  let restartTimer = null;
  let restarts = [];
  const state = {
    status: 'starting',
    qr: null,
    info: null,
    lastError: null,
  };
  let chatsCache = { at: 0, chats: [] };

  function setState(patch) {
    const previous = state.status;
    Object.assign(state, patch);
    if (patch.status && patch.status !== previous) {
      console.log(`WhatsApp: ${state.status}`);
    }
  }

  function puppeteerOptions() {
    const options = {
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      options.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    return options;
  }

  function readWid(info) {
    if (!info || !info.wid) return '';
    if (typeof info.wid === 'string') return info.wid;
    return info.wid._serialized || info.wid.user || '';
  }

  function attach(created, myGen) {
    created.on('qr', async (qr) => {
      if (myGen !== generation) return;
      try {
        const image = await QRCode.toDataURL(qr, { margin: 1, width: 280 });
        if (myGen !== generation) return;
        setState({ status: 'qr', qr: image, info: null, lastError: null });
      } catch (err) {
        console.error(err);
        setState({ status: 'qr', qr: null, lastError: 'QR-Code konnte nicht erzeugt werden' });
      }
    });

    created.on('authenticated', () => {
      if (myGen !== generation) return;
      setState({ status: 'authenticated', qr: null, lastError: null });
    });

    created.on('loading_screen', () => {
      if (myGen !== generation || state.status === 'qr' || state.status === 'ready') return;
      setState({ status: 'authenticated' });
    });

    created.on('ready', () => {
      if (myGen !== generation) return;
      const info = created.info || {};
      setState({
        status: 'ready',
        qr: null,
        lastError: null,
        info: {
          pushname: info.pushname || '',
          wid: readWid(info),
        },
      });
      chatsCache = { at: 0, chats: [] };
      if (typeof onReady === 'function') {
        Promise.resolve(onReady()).catch((err) => console.error('Warteschlange', err));
      }
    });

    created.on('auth_failure', (message) => {
      if (myGen !== generation) return;
      setState({
        status: 'auth_failure',
        qr: null,
        info: null,
        lastError: String(message || 'Authentifizierung fehlgeschlagen'),
      });
    });

    created.on('disconnected', (reason) => {
      if (client !== created || intentionalStop || myGen !== generation) return;
      client = null;
      chatsCache = { at: 0, chats: [] };
      setState({
        status: 'disconnected',
        qr: null,
        info: null,
        lastError: reason ? `Verbindung getrennt (${reason})` : 'Verbindung getrennt',
      });
      scheduleRestart();
    });
  }

  function scheduleRestart() {
    if (restartTimer || intentionalStop) return;
    const now = Date.now();
    restarts = restarts.filter((stamp) => now - stamp < RESTART_WINDOW_MS);
    if (restarts.length >= RESTART_LIMIT) {
      setState({
        status: 'error',
        lastError: 'Automatische Neuverbindung gestoppt. Bitte erneut verbinden.',
      });
      return;
    }
    restarts.push(now);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!intentionalStop) void startInner();
    }, 5000);
  }

  async function destroyClient(current) {
    if (!current) return;
    try {
      await current.destroy();
    } catch {
      /* Browser ist bereits geschlossen. */
    }
  }

  async function startInner() {
    const myGen = ++generation;
    intentionalStop = false;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    const previous = client;
    client = null;
    await destroyClient(previous);
    if (myGen !== generation) return;

    setState({ status: 'starting', qr: null, info: null, lastError: null });
    fs.mkdirSync(sessionPath, { recursive: true });
    const created = new Client({
      authStrategy: new LocalAuth({ dataPath: sessionPath }),
      puppeteer: puppeteerOptions(),
    });
    if (myGen !== generation) {
      await destroyClient(created);
      return;
    }
    client = created;
    attach(created, myGen);
    try {
      await created.initialize();
    } catch (err) {
      if (myGen !== generation || client !== created) return;
      console.error(err);
      setState({
        status: 'error',
        qr: null,
        lastError: err.message || 'WhatsApp-Start fehlgeschlagen',
      });
    }
  }

  async function rmSession() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await fs.promises.rm(sessionPath, { recursive: true, force: true });
        return;
      } catch (err) {
        if (attempt === 4) {
          setState({ lastError: `Session konnte nicht gelöscht werden: ${err.message}` });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
  }

  function start() {
    restarts = [];
    void startInner();
  }

  async function restart() {
    restarts = [];
    intentionalStop = true;
    generation += 1;
    const current = client;
    client = null;
    chatsCache = { at: 0, chats: [] };
    await destroyClient(current);
    intentionalStop = false;
    void startInner();
  }

  async function logout() {
    restarts = [];
    intentionalStop = true;
    generation += 1;
    setState({ status: 'starting', qr: null, info: null, lastError: null });
    const current = client;
    client = null;
    chatsCache = { at: 0, chats: [] };
    if (current) {
      try {
        await current.logout();
      } catch {
        /* Noch keine gültige Session. */
      }
      await destroyClient(current);
    }
    await rmSession();
    intentionalStop = false;
    void startInner();
  }

  async function stop() {
    intentionalStop = true;
    generation += 1;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    const current = client;
    client = null;
    await destroyClient(current);
  }

  function isReady() {
    return state.status === 'ready' && client != null;
  }

  async function send(chatId, text) {
    if (!isReady()) {
      const err = new Error('WhatsApp ist nicht verbunden');
      err.code = 'NOT_READY';
      throw err;
    }
    let target = chatId;
    if (chatId.endsWith('@c.us')) {
      const digits = chatId.slice(0, -5);
      const numberId = await client.getNumberId(digits);
      if (!numberId) {
        const err = new Error('Diese Nummer ist nicht bei WhatsApp registriert');
        err.code = 'PERMANENT';
        throw err;
      }
      target = numberId._serialized || chatId;
    }
    await client.sendMessage(target, text);
  }

  async function listChats(force) {
    if (!isReady()) {
      const err = new Error('WhatsApp ist nicht verbunden');
      err.code = 'NOT_READY';
      throw err;
    }
    if (!force && Date.now() - chatsCache.at < 60_000) return chatsCache.chats;
    const chats = await client.getChats();
    const mapped = chats
      .map((chat) => ({
        id: chat.id && chat.id._serialized,
        name: chat.name || chat.formattedTitle || (chat.id && chat.id.user) || 'Chat',
        isGroup: !!chat.isGroup,
      }))
      .filter((chat) => chat.id && /@(?:c\.us|g\.us|lid)$/.test(chat.id));
    mapped.sort((a, b) => Number(b.isGroup) - Number(a.isGroup) || a.name.localeCompare(b.name, 'de'));
    chatsCache = { at: Date.now(), chats: mapped.slice(0, 500) };
    return chatsCache.chats;
  }

  function getState() {
    return {
      status: state.status,
      qr: state.qr,
      info: state.info ? { ...state.info } : null,
      lastError: state.lastError,
    };
  }

  return { start, restart, logout, stop, send, listChats, getState, isReady };
}

module.exports = { createWhatsApp };
