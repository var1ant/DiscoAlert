'use strict';
// discord-telegram-watcher
// Polls one Discord channel with a bot token and forwards new messages to a Telegram chat.
// Built-in Node modules only (no npm install needed). Needs Node 14 or newer.
// Config is read from config.env next to this file.
//
// Modes:
//   node watcher.js              run the watcher loop
//   node watcher.js --check      test Discord access and send a Telegram test message
//   node watcher.js --find-chat  list Telegram chat IDs that have messaged your bot

const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE = __dirname;
const STATE_FILE = path.join(BASE, 'state.json');
const LOG_FILE = path.join(BASE, 'watcher.log');
const UA = 'DiscordBot (https://github.com/, 1.0)'; // Discord requires: DiscordBot ($url, $versionNumber)
const MAX_PAGES = 3; // 3 pages x 50 messages = up to 150 backlog messages per cycle
const ERROR_COOLDOWN_MS = 3600 * 1000; // at most one error alert to Telegram per hour

function log(level, msg) {
  const line = new Date().toISOString() + ' ' + level + ' ' + msg + '\n';
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1000000) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    }
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) { /* logging must never crash the watcher */ }
  process.stdout.write(line);
}

function loadConfig() {
  const cfg = {};
  let raw;
  try {
    raw = fs.readFileSync(path.join(BASE, 'config.env'), 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    console.error('Cannot read config.env next to watcher.js. Copy config.env.example to config.env and fill it in.');
    process.exit(1);
  }
  raw.split(/\r?\n/).forEach(function (line) {
    line = line.trim();
    if (!line || line.charAt(0) === '#') return;
    const i = line.indexOf('=');
    if (i < 1) return;
    cfg[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  });
  return cfg;
}

const CFG = loadConfig();

function need(keys) {
  const missing = keys.filter(function (k) { return !CFG[k]; });
  if (missing.length) {
    console.error('config.env is missing: ' + missing.join(', '));
    process.exit(1);
  }
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function request(method, urlStr, headers, body) {
  return new Promise(function (resolve, reject) {
    const u = new URL(urlStr);
    const opts = {
      method: method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: Object.assign({}, headers || {}),
      timeout: 20000
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(opts, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({ code: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('timeout', function () { req.destroy(new Error('Request timed out')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function discordGet(p) {
  return request('GET', 'https://discord.com/api/v10' + p, {
    'Authorization': 'Bot ' + CFG.DISCORD_BOT_TOKEN,
    'User-Agent': UA
  });
}

async function telegram(text) {
  const r = await request('POST', 'https://api.telegram.org/bot' + CFG.TELEGRAM_BOT_TOKEN + '/sendMessage',
    { 'Content-Type': 'application/json' },
    JSON.stringify({ chat_id: CFG.TELEGRAM_CHAT_ID, text: text, parse_mode: 'HTML' }));
  if (r.code !== 200) throw new Error('Telegram ' + r.code + ': ' + r.body.slice(0, 300));
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}

function saveState(state) {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Message text plus any embed title, description and fields (bots often post embeds).
function fullText(m) {
  const parts = [m.content || ''];
  (m.embeds || []).forEach(function (e) {
    if (e.title) parts.push(e.title);
    if (e.description) parts.push(e.description);
    (e.fields || []).forEach(function (f) { parts.push((f.name || '') + ': ' + (f.value || '')); });
  });
  return parts.join('\n').trim();
}

function shouldAlert(m) {
  if (String(CFG.IGNORE_BOTS || 'false').toLowerCase() === 'true' && m.author && m.author.bot) return false;
  const kws = String(CFG.KEYWORDS || '').split(',')
    .map(function (k) { return k.trim().toLowerCase(); })
    .filter(Boolean);
  if (!kws.length) return true;
  const text = fullText(m).toLowerCase();
  return kws.some(function (k) { return text.indexOf(k) !== -1; });
}

// Telegram message layout: bold sender name, then the message text.
function fmt(m) {
  const a = m.author || {};
  const name = (m.member && m.member.nick) || a.global_name || a.username || 'Unknown';
  let body = esc(fullText(m));
  const files = (m.attachments || []).map(function (x) { return x.url; });
  if (files.length) body += (body ? '\n\n' : '') + 'Attachments:\n' + files.map(esc).join('\n');
  if (!body) body = '(no text content)';
  if (body.length > 3500) body = body.slice(0, 3500) + '... (truncated)';
  return '<b>' + esc(name) + '</b>\n' + body;
}

function discordHint(code, body) {
  if (body.indexOf('40333') !== -1) {
    return '40333 = Discord (Cloudflare) blocked this request. Usually this network or IP is blocked, not a permissions problem. Try another server or network.';
  }
  const map = {
    401: 'bad token',
    403: 'bot lacks View Channel / Read Message History, or was never added to the server',
    404: 'wrong channel ID, or bot cannot see the channel'
  };
  return map[code] || 'unexpected response';
}

function pollSeconds() {
  return Math.max(10, parseInt(CFG.POLL_SECONDS || '60', 10) || 60);
}

async function findChat() {
  need(['TELEGRAM_BOT_TOKEN']);
  const r = await request('GET', 'https://api.telegram.org/bot' + CFG.TELEGRAM_BOT_TOKEN + '/getUpdates');
  let data;
  try { data = JSON.parse(r.body); } catch (e) { data = {}; }
  if (r.code !== 200) {
    console.log('Telegram HTTP ' + r.code + ': ' + r.body.slice(0, 200));
    process.exit(1);
  }
  const seen = {};
  (data.result || []).forEach(function (u) {
    const chat = (u.message || u.channel_post || {}).chat;
    if (chat) seen[chat.id] = chat.first_name || chat.title || chat.username || '';
  });
  const ids = Object.keys(seen);
  if (!ids.length) {
    console.log('No messages found. Send any message to your Telegram bot, then run again.');
    process.exit(1);
  }
  ids.forEach(function (id) { console.log('TELEGRAM_CHAT_ID=' + id + '   (' + seen[id] + ')'); });
}

async function check() {
  need(['DISCORD_BOT_TOKEN', 'DISCORD_CHANNEL_ID', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
  const r = await discordGet('/channels/' + CFG.DISCORD_CHANNEL_ID + '/messages?limit=1');
  console.log('Discord HTTP ' + r.code);
  if (r.code !== 200) {
    console.log(r.body.slice(0, 300));
    console.log('Hint: ' + discordHint(r.code, r.body));
    process.exit(1);
  }
  await telegram('Check OK: Discord reachable and Telegram works.');
  console.log('Telegram OK. Discord OK.');
}

// First run: remember the newest existing message so old history is not sent.
async function initState(state) {
  const r = await discordGet('/channels/' + CFG.DISCORD_CHANNEL_ID + '/messages?limit=1');
  if (r.code !== 200) {
    throw new Error('Discord ' + r.code + ' (' + discordHint(r.code, r.body) + '): ' + r.body.slice(0, 300));
  }
  const msgs = JSON.parse(r.body);
  state.last_id = msgs.length ? msgs[0].id : '0';
  saveState(state);
  await telegram('Discord watcher is live. Polling every ' + pollSeconds() + 's.');
}

async function poll(state) {
  let last = state.last_id;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await discordGet('/channels/' + CFG.DISCORD_CHANNEL_ID + '/messages?limit=50&after=' + last);
    if (r.code === 429) {
      let wait = 5;
      try { wait = parseFloat(JSON.parse(r.body).retry_after) || 5; } catch (e) { /* keep default */ }
      await sleep(Math.min(wait, 60) * 1000);
      return;
    }
    if (r.code !== 200) {
      throw new Error('Discord ' + r.code + ' (' + discordHint(r.code, r.body) + '): ' + r.body.slice(0, 300));
    }
    const batch = JSON.parse(r.body);
    if (!batch.length) return;
    // Discord returns newest first; send oldest first. IDs are 64-bit, so compare as BigInt.
    batch.sort(function (a, b) {
      const x = BigInt(a.id);
      const y = BigInt(b.id);
      return x < y ? -1 : (x > y ? 1 : 0);
    });
    for (const m of batch) {
      if (shouldAlert(m)) await telegram(fmt(m)); // throws on failure, so last_id is not advanced
      last = m.id;
      state.last_id = last;
      saveState(state);
    }
    if (batch.length < 50) return;
  }
}

async function main() {
  if (process.argv.indexOf('--find-chat') !== -1) return findChat();
  if (process.argv.indexOf('--check') !== -1) return check();
  need(['DISCORD_BOT_TOKEN', 'DISCORD_CHANNEL_ID', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
  const state = loadState();
  let lastErr = 0;
  log('INFO', 'Watcher started');
  for (;;) {
    try {
      if (!state.last_id) await initState(state);
      await poll(state);
    } catch (e) {
      log('ERROR', String(e && e.message ? e.message : e));
      if (Date.now() - lastErr > ERROR_COOLDOWN_MS) {
        lastErr = Date.now();
        try { await telegram('Discord watcher error:\n' + esc(String(e && e.message ? e.message : e).slice(0, 500))); } catch (e2) { /* ignore */ }
      }
    }
    await sleep(pollSeconds() * 1000);
  }
}

main().catch(function (e) {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
