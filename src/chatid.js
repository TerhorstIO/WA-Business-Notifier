function normalizeChatId(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    throw new Error('Zielchat fehlt');
  }

  if (raw.includes('@')) {
    if (!/^\d+(?:-\d+)?@(?:c\.us|g\.us|lid)$/.test(raw)) {
      throw new Error('Ungültige Chat-ID');
    }
    return raw;
  }

  let digits = raw.replace(/[^\d]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length < 8 || digits.length > 15) {
    throw new Error('Telefonnummer ungültig. Internationale Nummer ohne Plus, zum Beispiel 491701234567');
  }
  return `${digits}@c.us`;
}

module.exports = { normalizeChatId };
