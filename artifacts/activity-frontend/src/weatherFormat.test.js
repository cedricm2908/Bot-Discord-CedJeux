// LOT ACTIVITY-UX-WEATHER -- tests de weatherFormat.js (logique de
// presentation pure, sans DOM/fetch/SDK Discord). Couvre les CAS A-E de la
// mission QA "ameliorer l'interface meteo".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildWeatherViewModel, formatCountdown, multiplierToEffectLabel } from './weatherFormat.js';

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
