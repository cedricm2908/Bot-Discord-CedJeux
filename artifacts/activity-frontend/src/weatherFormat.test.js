// LOT ACTIVITY-UX-WEATHER -- tests de weatherFormat.js (logique de
// presentation pure, sans DOM/fetch/SDK Discord). Couvre les CAS A-E de la
// mission QA "ameliorer l'interface meteo".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildWeatherTimelineLabel, buildWeatherViewModel, formatCountdown, multiplierToEffectLabel } from './weatherFormat.js';

const NOW = 1_700_000_000_000;

function buildMe(overrides = {}) {
  return {
    weather: {
      current: { key: 'normal', label: 'Normal', emoji: '☀️', multiplier: 1 },
      nextChangeAt: NOW + 522_000,
      forecastPurchased: false,
      forecast: null,
      ...overrides,
    },
  };
}

// ===========================================================================
// CAS C/D/E -- multiplicateur > 1 / < 1 / == 1
// ===========================================================================

test('multiplierToEffectLabel -- CAS C : multiplicateur > 1 -> bonus positif', () => {
  assert.equal(multiplierToEffectLabel(1.25), '+25 %');
});

test('multiplierToEffectLabel -- CAS D : multiplicateur < 1 -> malus', () => {
  assert.equal(multiplierToEffectLabel(0.75), '-25 %');
});

test('multiplierToEffectLabel -- CAS E : multiplicateur == 1 -> aucun bonus/malus', () => {
  assert.equal(multiplierToEffectLabel(1), 'Aucun bonus/malus');
});

test('multiplierToEffectLabel -- arrondit proprement un multiplicateur non entier en pourcentage', () => {
  assert.equal(multiplierToEffectLabel(1.6), '+60 %');
  assert.equal(multiplierToEffectLabel(0.65), '-35 %');
});

// ===========================================================================
// formatCountdown
// ===========================================================================

test('formatCountdown -- formate MM:SS a partir d\'une duree en ms', () => {
  assert.equal(formatCountdown(522_000), '08:42');
  assert.equal(formatCountdown(5_000), '00:05');
  assert.equal(formatCountdown(0), '00:00');
});

test('formatCountdown -- une duree negative (deja ecoulee) est plafonnee a 00:00, jamais simulee', () => {
  assert.equal(formatCountdown(-10_000), '00:00');
});

// ===========================================================================
// CAS A -- forecast NON achete : météo actuelle + effet + timer visibles,
// prochaine météo VERROUILLEE (aucune trace du type reel)
// ===========================================================================

test('buildWeatherViewModel -- CAS A : forecast non achete -> current/effet/timer affiches, forecast verrouille (null), AUCUNE fuite', () => {
  const me = buildMe();
  const vm = buildWeatherViewModel(me, NOW);

  assert.equal(vm.current.emoji, '☀️');
  assert.equal(vm.current.label, 'Normal');
  assert.equal(vm.current.effectLabel, 'Aucun bonus/malus');
  assert.equal(vm.countdown, '08:42');
  assert.equal(vm.forecastPurchased, false);
  assert.equal(vm.forecast, null, 'la prochaine météo ne doit JAMAIS être devinée/affichée avant achat');
  assert.equal(JSON.stringify(vm).toLowerCase().includes('pests'), false);
  assert.equal(JSON.stringify(vm).toLowerCase().includes('rain'), false);
});

// ===========================================================================
// CAS B -- forecast achete : prochaine météo + effet + temps avant arrivée
// ===========================================================================

test('buildWeatherViewModel -- CAS B : forecast achete -> prochaine meteo, effet et temps avant arrivee affiches', () => {
  const me = buildMe({
    forecastPurchased: true,
    forecast: { key: 'pests', label: 'Invasion de parasites', emoji: '🐛', multiplier: 0.75 },
  });
  const vm = buildWeatherViewModel(me, NOW);

  assert.equal(vm.forecastPurchased, true);
  assert.ok(vm.forecast);
  assert.equal(vm.forecast.emoji, '🐛');
  assert.equal(vm.forecast.label, 'Invasion de parasites');
  assert.equal(vm.forecast.effectLabel, '-25 %', 'CAS D imbriqué : multiplicateur < 1 -> malus');
  assert.equal(vm.countdown, '08:42', 'le compte à rebours avant arrivée utilise le même nextChangeAt');
});

