const { parsePayload, buildMessage, samplePayload } = require('./parsers');

const KEEP_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 15 * 1000;
const MAX_ATTEMPTS = 5;

function clip(text, max) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function safeJson(value) {
  if (value === undefined) return '';
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

function createDispatcher({ db, whatsapp }) {
  let flushing = false;

  function recordEvent(fields) {
    const id = db.insertEvent(fields);
    db.pruneEvents(500);
    return id;
  }

  function accept(endpoint, payload, { test = false } = {}) {
    const payloadText = clip(safeJson(payload), 8000);
    let parsed;
    let message;
    try {
      parsed = parsePayload(endpoint, payload);
      message = buildMessage(endpoint, parsed);
    } catch (err) {
      recordEvent({
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        status: 'failed',
        summary: test ? 'Test' : 'Webhook',
        payload: payloadText,
        messageText: '',
        error: err.message,
      });
      return { httpStatus: 400, body: { error: err.message } };
    }

    const summary = clip(test ? `Test: ${parsed.title}` : parsed.title, 200);
    if (!endpoint.target_chat_id) {
      recordEvent({
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        status: 'failed',
        summary,
        payload: payloadText,
        messageText: message,
        error: 'Kein Zielchat konfiguriert',
      });
      return { httpStatus: 422, body: { error: 'Kein Zielchat konfiguriert' } };
    }

    const eventId = recordEvent({
      endpointId: endpoint.id,
      endpointName: endpoint.name,
      status: 'queued',
      summary,
      payload: payloadText,
      messageText: message,
      error: null,
    });
    db.insertOutbound({ eventId, chatId: endpoint.target_chat_id, body: message });
    setImmediate(() => {
      flush().catch((err) => console.error('Versand', err));
    });
    return { httpStatus: 202, body: { ok: true, id: eventId } };
  }

  function sendTest(endpoint) {
    return accept(endpoint, samplePayload(endpoint), { test: true });
  }

  function expire() {
    const cutoff = new Date(Date.now() - KEEP_MS).toISOString();
    for (const row of db.listExpired(cutoff)) {
      db.updateEvent(row.event_id, 'failed', 'Abgelaufen: WhatsApp war länger als 24 Stunden nicht verbunden');
      db.deleteOutbound(row.id);
    }
  }

  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      expire();
      if (!whatsapp.isReady()) return;
      const dueBefore = new Date(Date.now() - RETRY_MS).toISOString();
      const rows = db.listDueOutbound(dueBefore);
      for (const row of rows) {
        if (!whatsapp.isReady()) break;
        const now = new Date().toISOString();
        db.beginAttempt(row.id, now);
        try {
          await whatsapp.send(row.chat_id, row.body);
          db.updateEvent(row.event_id, 'sent', null);
          db.deleteOutbound(row.id);
        } catch (err) {
          if (err.code === 'NOT_READY') break;
          const attempts = row.attempts + 1;
          if (attempts >= MAX_ATTEMPTS || err.code === 'PERMANENT') {
            db.updateEvent(row.event_id, 'failed', err.message);
            db.deleteOutbound(row.id);
          } else {
            db.markAttempt(row.id, attempts, new Date().toISOString());
            db.updateEvent(row.event_id, 'queued', err.message);
          }
        }
      }
    } finally {
      flushing = false;
    }
  }

  function start() {
    setInterval(() => {
      db.purgeSessions(Date.now());
      flush().catch((err) => console.error('Versand', err));
    }, 2000);
  }

  return { accept, sendTest, flush, start };
}

module.exports = { createDispatcher };
