// LOT ACTIVITY-UX-QUANTITIES -- tests de quantitySelector.js (logique de
// preview pure, sans DOM/fetch). Couvre les cas VENTE et CRAFT demandes
// par la mission QA "selection des quantites pour vente et craft".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampQuantity, computeCraftPreview, computeMaxCraftable, computeSellPreview } from './quantitySelector.js';

// ===========================================================================
// clampQuantity
// ===========================================================================

test('clampQuantity -- ramene une valeur dans [1, max]', () => {
  assert.equal(clampQuantity(1, 16), 1);
  assert.equal(clampQuantity(5, 16), 5);
  assert.equal(clampQuantity(20, 16), 16, 'jamais plus que le stock/max reel');
  assert.equal(clampQuantity(0, 16), 1, 'minimum = 1');
  assert.equal(clampQuantity(-3, 16), 1, 'jamais negatif');
});

test('clampQuantity -- max = 0 -> 0 (aucune quantite valide)', () => {
  assert.equal(clampQuantity(5, 0), 0);
  assert.equal(clampQuantity(1, 0), 0);
});

test('clampQuantity -- tronque les decimales et gere une saisie vide/non numerique', () => {
  assert.equal(clampQuantity(3.9, 16), 3);
  assert.equal(clampQuantity(NaN, 16), 1);
  assert.equal(clampQuantity(undefined, 16), 1);
});

// ===========================================================================
// VENTE -- computeSellPreview
// ===========================================================================

test('computeSellPreview -- quantite 1 -> gain = prix unitaire', () => {
  const preview = computeSellPreview(16, 4, 1);
  assert.equal(preview.quantity, 1);
  assert.equal(preview.gain, 4);
});

test('computeSellPreview -- quantite 5 -> gain = prix x 5', () => {
  const preview = computeSellPreview(16, 4, 5);
  assert.equal(preview.quantity, 5);
  assert.equal(preview.gain, 20);
});

test('computeSellPreview -- MAX (quantite = stock) -> gain = prix x stock', () => {
  const preview = computeSellPreview(16, 4, 16);
  assert.equal(preview.quantity, 16);
  assert.equal(preview.gain, 64);
});

test('computeSellPreview -- une quantite superieure au stock est plafonnee au stock reel', () => {
  const preview = computeSellPreview(16, 4, 999);
  assert.equal(preview.quantity, 16, 'ne doit JAMAIS depasser le stock reellement possede');
  assert.equal(preview.gain, 64);
});

test('computeSellPreview -- stock 0 -> aucune quantite valide, gain 0', () => {
  const preview = computeSellPreview(0, 4, 5);
  assert.equal(preview.quantity, 0);
  assert.equal(preview.gain, 0);
});

// ===========================================================================
// CRAFT -- computeMaxCraftable
// ===========================================================================

test('computeMaxCraftable -- recette a un seul ingredient (Pain : 3 x blé, stock 16) -> floor(16/3) = 5', () => {
  const max = computeMaxCraftable({ wheat: 3 }, { wheat: 16 });
  assert.equal(max, 5);
});

test('computeMaxCraftable -- recette multi-ingredients -> minimum entre TOUS les ingredients', () => {
  // Tarte à la citrouille : 2 x citrouille + 1 x blé
  const max = computeMaxCraftable({ pumpkin: 2, wheat: 1 }, { pumpkin: 9, wheat: 30 });
  assert.equal(max, 4, "limite par la citrouille (floor(9/2)=4), pas par le blé (floor(30/1)=30)");
});

test('computeMaxCraftable -- ingredient manquant du tout -> 0', () => {
  const max = computeMaxCraftable({ wheat: 3 }, {});
  assert.equal(max, 0);
});

test('computeMaxCraftable -- aucun ingredient dans la recette -> 0 (jamais Infinity)', () => {
  const max = computeMaxCraftable({}, { wheat: 100 });
  assert.equal(max, 0);
});

// ===========================================================================
// CRAFT -- computeCraftPreview
// ===========================================================================

test('computeCraftPreview -- quantite 1 -> cout = recette unitaire', () => {
  const preview = computeCraftPreview({ wheat: 3 }, { wheat: 16 }, 1);
  assert.equal(preview.quantity, 1);
  assert.deepEqual(preview.costs, { wheat: 3 });
  assert.equal(preview.affordable, true);
});

test('computeCraftPreview -- quantite 4 -> chaque ingredient multiplie correctement (Pain : 3 x blé x4 = 12)', () => {
  const preview = computeCraftPreview({ wheat: 3 }, { wheat: 16 }, 4);
  assert.equal(preview.quantity, 4);
  assert.deepEqual(preview.costs, { wheat: 12 });
});

test('computeCraftPreview -- MAX -> quantite maximale calculee selon l\'ingredient limitant', () => {
  const preview = computeCraftPreview({ wheat: 3 }, { wheat: 16 }, 999);
  assert.equal(preview.quantity, 5, 'floor(16/3) = 5, jamais plus');
  assert.deepEqual(preview.costs, { wheat: 15 });
});

test('computeCraftPreview -- recette multi-ingredients (Tarte à la citrouille) -> tous les couts multiplies correctement', () => {
  const preview = computeCraftPreview({ pumpkin: 2, wheat: 1 }, { pumpkin: 9, wheat: 30 }, 3);
  assert.equal(preview.quantity, 3);
  assert.deepEqual(preview.costs, { pumpkin: 6, wheat: 3 });
  assert.equal(preview.affordable, true);
});

test('computeCraftPreview -- ressources insuffisantes -> quantite/affordable a 0', () => {
  const preview = computeCraftPreview({ wheat: 3 }, { wheat: 2 }, 1);
  assert.equal(preview.maxCraftable, 0);
  assert.equal(preview.quantity, 0);
  assert.equal(preview.affordable, false);
});
