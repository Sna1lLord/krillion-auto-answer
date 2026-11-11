// ==UserScript==
// @name         Krillion Puffer Party / Daily Dive Auto Answer
// @namespace    https://github.com/Sna1lLord/krillion-auto-answer
// @author       Sna1lLord
// @homepageURL  https://github.com/Sna1lLord/krillion-auto-answer
// @supportURL   https://github.com/Sna1lLord/krillion-auto-answer/issues
// @updateURL    https://raw.githubusercontent.com/Sna1lLord/krillion-auto-answer/main/krillion-auto-answer.user.js
// @downloadURL  https://raw.githubusercontent.com/Sna1lLord/krillion-auto-answer/main/krillion-auto-answer.user.js
// @license      MIT
// @version      4.2
// @description  Answers the current Krillion prompt with the best unused answer (Daily Dive + Puffer Party)
// @match        https://krillion.io/*
// @match        https://www.krillion.io/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      api.openai.com
// @connect      thewordfinder.com
// @connect      www.thewordfinder.com
// @connect      api.thewordfinder.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const SEL = {
    prompt: '.ds-card .prompt, .ds-prompt, [class*="ds-card"] [class*="prompt"]:not([class*="count"])',
    input: 'input.ds-input, input[aria-label="Your answer"], .ds-dock input[type="text"]',
    send: 'button.ds-dive-btn, button[aria-label="Send answer"], .ds-dock button[type="submit"]',
    chip: '.pf-say',
  };
  const isParty = () => location.pathname.startsWith('/party');
  const isDaily = () => location.pathname === '/' || location.pathname.startsWith('/unlimited');
  const TIER_RANK = { krillion: 6, deepcut: 5, rare: 4, schooler: 3, tooclever: 2, plankton: 1 };
  const TIER_NAME = { krillion: 'One in a Krillion', deepcut: 'Deep Cut', rare: 'Rare', schooler: 'Schooler', tooclever: 'Too Clever', plankton: 'Plankton' };

  const cfg = {
    get key() { return GM_getValue('apiKey', ''); },
    get model() { return GM_getValue('model', 'gpt-4.1-mini'); },
    get rarity() { return GM_getValue('rarity', 3); },
    get typeDelay() { return GM_getValue('typeDelay', 80); },
    get maxLen() { return GM_getValue('maxLen', 28); },
  };
  GM_registerMenuCommand('Set OpenAI API key (fallback only)', () => {
    const k = prompt('OpenAI API key (sk-...):', cfg.key);
    if (k !== null) GM_setValue('apiKey', k.trim());
  });
  GM_registerMenuCommand('Set OpenAI model', () => {
    const m = prompt('OpenAI model:', cfg.model);
    if (m) GM_setValue('model', m.trim());
  });
  GM_registerMenuCommand('Set how niche AI answers are (1-5)', () => {
    const r = prompt('Only used when a category is not in the answer sheets.\n1 = common, 3 = medium, 5 = very niche:', cfg.rarity);
    if (r !== null && +r >= 1 && +r <= 5) GM_setValue('rarity', Math.round(+r));
  });
  GM_registerMenuCommand('Set typing speed (ms/char)', () => {
    const d = prompt('Delay per character in ms (0 = instant):', cfg.typeDelay);
    if (d !== null && !isNaN(+d)) GM_setValue('typeDelay', +d);
  });
  GM_registerMenuCommand('Reload answer sheets', () => loadSheets(true));
  GM_registerMenuCommand('Show what is known for this category', () => {
    const p = promptText();
    const e = p && lookup(p);
    alert(!p ? 'No category on screen.' : !e ? `Not in the answer sheets yet:\n${p}` :
      `${e.text}\n\nOne in a Krillion: ${e.gems.join(', ') || '-'}\nDeep Cut (learned): ${e.deepcut.length}\nRare: ${e.rare.length}\nSchooler: ${e.schooler.length}`);
  });

  const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const promptText = () => (isParty() || isDaily()) ? ($(SEL.prompt)?.innerText || '').trim() : '';

  function gmGet(url, timeout = 20000) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'GET', url, timeout,
      onload: (r) => (r.status >= 200 && r.status < 300 ? resolve(r.responseText) : reject(new Error(`HTTP ${r.status}`))),
      onerror: () => reject(new Error('network error')),
      ontimeout: () => reject(new Error('timeout')),
    }));
  }

  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:2147483647;display:flex;align-items:center;justify-content:flex-end;gap:6px;font:11px/1.3 system-ui,sans-serif;max-width:60vw';
  const statusBox = document.createElement('div');
  statusBox.style.cssText = 'opacity:0;transition:opacity .15s;max-width:240px;text-align:right;pointer-events:none;color:#d8e8ff;text-shadow:0 0 2px #000a';
  const btn = document.createElement('div');
  btn.setAttribute('aria-hidden', 'true');
  btn.style.cssText = 'flex:none;width:18px;height:18px;border-radius:50%;background:#b8c8dc;box-shadow:0 0 0 1px #0006;opacity:.5;cursor:pointer;transition:opacity .15s,transform .15s';
  wrap.append(statusBox, btn);
  document.body.appendChild(wrap);
  wrap.addEventListener('mouseenter', () => { btn.style.opacity = '.9'; statusBox.style.opacity = '.9'; });
  wrap.addEventListener('mouseleave', () => { btn.style.opacity = '.5'; statusBox.style.opacity = '0'; });
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => answerNow());
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key.toLowerCase() === 'a') { e.preventDefault(); answerNow(); }
  });
  const status = (msg) => { statusBox.innerHTML = msg; console.log('[puffer-bot]', msg.replace(/<[^>]+>/g, '')); };

  function placeDot() {
    const onGame = isParty() || isDaily();
    wrap.style.display = onGame ? '' : 'none';
    sheetBoxShow(onGame);
    const a = onGame && $(SEL.input);
    const r = a && a.getBoundingClientRect();
    if (!r || !r.width) { Object.assign(wrap.style, { top: '', left: '', bottom: '10px', right: '10px', transform: '' }); return; }
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    Object.assign(wrap.style, {
      top: '', left: '', transform: '',
      right: `${Math.max(2, vw - r.right)}px`,
      bottom: `${Math.min(vh - 20, vh - r.top + 6)}px`,
    });
  }
  setInterval(placeDot, 300);
  window.addEventListener('resize', placeDot);

  const SHEET_PAGE = (d) => `https://www.thewordfinder.com/misc-solvers/krillion-answers/${d ? d + '/' : ''}`;
  const SHEET_API = (d) => `https://api.thewordfinder.com/krillion/${d || 'today'}`;
  let sheets = GM_getValue('sheets', {});
  let index = new Map();

  function findDay(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (Array.isArray(obj.prompts)) return obj;
    for (const v of Object.values(obj)) { const d = v && typeof v === 'object' && findDay(v.b || v); if (d) return d; }
    return null;
  }
  function parseDay(text) {
    try { const d = findDay(JSON.parse(text)); if (d) return d; } catch (_) { }
    const m = text.match(/<script[^>]*id="ng-state"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error('no data on page');
    const d = findDay(JSON.parse(m[1]));
    if (!d) throw new Error('no prompts on page');
    return d;
  }
  const slim = (day) => day.prompts.map(p => ({
    text: p.text,
    gems: [p.gem, ...(p.otherGems || [])].filter(Boolean).map(g => (typeof g === 'string' ? g : g.answer)).filter(Boolean),
    tiers: { plankton: p.tiers?.plankton || [], tooclever: p.tiers?.tooclever || [], schooler: p.tiers?.schooler || [], rare: p.tiers?.rare || [], deepcut: p.tiers?.deepcut || [] },
  }));

  async function fetchDay(date) {
    try { return parseDay(await gmGet(SHEET_API(date))); }
    catch (_) { return parseDay(await gmGet(SHEET_PAGE(date))); }
  }

  let loading = null;
  function loadSheets(force = false) {
    if (loading) return loading;
    loading = (async () => {
      try {
        const last = GM_getValue('sheetsFetched', 0);
        if (force || Date.now() - last > 60 * 60 * 1000 || !Object.keys(sheets).length) {
          status('Loading answer sheets...');
          const today = await fetchDay(null);
          sheets[today.date] = slim(today);
          for (const d of today.availableDates || []) {
            if (sheets[d] && d !== today.date) continue;
            try { sheets[d] = slim(await fetchDay(d)); } catch (e) { console.warn('[puffer-bot] sheet', d, e); }
            await sleep(250);
          }
          GM_setValue('sheets', sheets);
          GM_setValue('sheetsFetched', Date.now());
        }
        buildIndex();
        status(`Answer sheets ready: ${index.size} categories`);
      } catch (e) {
        buildIndex();
        status(`Couldn't load sheets (${e.message}) - using ${index.size} cached`);
      } finally { loading = null; }
    })();
    return loading;
  }

  let learned = GM_getValue('learned', {});
  let learnedDirty = false;
  setInterval(() => { if (learnedDirty) { GM_setValue('learned', learned); learnedDirty = false; } }, 5000);

  function learn(prompt, answer, tier) {
    const k = norm(prompt);
    const e = learned[k] || (learned[k] = { text: prompt, a: {} });
    if (e.a[answer] !== tier) { e.a[answer] = tier; learnedDirty = true; buildIndexEntry(k); }
  }

  function buildIndexEntry(k) {
    const l = learned[k];
    if (!l) return;
    const merged = index.get(k) || { text: l.text, gems: [], deepcut: [], rare: [], schooler: [], tooclever: [], plankton: [] };
    for (const [a, t] of Object.entries(l.a)) {
      const list = merged[t === 'krillion' ? 'gems' : t];
      if (list && !list.includes(a)) list.push(a);
    }
    index.set(k, merged);
  }
  function buildIndex() {
    index = new Map();
    for (const day of Object.values(sheets)) for (const p of day) {
      const k = norm(p.text);
      const e = index.get(k) || { text: p.text, gems: [], deepcut: [], rare: [], schooler: [], tooclever: [], plankton: [] };
      for (const g of p.gems) if (!e.gems.includes(g)) e.gems.push(g);
      for (const t of ['deepcut', 'rare', 'schooler', 'tooclever', 'plankton'])
        for (const a of p.tiers[t] || []) if (!e[t].includes(a)) e[t].push(a);
      index.set(k, e);
    }
    for (const k of Object.keys(learned)) buildIndexEntry(k);
  }

  function lookup(prompt) {
    const k = norm(prompt);
    if (index.has(k)) return index.get(k);
    const words = new Set(k.split(' '));
    let best = null, bestScore = 0;
    for (const [key, e] of index) {
      const w2 = new Set(key.split(' '));
      let inter = 0; for (const w of words) if (w2.has(w)) inter++;
      const score = inter / (words.size + w2.size - inter);
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return bestScore >= 0.75 ? best : null;
  }

  let used = new Set();
  let usedCategory = '';
  let stale = new Set();
  function scanRound() {
    const p = promptText();
    const chips = [...document.querySelectorAll(SEL.chip)];
    if (p && p !== usedCategory) {
      usedCategory = p; used = new Set();
      stale = new Set(chips.map(c => c.innerText.trim()));
    }
    for (const chip of chips) {
      const t = chip.innerText.trim();
      if (!t || chip.classList.contains('caret') || stale.has(t)) continue;
      used.add(norm(t));
      const tier = (chip.getAttribute('style') || '').match(/--tier-([a-z]+)/);
      if (p && tier && TIER_RANK[tier[1]] && chip.classList.contains('rest')) learn(p, t, tier[1]);
    }
  }
  setInterval(scanRound, 250);

  const singular = (n) => n.replace(/s$/, '');
  const isUsed = (a) => { const n = norm(a); return used.has(n) || used.has(singular(n)) || used.has(n + 's'); };

  function pickFromSheet(entry) {
    const fresh = (list) => list.filter(a => !isUsed(a));
    const shortFirst = (list) => {
      const short = list.filter(a => a.length <= cfg.maxLen);
      const pool = short.length ? short : list;
      return pool[Math.floor(Math.random() * pool.length)];
    };
    for (const [tier, list] of [['krillion', entry.gems], ['deepcut', entry.deepcut], ['rare', entry.rare], ['schooler', entry.schooler]]) {
      const f = fresh(list);
      if (f.length) return { answer: tier === 'krillion' ? f[0] : shortFirst(f), tier };
    }
    return null;
  }

  function askOpenAI(category, known) {
    const levels = {
      1: 'well-known, everyday answers - just not the single most obvious one',
      2: 'fairly common answers most people would recognise, skipping the top few obvious ones',
      3: 'moderately uncommon answers: not the first things people say, but ones an average adult would still recognise instantly',
      4: 'less common answers that a well-read person knows, but nothing truly obscure',
      5: 'rare, niche answers - still real and verifiable',
    };
    const sys =
      'You play Krillion Puffer Party: players take turns naming answers to a category. The answer must be ACCEPTED by the game, ' +
      'whose answer list comes from standard references, so it must be a real, clearly valid, commonly-spelled example of the category. ' +
      `Aim for ${levels[cfg.rarity] || levels[3]}. ` +
      'Return JSON {"answers": string[]} with 8 answers, best first. Each: common name only, 1-4 words, no explanations, standard spelling.';
    const user = `Category: ${category}\n\nAlready used (do not repeat): ${[...used].join(', ') || 'none'}` +
      (known.length ? `\n\nExamples the game has accepted before (style guide): ${known.slice(0, 30).join(', ')}` : '');
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'POST', url: 'https://api.openai.com/v1/chat/completions', timeout: 15000,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
      data: JSON.stringify({ model: cfg.model, temperature: 0.8, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
      onload: (r) => {
        try {
          const j = JSON.parse(r.responseText);
          if (j.error) return reject(new Error(j.error.message));
          resolve((JSON.parse(j.choices[0].message.content).answers || []).map(String).filter(Boolean));
        } catch (e) { reject(e); }
      },
      onerror: () => reject(new Error('network error')),
      ontimeout: () => reject(new Error('timeout')),
    }));
  }

  function setNativeValue(el, value) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  async function typeInto(el, text) {
    el.focus();
    setNativeValue(el, '');
    if (!cfg.typeDelay) { setNativeValue(el, text); return; }
    for (let i = 1; i <= text.length; i++) {
      const ch = text[i - 1];
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      setNativeValue(el, text.slice(0, i));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
      await sleep(cfg.typeDelay * (0.6 + Math.random() * 0.8));
    }
  }
  function send(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    setTimeout(() => { const b = $(SEL.send); if (el.value && b && !b.disabled) b.click(); }, 120);
  }

  let busy = false;
  async function answerNow() {
    if (busy) return;
    const input = $(SEL.input);
    if (!input) { status('No answer box on screen'); return; }
    if (input.disabled) { status(isParty() ? 'Not your turn yet' : 'Answer box not open yet'); return; }
    const category = promptText();
    if (!category) { status('No category on screen'); return; }

    busy = true; btn.style.transform = 'scale(.7)';
    try {
      scanRound();
      if (!index.size && loading) await loading;
      let entry = lookup(category);
      if (!entry && isDaily() && GM_getValue('sheetsFetched', 0) < Date.now() - 5 * 60 * 1000) {
        status('New prompt - reloading sheets...');
        await loadSheets(true);
        entry = lookup(category);
      }
      let choice = entry && pickFromSheet(entry);

      if (!choice) {
        if (!cfg.key) { status(entry ? 'Every known answer is used up - set an OpenAI key for more' : 'Category not in sheets - set an OpenAI key'); return; }
        status(`Asking AI... <i>${category}</i>`);
        const known = entry ? [...entry.gems, ...entry.deepcut, ...entry.rare] : [];
        const answers = await askOpenAI(category, known);
        const a = answers.find(x => !isUsed(x));
        if (!a) { status('AI had nothing new - click again'); return; }
        choice = { answer: a, tier: 'ai' };
      }

      const label = choice.tier === 'ai' ? 'AI guess' : `${TIER_NAME[choice.tier]} (from sheet)`;
      status(`<i>${category}</i><br>-> <b>${choice.answer}</b> · ${label}`);
      used.add(norm(choice.answer));
      await typeInto($(SEL.input) || input, choice.answer);
      send($(SEL.input) || input);
    } catch (e) {
      status('Error: ' + e.message);
    } finally {
      busy = false; btn.style.transform = '';
    }
  }

  const sheetBox = document.createElement('div');
  const SHEET_DIM = '.4', SHEET_HOVER = '.95';
  sheetBox.style.cssText = 'position:fixed;top:6px;right:8px;z-index:2147483647;max-width:220px;text-align:right;' +
    'font:10px/1.3 system-ui,sans-serif;color:#d8e8ff;text-shadow:0 0 2px #000a;opacity:' + SHEET_DIM + ';' +
    'transition:opacity .15s;pointer-events:auto;user-select:none;white-space:normal';
  sheetBox.addEventListener('mouseenter', () => { sheetBox.style.opacity = SHEET_HOVER; });
  sheetBox.addEventListener('mouseleave', () => { sheetBox.style.opacity = SHEET_DIM; });
  document.body.appendChild(sheetBox);
  function sheetBoxShow(on) { sheetBox.style.display = on ? '' : 'none'; }

  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const aiCache = new Map();
  let lastAiAsk = 0;
  function aiForCorner(p) {
    if (!cfg.key || aiCache.has(p) || Date.now() - lastAiAsk < 5000) return;
    lastAiAsk = Date.now();
    aiCache.set(p, 'pending');
    askOpenAI(p, []).then(a => aiCache.set(p, a)).catch(() => aiCache.set(p, 'error'));
  }

  let lastSheetHtml = '';
  const line = (tag, list) => `<div>${tag ? `<span style="opacity:.6">${tag}</span> ` : ''}${list.map(esc).join(' · ')}</div>`;
  const note = (t) => `<div style="opacity:.6">${t}</div>`;

  function renderSheet() {
    const p = promptText();
    let html;
    if (!p) html = isParty() ? note('·') : '';
    else if (!cfg.key) html = note('set an OpenAI key');
    else {
      aiForCorner(p);
      const ai = aiCache.get(p);
      const fresh = Array.isArray(ai) ? ai.filter(a => !isUsed(a)).slice(0, 6) : [];
      if (Array.isArray(ai) && !fresh.length) aiCache.delete(p);
      html = fresh.length ? line('', fresh)
        : ai === 'error' ? note('AI error - retrying')
        : note('asking AI...');
      if (ai === 'error') setTimeout(() => { if (aiCache.get(p) === 'error') aiCache.delete(p); }, 5000);
    }
    if (html !== lastSheetHtml) { sheetBox.innerHTML = html; lastSheetHtml = html; }
  }
  setInterval(renderSheet, 400);

  buildIndex();
  loadSheets();
})();
