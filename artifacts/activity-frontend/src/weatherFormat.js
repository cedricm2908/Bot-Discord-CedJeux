// LOT ACTIVITY-UX-WEATHER -- logique de presentation PURE (aucun DOM,
// aucun fetch, aucun SDK Discord) pour la section meteo de l'Activity.
// Separee de main.js pour rester testable avec `node --test`, sans
// dependance a un environnement navigateur/jsdom.
//
// Ne calcule JAMAIS de multiplicateur/effet elle-meme : toutes les
// valeurs proviennent du payload backend (GET /activity/me -> `weather`,
// GET /activity/crops -> `weatherTypes`), lui-meme derive de
// WEATHER_INFO (constants.ts) -- source de verite UNIQUE, cote serveur.

// Transforme un multiplicateur reel (ex: 1.25, 0.75, 1) en libelle lisible.
// 1.25 -> "+25 %", 0.75 -> "-25 %", 1 -> "Aucun bonus/malus".
export function multiplierToEffectLabel(multiplier) {
  const percent = Math.round((multiplier - 1) * 100);
  if (percent === 0) return 'Aucun bonus/malus';
  return percent > 0 ? `+${percent} %` : `${percent} %`;
}

// Formate une duree en millisecondes en "MM:SS" (jamais negatif : une
// duree ecoulee/depassee est plafonnee a 00:00, le vrai etat arrivera au
// prochain refresh serveur -- aucune simulation locale de la meteo).
export function formatCountdown(msRemaining) {
  const totalSeconds = Math.max(0, Math.round(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// Construit le modele d'affichage complet de la section meteo a partir du
// payload GET /activity/me (`me.weather`) et de l'horloge locale `now`.
// Fonction PURE : meme entree -> meme sortie, aucun effet de bord.
//
// me.weather.forecast est `null` tant que le joueur n'a pas achete de
// prevision (garanti cote backend, jamais peuple autrement que par
// POST /activity/forecast) -- cette fonction se contente de refleter
// fidelement cette valeur, elle n'invente RIEN et ne "devine" jamais la
// prochaine meteo a partir d'autre chose.
export function buildWeatherViewModel(me, now = Date.now()) {
  const current = me.weather.current;
  const msRemaining = me.weather.nextChangeAt - now;
  const forecast = me.weather.forecast;
  return {
    current: {
      key: current.key,
      emoji: current.emoji,
      label: current.label,
      effectLabel: multiplierToEffectLabel(current.multiplier),
    },
    countdown: formatCountdown(msRemaining),
    countdownMs: msRemaining,
    forecastPurchased: me.weather.forecastPurchased === true,
    forecast: forecast
      ? {
          key: forecast.key,
          emoji: forecast.emoji,
          label: forecast.label,
          effectLabel: multiplierToEffectLabel(forecast.multiplier),
        }
      : null,
  };
}
