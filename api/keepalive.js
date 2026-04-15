// Redis keepalive endpoint.
// Called by Vercel Cron on a schedule to send traffic to Upstash Redis
// and prevent the free-tier instance from being archived for inactivity.
//
// This endpoint does NOT call DeepSeek. It only performs a light-weight
// Redis operation (read + write a small probe key) — zero AI API cost.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({ ok: false, error: 'Redis env not configured' });
  }

  const probeKey = 'keepalive:probe';
  const now = new Date().toISOString();

  try {
    // 1. Write a probe value (TTL 2 days — plenty of headroom for weekly cron)
    const setRes = await fetch(
      `${REDIS_URL}/set/${encodeURIComponent(probeKey)}/${encodeURIComponent(now)}/ex/172800`,
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }
    );
    const setOk = setRes.ok;

    // 2. Read it back to confirm Redis is reachable
    const getRes = await fetch(
      `${REDIS_URL}/get/${encodeURIComponent(probeKey)}`,
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }
    );
    const getData = await getRes.json();

    return res.status(200).json({
      ok: true,
      wrote: setOk,
      readback: getData.result,
      at: now
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
