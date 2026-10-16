const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

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
      enabled INTEGER NOT NULL DEFAULT 1,
      parser TEXT NOT NULL,
      template TEXT NOT NULL,
      target_chat_id TEXT NOT NULL DEFAULT '',
      target_label TEXT NOT NULL DEFAULT '',
      title_path TEXT NOT NULL DEFAULT 'title',
      message_path TEXT NOT NULL DEFAULT 'message',
      created_at TEXT NOT NULL
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
        name, token_hash, enabled, parser, template, target_chat_id, target_label, title_path, message_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateEndpoint: database.prepare(`
      UPDATE endpoints
      SET name = ?, enabled = ?, parser = ?, template = ?, target_chat_id = ?, target_label = ?, title_path = ?, message_path = ?
      WHERE id = ?
    `),
    updateToken: database.prepare('UPDATE endpoints SET token_hash = ? WHERE id = ?'),
    deleteEndpoint: database.prepare('DELETE FROM endpoints WHERE id = ?'),
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
      fields.enabled ? 1 : 0,
      fields.parser,
      fields.template,
      fields.target_chat_id,
      fields.target_label,
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
      fields.target_chat_id,
      fields.target_label,
      fields.title_path,
      fields.message_path,
      id,
    );
  }

  function updateToken(id, tokenHash) {
    stmts.updateToken.run(tokenHash, id);
  }

  function deleteEndpoint(id) {
    stmts.deleteEndpoint.run(id);
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
