const path = require('path');
const express = require('express');
const { openDatabase } = require('./db');
const { createWhatsApp } = require('./whatsapp');
const { createDispatcher } = require('./hooks');
const { normalizeChatId } = require('./chatid');
const { DEFAULT_TEMPLATE, listParsers } = require('./parsers');
const {
  COOKIE,
  SESSION_MS,
  hashPassword,
  verifyPassword,
  hashToken,
  newToken,
  newSessionId,
  assertUsername,
  assertPassword,
  httpError,
  readCookie,
} = require('./auth');

const PARSER_IDS = new Set(['generic', 'aapanel', 'proxmox']);
const PATH_PATTERN = /^[\w.]+$/;

function mapEndpoint(row) {
  return {
    id: row.id,
    name: row.name,
    enabled: !!row.enabled,
    parser: row.parser,
    template: row.template,
    targetChatId: row.target_chat_id,
    targetLabel: row.target_label,
    titlePath: row.title_path,
    messagePath: row.message_path,
    createdAt: row.created_at,
  };
}

function mapEvent(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    endpointId: row.endpoint_id,
    endpointName: row.endpoint_name,
    status: row.status,
    summary: row.summary,
    payload: row.payload,
    messageText: row.message_text,
    error: row.error,
  };
}

function parseEndpointInput(body) {
  const source = body && typeof body === 'object' ? body : {};
  const name = typeof source.name === 'string' ? source.name.trim() : '';
  if (name.length < 1 || name.length > 80) {
    throw httpError(400, 'Name fehlt oder ist zu lang');
  }
  if (!PARSER_IDS.has(source.parser)) {
    throw httpError(400, 'Parser ungültig');
  }
  const template = typeof source.template === 'string' ? source.template : '';
  if (!template.trim() || template.length > 4000) {
    throw httpError(400, 'Vorlage fehlt oder ist zu lang');
  }
  const titlePath = typeof source.titlePath === 'string' && source.titlePath.trim()
    ? source.titlePath.trim()
    : 'title';
  const messagePath = typeof source.messagePath === 'string' && source.messagePath.trim()
    ? source.messagePath.trim()
    : 'message';
  if (titlePath.length > 120 || messagePath.length > 120 || !PATH_PATTERN.test(titlePath) || !PATH_PATTERN.test(messagePath)) {
    throw httpError(400, 'Feldpfad ungültig');
  }

  let targetChatId = '';
  let targetLabel = typeof source.targetLabel === 'string' ? source.targetLabel.trim() : '';
  const rawTarget = typeof source.targetChatId === 'string' ? source.targetChatId.trim() : '';
  if (rawTarget) {
    try {
      targetChatId = normalizeChatId(rawTarget);
    } catch (err) {
      throw httpError(400, err.message);
    }
    if (!targetLabel) targetLabel = rawTarget;
  }

  return {
    name,
    enabled: source.enabled !== false,
    parser: source.parser,
    template,
    target_chat_id: targetChatId,
    target_label: targetLabel.slice(0, 120),
    title_path: titlePath,
    message_path: messagePath,
  };
}

function endpointId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) return null;
  return id;
}

function sameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === '1',
    path: '/',
    maxAge: SESSION_MS,
  };
}

function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch(next);
  };
}

