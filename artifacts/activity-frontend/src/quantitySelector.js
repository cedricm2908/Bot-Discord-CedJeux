// LOT ACTIVITY-UX-QUANTITIES -- logique de presentation PURE (aucun DOM,
// aucun fetch) pour les selecteurs de quantite "[ - ] [ n ] [ + ] [ MAX ]"
// de la vente d'inventaire et du craft. Separee de main.js pour rester
// testable avec `node --test`, meme convention que weatherFormat.js.
//
// Ne fait AUCUN appel API et ne duplique AUCUNE regle metier de decision
// (le backend -- sell()/craft() dans farm.ts -- reste la seule source de
// verite au moment de l'action reelle) : ces fonctions ne font que
// PREVISUALISER, a partir du payload deja recu (inventory, prix, RECIPES),
// exactement les memes formules que le backend utilise deja
// (currentCropPrice/productPrice pour le prix, floor(stock/besoin) pour le
// max fabricable -- voir craft() dans farm.ts).

// Ramene `value` dans [1, max], ou 0 si max <= 0 (rien de vendable/
// fabricable : aucune quantite valide). Toujours un entier.
export function clampQuantity(value, max) {
  const ceiling = Math.max(0, Math.floor(max));
  if (ceiling <= 0) return 0;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, ceiling);
}

// Previsualisation de vente : gain = quantite x prix unitaire actuel (le
// prix vient TOUJOURS du payload backend -- jamais une valeur codee en
// dur ici).
export function computeSellPreview(stock, unitPrice, quantity) {
  const clamped = clampQuantity(quantity, stock);
  return { quantity: clamped, gain: clamped * unitPrice };
}

// Nombre maximum d'unites fabricables avec le stock actuel, tous
// ingredients confondus -- min(floor(stock[ingredient] / besoin)) sur
// TOUS les ingredients de la recette, exactement la formule utilisee par
// craft() (farm.ts) pour valider une requete, mais ici independante de la
// quantite demandee (le "vrai" maximum, pas une simple verification).
export function computeMaxCraftable(ingredients, inventory) {
  const entries = Object.entries(ingredients ?? {});
  if (!entries.length) return 0;
  let max = Infinity;
  for (const [itemId, needed] of entries) {
    const perUnit = needed || 1;
    const available = inventory[itemId] ?? 0;
    max = Math.min(max, Math.floor(available / perUnit));
  }
  return Number.isFinite(max) ? Math.max(0, max) : 0;
}

// Previsualisation de craft : cout total par ingredient (recette unitaire
// x quantite) + quantite produite + si c'est realisable avec le stock
// actuel. `quantity` est clampee au maxCraftable REEL (jamais > stock
// disponible).
export function computeCraftPreview(ingredients, inventory, quantity) {
  const maxCraftable = computeMaxCraftable(ingredients, inventory);
  const clamped = clampQuantity(quantity, maxCraftable);
  const costs = Object.fromEntries(
    Object.entries(ingredients ?? {}).map(([itemId, needed]) => [itemId, (needed ?? 0) * clamped]),
  );
  return {
    quantity: clamped,
    maxCraftable,
    costs,
    affordable: maxCraftable > 0 && clamped > 0,
  };
}
