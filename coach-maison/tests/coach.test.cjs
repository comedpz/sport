// Série de tests Coach Maison — node:test + Playwright (Chromium, viewport iPhone)
// Lancer : NODE_PATH=/opt/npm-tools/node_modules node --test tests/
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(__dirname, 'screens');
fs.mkdirSync(SHOTS, { recursive: true });
const MONDAY = new Date('2026-10-19T08:00:00+02:00');
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR', timezoneId: 'Europe/Paris' };

let server, base, browser;
before(async () => {
  server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const f = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    const type = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.png': 'image/png' }[path.extname(f)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type }); fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

// Ouvre l'app avec une horloge contrôlée ; renvoie {page, ctx, errors}
async function open({ seed, initScript, time = MONDAY } = {}) {
  const ctx = await browser.newContext({ ...MOBILE, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.addInitScript(() => { try { delete Navigator.prototype.share; delete Navigator.prototype.canShare; } catch (e) {} });
  if (initScript) await page.addInitScript(initScript);
  if (seed) await page.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('coachMaison.v1', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  await page.clock.install({ time });
  await page.goto(base);
  return { page, ctx, errors };
}
const phase = page => page.locator('.stage').getAttribute('data-test');
const state = page => page.evaluate(() => JSON.parse(JSON.stringify(CM.getState())));
const tMain = page => page.locator('#tMain').innerText();
async function remainingMs(page) { return page.evaluate(() => { const r = CM.getRun(); return r.endAt === null ? 0 : r.endAt - Date.now(); }); }
async function finishStep(page) { await page.clock.runFor((await remainingMs(page)) + 250); }
async function startSession(page, id) { await page.click(`[data-test=session-${id}]`); await page.click('[data-test=start]'); }
async function runToEnd(page, onRest) {
  for (let i = 0; i < 300; i++) {
    if (await page.locator('[data-test=save], [data-test=home]').count()) return;
    const ph = await phase(page);
    if (ph === 'phase-rest' && onRest) await onRest(page);
    if (ph === 'phase-work' && await page.locator('[data-test=done]').count()) { await page.click('[data-test=done]'); continue; }
    await finishStep(page);
  }
  throw new Error('La séance ne se termine pas');
}
async function noHorizontalScroll(page) {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(w <= 390, `scroll horizontal : largeur ${w}px`);
}
async function bigButtons(page) {
  const small = await page.evaluate(() => [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null)
    .map(b => ({ t: b.innerText.trim(), h: b.getBoundingClientRect().height })).filter(b => b.h < 44));
  assert.deepEqual(small, [], 'boutons trop petits pour le doigt');
}

// ---------------------------------------------------------------------------
describe('1. Logique d’ajustement', () => {
  let page, ctx;
  before(async () => ({ page, ctx } = await open()));
  after(async () => ctx.close());
  const adj = (id, cur, r) => page.evaluate(([id, cur, r]) => CM.adjust(CM.EXERCISES[id], cur, r), [id, cur, r]);

  test('Trop facile : 15 → 17 répétitions', async () => {
    const r = await adj('squat', { target: 15, weight: 2, okStreak: 0 }, 'easy');
    assert.equal(r.target, 17); assert.equal(r.change, 'up');
  });
  test('OK une fois : rien ne bouge ; deux OK de suite : +5 % (17 → 18)', async () => {
    const a = await adj('squat', { target: 17, weight: 2, okStreak: 0 }, 'ok');
    assert.equal(a.target, 17); assert.equal(a.okStreak, 1);
    const b = await adj('squat', a, 'ok');
    assert.equal(b.target, 18); assert.equal(b.okStreak, 0);
  });
  test('Trop dur : 18 → 15 et la série de OK repart à zéro', async () => {
    const r = await adj('squat', { target: 18, weight: 2, okStreak: 1 }, 'hard');
    assert.equal(r.target, 15); assert.equal(r.okStreak, 0);
  });
  test('Pas de réponse : rien ne change', async () => {
    const r = await adj('squat', { target: 15, weight: 2, okStreak: 1 }, undefined);
    assert.deepEqual([r.target, r.weight, r.okStreak, r.change], [15, 2, 1, null]);
  });
  test('Exercices en temps : pas de 5 s (30 → 35, 30 → 25, 20 → 25)', async () => {
    assert.equal((await adj('planche', { target: 30, okStreak: 0 }, 'easy')).target, 35);
    assert.equal((await adj('planche', { target: 30, okStreak: 0 }, 'hard')).target, 25);
    assert.equal((await adj('planche', { target: 20, okStreak: 1 }, 'ok')).target, 25);
  });
  test('Petits objectifs : toujours au moins +1 (5 → 6, 6 → 7)', async () => {
    assert.equal((await adj('burpee', { target: 5, okStreak: 0 }, 'easy')).target, 6);
    assert.equal((await adj('burpee', { target: 6, okStreak: 1 }, 'ok')).target, 7);
  });
  test('Plafond 30 rép. puis haltère du dessus (2 → 3 kg, 20 rép.)', async () => {
    const a = await adj('squat', { target: 28, weight: 2, okStreak: 0 }, 'easy');
    assert.deepEqual([a.target, a.weight], [30, 2]);
    const b = await adj('squat', { target: 30, weight: 2, okStreak: 0 }, 'easy');
    assert.deepEqual([b.target, b.weight, b.change], [20, 3, 'weight-up']);
    const c = await adj('squat', { target: 30, weight: 3, okStreak: 0 }, 'easy');
    assert.deepEqual([c.target, c.weight, c.change], [30, 3, null]);
    const d = await adj('planche', { target: 60, okStreak: 0 }, 'easy');
    assert.equal(d.target, 60);
  });
  test('Plancher 5 rép. / 15 s puis haltère plus léger', async () => {
    const a = await adj('squat', { target: 5, weight: 2, okStreak: 0 }, 'hard');
    assert.deepEqual([a.target, a.weight, a.change], [5, 1, 'weight-down']);
    assert.equal((await adj('crunch', { target: 5, okStreak: 0 }, 'hard')).target, 5);
    assert.equal((await adj('planche', { target: 15, okStreak: 0 }, 'hard')).target, 15);
    assert.equal((await adj('planche', { target: 20, okStreak: 0 }, 'hard')).target, 15);
  });
  test('L’échauffement ne s’ajuste jamais', async () => {
    const r = await adj('rotations', { target: 30, okStreak: 0 }, 'easy');
    assert.equal(r.target, 30);
  });
  test('Durée estimée : 15–25 min par séance, découverte < 4 min', async () => {
    const est = await page.evaluate(() => Object.fromEntries(CM.SESSIONS.map(s => [s.id, CM.estimateSec(s, CM.getState()) / 60])));
    for (const id of ['jambes', 'abdos', 'hiit']) assert.ok(est[id] >= 15 && est[id] <= 25, `${id} : ${est[id].toFixed(1)} min`);
    assert.ok(est.decouverte < 4, `découverte : ${est.decouverte}`);
  });
  test('Plan de séance : échauffement + 3 tours, pas de repos final, grosse pause de 60 s entre les tours', async () => {
    const p = await page.evaluate(() => CM.buildPlan(CM.SESSIONS[0], CM.getState()));
    const work = p.filter(s => s.kind === 'work');
    assert.equal(work.filter(s => s.warm).length, 2);
    assert.equal(work.filter(s => !s.warm).length, 15);
    assert.equal(p[p.length - 1].kind, 'work');
    const big = p.filter(s => s.kind === 'rest' && s.roundBreak);
    assert.equal(big.length, 2); assert.ok(big.every(s => s.dur === 60));
  });
});

// ---------------------------------------------------------------------------
describe('2. Parcours complet (séance découverte)', () => {
  let page, ctx, errors;
  before(async () => ({ page, ctx, errors } = await open()));
  after(async () => ctx.close());

  test('Accueil : 4 séances, compteur semaine à 0/3', async () => {
    assert.equal(await page.locator('.session').count(), 4);
    assert.equal(await page.locator('[data-test=week]').innerText(), '0 / 3 séances');
    await page.screenshot({ path: path.join(SHOTS, '1-accueil.png'), fullPage: true });
    await noHorizontalScroll(page); await bigButtons(page);
  });
  test('Aperçu puis départ : compte à rebours 5 s et annonce vocale', async () => {
    await page.click('[data-test=session-decouverte]');
    assert.match(await page.locator('h1').innerText(), /découverte/i);
    await page.screenshot({ path: path.join(SHOTS, '2-apercu.png'), fullPage: true });
    await bigButtons(page);
    await page.click('[data-test=start]');
    assert.equal(await phase(page), 'phase-ready');
    const says = await page.evaluate(() => CM.events.filter(e => e.type === 'say').map(e => e.value));
    assert.ok(says.includes('Prépare-toi. Premier exercice : Jumping jacks, 30 secondes'), says.join(' | '));
  });
  test('Exercice en temps : le chrono descend et passe tout seul au repos', async () => {
    await finishStep(page);
    assert.equal(await phase(page), 'phase-work');
    assert.equal(await page.locator('[data-test=ex-name]').innerText(), 'Jumping jacks');
    assert.equal(await tMain(page), '30');
    await page.clock.runFor(10000);
    assert.equal(await tMain(page), '20');
    await page.screenshot({ path: path.join(SHOTS, '3-exercice-chrono.png') });
    await noHorizontalScroll(page); await bigButtons(page);
    const beepsBefore = await page.evaluate(() => CM.events.filter(e => e.type === 'beep').length);
    await finishStep(page);
    const beeps = await page.evaluate(() => CM.events.filter(e => e.type === 'beep').length) - beepsBefore;
    assert.ok(beeps >= 3, `bips 3-2-1 attendus, reçu ${beeps}`);
    assert.equal(await phase(page), 'phase-rest');
  });
  test('Repos : question de ressenti + aperçu de l’exercice suivant + bouton +10 s', async () => {
    assert.equal(await page.locator('[data-test=rate-box]').count(), 1);
    assert.match(await page.locator('[data-test=next]').innerText(), /Squats/);
    assert.equal(await tMain(page), '10');
    await page.click('[data-test=addrest]');
    assert.equal(await tMain(page), '20');
    await page.click('[data-test=rate-jacks-easy]');
    assert.equal(await page.locator('[data-test=rate-jacks-easy]').getAttribute('aria-pressed'), 'true');
    await page.screenshot({ path: path.join(SHOTS, '4-repos-ressenti.png') });
    await noHorizontalScroll(page); await bigButtons(page);
    await finishStep(page);
  });
  test('Exercice en répétitions : objectif, haltère et bouton Terminé', async () => {
    assert.equal(await page.locator('[data-test=ex-name]').innerText(), 'Squats');
    assert.equal(await page.locator('[data-test=target]').innerText(), '15');
    assert.equal(await page.locator('[data-test=chip-weight]').innerText(), '2 kg');
    await page.clock.runFor(42000);
    assert.equal(await phase(page), 'phase-work', 'un exercice en répétitions ne doit pas passer tout seul');
    await page.screenshot({ path: path.join(SHOTS, '5-exercice-reps.png') });
    await page.click('[data-test=done]');
    assert.equal(await phase(page), 'phase-rest');
    await page.click('[data-test=rate-squat-ok]');
    await page.click('[data-test=skip]');
    assert.equal(await page.locator('[data-test=ex-name]').innerText(), 'Gainage planche');
    await finishStep(page);
  });
  test('Fin : récap, ressentis pré-remplis, le dernier exercice se note ici', async () => {
    assert.equal(await page.locator('[data-test=end-count]').innerText(), '3/3');
    assert.equal(await page.locator('[data-test=rate-jacks-easy]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-test=rate-squat-ok]').getAttribute('aria-pressed'), 'true');
    await page.click('[data-test=rate-planche-hard]');
    await page.screenshot({ path: path.join(SHOTS, '6-fin-ressenti.png'), fullPage: true });
    await noHorizontalScroll(page); await bigButtons(page);
  });
  test('Enregistrer : objectifs ajustés pour la prochaine fois', async () => {
    await page.click('[data-test=save]');
    const changes = await page.locator('[data-test=change]').allInnerTexts();
    assert.equal(changes.length, 2, changes.join(' | '));
    assert.ok(changes.some(c => /Jumping jacks : 30 → 35 s/.test(c)), changes.join(' | '));
    assert.ok(changes.some(c => /Gainage planche : 30 → 25 s/.test(c)), changes.join(' | '));
    await page.screenshot({ path: path.join(SHOTS, '7-fin-ajustements.png'), fullPage: true });
    const s = await state(page);
    assert.equal(s.ex.jacks.target, 35); assert.equal(s.ex.planche.target, 25);
    assert.equal(s.ex.squat.target, 15); assert.equal(s.ex.squat.okStreak, 1);
    assert.equal(s.history.length, 1); assert.equal(s.history[0].done, 3);
  });
  test('Les données survivent à la fermeture de l’app', async () => {
    await page.reload();
    const s = await state(page);
    assert.equal(s.ex.jacks.target, 35); assert.equal(s.history.length, 1);
    await page.click('[data-test=tab-progress]');
    assert.match(await page.locator('[data-test=lvl-jacks]').innerText(), /35 s/);
    assert.equal(await page.locator('[data-test=hist]').count(), 1);
    assert.equal(await page.locator('[data-test=total]').innerText(), '0', 'la découverte ne compte pas dans le total');
    await page.screenshot({ path: path.join(SHOTS, '8-progres.png'), fullPage: true });
    await noHorizontalScroll(page); await bigButtons(page);
  });
  test('Aucune erreur JavaScript', () => assert.deepEqual(errors, []));
});

// ---------------------------------------------------------------------------
describe('3. Contrôles pendant la séance', () => {
  test('Pause : le chrono s’arrête puis repart', async () => {
    const { page, ctx, errors } = await open();
    await startSession(page, 'jambes');
    await page.click('[data-test=skip]');          // Go !
    assert.equal(await page.locator('[data-test=ex-name]').innerText(), 'Rotations articulaires');
    await page.clock.runFor(5300);
    assert.equal(await tMain(page), '25');
    await page.click('[data-test=pause]');
    await page.clock.runFor(15000);
    assert.equal(await tMain(page), '25');
    assert.equal(await page.locator('[data-test=pause]').innerText(), 'Reprendre');
    await page.click('[data-test=pause]');
    await page.clock.runFor(5000);
    assert.equal(await tMain(page), '20');
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Passer : un exercice passé n’est pas compté comme fait', async () => {
    const { page, ctx, errors } = await open();
    await startSession(page, 'decouverte');
    await page.click('[data-test=skip]');          // Go !
    await page.click('[data-test=skip]');          // passe Jumping jacks
    assert.equal(await phase(page), 'phase-rest');
    await page.click('[data-test=skip]');          // passe le repos
    await page.click('[data-test=done]');          // squats faits
    await page.click('[data-test=skip]');          // repos
    await page.click('[data-test=skip]');          // passe planche
    assert.equal(await page.locator('[data-test=end-count]').innerText(), '1/3');
    assert.equal(await page.locator('.end-ex').count(), 1, 'seuls les exercices faits sont à noter');
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Gainage latéral : signal « change de côté » à mi-temps', async () => {
    const { page, ctx, errors } = await open();
    await startSession(page, 'abdos');
    for (let i = 0; i < 40 && (await page.locator('[data-test=ex-name]').count() === 0 || await page.locator('[data-test=ex-name]').innerText() !== 'Gainage latéral'); i++)
      await page.click(await page.locator('[data-test=done]').count() ? '[data-test=done]' : '[data-test=skip]');
    assert.equal(await page.locator('[data-test=side]').innerText(), 'Côté 1/2');
    assert.equal(await tMain(page), '20');
    await page.clock.runFor(20500);
    assert.equal(await page.locator('[data-test=side]').innerText(), 'Côté 2/2');
    assert.ok(await page.evaluate(() => CM.events.some(e => e.value === 'Change de côté')));
    await page.screenshot({ path: path.join(SHOTS, '9-gainage-cote.png') });
    await finishStep(page);
    assert.equal(await phase(page), 'phase-rest');
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Arrêter → « Terminer et enregistrer » garde ce qui est fait', async () => {
    const { page, ctx, errors } = await open();
    await startSession(page, 'decouverte');
    await page.click('[data-test=skip]');
    await finishStep(page);                         // jacks fait
    await page.click('[data-test=quit]');
    await page.screenshot({ path: path.join(SHOTS, '10-arreter.png') });
    await page.click('[data-test=m-quit-finish]');
    assert.equal(await page.locator('[data-test=end-count]').innerText(), '1/3');
    await page.click('[data-test=save]');
    assert.equal((await state(page)).history.length, 1);
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Arrêter → « Abandonner » ne sauvegarde rien', async () => {
    const { page, ctx, errors } = await open();
    await startSession(page, 'decouverte');
    await page.click('[data-test=skip]');
    await finishStep(page);
    await page.click('[data-test=quit]');
    await page.click('[data-test=m-quit-abandon]');
    assert.equal(await page.locator('.session').count(), 4);
    assert.equal((await state(page)).history.length, 0);
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Arrêter → « Continuer » reprend là où on était', async () => {
    const { page, ctx, errors } = await open();
    await startSession(page, 'decouverte');
    await page.click('[data-test=skip]');
    await page.clock.runFor(10000);
    await page.click('[data-test=quit]');
    await page.clock.runFor(20000);
    await page.click('[data-test=m-quit-cancel]');
    assert.equal(await tMain(page), '20');
    assert.deepEqual(errors, []); await ctx.close();
  });
});

// ---------------------------------------------------------------------------
describe('4. Vraie séance de 20 min, du début à la fin', () => {
  test('Jambes & fessiers : 3 tours, tout « Trop facile », compteur semaine 1/3', async () => {
    const { page, ctx, errors } = await open();
    await startSession(page, 'jambes');
    const seen = [];
    await runToEnd(page, async p => {
      const box = p.locator('[data-test=rate-box] .rbtn.r-easy:not(.sel)');
      if (await box.count()) await box.click();
    });
    const s0 = await page.evaluate(() => CM.getRun().plan.filter(s => s.kind === 'work' && !s.warm).map(s => s.exId));
    for (const id of ['squat', 'fente', 'pont', 'kickback', 'chaise']) assert.equal(s0.filter(x => x === id).length, 3);
    assert.equal(await page.locator('[data-test=end-count]').innerText(), '15/15');
    assert.equal(await page.locator('[data-test=rate-chaise-easy]').getAttribute('aria-pressed'), 'true');
    await page.click('[data-test=save]');
    const st = await state(page);
    assert.deepEqual([st.ex.squat.target, st.ex.fente.target, st.ex.pont.target, st.ex.kickback.target, st.ex.chaise.target], [17, 18, 17, 14, 35]);
    await page.click('[data-test=home]');
    assert.equal(await page.locator('[data-test=week]').innerText(), '1 / 3 séances');
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('La semaine repart à zéro le lundi suivant', async () => {
    const seed = { version: 1, ex: {}, history: [{ id: '1', date: '2026-10-20T08:00:00+02:00', sessionId: 'jambes', name: 'Jambes & fessiers', durationSec: 1200, done: 15, total: 15 }], settings: { sound: true, voice: true } };
    const { page, ctx } = await open({ seed, time: new Date('2026-10-27T09:00:00+01:00') });
    assert.equal(await page.locator('[data-test=week]').innerText(), '0 / 3 séances');
    await ctx.close();
  });
  test('Passage à l’haltère du dessus visible en fin de séance', async () => {
    const seed = { version: 1, ex: { squat: { target: 30, weight: 2, okStreak: 0 } }, history: [], settings: { sound: true, voice: true } };
    const { page, ctx, errors } = await open({ seed });
    await startSession(page, 'decouverte');
    await runToEnd(page);
    await page.click('[data-test=rate-squat-easy]');
    await page.click('[data-test=save]');
    assert.match((await page.locator('[data-test=change]').allInnerTexts()).join(' '), /Squats : passe à 3 kg \(20 rép\.\)/);
    assert.deepEqual(errors, []); await ctx.close();
  });
});

// ---------------------------------------------------------------------------
describe('5. Sauvegarde, restauration, réglages', () => {
  test('Sauvegarder → tout effacer → restaurer : on retrouve tout', async () => {
    const { page, ctx, errors } = await open();
    await startSession(page, 'decouverte');
    await runToEnd(page);
    await page.click('[data-test=rate-jacks-easy]');
    await page.click('[data-test=save]');
    await page.click('[data-test=home]');
    await page.click('[data-test=tab-settings]');
    await page.screenshot({ path: path.join(SHOTS, '11-reglages.png'), fullPage: true });
    await noHorizontalScroll(page); await bigButtons(page);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-test=export]')]);
    const file = path.join(SHOTS, 'sauvegarde-test.json');
    await dl.saveAs(file);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(json.app, 'coach-maison'); assert.equal(json.data.history.length, 1);
    await page.click('[data-test=reset]');
    await page.click('[data-test=m-reset-confirm]');
    assert.equal((await state(page)).history.length, 0);
    assert.equal((await state(page)).ex.jacks.target, 30);
    await page.setInputFiles('#importFile', file);
    await page.click('[data-test=m-import-confirm]');
    const s = await state(page);
    assert.equal(s.history.length, 1); assert.equal(s.ex.jacks.target, 35);
    await page.reload();
    assert.equal((await state(page)).history.length, 1);
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Un mauvais fichier est refusé sans rien casser', async () => {
    const { page, ctx, errors } = await open();
    await page.click('[data-test=tab-settings]');
    await page.setInputFiles('#importFile', { name: 'photo.json', mimeType: 'application/json', buffer: Buffer.from('{"pas":"bon"}') });
    await page.waitForSelector('#toast.show');
    assert.equal(await page.locator('#toast').innerText(), 'Fichier non reconnu');
    assert.equal(await page.locator('#modal').isHidden(), true);
    await page.setInputFiles('#importFile', { name: 'casse.json', mimeType: 'application/json', buffer: Buffer.from('pas du json') });
    assert.equal((await state(page)).history.length, 0);
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Bips et voix : réglages mémorisés', async () => {
    const { page, ctx } = await open();
    await page.click('[data-test=tab-settings]');
    await page.click('[data-test=toggle-voice]');
    assert.equal(await page.locator('[data-test=toggle-voice]').getAttribute('aria-pressed'), 'false');
    await page.reload();
    assert.equal((await state(page)).settings.voice, false);
    assert.equal((await state(page)).settings.sound, true);
    await ctx.close();
  });
  test('Navigation privée (stockage bloqué) : message clair, l’app marche quand même', async () => {
    const { page, ctx, errors } = await open({ initScript: () => {
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
    } });
    assert.equal(await page.locator('[data-test=storage-warn]').count(), 1);
    await startSession(page, 'decouverte');
    await runToEnd(page);
    await page.click('[data-test=save]');
    assert.equal(await page.locator('[data-test=home]').count(), 1);
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Fichiers de l’écran d’accueil présents (icône + manifest)', async () => {
    const { page, ctx } = await open();
    const r = await page.evaluate(async () => {
      const m = await fetch(document.querySelector('link[rel=manifest]').href).then(r => r.json());
      const i = await fetch(document.querySelector('link[rel=apple-touch-icon]').href);
      return { name: m.name, display: m.display, icon: i.status };
    });
    assert.deepEqual(r, { name: 'Coach Maison', display: 'standalone', icon: 200 });
    await ctx.close();
  });
});