test('buildWeatherViewModel -- météo active (pluie) avec bonus positif -> current.effectLabel reflète +25 %', () => {
  const me = buildMe({ current: { key: 'rain', label: 'Pluie bénie', emoji: '☔', multiplier: 1.25 } });
  const vm = buildWeatherViewModel(me, NOW);

  assert.equal(vm.current.effectLabel, '+25 %');
});

// ===========================================================================
// LOT ACTIVITY-UX-WEATHER-TIMELINE -- UN SEUL compte a rebours central
// (meteo actuelle qui se termine == prochaine meteo qui commence, le MEME
// instant, jamais deux timers separes).
// ===========================================================================

test('buildWeatherViewModel -- expose un SEUL champ countdown (pas de countdown distinct par carte, meme instant pour les deux)', () => {
  const me = buildMe({
    forecastPurchased: true,
    forecast: { key: 'rain', label: 'Pluie bénie', emoji: '☔', multiplier: 1.25 },
  });
  const vm = buildWeatherViewModel(me, NOW);

  assert.equal(Object.prototype.hasOwnProperty.call(vm, 'countdown'), true);
  assert.equal(vm.forecast.countdown, undefined, "le sous-objet forecast ne doit jamais porter son propre countdown -- un seul timer, au niveau racine du modele");
});

test('buildWeatherTimelineLabel -- CAS C : formate le timer central a partir du countdown deja calcule', () => {
  assert.equal(buildWeatherTimelineLabel('08:42'), 'Changement météo dans 08:42');
});

test('buildWeatherViewModel + buildWeatherTimelineLabel -- CAS A : forecast verrouille -> meteo actuelle visible, timer central visible, prochaine meteo cachee, UN SEUL countdown rendu', () => {
  const me = buildMe();
  const vm = buildWeatherViewModel(me, NOW);
  const timeline = buildWeatherTimelineLabel(vm.countdown);

  assert.equal(vm.current.label, 'Normal', 'météo actuelle visible');
  assert.equal(timeline, 'Changement météo dans 08:42', 'timer central visible, calculé une seule fois');
  assert.equal(vm.forecast, null, 'prochaine météo cachée tant que non achetée');
});

test('buildWeatherViewModel + buildWeatherTimelineLabel -- CAS B : forecast debloque -> meteo actuelle visible, timer central visible, prochaine meteo visible, aucun deuxieme timer dans le modele de prevision', () => {
  const me = buildMe({
    forecastPurchased: true,
    forecast: { key: 'pests', label: 'Invasion de parasites', emoji: '🐛', multiplier: 0.75 },
  });
  const vm = buildWeatherViewModel(me, NOW);
  const timeline = buildWeatherTimelineLabel(vm.countdown);

  assert.equal(vm.current.label, 'Normal');
  assert.equal(timeline, 'Changement météo dans 08:42');
  assert.equal(vm.forecast.label, 'Invasion de parasites', 'prochaine météo visible');
  assert.equal(Object.keys(vm.forecast).sort().join(','), 'effectLabel,emoji,key,label', "le forecast ne porte AUCUNE cle countdown/arrivee -- le timer central est la seule source, jamais dupliquee dans la carte prevision");
});

test('buildWeatherTimelineLabel -- CAS D : expiration (countdown deja a 00:00) -> affiche 00:00, aucune simulation locale de changement', () => {
  const me = buildMe();
  const vm = buildWeatherViewModel(me, NOW + 10 * 60 * 1000); // "now" 10 min apres nextChangeAt : deja expire
  const timeline = buildWeatherTimelineLabel(vm.countdown);

  assert.equal(vm.countdown, '00:00');
  assert.equal(timeline, 'Changement météo dans 00:00');
  assert.equal(vm.current.key, 'normal', "la meteo COURANTE affichee reste EXACTEMENT celle du payload backend recu -- aucune bascule locale vers la prochaine meteo, meme a 00:00");
});

test('buildWeatherViewModel -- CAS E : le verrouillage forecast reste strictement identique (forecastPurchased/forecast inchange par ce LOT presentation-only)', () => {
  const locked = buildWeatherViewModel(buildMe(), NOW);
  assert.equal(locked.forecastPurchased, false);
  assert.equal(locked.forecast, null);

  const unlocked = buildWeatherViewModel(
    buildMe({ forecastPurchased: true, forecast: { key: 'rain', label: 'Pluie bénie', emoji: '☔', multiplier: 1.25 } }),
    NOW,
  );
  assert.equal(unlocked.forecastPurchased, true);
  assert.ok(unlocked.forecast);
});
