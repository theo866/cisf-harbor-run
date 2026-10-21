// Shared Harbor Run leaderboard, stored in Upstash Redis (added through the Vercel Marketplace).
// GET  /api/scores?limit=50              -> { top, total }
// POST /api/scores { name, score, seconds } -> { id, rank, total, top, you }

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'harbor-run:scores';
const KEEP = 500; // only the top 500 scores are kept

async function redis(commands) {
  const r = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!r.ok) throw new Error(`Redis responded ${r.status}`);
  return (await r.json()).map(x => {
    if (x.error) throw new Error(x.error);
    return x.result;
  });
}

// Members are stored as "<unique id>:<name>" so two players can share a name.
function parseTop(flat) {
  const top = [];
  for (let i = 0; i < flat.length; i += 2) {
    const id = flat[i];
    top.push({ id, name: id.slice(id.indexOf(':') + 1), score: Math.round(Number(flat[i + 1])), rank: i / 2 + 1 });
  }
  return top;
}

function cleanName(raw) {
  return String(raw || '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} .'_-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(503).json({ error: "The leaderboard isn't set up yet." });
  }

  try {
    if (req.method === 'GET') {
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const [flat, total] = await redis([
        ['ZRANGE', KEY, '0', String(limit - 1), 'REV', 'WITHSCORES'],
        ['ZCARD', KEY]
      ]);
      return res.status(200).json({ top: parseTop(flat), total });
    }

    if (req.method === 'POST') {
      let body = req.body || {};
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
      }
      const name = cleanName(body.name);
      const score = Math.floor(Number(body.score));
      const seconds = Number(body.seconds);

      if (!name) return res.status(400).json({ error: 'Enter a name using letters or numbers.' });
      // The game tops out around 200 points a second, so anything faster was not earned in a real run.
      if (!Number.isFinite(score) || score < 1 || !Number.isFinite(seconds) || seconds < 1 || seconds > 7200 || score > seconds * 220 + 200) {
        return res.status(400).json({ error: "That score doesn't look like a real run." });
      }

      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
      const [allowed] = await redis([['SET', `harbor-run:limit:${ip}`, '1', 'NX', 'EX', '5']]);
      if (allowed !== 'OK') return res.status(429).json({ error: 'Wait a few seconds, then try again.' });

      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}:${name}`;
      const [, , rank, total, flat] = await redis([
        ['ZADD', KEY, String(score), id],
        ['ZREMRANGEBYRANK', KEY, '0', String(-KEEP - 1)],
        ['ZREVRANK', KEY, id],
        ['ZCARD', KEY],
        ['ZRANGE', KEY, '0', '9', 'REV', 'WITHSCORES']
      ]);
      return res.status(200).json({
        id,
        rank: rank === null ? null : rank + 1,
        total,
        top: parseTop(flat),
        you: { id, name, score }
      });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Use GET or POST.' });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: "Couldn't reach the leaderboard. Try again in a moment." });
  }
};
