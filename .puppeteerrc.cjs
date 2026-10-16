const os = require('os');
const path = require('path');

const cacheDirectory = process.env.PUPPETEER_CACHE_DIR
  || (process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'whatsapp-monitor', 'puppeteer')
    : path.join(__dirname, '.cache', 'puppeteer'));

module.exports = { cacheDirectory };
