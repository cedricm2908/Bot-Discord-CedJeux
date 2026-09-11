import { defineConfig } from 'vite';

// LOT ACTIVITY-CACHE -- AUCUN nom de fichier fixe ici : Vite utilise ses
// noms de sortie PAR DEFAUT (assets/<nom>-<hash>.<ext>), qui incluent un
// hash du CONTENU reel a chaque build. `index.html` (genere dans dist/,
// copie tel quel par build.mjs) reference automatiquement le bon fichier
// hashe -- jamais un hash a maintenir/incrementer a la main (fini les
// "?v=16"). Un changement de code => contenu different => hash different
// => URL differente => plus aucun risque qu'un cache Discord/proxy
// reutilise silencieusement un ancien JS. `assetsDir` n'est PAS surchargee
// non plus : les assets vont dans le sous-dossier `assets/` par defaut,
// ce qui permet a Express (app.ts) de leur appliquer une politique de
// cache longue duree distincte de celle d'index.html (voir app.ts).
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
  },
});
