<!doctype html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Farm2Win</title>
<style>
  :root{
    --stone-50:#eef0e2; --stone-100:#e3e6d3; --stone-200:#d3d7bf;
    --ink-900:#241d14; --ink-700:#4a4132; --card:#f7f5ea; --card-line:#cdd0b9;
    --leaf:#3f6b2f; --harvest:#a8641f;
  }
  *{box-sizing:border-box;}
  html, body{ margin:0; padding:0; width:100%; height:100%; background:var(--stone-50); overflow:hidden; }
  body{ font-family:system-ui, -apple-system, "Segoe UI", sans-serif; color:var(--ink-900); }
  #app{ width:100%; height:100%; overflow-y:auto; }
  .center{ display:flex; align-items:center; justify-content:center; height:100%; flex-direction:column; gap:10px; padding:20px; text-align:center; }
  .status{ font-size:.95rem; color:var(--ink-700); }
  .status.error{ color:#8c2f2f; }
  .spinner{ width:28px; height:28px; border:3px solid var(--card-line); border-top-color:var(--leaf); border-radius:50%; animation:spin .8s linear infinite; }
  @keyframes spin{ to{ transform:rotate(360deg); } }
</style>
  <script type="module" crossorigin src="./app.js?v=8"></script>
</head>
<body>
<div id="app"><div class="center"><div class="spinner"></div><div class="status" id="status">Connexion à Discord…</div></div></div>
</body>
</html>