function createApp() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    throw new Error('Node.js 22 oder neuer wird benötigt');
  }

  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const db = openDatabase(dataDir);
  let dispatcher;
  const whatsapp = createWhatsApp({
    dataDir,
    onReady: () => dispatcher.flush(),
  });
  dispatcher = createDispatcher({ db, whatsapp });

  const app = express();
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api')) return next();
    res.setHeader('Cache-Control', 'no-store');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !sameOrigin(req)) {
      res.status(403).json({ error: 'Ursprung nicht erlaubt' });
      return;
    }
    next();
  });

  function currentSession(req) {
    const sid = readCookie(req, COOKIE);
    if (!sid) return null;
    const session = db.getSession(sid);
    if (!session || session.expires_at <= Date.now()) {
      if (session) db.deleteSession(sid);
      return null;
    }
    return sid;
  }

  function requireAuth(req, res, next) {
    const sid = currentSession(req);
    if (!sid || !db.getUser()) {
      res.status(401).json({ error: 'Nicht angemeldet' });
      return;
    }
    db.touchSession(sid, Date.now() + SESSION_MS);
    next();
  }

  function issueSession(res) {
    const sid = newSessionId();
    db.createSession(sid, Date.now() + SESSION_MS);
    res.cookie(COOKIE, sid, cookieOptions());
  }

  app.post('/hooks/:token', (req, res) => {
    const endpoint = db.getEndpointByTokenHash(hashToken(req.params.token || ''));
    if (!endpoint) {
      res.status(401).json({ error: 'Ungültiger Token' });
      return;
    }
    if (!endpoint.enabled) {
      res.status(404).json({ error: 'Endpunkt ist deaktiviert' });
      return;
    }
    const result = dispatcher.accept(endpoint, req.body);
    res.status(result.httpStatus).json(result.body);
  });

  app.get('/api/bootstrap', (req, res) => {
    const user = db.getUser();
    const authenticated = !!(user && currentSession(req));
    res.json({
      needsSetup: !user,
      authenticated,
      username: authenticated ? user.username : null,
    });
  });

  app.post('/api/setup', asyncRoute(async (req, res) => {
    if (db.getUser()) throw httpError(409, 'Konto existiert bereits');
    const username = assertUsername(req.body && req.body.username);
    assertPassword(req.body && req.body.password);
    if (!req.body || req.body.password !== req.body.passwordConfirm) {
      throw httpError(400, 'Passwörter stimmen nicht überein');
    }
    const hashed = hashPassword(req.body.password);
    db.createUser(username, hashed.hash, hashed.salt);
    issueSession(res);
    res.status(201).json({ username });
  }));

  app.post('/api/login', (req, res) => {
    const user = db.getUser();
    if (!user) {
      res.status(409).json({ error: 'Zuerst ein Konto anlegen' });
      return;
    }
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const passwordOk = verifyPassword(password, user.password_salt, user.password_hash);
    if (username !== user.username || !passwordOk) {
      res.status(401).json({ error: 'Anmeldung fehlgeschlagen' });
      return;
    }
    issueSession(res);
    res.json({ username: user.username });
  });

  app.use('/api', requireAuth);

  app.get('/api/meta', (req, res) => {
    res.json({ parsers: listParsers(), defaultTemplate: DEFAULT_TEMPLATE });
  });

  app.post('/api/logout', (req, res) => {
    const sid = readCookie(req, COOKIE);
    if (sid) db.deleteSession(sid);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.post('/api/account/password', asyncRoute(async (req, res) => {
    const user = db.getUser();
    const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    if (!verifyPassword(currentPassword, user.password_salt, user.password_hash)) {
      throw httpError(401, 'Aktuelles Passwort ist falsch');
    }
    assertPassword(req.body && req.body.newPassword);
    if (req.body.newPassword !== req.body.passwordConfirm) {
      throw httpError(400, 'Passwörter stimmen nicht überein');
    }
    const hashed = hashPassword(req.body.newPassword);
    db.updatePassword(hashed.hash, hashed.salt);
    db.deleteAllSessions();
    issueSession(res);
    res.json({ ok: true });
  }));

  app.get('/api/whatsapp/status', (req, res) => {
    res.json({ ...whatsapp.getState(), queueCount: db.countOutbound() });
  });

  app.post('/api/whatsapp/logout', asyncRoute(async (req, res) => {
    await whatsapp.logout();
    res.json({ ...whatsapp.getState(), queueCount: db.countOutbound() });
  }));

  app.post('/api/whatsapp/restart', asyncRoute(async (req, res) => {
    await whatsapp.restart();
    res.json({ ...whatsapp.getState(), queueCount: db.countOutbound() });
  }));

  app.get('/api/whatsapp/chats', asyncRoute(async (req, res) => {
    try {
      const chats = await whatsapp.listChats(req.query.refresh === '1');
      res.json({ chats });
    } catch (err) {
      if (err.code === 'NOT_READY') throw httpError(409, err.message);
      throw err;
    }
  }));

  app.get('/api/endpoints', (req, res) => {
    res.json({ endpoints: db.listEndpoints().map(mapEndpoint) });
  });

  app.post('/api/endpoints', asyncRoute(async (req, res) => {
    const fields = parseEndpointInput(req.body);
    const token = newToken();
    const id = db.insertEndpoint({ ...fields, token_hash: hashToken(token) });
    res.status(201).json({
      endpoint: mapEndpoint(db.getEndpoint(id)),
      token,
      webhookPath: `/hooks/${token}`,
    });
  }));

  app.put('/api/endpoints/:id', asyncRoute(async (req, res) => {
    const id = endpointId(req.params.id);
    if (!id || !db.getEndpoint(id)) throw httpError(404, 'Endpunkt nicht gefunden');
    const fields = parseEndpointInput(req.body);
    db.updateEndpoint(id, fields);
    res.json({ endpoint: mapEndpoint(db.getEndpoint(id)) });
  }));

  app.delete('/api/endpoints/:id', (req, res) => {
    const id = endpointId(req.params.id);
    if (!id || !db.getEndpoint(id)) {
      res.status(404).json({ error: 'Endpunkt nicht gefunden' });
      return;
    }
    db.deleteEndpoint(id);
    res.json({ ok: true });
  });

  app.post('/api/endpoints/:id/token', (req, res) => {
    const id = endpointId(req.params.id);
    if (!id || !db.getEndpoint(id)) {
      res.status(404).json({ error: 'Endpunkt nicht gefunden' });
      return;
    }
    const token = newToken();
    db.updateToken(id, hashToken(token));
    res.json({
      endpoint: mapEndpoint(db.getEndpoint(id)),
      token,
      webhookPath: `/hooks/${token}`,
    });
  });

  app.post('/api/endpoints/:id/test', (req, res) => {
    const id = endpointId(req.params.id);
    const endpoint = id && db.getEndpoint(id);
    if (!endpoint) {
      res.status(404).json({ error: 'Endpunkt nicht gefunden' });
      return;
    }
    const result = dispatcher.sendTest(endpoint);
    res.status(result.httpStatus).json(result.body);
  });

  app.get('/api/events', (req, res) => {
    res.json({ events: db.listEvents(200).map(mapEvent) });
  });

  app.use(express.static(path.join(__dirname, '..', 'public'), {
    etag: false,
    maxAge: 0,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-store');
    },
  }));

  app.use((err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Ungültiges JSON' });
      return;
    }
    if (err.status === 413 || err.type === 'entity.too.large') {
      res.status(413).json({ error: 'Anfrage zu groß' });
      return;
    }
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Interner Fehler' : err.message });
  });

  return { app, db, whatsapp, dispatcher, dataDir };
}

function main() {
  const { app, db, whatsapp, dispatcher } = createApp();
  const host = process.env.HOST || '0.0.0.0';
  const port = Number(process.env.PORT || 3000);
  whatsapp.start();
  dispatcher.start();
  const server = app.listen(port, host, () => {
    const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    console.log(`Monitor läuft auf http://${shownHost}:${port}`);
  });

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    await whatsapp.stop();
    db.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on('SIGINT', () => { shutdown().catch((err) => console.error(err)); });
  process.on('SIGTERM', () => { shutdown().catch((err) => console.error(err)); });
}

if (require.main === module) {
  main();
}

module.exports = { createApp };
