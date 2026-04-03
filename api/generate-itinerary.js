const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch { return null; }
}

async function redisSet(key, value, ttlSeconds = 604800) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}/ex/${ttlSeconds}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
  } catch {}
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { destination, style, days, budget, departure } = req.body;
  if (!destination || !style || !days) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Check Redis cache
  const cacheKey = `itinerary:${destination}:${style}:${days}:${budget || 'any'}:${departure || 'any'}`;
  const cached = await redisGet(cacheKey);
  if (cached) {
    return res.status(200).json({ itinerary: cached, cached: true });
  }

  const API_KEY = process.env.DEEPSEEK_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const STYLE_MAP = {
    hardcore: { label: '特种兵打卡', budget: '经济型', hotel: '青旅、经济型连锁酒店、胶囊旅馆', pace: '高强度暴走，一天至少5个景点' },
    chill: { label: '佛系休闲党', budget: '中等', hotel: '精品民宿、三四星酒店', pace: '慢节奏，每天2-3个地方，留够咖啡和发呆时间' },
    resort: { label: '度假全躺平', budget: '奢华', hotel: '五星级度假酒店、度假村、海景套房', pace: '以酒店为中心，偶尔出门，SPA和泳池是重点' },
    outdoor: { label: '户外狂人', budget: '中等偏高', hotel: '营地、山间小屋、靠近自然的Lodge', pace: '徒步、骑行、水上运动为主，追求肾上腺素' }
  };

  const styleInfo = STYLE_MAP[style] || STYLE_MAP.chill;

  const prompt = `你是一位经验丰富、极度幽默的旅行规划师，对全球各地的吃喝玩乐了如指掌。

请为从【${departure || '未指定'}】出发，去【${destination}】的 ${days} 天旅行做一份超详细的行程规划。

旅行风格：${styleInfo.label}
预算级别：${styleInfo.budget}（总预算约 ¥${budget || '不限'}）
住宿偏好：${styleInfo.hotel}

## 严格要求

1. **住宿推荐**：每天指定推荐住在哪个区域/街区，说明为什么选这个区域（交通便利？靠近景点？氛围好？），给出 1-2 个具体酒店/民宿名字参考。
2. **具体景点**：每天列出 2-4 个真实存在的具体地点（用真实地名），不要笼统说"逛老城区"，要说清楚去哪条街、哪个店、哪个景点。
3. **打卡特色**：每天推荐 1-2 个当地必体验的特色（特色美食店名、隐藏景点、文化体验、当地人才知道的地方）。
4. **交通建议**：简要说明当天各景点之间怎么走（地铁？打车？步行？租车？）。
5. **预估花费**：每天给一个大致的花费范围（人民币）。

## 行程结构

- 第1天必须是到达日（含接机/交通+入住+周边探索）
- 最后一天必须是离开日（含退房+最后购物/打卡+去机场）
- 节奏要符合"${styleInfo.label}"风格：${styleInfo.pace}

## 输出格式

每天的 title 要简短有冲击力（5-10字），desc 要生动幽默有画面感（80-150字，包含具体地名和推荐）。

每天的 iconName 必须从以下列表选一个：Coffee, Camera, Plane, Compass, Sunrise, Moon, Flame, Utensils, Store, Ticket, ShoppingBag, Gamepad2, Music, Waves, MapIcon, BedDouble。

严格按以下 JSON 格式返回，不要有任何多余内容：
[
  {
    "day": 1,
    "title": "标题",
    "desc": "详细描述，包含具体地名、酒店区域、美食推荐、交通方式",
    "iconName": "Plane",
    "hotel": "推荐住宿区域 + 酒店名",
    "cost": "预估花费（如：¥500-800）",
    "highlights": ["打卡亮点1", "打卡亮点2"]
  },
  ...共 ${days} 个对象
]`;

  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: 'You are a world-class travel planner. Return ONLY valid JSON array. No markdown, no extra text. Every place name must be real and accurate.'
          },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.8
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: `DeepSeek API error: ${response.status}`, detail: errText });
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) return res.status(502).json({ error: 'Empty API response' });

    const parsed = JSON.parse(text);
    const itinerary = Array.isArray(parsed)
      ? parsed
      : (parsed.itinerary || parsed.days || parsed.schedule || Object.values(parsed)[0]);

    if (!Array.isArray(itinerary)) {
      return res.status(502).json({ error: 'Unexpected response format' });
    }

    // Cache to Redis (7 days TTL)
    await redisSet(cacheKey, itinerary);

    return res.status(200).json({ itinerary });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
