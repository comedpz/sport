// Série de tests Coach Maison — node:test + Playwright (Chromium, viewport iPhone)
// Lancer : npm test
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(__dirname, 'screens');
fs.mkdirSync(SHOTS, { recursive: true });
const MONDAY = new Date('2026-10-19T08:00:00+02:00');   // semaine 1 du cycle : Jambes, HIIT, Haut du corps
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR', timezoneId: 'Europe/Paris' };
// Petite séance de test (3 exercices, 1 tour, sans échauffement) : temps, répétitions avec haltère, gainage au sol
const MINI = { rid: 'cardio_abdos', items: ['jacks', 'squat', 'planche'], rounds: 1, noWarm: true };

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
const says = page => page.evaluate(() => CM.events.filter(e => e.type === 'say').map(e => e.value));
const tMain = async page => { await page.evaluate(() => CM.refresh()); return page.locator('#tMain').innerText(); };   // chrono à jour (l'écran se rafraîchit toutes les 200 ms)
async function remainingMs(page) { return page.evaluate(() => { const r = CM.getRun(); return r.endAt === null ? 0 : r.endAt - Date.now(); }); }
async function finishStep(page) { await page.clock.runFor((await remainingMs(page)) + 250); }
// Bouton d'étape (Go / Passer / Terminé / J'ai tout) : l'app ignore un 2e tap à moins de 0,4 s (double tap)
async function tap(page, sel) { await page.clock.runFor(450); await page.click(sel); }
// Séance du programme : accueil -> aperçu -> écran matériel
async function startSession(page, id) { await page.click(`[data-test=session-${id}]`); await page.click('[data-test=start]'); }
// Séance sur mesure (tests) : aperçu -> écran matériel -> « J'ai tout » -> compte à rebours
async function startCustom(page, sess) {
  await page.evaluate(s => CM.openPreview(s), sess);
  await page.click('[data-test=start]');
  await tap(page, '[data-test=gear-go]');
}
async function runToEnd(page, onRest) {
  for (let i = 0; i < 400; i++) {
    if (await page.locator('[data-test=save], [data-test=home]').count()) return;
    const ph = await phase(page);
    if (ph === 'phase-gear') { await tap(page, '[data-test=gear-go]'); continue; }
    if (ph === 'phase-rest' && onRest) await onRest(page);
    if (ph === 'phase-work' && await page.locator('[data-test=done]').count()) { await tap(page, '[data-test=done]'); continue; }
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
// Historique fictif : n séances complètes de 20 min dans la semaine du lundi donné
function weekHistory(monday, n, forme) {
  return Array.from({ length: n }, (_, i) => ({ id: monday + i, date: new Date(new Date(monday).getTime() + (i * 2 + 1) * 86400000).toISOString(),
    sessionId: ['jambes', 'hiit', 'abdos'][i % 3], name: 'Séance', durationSec: 1200, done: 15, total: 15, ...(forme ? { forme: forme + i } : {}) })).reverse();
}

// ---------------------------------------------------------------------------
describe('1. Logique : ajustement, programme, pauses', () => {
  let page, ctx;
  before(async () => ({ page, ctx } = await open()));
  after(async () => ctx.close());
  const adj = (id, cur, r) => page.evaluate(([id, cur, r]) => CM.adjust(CM.EXERCISES[id], cur, r), [id, cur, r]);
  const plan = (sess, feel) => page.evaluate(([s, f]) => CM.buildPlan(s, CM.getState(), f), [sess, feel]);

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
  test('Plancher 5 rép. / 15 s puis haltère plus léger, avec plus de répétitions (même effort)', async () => {
    const a = await adj('squat', { target: 5, weight: 2, okStreak: 0 }, 'hard');
    assert.deepEqual([a.target, a.weight, a.change], [10, 1, 'weight-down']);
    const b = await adj('sumo', { target: 5, weight: 3, okStreak: 0 }, 'hard');
    assert.deepEqual([b.target, b.weight], [8, 2]);
    assert.equal((await adj('crunch', { target: 5, okStreak: 0 }, 'hard')).target, 5);
    assert.equal((await adj('planche', { target: 15, okStreak: 0 }, 'hard')).target, 15);
    assert.equal((await adj('planche', { target: 20, okStreak: 0 }, 'hard')).target, 15);
  });
  test('L’échauffement ne s’ajuste jamais', async () => {
    const r = await adj('rotations', { target: 30, okStreak: 0 }, 'easy');
    assert.equal(r.target, 30);
  });
  test('Programme : 12 séances différentes sur 4 semaines, muscu et cardio en alternance', async () => {
    const r = await page.evaluate(() => ({ cycle: CM.CYCLE, kinds: CM.CYCLE.map(w => w.map(id => CM.RECIPES[id].kind)), all: Object.keys(CM.RECIPES) }));
    const flat = r.cycle.flat();
    assert.equal(new Set(flat).size, 12); assert.deepEqual([...flat].sort(), [...r.all].sort());
    for (const k of r.kinds) assert.ok(k[0] !== k[1] && k[1] !== k[2], k.join(' / '));
  });
  test('Toutes les séances durent environ 20 min (17 à 23 min), quels que soient les exercices tirés', async () => {
    const est = await page.evaluate(() => {
      const out = [];
      for (const rid of Object.keys(CM.RECIPES)) for (const seed of ['a', 'b', 'c', 'd']) {
        const s = CM.makeSession(rid, CM.getState(), seed);
        out.push([rid + ':' + seed, CM.estimateSec(s, CM.getState()) / 60, s.items.every(Boolean)]);
      }
      return out;
    });
    for (const [id, min, ok] of est) { assert.ok(ok, id + ' : exercice manquant'); assert.ok(min >= 17 && min <= 23, `${id} : ${min.toFixed(1)} min`); }
  });
  test('Échauffement : au moins 2 min d’effort, adapté aux parties du corps travaillées', async () => {
    const r = await page.evaluate(() => Object.fromEntries(Object.keys(CM.RECIPES).map(rid => {
      const p = CM.buildPlan(CM.makeSession(rid, CM.getState(), 'x'), CM.getState());
      const w = p.filter(s => s.kind === 'work' && s.warm);
      return [rid, { sec: w.reduce((a, s) => a + s.dur, 0), ids: w.map(s => s.exId) }];
    })));
    for (const [rid, w] of Object.entries(r)) assert.ok(w.sec >= 120, `${rid} : ${w.sec} s`);
    assert.ok(r.jambes.ids.includes('w_squat') && r.jambes.ids.includes('w_fente'));
    assert.ok(r.bras.ids.includes('w_bras') && r.bras.ids.includes('w_epaules'));
    assert.ok(r.abdos.ids.includes('w_chat') && r.abdos.ids.includes('w_buste'));
    assert.ok(r.hiit.ids.includes('w_talons'));
  });
  test('Pauses courtes : muscu 15–30 s, cardio 10–20 s (+ tabata), pas de pause après le dernier exercice', async () => {
    const r = await page.evaluate(() => Object.keys(CM.RECIPES).map(rid => {
      const p = CM.buildPlan(CM.makeSession(rid, CM.getState(), 'x'), CM.getState());
      const rests = p.filter(s => s.kind === 'rest' && !s.warm);
      return { rid, kind: CM.RECIPES[rid].kind, format: CM.RECIPES[rid].format, last: p[p.length - 1].kind,
        inner: rests.filter(s => !s.roundBreak).map(s => s.dur), breaks: rests.filter(s => s.roundBreak).map(s => s.dur) };
    }));
    for (const s of r) {
      assert.equal(s.last, 'work', s.rid);
      const [lo, hi] = s.format === 'pyramid' ? [5, 25] : s.kind === 'muscu' ? [15, 25] : [10, 20];
      for (const d of s.inner) assert.ok(d >= lo && d <= hi, `${s.rid} : pause de ${d} s`);
      for (const d of s.breaks) assert.ok(d <= (s.format === 'tabata' ? 45 : 30), `${s.rid} : grosse pause de ${d} s`);
    }
  });
  test('Pauses intelligentes : un peu plus pour changer d’haltère, mettre les chevillères, se mettre au sol', async () => {
    const p = await plan({ rid: 'jambes', items: ['chaise', 'squat', 'pont', 'kickback'], rounds: 1, noWarm: true });
    const rests = p.filter(s => s.kind === 'rest' && s.prevExId);
    assert.deepEqual(rests.map(s => s.dur), [20, 25, 25]);   // 15 s + haltère ; + haltère + sol ; + chevillères
    assert.deepEqual(rests.map(s => s.weightChange), [2, 3, null]);
    assert.deepEqual(rests.map(s => s.anklesOn), [false, false, true]);
    const c = await plan({ rid: 'hiit', items: ['jacks', 'burpee', 'genoux_rap'], rounds: 1, noWarm: true });
    assert.deepEqual(c.filter(s => s.kind === 'rest' && s.prevExId).map(s => s.dur), [10, 15]);   // + 5 s après un effort intense
  });
  test('Pyramide : 60-80-100-80-60 % de l’objectif, pauses en pyramide', async () => {
    const p = await plan({ rid: 'fessiers_pyr', items: ['squat', 'sumo'], noWarm: true });
    const w = p.filter(s => s.kind === 'work');
    assert.deepEqual(w.filter(s => s.exId === 'squat').map(s => s.target), [9, 12, 15, 12, 9]);
    const rests = p.filter(s => s.kind === 'rest' && s.prevExId);
    assert.deepEqual(rests.filter(s => !s.roundBreak).map(s => s.dur), [15, 15, 20, 15, 15]);
    assert.deepEqual(rests.filter(s => s.roundBreak).map(s => s.dur), [20, 20, 25, 20]);
    assert.deepEqual(w.map(s => !!s.early), [true, true, true, true, false, false, false, false, false, false], 'ressenti demandé à partir du palier le plus dur');
  });
  test('Tabata : 4 blocs de 8 × 20 s, 10 s de repos, 45 s entre les blocs, au chrono', async () => {
    const p = await page.evaluate(() => CM.buildPlan(CM.makeSession('tabata', CM.getState(), 'x'), CM.getState()));
    const w = p.filter(s => s.kind === 'work' && !s.warm);
    assert.equal(w.length, 32); assert.ok(w.every(s => s.dur === 20 && s.fixed));
    const rests = p.filter(s => s.kind === 'rest' && !s.warm && s.prevExId && !p[p.indexOf(s) - 1].warm);
    assert.equal(rests.filter(s => s.dur === 10).length, 28); assert.equal(rests.filter(s => s.dur === 45).length, 3);
  });
  test('Les exercices tournent : la fois suivante, d’autres exercices sont choisis', async () => {
    const r = await page.evaluate(() => {
      const st = JSON.parse(JSON.stringify(CM.getState()));
      const a = CM.makeSession('jambes', st, 'x');
      a.items.forEach(id => { st.ex[id].last = Date.now(); });
      return [a.items, CM.makeSession('jambes', st, 'x').items];
    });
    assert.equal(r[0].filter(id => r[1].includes(id)).length, 0, r.join(' | '));
  });
  test('Forme du jour : fatiguée -15 % et pauses plus longues, en forme +10 %', async () => {
    const sess = { rid: 'jambes', items: ['squat', 'pont'], rounds: 1, noWarm: true };
    const [n, t, g] = [await plan(sess, 'normal'), await plan(sess, 'tired'), await plan(sess, 'great')];
    const sq = p => p.find(s => s.exId === 'squat').target, rest = p => p.find(s => s.kind === 'rest' && s.prevExId).dur;
    assert.deepEqual([sq(n), sq(t), sq(g)], [15, 13, 17]);
    assert.deepEqual([rest(n), rest(t), rest(g)], [25, 30, 25]);
  });
  test('Niveaux et indice de forme', async () => {
    const r = await page.evaluate(() => {
      const st = JSON.parse(JSON.stringify(CM.getState()));
      const f0 = CM.formeIndex(st);
      st.ex.squat.target = 18; const f1 = CM.formeIndex(st);
      st.ex.squat = { target: 20, weight: 3, okStreak: 0, last: 1 }; const f2 = CM.formeIndex(st);
      for (const id of Object.keys(st.ex)) st.ex[id].target = 1; const f3 = CM.formeIndex(st);
      return { f0, f1, f2, f3, l: [0, 49, 50, 160, 4800, 6000, 7600].map(p => CM.levelOf(p)) };
    });
    assert.deepEqual([r.f0, r.f1, r.f2, r.f3], [100, 102, 110, 50], 'indice : jamais sous 50');
    assert.deepEqual(r.l.map(l => l.lvl + ' ' + l.name), ['1 Débutante', '1 Débutante', '2 Motivée', '3 Régulière', '12 Légende', '13 Mythique', '14 Mythique']);
  });
});

// ---------------------------------------------------------------------------
describe('2. Parcours complet', () => {
  let page, ctx, errors;
  before(async () => ({ page, ctx, errors } = await open()));
  after(async () => ctx.close());

  test('Accueil : programme de 3 séances (muscu / cardio / muscu), compteur 0/3, niveau 1', async () => {
    assert.equal(await page.locator('.session').count(), 3);
    for (const id of ['jambes', 'hiit', 'haut_abdos']) assert.equal(await page.locator(`[data-test=session-${id}]`).count(), 1, id);
    assert.equal(await page.locator('[data-test=week]').innerText(), '0 / 3 séances');
    assert.equal(await page.locator('[data-test=level]').innerText(), 'Débutante');
    assert.equal(await page.locator('[data-test=forme]').innerText(), '100');
    assert.equal(await page.locator('[data-test=session-jambes] [data-test=reco]').count(), 1);
    assert.equal(await page.locator('[data-test=session-decouverte]').count(), 0, 'la séance découverte a disparu');
    await page.screenshot({ path: path.join(SHOTS, '1-accueil.png'), fullPage: true });
    await noHorizontalScroll(page); await bigButtons(page);
  });
  test('Aperçu : échauffement, programme, matériel', async () => {
    await page.click('[data-test=session-jambes]');
    assert.match(await page.locator('h1').innerText(), /Jambes/);
    assert.match(await page.locator('.pv-sec').first().innerText(), /Échauffement/i);
    assert.match(await page.locator('[data-test=pv-gear]').innerText(), /Haltères/);
    await page.screenshot({ path: path.join(SHOTS, '2-apercu.png'), fullPage: true });
    await noHorizontalScroll(page); await bigButtons(page);
    await page.click('[data-action=home]');
  });
  test('Départ : écran matériel lu à voix haute, puis compte à rebours', async () => {
    await page.evaluate(s => CM.openPreview(s), MINI);
    await page.click('[data-test=start]');
    assert.equal(await phase(page), 'phase-gear');
    const g = await page.locator('[data-test=gear]').innerText();
    assert.match(g, /Haltères 2 kg/); assert.match(g, /Tapis de sol/);
    assert.ok((await says(page)).includes('Pour cette séance, prépare : tes haltères de 2 kilos et ton tapis.'), (await says(page)).join(' | '));
    await page.clock.runFor(30000);
    assert.equal(await phase(page), 'phase-gear', 'l’écran matériel attend qu’on soit prête');
    await page.screenshot({ path: path.join(SHOTS, '3-materiel.png') });
    await noHorizontalScroll(page); await bigButtons(page);
    await tap(page, '[data-test=gear-go]');
    assert.equal(await phase(page), 'phase-ready');
    assert.ok((await says(page)).includes('Prépare-toi : Jumping jacks'));
  });
  test('Exercice en temps : le chrono descend et passe tout seul au repos', async () => {
    await finishStep(page);
    assert.equal(await phase(page), 'phase-work');
    assert.equal(await page.locator('[data-test=ex-name]').innerText(), 'Jumping jacks');
    assert.equal(await tMain(page), '30');
    await page.clock.runFor(10000);
    assert.equal(await tMain(page), '20');
    await page.screenshot({ path: path.join(SHOTS, '4-exercice-chrono.png') });
    await noHorizontalScroll(page); await bigButtons(page);
    const beepsBefore = await page.evaluate(() => CM.events.filter(e => e.type === 'beep').length);
    await finishStep(page);
    const beeps = await page.evaluate(() => CM.events.filter(e => e.type === 'beep').length) - beepsBefore;
    assert.ok(beeps >= 3, `bips 3-2-1 attendus, reçu ${beeps}`);
    assert.equal(await phase(page), 'phase-rest');
  });
  test('Repos : ressenti, exercice suivant, « prends tes haltères », +10 s', async () => {
    assert.equal(await page.locator('[data-test=rate-box]').count(), 1);
    assert.match(await page.locator('[data-test=next]').innerText(), /Squats/);
    assert.equal(await page.locator('[data-test=tip]').innerText(), 'Prends 2 kg');
    assert.ok((await says(page)).includes('Repos. Ensuite : Squats, avec 2 kilos'));
    assert.equal(await tMain(page), '15');
    await page.click('[data-test=addrest]');
    assert.equal(await tMain(page), '25');
    await page.click('[data-test=rate-jacks-easy]');
    assert.equal(await page.locator('[data-test=rate-jacks-easy]').getAttribute('aria-pressed'), 'true');
    await page.screenshot({ path: path.join(SHOTS, '5-repos-ressenti.png') });
    await noHorizontalScroll(page); await bigButtons(page);
    await finishStep(page);
  });
  test('Exercice en répétitions : objectif, haltère et bouton Terminé', async () => {
    assert.equal(await page.locator('[data-test=ex-name]').innerText(), 'Squats');
    assert.equal(await page.locator('[data-test=target]').innerText(), '15');
    assert.equal(await page.locator('[data-test=chip-weight]').innerText(), '2 kg');
    await page.clock.runFor(42000);
    assert.equal(await phase(page), 'phase-work', 'un exercice en répétitions ne doit pas passer tout seul');
    await page.screenshot({ path: path.join(SHOTS, '6-exercice-reps.png') });
    await tap(page, '[data-test=done]');
    assert.equal(await phase(page), 'phase-rest');
    await page.click('[data-test=rate-squat-ok]');
    await tap(page, '[data-test=skip]');
    assert.equal(await page.locator('[data-test=ex-name]').innerText(), 'Gainage planche');
    await finishStep(page);
  });
  test('Fin : récap, ressentis pré-remplis, le dernier exercice se note ici', async () => {
    assert.equal(await page.locator('[data-test=end-count]').innerText(), '3/3');
    assert.equal(await page.locator('[data-test=rate-jacks-easy]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-test=rate-squat-ok]').getAttribute('aria-pressed'), 'true');
    await page.click('[data-test=rate-planche-hard]');
    await page.screenshot({ path: path.join(SHOTS, '7-fin-ressenti.png'), fullPage: true });
    await noHorizontalScroll(page); await bigButtons(page);
  });
  test('Enregistrer : objectifs ajustés, points gagnés', async () => {
    await page.click('[data-test=save]');
    const changes = await page.locator('[data-test=change]').allInnerTexts();
    assert.equal(changes.length, 2, changes.join(' | '));
    assert.ok(changes.some(c => /Jumping jacks : 30 → 35 s/.test(c)), changes.join(' | '));
    assert.ok(changes.some(c => /Gainage planche : 30 → 25 s/.test(c)), changes.join(' | '));
    assert.match(await page.locator('[data-test=gain]').innerText(), /\+\d+ points/);
    await page.screenshot({ path: path.join(SHOTS, '8-fin-points.png'), fullPage: true });
    const s = await state(page);
    assert.equal(s.ex.jacks.target, 35); assert.equal(s.ex.planche.target, 25);
    assert.equal(s.ex.squat.target, 15); assert.equal(s.ex.squat.okStreak, 1);
    assert.equal(s.history.length, 1); assert.equal(s.history[0].done, 3);
    assert.equal(s.history[0].kind, 'cardio'); assert.equal(s.history[0].forme, 100 + Math.round(10 * (35 / 30 - 1 + 25 / 30 - 1)));
    assert.ok(s.ex.squat.last > 0, 'date du dernier passage enregistrée');
  });
  test('Les données survivent à la fermeture de l’app', async () => {
    await page.reload();
    const s = await state(page);
    assert.equal(s.ex.jacks.target, 35); assert.equal(s.history.length, 1);
    await page.click('[data-test=tab-progress]');
    assert.match(await page.locator('[data-test=lvl-jacks]').innerText(), /35 s/);
    assert.equal(await page.locator('[data-test=hist]').count(), 1);
    assert.equal(await page.locator('[data-test=total]').innerText(), '1');
    await page.screenshot({ path: path.join(SHOTS, '9-progres.png'), fullPage: true });
    await noHorizontalScroll(page); await bigButtons(page);
  });
  test('Aucune erreur JavaScript', () => assert.deepEqual(errors, []));
});

// ---------------------------------------------------------------------------
describe('3. Contrôles pendant la séance', () => {
  test('Pause : le chrono s’arrête puis repart', async () => {
    const { page, ctx, errors } = await open();
    await startSession(page, 'jambes');
    await tap(page, '[data-test=gear-go]');
    await tap(page, '[data-test=skip]');          // Go !
    assert.equal(await page.locator('[data-test=ex-name]').innerText(), 'Rotations chevilles et hanches');
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
  test('Forme du jour : « Fatiguée » allège la séance', async () => {
    const { page, ctx, errors } = await open();
    await page.evaluate(s => CM.openPreview(s), MINI);
    await page.click('[data-test=start]');
    await page.click('[data-test=feel-tired]');
    assert.equal(await page.locator('[data-test=feel-tired]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => CM.getRun().plan.find(s => s.exId === 'squat').target), 13);
    await tap(page, '[data-test=gear-go]');
    await runToEnd(page);
    await page.click('[data-test=save]');
    assert.equal((await state(page)).history[0].feel, 'tired');
    assert.equal((await state(page)).ex.squat.target, 15, 'l’objectif de base ne bouge pas');
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Passer : un exercice passé n’est pas compté comme fait', async () => {
    const { page, ctx, errors } = await open();
    await startCustom(page, MINI);
    await tap(page, '[data-test=skip]');          // Go !
    await tap(page, '[data-test=skip]');          // passe Jumping jacks
    assert.equal(await phase(page), 'phase-rest');
    await tap(page, '[data-test=skip]');          // passe le repos
    await tap(page, '[data-test=done]');          // squats faits
    await tap(page, '[data-test=skip]');          // repos
    await tap(page, '[data-test=skip]');          // passe planche
    assert.equal(await page.locator('[data-test=end-count]').innerText(), '1/3');
    assert.equal(await page.locator('.end-ex').count(), 1, 'seuls les exercices faits sont à noter');
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Gainage latéral : signal « change de côté » à mi-temps', async () => {
    const { page, ctx, errors } = await open();
    await startCustom(page, { rid: 'abdos', items: ['gainage_lat'], rounds: 1, noWarm: true });
    await tap(page, '[data-test=skip]');          // Go !
    assert.equal(await page.locator('[data-test=side]').innerText(), 'Côté 1/2');
    assert.equal(await tMain(page), '20');
    await page.clock.runFor(20500);
    assert.equal(await page.locator('[data-test=side]').innerText(), 'Côté 2/2');
    assert.ok(await page.evaluate(() => CM.events.some(e => e.value === 'Change de côté')));
    await page.screenshot({ path: path.join(SHOTS, '10-gainage-cote.png') });
    await finishStep(page);
    assert.equal(await page.locator('[data-test=end-count]').innerText(), '1/1');
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Arrêter → « Terminer et enregistrer » garde ce qui est fait', async () => {
    const { page, ctx, errors } = await open();
    await startCustom(page, MINI);
    await tap(page, '[data-test=skip]');
    await finishStep(page);                         // jacks fait
    await page.click('[data-test=quit]');
    await page.screenshot({ path: path.join(SHOTS, '11-arreter.png') });
    await page.click('[data-test=m-quit-finish]');
    assert.equal(await page.locator('[data-test=end-count]').innerText(), '1/3');
    await page.click('[data-test=save]');
    assert.equal((await state(page)).history.length, 1);
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Arrêter → « Abandonner » ne sauvegarde rien', async () => {
    const { page, ctx, errors } = await open();
    await startCustom(page, MINI);
    await tap(page, '[data-test=skip]');
    await finishStep(page);
    await page.click('[data-test=quit]');
    await page.click('[data-test=m-quit-abandon]');
    assert.equal(await page.locator('.session').count(), 3);
    assert.equal((await state(page)).history.length, 0);
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Arrêter → « Continuer » reprend là où on était', async () => {
    const { page, ctx, errors } = await open();
    await startCustom(page, MINI);
    await tap(page, '[data-test=skip]');
    await page.clock.runFor(10000);
    await page.click('[data-test=quit]');
    await page.clock.runFor(20000);
    await page.click('[data-test=m-quit-cancel]');
    assert.equal(await tMain(page), '20');
    assert.deepEqual(errors, []); await ctx.close();
  });
});

// ---------------------------------------------------------------------------
describe('4. Vraies séances, semaine, motivation', () => {
  test('Jambes & fessiers du début à la fin : tout « Trop facile », compteur 1/3, cardio conseillé ensuite', async () => {
    const { page, ctx, errors } = await open();
    await startSession(page, 'jambes');
    await runToEnd(page, async p => {
      const box = p.locator('[data-test=rate-box] .rbtn.r-easy:not(.sel)');
      if (await box.count()) await box.click();
    });
    const r = await page.evaluate(() => { const r = CM.getRun(); return { items: r.session.items, rounds: r.session.rounds,
      warm: r.plan.filter(s => s.kind === 'work' && s.warm).length, work: r.plan.filter(s => s.kind === 'work' && !s.warm).map(s => s.exId) }; });
    assert.equal(r.warm, 4);
    for (const id of r.items) assert.equal(r.work.filter(x => x === id).length, r.rounds, id);
    assert.equal(await page.locator('[data-test=end-count]').innerText(), `${r.work.length}/${r.work.length}`);
    const before = await state(page);
    await page.click('[data-test=save]');
    const st = await state(page);
    for (const id of r.items) assert.ok(st.ex[id].target > before.ex[id].target || st.ex[id].weight > before.ex[id].weight, id);
    assert.ok(st.history[0].forme > 100);
    await page.click('[data-test=home]');
    assert.equal(await page.locator('[data-test=week]').innerText(), '1 / 3 séances');
    assert.match(await page.locator('[data-test=session-jambes]').innerText(), /Faite ✓/);
    assert.equal(await page.locator('[data-test=session-hiit] [data-test=reco]').count(), 1, 'après la muscu, le cardio est conseillé');
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Semaine suivante : compteur à zéro et nouveau programme', async () => {
    const seed = { version: 1, ex: {}, history: [{ id: '1', date: '2026-10-20T08:00:00+02:00', sessionId: 'jambes', name: 'Jambes & fessiers', durationSec: 1200, done: 15, total: 15 }], settings: { sound: true, voice: true } };
    const { page, ctx } = await open({ seed, time: new Date('2026-10-27T09:00:00+01:00') });
    assert.equal(await page.locator('[data-test=week]').innerText(), '0 / 3 séances');
    for (const id of ['tabata', 'fessiers_pyr', 'cardio_abdos']) assert.equal(await page.locator(`[data-test=session-${id}]`).count(), 1, id);
    await ctx.close();
  });
  test('Le programme de la semaine ne change pas d’un jour à l’autre', async () => {
    const { page, ctx } = await open();
    const a = (await state(page)).plan;
    await page.clock.setSystemTime(new Date('2026-10-23T18:00:00+02:00'));
    await page.reload();
    assert.deepEqual((await state(page)).plan, a);
    await ctx.close();
  });
  test('Séance en plus : choix du thème, compte dans la semaine (4/3)', async () => {
    const history = ['jambes', 'hiit', 'haut_abdos'].map((id, i) => ({ id: 'h' + i, date: new Date(Date.parse('2026-10-19T06:00:00+02:00') + i * 3600e3).toISOString(),
      sessionId: id, name: 'Séance', durationSec: 1200, done: 15, total: 15 })).reverse();
    const seed = { version: 1, ex: {}, history, settings: { sound: true, voice: true } };
    const { page, ctx, errors } = await open({ seed, time: new Date('2026-10-19T20:00:00+02:00') });
    assert.equal(await page.locator('[data-test=week]').innerText(), '3 / 3 séances');
    await page.click('[data-test=extra]');
    await page.screenshot({ path: path.join(SHOTS, '12-seance-en-plus.png') });
    await bigButtons(page);
    await page.click('[data-test=m-extra-theme-cardio]');
    assert.match(await page.locator('.s-top').innerText(), /Cardio/);
    assert.match(await page.locator('.s-top').innerText(), /Séance en plus/);
    const name = await page.locator('h1').innerText();
    assert.equal(await page.evaluate(n => Object.values(CM.RECIPES).find(r => r.name === n).kind, name), 'cardio');
    await page.click('[data-action=home]');
    await startCustom(page, { ...MINI, extra: true });
    await runToEnd(page);
    await page.click('[data-test=save]');
    await page.click('[data-test=home]');
    assert.equal(await page.locator('[data-test=week]').innerText(), '4 / 3 séances');
    assert.equal((await state(page)).history[0].extra, true);
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Série de semaines, niveau et courbe de forme', async () => {
    const history = [...weekHistory('2026-10-12T07:00:00+02:00', 3, 106), ...weekHistory('2026-10-05T07:00:00+02:00', 3, 102)];
    const { page, ctx, errors } = await open({ seed: { version: 1, ex: {}, history, settings: { sound: true, voice: true } } });
    assert.equal(await page.locator('[data-test=streak]').innerText(), '🔥 2');
    assert.equal(await page.locator('[data-test=level]').innerText(), 'Régulière');   // 6 × 30 + 2 × 20 = 220 points
    await page.click('[data-test=tab-progress]');
    assert.equal(await page.locator('[data-test=spark] circle').count(), 2);
    await page.screenshot({ path: path.join(SHOTS, '13-progres-courbe.png'), fullPage: true });
    await noHorizontalScroll(page); await bigButtons(page);
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Nouveau niveau fêté en fin de séance', async () => {
    const history = weekHistory('2026-10-12T07:00:00+02:00', 1);
    history[0].durationSec = 38 * 60;   // 38 + 10 = 48 points : juste sous le niveau 2 (50)
    const { page, ctx, errors } = await open({ seed: { version: 1, ex: {}, history, settings: { sound: true, voice: true } } });
    await startCustom(page, MINI);
    await runToEnd(page);
    await page.click('[data-test=save]');
    assert.match(await page.locator('[data-test=levelup]').innerText(), /Niveau 2 · Motivée/);
    assert.ok((await says(page)).some(s => /niveau 2/.test(s)));
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Passage à l’haltère du dessus visible en fin de séance', async () => {
    const seed = { version: 1, ex: { squat: { target: 30, weight: 2, okStreak: 0 } }, history: [], settings: { sound: true, voice: true } };
    const { page, ctx, errors } = await open({ seed });
    await startCustom(page, MINI);
    await runToEnd(page);
    await page.click('[data-test=rate-squat-easy]');
    await page.click('[data-test=save]');
    assert.match((await page.locator('[data-test=change]').allInnerTexts()).join(' '), /Squats : passe à 3 kg \(20 rép\.\)/);
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Tabata au chrono : pas de ressenti à donner, la séance s’enregistre', async () => {
    const { page, ctx, errors } = await open();
    await startCustom(page, { rid: 'tabata', items: ['jacks', 'squat'], noWarm: true });
    await runToEnd(page);
    assert.equal(await page.locator('[data-test=end-count]').innerText(), '8/8');
    assert.equal(await page.locator('.end-ex').count(), 0);
    await page.click('[data-test=save]');
    assert.equal((await state(page)).history[0].done, 8);
    assert.equal((await state(page)).ex.squat.target, 15);
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Mise à jour depuis la v1 : niveaux, historique et réglages conservés', async () => {
    const seed = { version: 1, ex: { squat: { target: 18, weight: 2, okStreak: 1 }, jacks: { target: 35, weight: null, okStreak: 0 } },
      history: [{ id: '2', date: '2026-10-18T10:00:00+02:00', sessionId: 'jambes', name: 'Jambes & fessiers', mini: false, durationSec: 1180, done: 15, total: 15, ratings: {}, changes: [] },
                { id: '1', date: '2026-10-17T10:00:00+02:00', sessionId: 'decouverte', name: 'Séance découverte', mini: true, durationSec: 130, done: 3, total: 3, ratings: {}, changes: [] }],
      settings: { sound: false, voice: true } };
    const { page, ctx, errors } = await open({ seed });
    const s = await state(page);
    assert.deepEqual([s.ex.squat.target, s.ex.squat.okStreak, s.ex.jacks.target], [18, 1, 35]);
    assert.equal(s.ex.fente_lat.target, 12, 'les nouveaux exercices démarrent à leur objectif de départ');
    assert.equal(s.history.length, 2); assert.equal(s.settings.sound, false);
    assert.equal(s.plan.sessions.length, 3);
    assert.equal(await page.locator('[data-test=forme]').innerText(), '104');   // squats +20 %, jumping jacks +17 % -> +3,7
    await page.click('[data-test=tab-progress]');
    assert.match(await page.locator('[data-test=lvl-squat]').innerText(), /18 rép/);
    assert.equal(await page.locator('[data-test=hist]').count(), 2);
    assert.deepEqual(errors, []); await ctx.close();
  });
});

// ---------------------------------------------------------------------------
describe('5. Sauvegarde, restauration, réglages', () => {
  test('Sauvegarder → tout effacer → restaurer : on retrouve tout', async () => {
    const { page, ctx, errors } = await open();
    await startCustom(page, MINI);
    await runToEnd(page);
    await page.click('[data-test=rate-jacks-easy]');
    await page.click('[data-test=save]');
    await page.click('[data-test=home]');
    await page.click('[data-test=tab-settings]');
    await page.screenshot({ path: path.join(SHOTS, '14-reglages.png'), fullPage: true });
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
  test('Une sauvegarde de l’ancienne version se restaure', async () => {
    const { page, ctx, errors } = await open();
    await page.click('[data-test=tab-settings]');
    const old = { app: 'coach-maison', version: 1, exportedAt: '2026-10-18T10:00:00.000Z', data: { version: 1,
      ex: { squat: { target: 17, weight: 2, okStreak: 0 }, planche: { target: 40, weight: null, okStreak: 1 } },
      history: [{ id: '1', date: '2026-10-18T10:00:00+02:00', sessionId: 'abdos', name: 'Abdos & gainage', mini: false, durationSec: 1100, done: 18, total: 18, ratings: {}, changes: [] }],
      settings: { sound: true, voice: false } } };
    await page.setInputFiles('#importFile', { name: 'ancienne.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
    await page.click('[data-test=m-import-confirm]');
    const s = await state(page);
    assert.deepEqual([s.ex.squat.target, s.ex.planche.target, s.history.length, s.settings.voice], [17, 40, 1, false]);
    await page.click('[data-test=tab-home]');
    assert.equal(await page.locator('.session').count(), 3);
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
    assert.equal(await page.locator('.session').count(), 3);
    await startCustom(page, MINI);
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

// ---------------------------------------------------------------------------
describe('6. Cas difficiles (relecture du code, simulations)', () => {
  test('Données illisibles au démarrage : mises de côté avant toute écriture', async () => {
    const raw = '{"version":1,"ex":{"squat":{"target":24';
    const { page, ctx, errors } = await open({ initScript: r => { if (!sessionStorage.getItem('s')) { localStorage.setItem('coachMaison.v1', r); sessionStorage.setItem('s', '1'); } } });
    await ctx.close();
    const t = await open({ initScript: new Function(`if (!sessionStorage.getItem('s')) { localStorage.setItem('coachMaison.v1', ${JSON.stringify(raw)}); sessionStorage.setItem('s', '1'); }`) });
    assert.equal(await t.page.evaluate(() => localStorage.getItem('coachMaison.v1.illisible')), raw);
    assert.equal(await t.page.locator('.session').count(), 3);
    assert.deepEqual(t.errors, []); await t.ctx.close();
  });
  test('Mémoire pleine : ses données sont lues, jamais écrasées', async () => {
    const data = JSON.stringify({ version: 1, ex: { squat: { target: 24, weight: 3, okStreak: 0 } }, history: [{ id: '1', date: '2026-10-18T10:00:00+02:00', sessionId: 'jambes', name: 'Jambes & fessiers', durationSec: 1200, done: 15, total: 15 }], settings: { sound: true, voice: true } });
    const { page, ctx, errors } = await open({ initScript: new Function(`localStorage.setItem('coachMaison.v1', ${JSON.stringify(data)});
      Storage.prototype.setItem = function () { throw new DOMException('plein', 'QuotaExceededError'); };`) });
    assert.equal((await state(page)).ex.squat.target, 24);
    assert.equal(await page.locator('[data-test=storage-warn]').count(), 1);
    await startCustom(page, MINI);
    await runToEnd(page);
    await page.click('[data-test=save]');
    assert.equal(await page.evaluate(() => localStorage.getItem('coachMaison.v1')), data, 'les données d’origine sont intactes');
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Mise à jour en milieu de semaine : la séance déjà faite avant est cochée', async () => {
    const seed = { version: 1, ex: {}, history: [{ id: '1', date: '2026-10-19T10:00:00+02:00', sessionId: 'jambes', name: 'Jambes & fessiers', mini: false, durationSec: 1200, done: 15, total: 15 }], settings: { sound: true, voice: true } };
    const { page, ctx, errors } = await open({ seed, time: new Date('2026-10-20T18:00:00+02:00') });
    assert.equal(await page.locator('[data-test=week]').innerText(), '1 / 3 séances');
    assert.match(await page.locator('[data-test=session-jambes]').innerText(), /Faite ✓/);
    assert.equal(await page.locator('[data-test=session-hiit] [data-test=reco]').count(), 1);
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Chrono des répétitions : ne saute pas après une pause', async () => {
    const { page, ctx, errors } = await open();
    await startCustom(page, { ...MINI, items: ['squat'] });
    await tap(page, '[data-test=skip]');            // Go !
    await page.clock.runFor(10200);
    assert.equal(await tMain(page), '⏱ 0:10');
    await page.click('[data-test=pause]');
    await page.clock.runFor(60000);
    await page.click('[data-test=pause]');
    assert.equal(await tMain(page), '⏱ 0:10');
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Double tap : le 2e tap ne fait pas passer l’exercice suivant', async () => {
    const { page, ctx, errors } = await open();
    await startCustom(page, MINI);
    await tap(page, '[data-test=skip]');            // Go !
    await finishStep(page);                         // jumping jacks faits -> repos
    await tap(page, '[data-test=skip]');            // « Passer le repos »…
    await page.click('[data-test=skip]');           // … et un 2e tap involontaire sur « Passer »
    assert.equal(await phase(page), 'phase-work');
    assert.equal(await page.locator('[data-test=ex-name]').innerText(), 'Squats');
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Forme du jour en tabata : un bloc de moins si fatiguée, 25 s si en forme', async () => {
    const { page, ctx } = await open();
    const r = await page.evaluate(() => { const st = CM.getState(), s = CM.makeSession('tabata', st, 'x');
      const w = f => CM.buildPlan(s, st, f).filter(x => x.kind === 'work' && x.fixed);
      return { n: w('normal').length, t: w('tired').length, g: [...new Set(w('great').map(x => x.dur))], est: ['tired', 'normal', 'great'].map(f => CM.estimateSec(s, st, f)) }; });
    assert.deepEqual([r.n, r.t, r.g], [32, 24, [25]]);
    assert.ok(r.est[0] < r.est[1] && r.est[1] < r.est[2], 'fatiguée = plus court, en forme = plus long');
    await ctx.close();
  });
  test('Un jour « fatiguée », « trop facile » ne fait pas monter l’objectif normal', async () => {
    const { page, ctx, errors } = await open();
    await page.evaluate(s => CM.openPreview(s), MINI);
    await page.click('[data-test=start]');
    await page.click('[data-test=feel-tired]');
    await tap(page, '[data-test=gear-go]');
    await runToEnd(page);
    await page.click('[data-test=rate-squat-easy]');
    await page.click('[data-test=save]');
    const s = await state(page);
    assert.deepEqual([s.ex.squat.target, s.ex.squat.okStreak], [15, 1], 'compté comme « OK »');
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Historique avec une date invalide : ignoré, l’onglet Progrès s’ouvre', async () => {
    const seed = { version: 1, ex: {}, history: [{ id: '2', date: 'pas une date', sessionId: 'jambes', name: 'X', durationSec: 10, done: 1, total: 1 },
      { id: '1', date: '2026-10-18T10:00:00+02:00', sessionId: 'hiit', name: 'HIIT', durationSec: 1200, done: 24, total: 24, forme: 101 }], settings: { sound: true, voice: true } };
    const { page, ctx, errors } = await open({ seed });
    await page.click('[data-test=tab-progress]');
    assert.equal(await page.locator('[data-test=hist]').count(), 1);
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Séance en plus : évite les séances encore prévues cette semaine', async () => {
    const { page, ctx, errors } = await open();
    for (const theme of ['cardio', 'haut', 'surprise']) {
      await page.click('[data-test=extra]');
      await page.click(`[data-test=m-extra-theme-${theme}]`);
      const name = await page.locator('h1').innerText();
      assert.ok(!['HIIT corps entier', 'Haut du corps & abdos', 'Jambes & fessiers'].includes(name), `${theme} -> ${name}`);
      await page.click('[data-action=home]');
    }
    assert.deepEqual(errors, []); await ctx.close();
  });
  test('Très forte (tous les objectifs au max) : séances toujours autour de 20 min', async () => {
    const { page, ctx } = await open();
    const r = await page.evaluate(() => { const st = JSON.parse(JSON.stringify(CM.getState()));
      for (const [id, e] of Object.entries(st.ex)) { e.target = CM.EXERCISES[id].type === 'time' ? 60 : 30; if (e.weight) e.weight = 3; }
      const out = []; for (const rid of Object.keys(CM.RECIPES)) for (const seed of 'abcd') out.push([rid, CM.estimateSec(CM.makeSession(rid, st, seed), st) / 60]); return out; });
    for (const [rid, min] of r) assert.ok(min >= 16 && min <= 24, `${rid} : ${min.toFixed(1)} min`);
    await ctx.close();
  });
  test('Séance ouverte dimanche soir mais lancée lundi : comptée en plus, pas dans le nouveau programme', async () => {
    const { page, ctx, errors } = await open({ time: new Date('2026-10-25T23:58:00+01:00') });
    await page.evaluate(() => { const p = CM.getState().plan; CM.openPreview({ ...p.sessions[0], items: ['jacks'], rounds: 1, noWarm: true, slot: 0, week: p.week }); });
    await page.clock.runFor(180000);                // minuit passe avant de lancer
    await page.click('[data-test=start]');
    await tap(page, '[data-test=gear-go]');
    await runToEnd(page);
    await page.click('[data-test=save]');
    const s = await state(page);
    assert.deepEqual([s.history[0].slot, s.history[0].extra], [null, true]);
    await page.click('[data-test=home]');
    assert.equal(await page.locator('.badge.done').count(), 0);
    assert.equal(await page.locator('[data-test=week]').innerText(), '1 / 3 séances');
    assert.deepEqual(errors, []); await ctx.close();
  });
});
