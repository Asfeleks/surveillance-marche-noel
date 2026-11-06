// Vérifie la page de réservation Google Agenda et alerte si un créneau
// se libère avant la place déjà obtenue (config.json → watchUntil).
// Le lien de réservation et le canal ntfy ne sont PAS dans le dépôt :
// ils viennent des variables BOOKING_URL et NTFY_TOPIC (secrets GitHub),
// ou du fichier local.json (non publié) quand on lance le script sur le Mac.
// Usage : node check.js                  → une vérification
//         node check.js --loop 340       → vérifie toutes les 5 min pendant 340 min
//         node check.js --test           → envoie seulement une notification de test
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const DIR = __dirname;
const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {});
const cfg = {
  ...readJson(path.join(DIR, 'config.json')),
  ...readJson(path.join(DIR, 'local.json')),
  ...JSON.parse(process.env.OVERRIDE || '{}'),
};
if (process.env.NTFY_TOPIC) cfg.ntfyTopic = process.env.NTFY_TOPIC;
if (process.env.BOOKING_URL) cfg.bookingUrl = process.env.BOOKING_URL;
if (!cfg.ntfyTopic || !cfg.bookingUrl) throw new Error('BOOKING_URL ou NTFY_TOPIC manquant');
if (process.env.CHROME_PATH) cfg.chromePath = process.env.CHROME_PATH;
const STATE = path.join(DIR, process.env.OVERRIDE ? 'test-state.json' : 'deja-signales.json');
const from = Date.parse(cfg.watchFrom);
const until = Date.parse(cfg.watchUntil);

const log = (...a) => console.log(
  new Date().toLocaleString('fr-FR', { timeZone: 'Indian/Antananarivo' }), ...a);

function fmt(ms) {
  return new Date(ms).toLocaleString('fr-FR', {
    timeZone: 'Indian/Antananarivo', weekday: 'long', day: 'numeric',
    month: 'long', hour: '2-digit', minute: '2-digit',
  });
}

async function notify(title, message) {
  // Notification sur le téléphone via ntfy
  const res = await fetch('https://ntfy.sh/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: cfg.ntfyTopic, title, message, priority: 5,
      tags: ['christmas_tree'], click: cfg.bookingUrl,
    }),
  });
  if (!res.ok) throw new Error(`ntfy : ${res.status} ${await res.text()}`);
}

async function findSlots() {
  const browser = await puppeteer.launch({
    executablePath: cfg.chromePath, headless: true,
    args: ['--lang=fr-FR', '--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.emulateTimezone('Indian/Antananarivo');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9' });
    await page.goto(cfg.bookingUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('button[aria-label]', { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2000));

    const found = new Set();
    for (const day of cfg.daysToWatch) {
      // Bouton du petit calendrier : "Lundi 9, aucun créneau disponible" si complet
      const status = await page.evaluate((d) => {
        const re = new RegExp(`^\\S+ ${d}(,|$)`);
        const btn = [...document.querySelectorAll('button[aria-label]')]
          .find((b) => re.test(b.getAttribute('aria-label')));
        if (!btn) return 'introuvable';
        const label = btn.getAttribute('aria-label');
        if (/aucun créneau/i.test(label)) return 'complet';
        btn.click();
        return 'disponible';
      }, day);
      log(`Jour ${day} : ${status}`);
      if (status === 'introuvable') throw new Error(`Jour ${day} introuvable sur la page`);
      if (status !== 'disponible') continue;
      await new Promise((r) => setTimeout(r, 2500));
      const times = await page.evaluate(() =>
        [...document.querySelectorAll('button[data-date-time]')]
          .map((b) => Number(b.getAttribute('data-date-time'))));
      times.filter((t) => t >= from && t < until).forEach((t) => found.add(t));
    }
    return [...found].sort((a, b) => a - b);
  } finally {
    await browser.close();
  }
}

async function checkOnce() {
  const slots = await findSlots();
  const already = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : [];
  const fresh = slots.filter((t) => !already.includes(t));
  log(`Créneaux avant la place actuelle : ${slots.length} (nouveaux : ${fresh.length})`);
  // On garde seulement les créneaux encore libres, pour re-signaler s'ils se libèrent à nouveau
  fs.writeFileSync(STATE, JSON.stringify(slots));
  if (fresh.length && !process.env.DRY_RUN) {
    const list = fresh.slice(0, 6).map(fmt).join('\n');
    await notify('🎄 Place libérée au marché de Noël !',
      `Créneau(x) disponible(s) :\n${list}\nRéservez vite !`);
    log('Alerte envoyée.');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (process.argv.includes('--test')) {
    await notify('Test marché de Noël 🎄',
      'Ceci est un test : si vous lisez ce message, les alertes fonctionnent.');
    log('Notification de test envoyée.');
    return;
  }
  const loopIdx = process.argv.indexOf('--loop');
  if (loopIdx === -1) {
    if (Date.now() > until) { log('Date dépassée, plus rien à surveiller.'); return; }
    await checkOnce();
    return;
  }

  // Mode boucle : une vérification toutes les 5 minutes pendant N minutes
  const intervalMs = Number(process.env.INTERVAL_SEC || 300) * 1000;
  const stopAt = Date.now() + Number(process.argv[loopIdx + 1] || 340) * 60000;
  let errors = 0;
  let warned = false;
  while (Date.now() < stopAt && Date.now() < until) {
    const started = Date.now();
    try {
      await checkOnce();
      if (warned) {
        await notify('✅ Surveillance rétablie', 'Les vérifications fonctionnent de nouveau.').catch(() => {});
      }
      errors = 0; warned = false;
    } catch (e) {
      errors += 1;
      log(`ERREUR (${errors} de suite) :`, e.message);
      // Après ~30 min d'échecs, on prévient une seule fois
      if (errors >= 6 && !warned) {
        await notify('⚠️ Surveillance en panne',
          'La page de réservation ne peut plus être lue depuis 30 minutes. Vérifiez-la vous-même.')
          .catch((e2) => log('ntfy échoué :', e2.message));
        warned = true;
      }
    }
    const wait = intervalMs - (Date.now() - started);
    if (Date.now() + wait >= stopAt) break;
    await sleep(Math.max(wait, 10000));
  }
  if (Date.now() >= until) log('Date dépassée, plus rien à surveiller.');
  else log('Fin de ce cycle, la tâche va se relancer.');
})().catch(async (e) => {
  log('ERREUR :', e.message);
  process.exitCode = 1;
});
