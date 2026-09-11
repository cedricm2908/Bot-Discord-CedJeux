import { DiscordSDK, patchUrlMappings } from '@discord/embedded-app-sdk';
import { buildWeatherViewModel, multiplierToEffectLabel } from './weatherFormat.js';
import { clampQuantity, computeCraftPreview, computeMaxCraftable, computeSellPreview } from './quantitySelector.js';

const CLIENT_ID = '1545070811713372262';
const API_TARGET = 'workspaceapi-server-production-e501.up.railway.app';

patchUrlMappings([{ prefix: '/api', target: API_TARGET }]);

const appEl = document.getElementById('app');

const TIER_COLORS = {
  1: { c: '#3f6b2f', soft: '#e3ecda' },
  5: { c: '#8a6420', soft: '#efe6d0' },
  12: { c: '#a8541f', soft: '#f2e0cf' },
  20: { c: '#1f6f60', soft: '#dceae5' },
  30: { c: '#8c2f2f', soft: '#f1dcda' },
  45: { c: '#5b3c96', soft: '#e6ddf4' },
};

const UPGRADE_LABELS = {
  plots: { label: 'Parcelle', icon: '🟫' },
  irrigation: { label: 'Irrigation', icon: '💧' },
  fertilizer: { label: 'Engrais', icon: '🌿' },
};

const STARTING_PLOTS = 4;
const MAX_PLOTS = 40;
const MAX_IRRIGATION = 15;
const MAX_FERTILIZER = 20;
// Doit rester identique a FORECAST_COST (artifacts/api-server/src/discord/constants.ts) --
// prix inchange par ce LOT, affiche ici uniquement pour le bouton d'achat.
const FORECAST_COST = 15;

function itemUnitPrice(itemId, marketMultiplier) {
  const crop = cropById[itemId];
  if (crop) return Math.max(1, Math.round(crop.basePrice * marketMultiplier));
  const recipe = recipeById[itemId];
  return recipe ? recipe.sellPrice : 0;
}

function upgradeInfo(kind, me) {
  if (kind === 'plots') {
    const current = me.plots.length;
    const maxed = current >= MAX_PLOTS;
    const cost = maxed ? null : Math.round(120 * 1.55 ** (current - STARTING_PLOTS));
    return { current, max: MAX_PLOTS, cost, maxed };
  }
  if (kind === 'irrigation') {
    const current = me.irrigationLevel;
    const maxed = current >= MAX_IRRIGATION;
    const cost = maxed ? null : Math.round(200 * 1.45 ** current);
    return { current, max: MAX_IRRIGATION, cost, maxed };
  }
  const current = me.fertilizerLevel;
  const maxed = current >= MAX_FERTILIZER;
  const cost = maxed ? null : Math.round(200 * 1.45 ** current);
  return { current, max: MAX_FERTILIZER, cost, maxed };
}

let accessToken = null;
let crops = [];
let recipes = [];
let weatherTypes = [];
let cropById = {};
let recipeById = {};
let currentMe = null;
let pickerOpenForPlot = null;
let feedback = null;
let refreshTimer = null;
let weatherHelpOpen = false;
let weatherTickTimer = null;
// LOT ACTIVITY-UX-QUANTITIES -- quantite selectionnee PAR item vendable /
// PAR recette, jamais une seule variable globale (chaque ligne garde son
// propre etat, independamment des autres).
const sellQuantities = {};
const craftQuantities = {};

// `kind` distingue les deux stores ('sell' | 'craft') pour reutiliser LA
// MEME logique de controle [ − ][ n ][ + ][ MAX ] sur les deux sections
// sans dupliquer le wiring d'evenements.
function qtyStoreFor(kind) {
  return kind === 'sell' ? sellQuantities : craftQuantities;
}

// Lit la quantite actuellement selectionnee pour `id`, la RECLAMPE contre
// le maximum reel courant (stock/maxCraftable, qui peut avoir change
// depuis le dernier refresh) et normalise le store en consequence --
// applique automatiquement "reduire la quantite au nouveau maximum" (voir
// mission section 6) sans jamais exiger d'action du joueur.
function getQty(kind, id, max) {
  const store = qtyStoreFor(kind);
  const clamped = clampQuantity(store[id] ?? 1, max);
  store[id] = clamped;
  return clamped;
}

function setQty(kind, id, value, max) {
  qtyStoreFor(kind)[id] = clampQuantity(value, max);
  render();
}

// Composant visuel generique reutilise par la vente ET le craft.
function quantityControlHtml(kind, id, quantity, max) {
  const disabled = max <= 0;
  return `
    <div class="qty-control">
      <button class="qty-btn" data-qty-minus="${id}" data-qty-kind="${kind}" ${disabled || quantity <= 1 ? 'disabled' : ''}>−</button>
      <input class="qty-input" type="number" inputmode="numeric" min="1" max="${max}" step="1" value="${quantity}" data-qty-input="${id}" data-qty-kind="${kind}" ${disabled ? 'disabled' : ''} />
      <button class="qty-btn" data-qty-plus="${id}" data-qty-kind="${kind}" ${disabled || quantity >= max ? 'disabled' : ''}>+</button>
      <button class="mini-btn qty-max-btn" data-qty-setmax="${id}" data-qty-kind="${kind}" ${disabled ? 'disabled' : ''}>MAX</button>
    </div>`;
}

function tierFor(unlockLevel) {
  const levels = Object.keys(TIER_COLORS).map(Number).sort((a, b) => a - b);
  let picked = levels[0];
  for (const lvl of levels) if (unlockLevel >= lvl) picked = lvl;
  return TIER_COLORS[picked];
}

function stageIcon(crop, plot) {
  if (plot.ready) return crop.emoji;
  if (plot.percent < 33) return '🌱';
  if (plot.percent < 70) return '🌿';
  return crop.emoji;
}

