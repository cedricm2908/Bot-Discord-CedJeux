import express from 'express';
import cors from 'cors';

const REPLIT_BASE = 'https://bot-discord-ced-jeux--cedricmacedonia.replit.app';

const app = express();
app.use(cors());
app.use(express.json());

async function forwardGet(path, req, res) {
  try {
    const upstream = await fetch(`${REPLIT_BASE}${path}`, {
      headers: { Authorization: req.headers.authorization ?? '' },
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Relay error', detail: String(err) });
  }
}

async function forwardPost(path, req, res) {
  try {
    const upstream = await fetch(`${REPLIT_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: req.headers.authorization ?? '',
      },
      body: JSON.stringify(req.body ?? {}),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Relay error', detail: String(err) });
  }
}

app.get(['/healthz', '/api/healthz'], (_req, res) => {
  res.json({ status: 'ok', relay: true });
});

app.post(['/activity/token', '/api/activity/token'], (req, res) =>
  forwardPost('/api/activity/token', req, res),
);
app.get(['/activity/me', '/api/activity/me'], (req, res) =>
  forwardGet('/api/activity/me', req, res),
);
app.get(['/activity/crops', '/api/activity/crops'], (req, res) =>
  forwardGet('/api/activity/crops', req, res),
);
app.post(['/activity/plant', '/api/activity/plant'], (req, res) =>
  forwardPost('/api/activity/plant', req, res),
);
app.post(['/activity/harvest', '/api/activity/harvest'], (req, res) =>
  forwardPost('/api/activity/harvest', req, res),
);
app.post(['/activity/sell', '/api/activity/sell'], (req, res) =>
  forwardPost('/api/activity/sell', req, res),
);
app.post(['/activity/buy', '/api/activity/buy'], (req, res) =>
  forwardPost('/api/activity/buy', req, res),
);
app.post(['/activity/craft', '/api/activity/craft'], (req, res) =>
  forwardPost('/api/activity/craft', req, res),
);
app.post(['/activity/daily', '/api/activity/daily'], (req, res) =>
  forwardPost('/api/activity/daily', req, res),
);
app.post(['/activity/autoreplant', '/api/activity/autoreplant'], (req, res) =>
  forwardPost('/api/activity/autoreplant', req, res),
);

app.use((req, res) => {
  res.status(404).json({ error: 'Relay: no route for', path: req.path });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Relay listening on ${port}, forwarding to ${REPLIT_BASE}`);
});
