const DEFAULT_TEMPLATE = '*{{source}}* {{title}}\n\n{{message}}';

const AAPANEL_BODY = `{
  "title": "$title",
  "message": "$msg",
  "type": "$type"
}`;

const PROXMOX_BODY = `{
  "title": "{{ escape title }}",
  "message": "{{ escape message }}",
  "severity": "{{ severity }}",
  "timestamp": {{ timestamp }},
  "fields": {{ json fields }}
}`;

const PARSERS = {
  generic: {
    id: 'generic',
    label: 'Generisches JSON',
    hint: 'Beliebiges JSON per POST. Titel und Text werden über die Punktpfade gelesen, zum Beispiel content.text.',
    body: null,
  },
  aapanel: {
    id: 'aapanel',
    label: 'aaPanel',
    hint: 'In aaPanel unter Einstellungen → Alarm → Webhook die URL eintragen, Request Header {} setzen und diesen Body als Custom Parameters verwenden.',
    body: AAPANEL_BODY,
  },
  proxmox: {
    id: 'proxmox',
    label: 'Proxmox',
    hint: 'In Proxmox unter Datacenter → Benachrichtigungen ein Webhook-Ziel anlegen. Methode POST, Header Content-Type: application/json, URL die Webhook-URL, Body wie unten.',
    body: PROXMOX_BODY,
  },
};

function listParsers() {
  return Object.values(PARSERS);
}

function plainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function assertObject(body) {
  if (!plainObject(body)) {
    throw new Error('JSON-Objekt erwartet');
  }
}

function blocked(part) {
  return part === '__proto__' || part === 'prototype' || part === 'constructor';
}

function getPath(obj, path) {
  const parts = String(path || '').split('.').filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (blocked(part) || current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return parts.length ? current : undefined;
}

function setPath(obj, path, value) {
  const parts = String(path || '').split('.').filter(Boolean);
  if (!parts.length) return;
  let current = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (blocked(part)) return;
    if (!plainObject(current[part])) current[part] = {};
    current = current[part];
  }
  const last = parts[parts.length - 1];
  if (!blocked(last)) current[last] = value;
}

function asText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeTimestamp(value) {
  if (value == null || value === '') return new Date().toISOString();
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return new Date().toISOString();
    const ms = numeric < 1e12 ? numeric * 1000 : numeric;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function readFields(body) {
  return plainObject(body.fields) ? body.fields : {};
}

function parseGeneric(endpoint, body) {
  assertObject(body);
  const titlePath = endpoint.title_path || 'title';
  const messagePath = endpoint.message_path || 'message';
  const title = asText(getPath(body, titlePath)).trim();
  const message = asText(getPath(body, messagePath)).trim();
  if (!title && !message) {
    throw new Error(`Keine Daten unter „${titlePath}“ oder „${messagePath}“`);
  }
  return {
    title: title || 'Meldung',
    message,
    severity: asText(body.severity).trim(),
    type: asText(body.type).trim(),
    timestamp: normalizeTimestamp(body.timestamp),
    fields: readFields(body),
  };
}

function parseAapanel(body) {
  assertObject(body);
  const hasDirect = typeof body.title === 'string' || typeof body.message === 'string' || typeof body.msg === 'string';
  if (hasDirect) {
    const title = asText(body.title).trim();
    const message = asText(body.message || body.msg).trim();
    if (!title && !message) throw new Error('aaPanel-Felder title/message oder content.text fehlen');
    return {
      title: title || 'aaPanel',
      message,
      severity: '',
      type: asText(body.type).trim(),
      timestamp: normalizeTimestamp(body.timestamp),
      fields: {},
    };
  }

  const text = body.content && typeof body.content.text === 'string' ? body.content.text.trim() : '';
  if (!text) throw new Error('aaPanel-Felder title/message oder content.text fehlen');
  return {
    title: 'aaPanel',
    message: text,
    severity: '',
    type: asText(body.msg_type).trim(),
    timestamp: new Date().toISOString(),
    fields: {},
  };
}

function parseProxmox(body) {
  assertObject(body);
  const title = asText(body.title).trim();
  const message = asText(body.message).trim();
  if (!title && !message) throw new Error('Proxmox-Felder title oder message fehlen');
  const fields = readFields(body);
  return {
    title: title || 'Proxmox',
    message,
    severity: asText(body.severity).trim(),
    type: asText(fields.type).trim(),
    timestamp: normalizeTimestamp(body.timestamp),
    fields,
  };
}

function parsePayload(endpoint, body) {
  let parsed;
  if (endpoint.parser === 'generic') parsed = parseGeneric(endpoint, body);
  else if (endpoint.parser === 'aapanel') parsed = parseAapanel(body);
  else if (endpoint.parser === 'proxmox') parsed = parseProxmox(body);
  else throw new Error('Unbekannter Parser');
  parsed.source = endpoint.name;
  return parsed;
}

function formatFields(fields) {
  if (fields == null || fields === '') return '';
  if (typeof fields !== 'object') return String(fields);
  if (Array.isArray(fields)) return fields.length ? JSON.stringify(fields, null, 2) : '';
  if (!Object.keys(fields).length) return '';
  return JSON.stringify(fields, null, 2);
}

function renderTemplate(template, vars) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key) || vars[key] == null) return '';
    return String(vars[key]);
  }).trim();
}

function buildMessage(endpoint, parsed) {
  const text = renderTemplate(endpoint.template || DEFAULT_TEMPLATE, {
    title: parsed.title,
    message: parsed.message,
    severity: parsed.severity,
    type: parsed.type,
    source: parsed.source,
    timestamp: parsed.timestamp,
    fields: formatFields(parsed.fields),
  });
  if (!text) throw new Error('Die Vorlage hat keinen Text erzeugt');
  if (text.length > 3500) return `${text.slice(0, 3490)}\n…`;
  return text;
}

function samplePayload(endpoint) {
  if (endpoint.parser === 'aapanel') {
    return { title: 'Test', message: 'Testmeldung aus dem Webinterface', type: 'test' };
  }
  if (endpoint.parser === 'proxmox') {
    return {
      title: 'Test',
      message: 'Testmeldung aus dem Webinterface',
      severity: 'info',
      timestamp: Math.floor(Date.now() / 1000),
      fields: { type: 'test', hostname: 'monitor' },
    };
  }
  const body = { severity: 'info', type: 'test', timestamp: new Date().toISOString() };
  setPath(body, endpoint.title_path || 'title', 'Test');
  setPath(body, endpoint.message_path || 'message', 'Testmeldung aus dem Webinterface');
  return body;
}

module.exports = {
  DEFAULT_TEMPLATE,
  listParsers,
  parsePayload,
  buildMessage,
  samplePayload,
};