function setStatus(text, isError = false) {
  appEl.innerHTML = `
    <div class="center">
      ${isError ? '' : '<div class="spinner"></div>'}
      <div class="status${isError ? ' error' : ''}">${text}</div>
    </div>
  `;
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `${res.status}`);
  return body;
}

async function postAction(path, body) {
  return fetchJson(`/.proxy/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body ?? {}),
  });
}

async function runAction(promiseFn, successMessage) {
  try {
    const me = await promiseFn();
    currentMe = me;
    feedback = { text: successMessage, error: false };
  } catch (err) {
    feedback = { text: err.message || 'Action impossible', error: true };
  }
  pickerOpenForPlot = null;
  render();
}

function openPicker(plotIndex) { pickerOpenForPlot = plotIndex; render(); }
function closePicker() { pickerOpenForPlot = null; render(); }
function plantCrop(plotIndex, cropId) {
  runAction(() => postAction('/activity/plant', { cropId, plot: plotIndex + 1 }), `Culture plantée sur la parcelle ${plotIndex + 1} !`);
}
function harvestAll() { runAction(() => postAction('/activity/harvest'), 'Récolte effectuée !'); }
function claimDaily() { runAction(() => postAction('/activity/daily'), 'Récompense quotidienne récupérée !'); }
function toggleAutoReplant() { runAction(() => postAction('/activity/autoreplant'), 'Replantation auto mise à jour.'); }
// LOT ACTIVITY-UX-QUANTITIES -- la quantite reellement envoyee au backend
// (POST /activity/sell { itemId, amount }) est TOUJOURS relue/reclampee
// juste avant l'appel (jamais une valeur potentiellement perimee) --
// meme routes existantes, seul le montant envoye change desormais.
function confirmSell(itemId) {
  const stock = currentMe?.inventory?.[itemId] ?? 0;
  const quantity = getQty('sell', itemId, stock);
  if (quantity < 1) return;
  const item = cropById[itemId] || recipeById[itemId];
  runAction(() => postAction('/activity/sell', { itemId, amount: quantity }), `${quantity}× ${item?.name ?? itemId} vendu(e) !`);
  delete sellQuantities[itemId];
}
function sellAll() { runAction(() => postAction('/activity/sell', { itemId: 'all' }), 'Inventaire vendu !'); }
function buyUpgrade(kind) {
  const label = UPGRADE_LABELS[kind]?.label ?? kind;
  runAction(() => postAction('/activity/buy', { kind, quantity: 1 }), `${label} améliorée !`);
}
// Meme principe que confirmSell() : POST /activity/craft { recipeId,
// quantity } -- route existante inchangee, seule la quantite envoyee
// varie desormais selon le selecteur du joueur.
function confirmCraft(recipeId) {
  const recipe = recipeById[recipeId];
  const maxCraftable = recipe ? computeMaxCraftable(recipe.ingredients, currentMe?.inventory ?? {}) : 0;
  const quantity = getQty('craft', recipeId, maxCraftable);
  if (quantity < 1) return;
  runAction(() => postAction('/activity/craft', { recipeId, quantity }), `${quantity}× ${recipe?.name ?? recipeId} fabriqué !`);
  delete craftQuantities[recipeId];
}
function claimQuestAction(index) {
  runAction(() => postAction('/activity/quest-claim', { questIndex: index }), 'Récompense de mission récupérée !');
}
function chooseSkinAction(skinId) {
  runAction(() => postAction('/activity/skin', { skinId }), 'Thème de parcelle changé !');
}
function buyForecastAction() {
  runAction(() => postAction('/activity/forecast'), 'Prévision météo débloquée !');
}
function toggleWeatherHelp() { weatherHelpOpen = !weatherHelpOpen; render(); }

// LOT ACTIVITY-UX-QUANTITIES -- [ − ][ n ][ + ][ MAX ] pour la vente ET le
// craft. AUCUN de ces handlers n'appelle l'API : ils ne font que mettre a
// jour sellQuantities/craftQuantities puis re-render() la preview
// (gain/couts) localement -- l'appel reseau n'a lieu qu'au clic sur
// "Vendre X"/"Fabriquer X" (confirmSell/confirmCraft ci-dessus).
function qtyMaxFor(kind, id) {
  if (!currentMe) return 0;
  if (kind === 'sell') return currentMe.inventory?.[id] ?? 0;
  const recipe = recipeById[id];
  return recipe ? computeMaxCraftable(recipe.ingredients, currentMe.inventory ?? {}) : 0;
}
function handleQtyMinus(kind, id) {
  const max = qtyMaxFor(kind, id);
  setQty(kind, id, getQty(kind, id, max) - 1, max);
}
function handleQtyPlus(kind, id) {
  const max = qtyMaxFor(kind, id);
  setQty(kind, id, getQty(kind, id, max) + 1, max);
}
function handleQtySetMax(kind, id) {
  const max = qtyMaxFor(kind, id);
  setQty(kind, id, max, max);
}
function handleQtyInput(kind, id, rawValue) {
  const max = qtyMaxFor(kind, id);
  // Saisie vide/invalide -> clampQuantity() retombe proprement sur 1
  // (ou 0 si max est deja 0), jamais NaN/negatif/decimal affiche.
  setQty(kind, id, rawValue === '' ? NaN : Number(rawValue), max);
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    if (pickerOpenForPlot === null && accessToken) {
      try {
        currentMe = await fetchJson('/.proxy/api/activity/me', { headers: { Authorization: `Bearer ${accessToken}` } });
        render();
      } catch (_e) { /* silent retry */ }
    }
    scheduleRefresh();
  }, 12000);
}

// Fait vivre le compte a rebours meteo (parcelle "Changement dans MM:SS")
// cote client SANS jamais interroger l'API chaque seconde : ne met a jour
// QUE le texte des noeuds DOM dedies (#weatherCountdown/#forecastCountdown),
// jamais un render() complet (qui reconstruirait toute la page a chaque
// tick). L'etat serveur reel (GET /activity/me, toutes les 12s via
// scheduleRefresh()) reste la SEULE source de verite -- quand le compte a
// rebours atteint 00:00, on ne simule JAMAIS localement le changement de
// meteo : le texte reste a 00:00 jusqu'au prochain refresh reel.
function scheduleWeatherTick() {
  if (weatherTickTimer) clearInterval(weatherTickTimer);
  weatherTickTimer = setInterval(() => {
    if (!currentMe) return;
    const vm = buildWeatherViewModel(currentMe);
    const currentEl = document.getElementById('weatherCountdown');
    if (currentEl) currentEl.textContent = `Changement dans ${vm.countdown}`;
    const forecastEl = document.getElementById('forecastCountdown');
    if (forecastEl) forecastEl.textContent = `Arrive dans ${vm.countdown}`;
  }, 1000);
}

function pickerHtml(me) {
  if (pickerOpenForPlot === null) return '';
  const options = crops.map((crop) => {
    const locked = me.level < crop.unlockLevel;
    const tooExpensive = !locked && me.coins < crop.seedCost;
    const disabled = locked || tooExpensive;
    const tier = tierFor(crop.unlockLevel);
    return `
      <button class="crop-option" data-crop="${crop.id}" ${disabled ? 'disabled' : ''} style="--tier-c:${tier.c}">
        <span class="crop-emoji">${crop.emoji}</span>
        <span class="crop-name">${crop.name}</span>
        <span class="crop-meta">${locked ? `🔒 niv. ${crop.unlockLevel}` : `💰 ${crop.seedCost}`}</span>
      </button>`;
  }).join('');
  return `
    <div class="picker-backdrop" id="pickerBackdrop">
      <div class="picker">
        <div class="picker-head"><span>Planter sur la parcelle ${pickerOpenForPlot + 1}</span><button class="picker-close" id="pickerClose">✕</button></div>
        <div class="picker-grid">${options}</div>
      </div>
    </div>`;
}

// LOT ACTIVITY-UX-QUANTITIES -- vente PAR quantite choisie (au lieu d'un
// simple bouton "Vendre" qui vendait tout le stock de l'item en un clic).
// "Tout vendre" (bouton global ci-dessous) reste disponible en parallele :
// il ne fait PAS la meme chose que "MAX" sur une seule ligne (il vend TOUT
// l'inventaire en une requete, MAX+Vendre ne vide qu'UN item) -- les deux
// coexistent, pas de doublon fonctionnel.
function inventoryHtml(me) {
  const entries = Object.entries(me.inventory);
  if (!entries.length) return '<p class="empty-note">Ton inventaire est vide — récolte des cultures pour commencer.</p>';
  let totalValue = 0;
  const rows = entries.map(([itemId, stock]) => {
    const item = cropById[itemId] || recipeById[itemId];
    if (!item || stock <= 0) return '';
    const unitPrice = itemUnitPrice(itemId, me.global.marketMultiplier);
    totalValue += unitPrice * stock;
    const quantity = getQty('sell', itemId, stock);
    const preview = computeSellPreview(stock, unitPrice, quantity);
    return `
      <div class="inv-row">
        <div class="inv-info">
          <span class="inv-icon">${item.emoji}</span>
          <span class="inv-name">${item.name}</span>
          <span class="inv-qty">Stock : ${stock}</span>
          <span class="inv-price">${unitPrice} 🪙 / unité</span>
        </div>
        <div class="qty-row">
          ${quantityControlHtml('sell', itemId, preview.quantity, stock)}
          <span class="qty-gain">Gain : ${preview.gain} 🪙</span>
          <button class="mini-btn qty-confirm-btn" data-sell-confirm="${itemId}" ${preview.quantity < 1 ? 'disabled' : ''}>Vendre ${preview.quantity}</button>
        </div>
      </div>`;
  }).join('');
  return `<div class="inv-list">${rows}</div><button class="action-btn" id="sellAllBtn">🏪 Tout vendre (💰 ${totalValue})</button>`;
}

function upgradeCardHtml(kind, me) {
  const meta = UPGRADE_LABELS[kind];
  const info = upgradeInfo(kind, me);
  const cantAfford = !info.maxed && me.coins < info.cost;
  return `
    <div class="upgrade-card">
      <span class="upgrade-icon">${meta.icon}</span>
      <span class="upgrade-label">${meta.label}</span>
      <span class="upgrade-level">${info.current}/${info.max}</span>
      <span class="upgrade-price">${info.maxed ? 'Niveau max' : `💰 ${info.cost}`}</span>
      <button class="mini-btn" data-buy="${kind}" ${info.maxed || cantAfford ? 'disabled' : ''}>${info.maxed ? 'Max' : 'Acheter'}</button>
    </div>`;
}

function upgradesHtml(me) {
  return `
    <div class="upgrade-row">
      ${upgradeCardHtml('plots', me)}
      ${upgradeCardHtml('irrigation', me)}
      ${upgradeCardHtml('fertilizer', me)}
    </div>`;
}

// LOT ACTIVITY-UX-QUANTITIES -- quantite a fabriquer choisie par recette
// (au lieu d'un simple bouton "Fabriquer" qui ne fabriquait qu'une unite).
// maxCraftable/couts/resultat sont recalcules EN DIRECT (computeMaxCraftable/
// computeCraftPreview, quantitySelector.js) a partir de recipe.ingredients
// (RECIPES, jamais hardcode) + me.inventory -- aucun appel API pour la
// preview, uniquement au clic sur "Fabriquer X" (confirmCraft()).
function craftingHtml(me) {
  if (!recipes.length) return '';
  const cards = recipes.map((recipe) => {
    const unitIngredients = Object.entries(recipe.ingredients).map(([cropId, qty]) => {
      const crop = cropById[cropId];
      return `${qty}× ${crop?.emoji ?? ''}`;
    }).join(' + ');
    const maxCraftable = computeMaxCraftable(recipe.ingredients, me.inventory);
    const quantity = getQty('craft', recipe.id, maxCraftable);
    const preview = computeCraftPreview(recipe.ingredients, me.inventory, quantity);
    const costLines = Object.entries(preview.costs).map(([cropId, total]) => {
      const crop = cropById[cropId];
      const available = me.inventory[cropId] ?? 0;
      return `<span class="craft-cost-line">${crop?.emoji ?? ''} ${total} nécessaires / ${available} disponibles</span>`;
    }).join('');
    return `
      <div class="craft-card">
        <span class="craft-emoji">${recipe.emoji}</span>
        <span class="craft-name">${recipe.name}</span>
        <span class="craft-ing">Recette unitaire : ${unitIngredients}</span>
        ${quantityControlHtml('craft', recipe.id, preview.quantity, maxCraftable)}
        <div class="craft-cost">${costLines}</div>
        <span class="craft-result">Résultat : ${preview.quantity}× ${recipe.emoji} ${recipe.name}</span>
        ${maxCraftable === 0 ? '<span class="craft-insufficient">⚠️ Ressources insuffisantes</span>' : ''}
        <button class="mini-btn qty-confirm-btn" data-craft-confirm="${recipe.id}" ${!preview.affordable ? 'disabled' : ''}>Fabriquer ${preview.quantity}</button>
      </div>`;
  }).join('');
  return `<div class="craft-row">${cards}</div>`;
}

function questsHtml(me) {
  if (!me.quests?.length) return '<p class="empty-note">Aucune mission pour le moment.</p>';
  const rows = me.quests.map((quest, index) => {
    const done = quest.progress >= quest.target;
    const percent = Math.min(100, Math.round((quest.progress / quest.target) * 100));
    return `
      <div class="quest-row">
        <span class="quest-label">${quest.label}</span>
        <div class="quest-bar"><span style="width:${percent}%"></span></div>
        <span class="quest-progress">${quest.progress}/${quest.target} · 💰 ${quest.rewardCoins}</span>
        <button class="mini-btn" data-quest="${index}" ${quest.claimed || !done ? 'disabled' : ''}>${quest.claimed ? 'Récupéré' : 'Récupérer'}</button>
      </div>`;
  }).join('');
  return `<div class="quest-list">${rows}</div>`;
}

function achievementsHtml(me) {
  if (!me.achievements?.length) return '<p class="empty-note">Aucun succès débloqué pour l\'instant.</p>';
  const chips = me.achievements.map((a) => `<span class="badge-chip" title="${a.label}">${a.emoji} ${a.label}</span>`).join('');
  return `<div class="badge-row">${chips}</div>`;
}

function skinsHtml(me) {
  if (!me.skins?.length) return '';
  const cards = me.skins.map((skin) => {
    const active = me.plotSkin === skin.id;
    return `
      <button class="skin-card ${active ? 'active' : ''}" data-skin="${skin.id}" ${!skin.unlocked || active ? 'disabled' : ''} style="--tier-c:${skin.color}">
        <span class="skin-emoji">${skin.emoji}</span>
        <span class="skin-name">${skin.name}</span>
        <span class="skin-meta">${active ? 'Actif' : skin.unlocked ? 'Choisir' : `🔒 niv. ${skin.unlockLevel}`}</span>
      </button>`;
  }).join('');
  return `<div class="skin-row">${cards}</div>`;
}

function challengeHtml(me) {
  const challenge = me.dailyChallenge;
  if (!challenge) return '';
  const crop = cropById[challenge.cropId];
  const percent = Math.min(100, Math.round((challenge.progress / challenge.target) * 100));
  const statusNote = challenge.completed
    ? (challenge.contributed ? '· Terminé, récompense reçue !' : '· Terminé par le serveur')
    : '';
  return `
    <div class="challenge-box">
      <span class="challenge-label">${crop?.emoji ?? ''} Récolter ${challenge.target} ${crop?.name ?? challenge.cropId} (tout le serveur)</span>
      <div class="challenge-bar"><span style="width:${percent}%"></span></div>
      <span class="challenge-progress">${challenge.progress}/${challenge.target} · 💰 ${challenge.rewardCoins} ${statusNote}</span>
    </div>`;
}

// LOT ACTIVITY-UX-WEATHER -- section météo complète : météo actuelle +
// effet réel + compte à rebours (D. temps restant) ; prévision VERROUILLÉE
// tant qu'elle n'est pas achetée (aucune fuite du nom/icône/multiplicateur
// de la prochaine météo -- me.weather.forecast reste `null` côté backend
// tant que POST /activity/forecast n'a pas été appelé avec succès) puis
// détaillée après achat ; panneau d'aide repliable listant TOUTES les
// météos réelles (weatherTypes, dérivé de GET /activity/crops).
function weatherSectionHtml(me) {
  const vm = buildWeatherViewModel(me);

  const forecastBody = vm.forecastPurchased && vm.forecast
    ? `
      <div class="weather-forecast unlocked">
        <span class="weather-forecast-title">🔮 Prévision débloquée</span>
        <div class="weather-current-line">
          <span class="weather-emoji">${vm.forecast.emoji}</span>
          <span class="weather-name">${vm.forecast.label}</span>
        </div>
        <span class="weather-effect">Rendement prévu : ${vm.forecast.effectLabel}</span>
        <span class="weather-countdown" id="forecastCountdown">Arrive dans ${vm.countdown}</span>
      </div>`
    : `
      <div class="weather-forecast locked">
        <span class="weather-forecast-title">🔮 Prévision</span>
        <span class="weather-locked">🔒 Prochaine météo inconnue</span>
        <p class="weather-hint">Achète une prévision pour connaître les prochaines conditions avant qu'elles arrivent.</p>
        <button class="action-btn" id="forecastBtn">🔮 Acheter la prévision — ${FORECAST_COST} 🪙</button>
      </div>`;

  const helpBody = weatherHelpOpen
    ? `<div class="weather-help-list">${weatherTypes.map((w) => `
        <div class="weather-help-row">
          <span class="weather-emoji">${w.emoji}</span>
          <span class="weather-name">${w.label}</span>
          <span class="weather-effect">Rendement : ${multiplierToEffectLabel(w.multiplier)}</span>
        </div>`).join('')}</div>`
    : '';

  return `
    <div class="panel weather-panel">
      <h3>🌦️ Météo</h3>
      <div class="weather-current">
        <div class="weather-current-line">
          <span class="weather-emoji">${vm.current.emoji}</span>
          <span class="weather-name">${vm.current.label}</span>
        </div>
        <span class="weather-effect">Rendement : ${vm.current.effectLabel}</span>
        <span class="weather-countdown" id="weatherCountdown">Changement dans ${vm.countdown}</span>
      </div>
      ${forecastBody}
      <button class="weather-help-toggle" id="weatherHelpToggle">ⓘ Effets météo ${weatherHelpOpen ? '▲' : '▼'}</button>
      ${helpBody}
    </div>`;
}

function renderFarm() {
  const me = currentMe;
  const readyCount = me.plots.filter((p) => !p.empty && p.ready).length;
  const emptyCount = me.plots.filter((p) => p.empty).length;

  const plotsHtml = me.plots.map((plot) => {
    if (plot.empty) {
      return `<button class="plot plot-empty" data-plot="${plot.index}"><span class="plot-diamond"><span class="plot-icon">➕</span></span><span class="plot-label">Planter</span></button>`;
    }
    const crop = cropById[plot.cropId];
    const tier = tierFor(crop.unlockLevel);
    const icon = stageIcon(crop, plot);
    if (plot.ready) {
      return `
        <div class="plot plot-ready" style="--tier-c:${tier.c}">
          <span class="plot-diamond"><span class="plot-icon">${icon}</span></span>
          <span class="plot-label">${crop.name}</span>
          <span class="plot-ready-badge">✅</span>
        </div>`;
    }
    return `
      <div class="plot" style="--tier-c:${tier.c}">
        <span class="plot-diamond"><span class="plot-icon">${icon}</span></span>
        <span class="plot-label">${crop.name}</span>
        <div class="plot-bar"><span style="width:${plot.percent}%"></span></div>
      </div>`;
  }).join('');

  appEl.innerHTML = `
    <style>
      .farm-page{ max-width:760px; margin:0 auto; padding:16px; }
      .topbar{ display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px; flex-wrap:wrap; }
      .brand{ font-weight:700; font-size:1.25rem; }
      .stats{ display:flex; gap:8px; font-family:ui-monospace, "SFMono-Regular", Consolas, monospace; font-size:.8rem; }
      .stat-chip{ background:var(--card); border:1px solid var(--card-line); border-radius:999px; padding:5px 11px; }
      .weather-line{ font-size:.8rem; color:var(--ink-700); margin-bottom:8px; font-family:ui-monospace, "SFMono-Regular", Consolas, monospace; }
      .xp-row{ display:flex; align-items:center; gap:8px; margin-bottom:12px; }
      .xp-label{ font-size:.76rem; font-weight:700; color:var(--harvest); white-space:nowrap; }
      .xp-bar{ flex:1; height:8px; border-radius:4px; background:var(--stone-200); overflow:hidden; }
      .xp-bar > span{ display:block; height:100%; background:linear-gradient(90deg, var(--leaf), var(--harvest)); }
      .xp-value{ font-size:.7rem; color:var(--ink-700); font-family:ui-monospace, monospace; white-space:nowrap; }
      .action-row{ display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px; }
      .action-btn{ font-family:inherit; font-size:.8rem; font-weight:600; padding:9px 14px; border-radius:9px; border:1px solid var(--card-line); background:var(--card); color:var(--ink-900); cursor:pointer; }
      .action-btn.primary{ background:var(--leaf); color:#fff; border-color:var(--leaf); }
      .action-btn:disabled{ opacity:.45; cursor:not-allowed; }
      .feedback{ font-size:.78rem; margin-bottom:10px; padding:7px 11px; border-radius:8px; background:var(--card); border:1px solid var(--card-line); }
      .feedback.error{ color:#8c2f2f; border-color:#e0b8b8; }
      .feedback.ok{ color:var(--leaf); border-color:#bcd6ae; }

      .field{
        background:
          repeating-linear-gradient(135deg, rgba(255,255,255,0.05) 0 2px, transparent 2px 26px),
          linear-gradient(160deg, #7fae5c, #5c8a48);
        border:6px solid #7a5230; border-radius:18px; padding:18px 14px;
        box-shadow:inset 0 0 0 3px rgba(255,255,255,0.15), 0 6px 18px rgba(0,0,0,0.18);
        position:relative; margin-bottom:16px;
      }
      .field::before, .field::after{
        content:'🌳'; position:absolute; font-size:1.4rem; opacity:.85;
      }
      .field::before{ top:-14px; left:8px; }
      .field::after{ top:-14px; right:8px; }
      .plots-grid{ display:grid; grid-template-columns:repeat(auto-fill, minmax(92px, 1fr)); gap:10px; }
      .plot{
        --tier-c:#3f6b2f;
        display:flex; flex-direction:column; align-items:center; gap:2px; padding:4px 2px 8px; font-family:inherit;
        background:none; border:none;
      }
      .plot-diamond{
        width:64px; height:64px; background:var(--card); border:2px solid var(--tier-c);
        clip-path:polygon(50% 4%, 96% 50%, 50% 96%, 4% 50%);
        display:flex; align-items:center; justify-content:center; position:relative;
        box-shadow:0 3px 6px rgba(0,0,0,0.18);
      }
      .plot-empty .plot-diamond{ opacity:.6; border-style:dashed; }
      .plot-empty{ cursor:pointer; }
      .plot-empty:hover .plot-diamond{ opacity:1; transform:translateY(-2px); }
      .plot-icon{ font-size:1.55rem; }
      .plot-label{ font-size:.66rem; font-weight:700; text-align:center; color:#fff; text-shadow:0 1px 2px rgba(0,0,0,0.35); }
      .plot-bar{ width:52px; height:4px; border-radius:2px; background:rgba(255,255,255,0.35); overflow:hidden; margin-top:1px; }
      .plot-bar > span{ display:block; height:100%; background:var(--tier-c); }
      .plot-ready-badge{ position:absolute; top:-18px; font-size:.85rem; }

      .panel{ background:var(--card); border:1px solid var(--card-line); border-radius:14px; padding:14px; margin-bottom:14px; }
      .panel h3{ margin:0 0 10px; font-size:.92rem; }
      .empty-note{ font-size:.8rem; color:var(--ink-700); margin:0; }
      .inv-list{ display:flex; flex-direction:column; gap:8px; margin-bottom:10px; }
      .inv-row{ display:flex; flex-direction:column; gap:6px; background:var(--stone-100); border-radius:10px; padding:8px 10px; font-size:.82rem; }
      .inv-info{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .inv-icon{ font-size:1.1rem; }
      .inv-name{ flex:1; font-weight:600; min-width:60px; }
      .inv-qty{ font-family:ui-monospace, monospace; color:var(--ink-700); font-size:.72rem; }
      .inv-price{ font-family:ui-monospace, monospace; font-size:.7rem; color:var(--harvest); white-space:nowrap; }
      .mini-btn{ font-family:inherit; font-size:.72rem; font-weight:600; padding:5px 10px; border-radius:7px; border:1px solid var(--card-line); background:var(--stone-100); cursor:pointer; }
      .mini-btn:disabled{ opacity:.4; cursor:not-allowed; }

      .qty-row{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .qty-gain{ font-family:ui-monospace, monospace; font-size:.74rem; color:var(--harvest); font-weight:700; white-space:nowrap; }
      .qty-control{ display:inline-flex; align-items:center; gap:4px; }
      .qty-btn{ font-family:inherit; font-size:.85rem; font-weight:700; width:24px; height:24px; line-height:1; border-radius:6px; border:1px solid var(--card-line); background:var(--card); color:var(--ink-900); cursor:pointer; }
      .qty-btn:disabled{ opacity:.35; cursor:not-allowed; }
      .qty-input{ width:42px; text-align:center; font-family:ui-monospace, monospace; font-size:.78rem; border:1px solid var(--card-line); border-radius:6px; padding:3px 2px; background:var(--card); color:var(--ink-900); }
      .qty-input:disabled{ opacity:.4; }
      .qty-max-btn{ font-size:.64rem; padding:4px 7px; }
      .qty-confirm-btn{ background:var(--leaf); color:#fff; border-color:var(--leaf); }
      .qty-confirm-btn:disabled{ background:var(--stone-100); color:var(--ink-700); border-color:var(--card-line); }

      .upgrade-row{ display:grid; grid-template-columns:repeat(auto-fit, minmax(140px,1fr)); gap:8px; }
      .upgrade-card{ display:flex; flex-direction:column; align-items:center; gap:4px; background:var(--stone-100); border-radius:10px; padding:10px; }
      .upgrade-icon{ font-size:1.3rem; }
      .upgrade-label{ font-size:.75rem; font-weight:600; }
      .upgrade-level{ font-family:ui-monospace, monospace; font-size:.7rem; color:var(--ink-700); }
      .upgrade-price{ font-family:ui-monospace, monospace; font-size:.72rem; font-weight:700; color:var(--harvest); }

      .craft-row{ display:grid; grid-template-columns:repeat(auto-fit, minmax(190px,1fr)); gap:8px; }
      .craft-card{ display:flex; flex-direction:column; align-items:center; gap:4px; background:var(--stone-100); border-radius:10px; padding:10px; text-align:center; }
      .craft-emoji{ font-size:1.3rem; }
      .craft-name{ font-size:.75rem; font-weight:600; }
      .craft-ing{ font-size:.66rem; color:var(--ink-700); font-family:ui-monospace, monospace; }
      .craft-cost{ display:flex; flex-direction:column; gap:2px; }
      .craft-cost-line{ font-size:.66rem; font-family:ui-monospace, monospace; color:var(--ink-700); }
      .craft-result{ font-size:.7rem; font-weight:600; color:var(--harvest); font-family:ui-monospace, monospace; }
      .craft-insufficient{ font-size:.68rem; font-weight:700; color:#8c2f2f; }

      .quest-list{ display:flex; flex-direction:column; gap:8px; }
      .quest-row{ display:grid; grid-template-columns:1fr auto; grid-template-areas:"label reward" "bar bar" "progress action"; gap:2px 8px; align-items:center; background:var(--stone-100); border-radius:10px; padding:8px 10px; }
      .quest-label{ grid-area:label; font-size:.78rem; font-weight:600; }
      .quest-bar{ grid-area:bar; height:6px; border-radius:3px; background:var(--stone-200); overflow:hidden; }
      .quest-bar > span{ display:block; height:100%; background:var(--leaf); }
      .quest-progress{ grid-area:progress; font-size:.68rem; color:var(--ink-700); font-family:ui-monospace, monospace; }
      .quest-row .mini-btn{ grid-area:action; justify-self:end; }

      .badge-row{ display:flex; flex-wrap:wrap; gap:6px; }
      .badge-chip{ font-size:.72rem; font-weight:600; background:var(--stone-100); border:1px solid var(--card-line); border-radius:999px; padding:5px 10px; }

      .skin-row{ display:grid; grid-template-columns:repeat(auto-fit, minmax(110px,1fr)); gap:8px; }
      .skin-card{ --tier-c:#3f6b2f; font-family:inherit; display:flex; flex-direction:column; align-items:center; gap:3px; background:var(--stone-100); border:1px solid var(--card-line); border-top:3px solid var(--tier-c); border-radius:10px; padding:10px 6px; cursor:pointer; }
      .skin-card.active{ background:var(--tier-c); }
      .skin-card.active .skin-name, .skin-card.active .skin-meta{ color:#fff; }
      .skin-card:disabled{ opacity:.55; cursor:not-allowed; }
      .skin-emoji{ font-size:1.4rem; }
      .skin-name{ font-size:.72rem; font-weight:600; }
      .skin-meta{ font-size:.65rem; color:var(--ink-700); font-family:ui-monospace, monospace; }

      .challenge-box{ display:flex; flex-direction:column; gap:6px; }
      .challenge-label{ font-size:.8rem; font-weight:600; }
      .challenge-bar{ height:8px; border-radius:4px; background:var(--stone-200); overflow:hidden; }
      .challenge-bar > span{ display:block; height:100%; background:linear-gradient(90deg, var(--leaf), var(--harvest)); }
      .challenge-progress{ font-size:.7rem; color:var(--ink-700); font-family:ui-monospace, monospace; }

      .weather-panel{ display:flex; flex-direction:column; gap:10px; }
      .weather-current{ display:flex; flex-direction:column; gap:3px; background:var(--stone-100); border-radius:10px; padding:10px 12px; }
      .weather-current-line{ display:flex; align-items:center; gap:6px; }
      .weather-emoji{ font-size:1.2rem; }
      .weather-name{ font-size:.85rem; font-weight:700; }
      .weather-effect{ font-size:.76rem; color:var(--harvest); font-family:ui-monospace, monospace; font-weight:600; }
      .weather-countdown{ font-size:.7rem; color:var(--ink-700); font-family:ui-monospace, monospace; }
      .weather-forecast{ display:flex; flex-direction:column; gap:4px; border-radius:10px; padding:10px 12px; }
      .weather-forecast.locked{ background:var(--stone-100); }
      .weather-forecast.unlocked{ background:linear-gradient(135deg, var(--stone-100), #e6ddf4); }
      .weather-forecast-title{ font-size:.76rem; font-weight:700; }
      .weather-locked{ font-size:.82rem; font-weight:600; color:var(--ink-700); }
      .weather-hint{ margin:0; font-size:.72rem; color:var(--ink-700); }
      .weather-help-toggle{ align-self:flex-start; font-family:inherit; font-size:.72rem; font-weight:600; background:none; border:none; color:var(--ink-700); cursor:pointer; padding:2px 0; }
      .weather-help-list{ display:flex; flex-direction:column; gap:6px; }
      .weather-help-row{ display:flex; align-items:center; gap:8px; font-size:.76rem; background:var(--stone-100); border-radius:8px; padding:6px 10px; }
      .weather-help-row .weather-name{ flex:1; font-size:.78rem; }

      .footnote{ font-size:.75rem; color:var(--ink-700); text-align:center; }

      .picker-backdrop{ position:fixed; inset:0; background:rgba(20,16,10,0.45); display:flex; align-items:center; justify-content:center; padding:16px; z-index:10; }
      .picker{ background:var(--stone-50); border:1px solid var(--card-line); border-radius:16px; padding:18px; max-width:420px; width:100%; max-height:80vh; overflow-y:auto; }
      .picker-head{ display:flex; align-items:center; justify-content:space-between; font-weight:700; margin-bottom:12px; }
      .picker-close{ background:none; border:none; font-size:1rem; cursor:pointer; color:var(--ink-700); }
      .picker-grid{ display:grid; grid-template-columns:repeat(auto-fill, minmax(120px, 1fr)); gap:8px; }
      .crop-option{ --tier-c:#3f6b2f; font-family:inherit; display:flex; flex-direction:column; align-items:center; gap:3px; background:var(--card); border:1px solid var(--card-line); border-top:3px solid var(--tier-c); border-radius:10px; padding:10px 6px; cursor:pointer; }
      .crop-option:disabled{ opacity:.4; cursor:not-allowed; }
      .crop-emoji{ font-size:1.5rem; }
      .crop-name{ font-size:.7rem; font-weight:600; text-align:center; }
      .crop-meta{ font-size:.65rem; color:var(--ink-700); font-family:ui-monospace, monospace; }
    </style>
    <div class="farm-page">
      <div class="topbar">
        <span class="brand">🌾 Farm2Win</span>
        <div class="stats">
          <span class="stat-chip">💰 ${me.coins}</span>
          <span class="stat-chip">Niv. ${me.level}</span>
          <span class="stat-chip">${readyCount} prête${readyCount > 1 ? 's' : ''}</span>
        </div>
      </div>
      <div class="weather-line">${me.user.username} · Marché ×${me.global.marketMultiplier.toFixed(2)} · ${me.weather.current.emoji} ${me.weather.current.label} ×${me.weather.current.multiplier.toFixed(2)}</div>
      <div class="xp-row">
        <span class="xp-label">⭐ Niveau ${me.level}</span>
        <div class="xp-bar"><span style="width:${Math.min(100, Math.round((me.xp / me.xpToNext) * 100))}%"></span></div>
        <span class="xp-value">${me.xp}/${me.xpToNext} XP</span>
      </div>

      ${feedback ? `<div class="feedback ${feedback.error ? 'error' : 'ok'}">${feedback.error ? '⚠️' : '✅'} ${feedback.text}</div>` : ''}

      <div class="action-row">
        <button class="action-btn primary" id="harvestBtn" ${readyCount === 0 ? 'disabled' : ''}>🧺 Tout récolter (${readyCount})</button>
        <button class="action-btn" id="dailyBtn">🎁 Récompense quotidienne</button>
        <button class="action-btn" id="autoReplantBtn">🔁 Replantation auto : ${me.autoReplant ? 'ON' : 'OFF'}</button>
      </div>

      <div class="field"><div class="plots-grid">${plotsHtml}</div></div>
      ${emptyCount > 0 ? '' : '<p class="empty-note" style="text-align:center;margin-bottom:14px;">Toutes tes parcelles sont occupées — achète-en plus ci-dessous.</p>'}

      <div class="panel"><h3>📦 Inventaire</h3>${inventoryHtml(me)}</div>
      <div class="panel"><h3>🛠️ Améliorations</h3>${upgradesHtml(me)}</div>
      ${recipes.length ? `<div class="panel"><h3>🍞 Ateliers de transformation</h3>${craftingHtml(me)}</div>` : ''}

      <div class="panel"><h3>🌾 Défi du jour</h3>${challengeHtml(me)}</div>
      <div class="panel"><h3>📜 Missions quotidiennes</h3>${questsHtml(me)}</div>
      <div class="panel"><h3>🏅 Succès</h3>${achievementsHtml(me)}</div>
      <div class="panel"><h3>🎨 Skins de parcelles</h3>${skinsHtml(me)}</div>
      ${weatherSectionHtml(me)}

      <div class="footnote">La ferme se met à jour automatiquement toutes les 12 secondes.</div>
    </div>
    ${pickerHtml(me)}
  `;

  document.getElementById('harvestBtn')?.addEventListener('click', harvestAll);
  document.getElementById('dailyBtn')?.addEventListener('click', claimDaily);
  document.getElementById('autoReplantBtn')?.addEventListener('click', toggleAutoReplant);
  document.getElementById('sellAllBtn')?.addEventListener('click', sellAll);
  appEl.querySelectorAll('.plot-empty').forEach((el) => el.addEventListener('click', () => openPicker(Number(el.dataset.plot))));
  document.getElementById('pickerClose')?.addEventListener('click', closePicker);
  document.getElementById('pickerBackdrop')?.addEventListener('click', (e) => { if (e.target.id === 'pickerBackdrop') closePicker(); });
  appEl.querySelectorAll('.crop-option').forEach((el) => el.addEventListener('click', () => plantCrop(pickerOpenForPlot, el.dataset.crop)));
  appEl.querySelectorAll('[data-buy]').forEach((el) => el.addEventListener('click', () => buyUpgrade(el.dataset.buy)));
  appEl.querySelectorAll('[data-quest]').forEach((el) => el.addEventListener('click', () => claimQuestAction(Number(el.dataset.quest))));
  appEl.querySelectorAll('[data-skin]').forEach((el) => el.addEventListener('click', () => chooseSkinAction(el.dataset.skin)));
  document.getElementById('forecastBtn')?.addEventListener('click', buyForecastAction);
  document.getElementById('weatherHelpToggle')?.addEventListener('click', toggleWeatherHelp);

  // LOT ACTIVITY-UX-QUANTITIES -- wiring generique [ − ][ n ][ + ][ MAX ],
  // partage entre les lignes de vente ET les cartes de craft via
  // data-qty-kind ('sell' | 'craft'). AUCUN de ces listeners n'appelle
  // l'API (voir handleQty*/render()) -- seuls "Vendre X"/"Fabriquer X"
  // declenchent une requete reseau.
  appEl.querySelectorAll('[data-qty-minus]').forEach((el) => el.addEventListener('click', () => handleQtyMinus(el.dataset.qtyKind, el.dataset.qtyMinus)));
  appEl.querySelectorAll('[data-qty-plus]').forEach((el) => el.addEventListener('click', () => handleQtyPlus(el.dataset.qtyKind, el.dataset.qtyPlus)));
  appEl.querySelectorAll('[data-qty-setmax]').forEach((el) => el.addEventListener('click', () => handleQtySetMax(el.dataset.qtyKind, el.dataset.qtySetmax)));
  appEl.querySelectorAll('[data-qty-input]').forEach((el) => el.addEventListener('change', () => handleQtyInput(el.dataset.qtyKind, el.dataset.qtyInput, el.value)));
  appEl.querySelectorAll('[data-sell-confirm]').forEach((el) => el.addEventListener('click', () => confirmSell(el.dataset.sellConfirm)));
  appEl.querySelectorAll('[data-craft-confirm]').forEach((el) => el.addEventListener('click', () => confirmCraft(el.dataset.craftConfirm)));
}

function render() {
  if (!currentMe) return;
  renderFarm();
  scheduleWeatherTick();
}

async function setup() {
  try {
    setStatus('Diagnostic : création du SDK Discord…');
    const discordSdk = new DiscordSDK(CLIENT_ID);

    setStatus('Diagnostic : attente de discordSdk.ready()…');
    await Promise.race([
      discordSdk.ready(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('DISCORD_READY_TIMEOUT')),
          5000,
        ),
      ),
    ]);
    setStatus('Diagnostic : discordSdk.ready() OK');

    setStatus('Autorisation Discord…');
    const { code } = await discordSdk.commands.authorize({
      client_id: CLIENT_ID,
      response_type: 'code',
      state: '',
      scope: ['identify'],
    });

    setStatus('Échange du code…');
    const tokenData = await fetchJson('/.proxy/api/activity/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    accessToken = tokenData.access_token;

    await discordSdk.commands.authenticate({ access_token: accessToken });

    setStatus('Chargement de ta ferme…');
    const [me, cropsData] = await Promise.all([
      fetchJson('/.proxy/api/activity/me', { headers: { Authorization: `Bearer ${accessToken}` } }),
      fetchJson('/.proxy/api/activity/crops'),
    ]);

    crops = cropsData.crops;
    recipes = cropsData.recipes ?? [];
    weatherTypes = cropsData.weatherTypes ?? [];
    cropById = Object.fromEntries(crops.map((c) => [c.id, c]));
    recipeById = Object.fromEntries(recipes.map((r) => [r.id, r]));
    currentMe = me;
    render();
    scheduleRefresh();
  } catch (err) {
    console.error('Erreur Activity Farm2Win', err);
    if (err && err.message === 'DISCORD_READY_TIMEOUT') {
      setStatus('Diagnostic : discordSdk.ready() TIMEOUT', true);
    } else {
      const name = err && err.name ? err.name : typeof err;
      const message = err && err.message ? err.message : String(err);
      setStatus(`Diagnostic : ${name} - ${message}`, true);
    }
  }
}

setup();
