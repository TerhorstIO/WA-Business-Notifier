const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function columnNames(database, table) {
  return database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

function migrateLegacyTargets(database) {
  if (!columnNames(database, 'endpoints').includes('target_chat_id')) return;
  const rows = database.prepare(`
    SELECT id, name, target_chat_id, target_label
    FROM endpoints
    WHERE target_chat_id != ''
  `).all();
  const insertRecipient = database.prepare(`
    INSERT INTO recipients (name, chat_id, enabled, created_at) VALUES (?, ?, 1, ?)
  `);
  const link = database.prepare(`
    INSERT OR IGNORE INTO endpoint_recipients (endpoint_id, recipient_id) VALUES (?, ?)
  `);
  const now = new Date().toISOString();
  for (const row of rows) {
    const info = insertRecipient.run(row.target_label || row.name, row.target_chat_id, now);
    link.run(row.id, Number(info.lastInsertRowid));
  }
  database.exec('ALTER TABLE endpoints DROP COLUMN target_chat_id');
  database.exec('ALTER TABLE endpoints DROP COLUMN target_label');
}

function ensureTokenColumn(database) {
  if (columnNames(database, 'endpoints').includes('token')) return;
  database.exec(`ALTER TABLE endpoints ADD COLUMN token TEXT NOT NULL DEFAULT ''`);
}

function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const database = new DatabaseSync(path.join(dataDir, 'monitor.db'));
  database.exec('PRAGMA journal_mode = DELETE');
  database.exec('PRAGMA busy_timeout = 3000');
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS endpoints (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      parser TEXT NOT NULL,
      template TEXT NOT NULL,
      title_path TEXT NOT NULL DEFAULT 'title',
      message_path TEXT NOT NULL DEFAULT 'message',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recipients (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS endpoint_recipients (
      endpoint_id INTEGER NOT NULL,
      recipient_id INTEGER NOT NULL,
      PRIMARY KEY (endpoint_id, recipient_id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL,
      endpoint_id INTEGER,
      endpoint_name TEXT,
      status TEXT NOT NULL,
      summary TEXT,
      payload TEXT,
      message_text TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS outbound (
      id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL,
      event_id INTEGER NOT NULL,
      chat_id TEXT NOT NULL,
      body TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT
    );
  `);

  migrateLegacyTargets(database);
  ensureTokenColumn(database);

  const stmts = {
    getUser: database.prepare('SELECT id, username, password_hash, password_salt, created_at FROM users WHERE id = 1'),
    insertUser: database.prepare(
      'INSERT INTO users (id, username, password_hash, password_salt, created_at) VALUES (1, ?, ?, ?, ?)',
    ),
    updatePassword: database.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = 1'),
    insertSession: database.prepare('INSERT INTO sessions (id, expires_at) VALUES (?, ?)'),
    getSession: database.prepare('SELECT id, expires_at FROM sessions WHERE id = ?'),
    deleteSession: database.prepare('DELETE FROM sessions WHERE id = ?'),
    deleteAllSessions: database.prepare('DELETE FROM sessions'),
    touchSession: database.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?'),
    purgeSessions: database.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    listEndpoints: database.prepare('SELECT * FROM endpoints ORDER BY id ASC'),
    getEndpoint: database.prepare('SELECT * FROM endpoints WHERE id = ?'),
    getEndpointByTokenHash: database.prepare('SELECT * FROM endpoints WHERE token_hash = ?'),
    insertEndpoint: database.prepare(`
      INSERT INTO endpoints (
        name, token_hash, token, enabled, parser, template, title_path, message_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateEndpoint: database.prepare(`
      UPDATE endpoints
      SET name = ?, enabled = ?, parser = ?, template = ?, title_path = ?, message_path = ?
      WHERE id = ?
    `),
    updateToken: database.prepare('UPDATE endpoints SET token_hash = ?, token = ? WHERE id = ?'),
    deleteEndpoint: database.prepare('DELETE FROM endpoints WHERE id = ?'),
    deleteEndpointLinks: database.prepare('DELETE FROM endpoint_recipients WHERE endpoint_id = ?'),
    listRecipients: database.prepare('SELECT * FROM recipients ORDER BY id ASC'),
    getRecipient: database.prepare('SELECT * FROM recipients WHERE id = ?'),
    insertRecipient: database.prepare(`
      INSERT INTO recipients (name, chat_id, enabled, created_at) VALUES (?, ?, ?, ?)
    `),
    updateRecipient: database.prepare(`
      UPDATE recipients SET name = ?, chat_id = ?, enabled = ? WHERE id = ?
    `),
    deleteRecipient: database.prepare('DELETE FROM recipients WHERE id = ?'),
    deleteRecipientLinks: database.prepare('DELETE FROM endpoint_recipients WHERE recipient_id = ?'),
    listRecipientEndpoints: database.prepare(`
      SELECT endpoint_id FROM endpoint_recipients WHERE recipient_id = ? ORDER BY endpoint_id ASC
    `),
    insertLink: database.prepare(`
      INSERT OR IGNORE INTO endpoint_recipients (endpoint_id, recipient_id) VALUES (?, ?)
    `),
    listRecipientsForEndpoint: database.prepare(`
      SELECT recipients.*
      FROM recipients
      JOIN endpoint_recipients ON endpoint_recipients.recipient_id = recipients.id
      WHERE endpoint_recipients.endpoint_id = ? AND recipients.enabled = 1
      ORDER BY recipients.id ASC
    `),
    insertEvent: database.prepare(`
      INSERT INTO events (
        created_at, endpoint_id, endpoint_name, status, summary, payload, message_text, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateEvent: database.prepare('UPDATE events SET status = ?, error = ? WHERE id = ?'),
    listEvents: database.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?'),
    pruneEvents: database.prepare(`
      DELETE FROM events
      WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)
    `),
    insertOutbound: database.prepare(`
      INSERT INTO outbound (created_at, event_id, chat_id, body, attempts, last_attempt_at)
      VALUES (?, ?, ?, ?, 0, NULL)
    `),
    listDueOutbound: database.prepare(`
      SELECT id, event_id, chat_id, body, attempts, last_attempt_at
      FROM outbound
      WHERE last_attempt_at IS NULL OR last_attempt_at <= ?
      ORDER BY id ASC
      LIMIT 10
    `),
    beginAttempt: database.prepare('UPDATE outbound SET last_attempt_at = ? WHERE id = ?'),
    markAttempt: database.prepare('UPDATE outbound SET attempts = ?, last_attempt_at = ? WHERE id = ?'),
    deleteOutbound: database.prepare('DELETE FROM outbound WHERE id = ?'),
    listExpired: database.prepare('SELECT id, event_id FROM outbound WHERE created_at < ?'),
    countOutbound: database.prepare('SELECT COUNT(*) AS count FROM outbound'),
  };

  function rowId(info) {
    return Number(info.lastInsertRowid);
  }

  function getUser() {
    return stmts.getUser.get();
  }

  function createUser(username, passwordHash, passwordSalt) {
    database.exec('BEGIN IMMEDIATE');
    try {
      if (stmts.getUser.get()) {
        const err = new Error('Konto existiert bereits');
        err.status = 409;
        throw err;
      }
      stmts.insertUser.run(username, passwordHash, passwordSalt, new Date().toISOString());
      database.exec('COMMIT');
    } catch (err) {
      try { database.exec('ROLLBACK'); } catch { /* already closed */ }
      throw err;
    }
  }

  function updatePassword(passwordHash, passwordSalt) {
    stmts.updatePassword.run(passwordHash, passwordSalt);
  }

  function createSession(id, expiresAt) {
    stmts.insertSession.run(id, expiresAt);
  }

  function getSession(id) {
    return stmts.getSession.get(id);
  }

  function deleteSession(id) {
    stmts.deleteSession.run(id);
  }

  function deleteAllSessions() {
    stmts.deleteAllSessions.run();
  }

  function touchSession(id, expiresAt) {
    stmts.touchSession.run(expiresAt, id);
  }

  function purgeSessions(now) {
    stmts.purgeSessions.run(now);
  }

  function listEndpoints() {
    return stmts.listEndpoints.all();
  }

  function getEndpoint(id) {
    return stmts.getEndpoint.get(id);
  }

  function getEndpointByTokenHash(tokenHash) {
    return stmts.getEndpointByTokenHash.get(tokenHash);
  }

  function insertEndpoint(fields) {
    const info = stmts.insertEndpoint.run(
      fields.name,
      fields.token_hash,
      fields.token,
      fields.enabled ? 1 : 0,
      fields.parser,
      fields.template,
      fields.title_path,
      fields.message_path,
      new Date().toISOString(),
    );
    return rowId(info);
  }

  function updateEndpoint(id, fields) {
    stmts.updateEndpoint.run(
      fields.name,
      fields.enabled ? 1 : 0,
      fields.parser,
      fields.template,
      fields.title_path,
      fields.message_path,
      id,
    );
  }

  function updateToken(id, tokenHash, token) {
    stmts.updateToken.run(tokenHash, token, id);
  }

  function deleteEndpoint(id) {
    stmts.deleteEndpointLinks.run(id);
    stmts.deleteEndpoint.run(id);
  }

  function listRecipients() {
    return stmts.listRecipients.all().map((row) => ({
      ...row,
      endpointIds: stmts.listRecipientEndpoints.all(row.id).map((link) => link.endpoint_id),
    }));
  }

  function getRecipient(id) {
    const row = stmts.getRecipient.get(id);
    if (!row) return undefined;
    return {
      ...row,
      endpointIds: stmts.listRecipientEndpoints.all(id).map((link) => link.endpoint_id),
    };
  }

  function insertRecipient(fields) {
    const info = stmts.insertRecipient.run(
      fields.name,
      fields.chat_id,
      fields.enabled ? 1 : 0,
      new Date().toISOString(),
    );
    return rowId(info);
  }

  function updateRecipient(id, fields) {
    stmts.updateRecipient.run(fields.name, fields.chat_id, fields.enabled ? 1 : 0, id);
  }

  function setRecipientEndpoints(recipientId, endpointIds) {
    stmts.deleteRecipientLinks.run(recipientId);
    for (const endpointId of endpointIds) {
      if (stmts.getEndpoint.get(endpointId)) stmts.insertLink.run(endpointId, recipientId);
    }
  }

  function deleteRecipient(id) {
    stmts.deleteRecipientLinks.run(id);
    stmts.deleteRecipient.run(id);
  }

  function listRecipientsForEndpoint(endpointId) {
    return stmts.listRecipientsForEndpoint.all(endpointId);
  }

  function insertEvent(fields) {
    const info = stmts.insertEvent.run(
      new Date().toISOString(),
      fields.endpointId ?? null,
      fields.endpointName ?? null,
      fields.status,
      fields.summary ?? '',
      fields.payload ?? '',
      fields.messageText ?? '',
      fields.error ?? null,
    );
    return rowId(info);
  }

  function updateEvent(id, status, error) {
    stmts.updateEvent.run(status, error ?? null, id);
  }

  function listEvents(limit) {
    return stmts.listEvents.all(limit);
  }

  function pruneEvents(keep) {
    stmts.pruneEvents.run(keep);
  }

  function insertOutbound(fields) {
    const info = stmts.insertOutbound.run(
      new Date().toISOString(),
      fields.eventId,
      fields.chatId,
      fields.body,
    );
    return rowId(info);
  }

  function listDueOutbound(notAfterIso) {
    return stmts.listDueOutbound.all(notAfterIso);
  }

  function beginAttempt(id, iso) {
    stmts.beginAttempt.run(iso, id);
  }

  function markAttempt(id, attempts, iso) {
    stmts.markAttempt.run(attempts, iso, id);
  }

  function deleteOutbound(id) {
    stmts.deleteOutbound.run(id);
  }

  function listExpired(cutoffIso) {
    return stmts.listExpired.all(cutoffIso);
  }

  function countOutbound() {
    const row = stmts.countOutbound.get();
    return Number(row.count);
  }

  function close() {
    database.close();
  }

  return {
    getUser,
    createUser,
    updatePassword,
    createSession,
    getSession,
    deleteSession,
    deleteAllSessions,
    touchSession,
    purgeSessions,
    listEndpoints,
    getEndpoint,
    getEndpointByTokenHash,
    insertEndpoint,
    updateEndpoint,
    updateToken,
    deleteEndpoint,
    listRecipients,
    getRecipient,
    insertRecipient,
    updateRecipient,
    setRecipientEndpoints,
    deleteRecipient,
    listRecipientsForEndpoint,
    insertEvent,
    updateEvent,
    listEvents,
    pruneEvents,
    insertOutbound,
    listDueOutbound,
    beginAttempt,
    markAttempt,
    deleteOutbound,
    listExpired,
    countOutbound,
    close,
  };
}

module.exports = { openDatabase };
