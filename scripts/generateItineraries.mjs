#!/usr/bin/env node
/**
 * 批量生成 44 组静态行程数据 (11 目的地 × 4 风格 × 14天)
 * 用法: GEMINI_API_KEY=你的key node scripts/generateItineraries.mjs
 *
 * 每次请求间隔 15 秒，避免触发 429 限流
 * 如果中途失败，会保留已生成的数据，下次运行跳过已有的组合
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_FILE = path.join(__dirname, '..', 'src', 'staticItineraries.json');

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('❌ 请设置环境变量: GEMINI_API_KEY=你的key node scripts/generateItineraries.mjs');
  process.exit(1);
}

const DESTINATIONS = [
  { id: 'th', name: '曼谷, 泰国' },
  { id: 'jp', name: '东京, 日本' },
  { id: 'hnl', name: '夏威夷' },
  { id: 'las', name: '拉斯维加斯' },
  { id: 'sfo', name: '旧金山' },
  { id: 'sea', name: '西雅图' },
  { id: 'gcn', name: '大峡谷' },
  { id: 'ysnp', name: '黄石国家公园' },
  { id: 'mia', name: '迈阿密' },
  { id: 'chi', name: '芝加哥' },
  { id: 'msy', name: '新奥尔良' },
];

const STYLES = [
  { id: 'hardcore', name: '特种兵打卡' },
  { id: 'chill', name: '佛系休闲党' },
  { id: 'resort', name: '度假全躺平' },
  { id: 'outdoor', name: '户外狂人' },
];

const DELAY_MS = 15000; // 15 seconds between API calls

function buildPrompt(destName, styleName) {
  return `你是一个脑洞大开、极度幽默的旅行规划师。
请为去【${destName}】规划一个【14】天的旅行行程。
旅行风格：${styleName}。

重要要求：
1. 每天的标题(title)要简短、有冲击力、符合这趟旅行的基调。
2. 每天的描述(desc)要生动、幽默、画面感极强，让人看了就想马上订机票，千万不要冷冰冰的罗列地名。每天描述控制在50-80字。
3. 第1天必须是到达日，最后一天（第14天）必须是离开日。
4. 每天的图标(iconName)必须且只能从以下列表中选择一个最符合当天活动的英文名：Coffee, Camera, Plane, Compass, Sunrise, Moon, Flame, Utensils, Store, Ticket, ShoppingBag, Gamepad2, Music, Waves, MapIcon, BedDouble。
5. 严格按照 JSON Array 格式返回，不包含任何 Markdown 代码块和其他废话。`;
}

async function callGemini(destName, styleName) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`;

  const payload = {
    contents: [{ parts: [{ text: buildPrompt(destName, styleName) }] }],
    systemInstruction: {
      parts: [{ text: "You are a creative and humorous travel planner. Always return valid JSON matching the requested schema. Never use markdown codeblocks." }]
    },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            day: { type: "INTEGER" },
            title: { type: "STRING" },
            desc: { type: "STRING" },
            iconName: { type: "STRING" }
          },
          required: ["day", "title", "desc", "iconName"]
        }
      }
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (res.status === 429) {
    throw new Error('RATE_LIMITED');
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response');

  return JSON.parse(text);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  // Load existing data (resume support)
  let existing = {};
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
    } catch { existing = {}; }
  }

  const combos = [];
  for (const dest of DESTINATIONS) {
    for (const style of STYLES) {
      const key = `${dest.id}-${style.id}`;
      if (existing[key]) {
        console.log(`⏭️  跳过已有: ${key}`);
        continue;
      }
      combos.push({ dest, style, key });
    }
  }

  console.log(`\n📋 共 ${combos.length} 组待生成（已有 ${Object.keys(existing).length} 组）\n`);

  for (let i = 0; i < combos.length; i++) {
    const { dest, style, key } = combos[i];
    console.log(`[${i + 1}/${combos.length}] 生成: ${dest.name} × ${style.name} (${key})`);

    let retries = 3;
    while (retries > 0) {
      try {
        const result = await callGemini(dest.name, style.name);
        existing[key] = result;

        // Save after each successful generation
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(existing, null, 2), 'utf-8');
        console.log(`  ✅ 成功！已保存 (${result.length} 天)`);
        break;
      } catch (e) {
        if (e.message === 'RATE_LIMITED') {
          console.log(`  ⚠️  被限流，等待 60 秒后重试...`);
          await sleep(60000);
          retries--;
        } else {
          console.error(`  ❌ 失败: ${e.message}`);
          retries--;
          if (retries > 0) {
            console.log(`  🔄 ${retries} 次重试机会，等待 30 秒...`);
            await sleep(30000);
          }
        }
      }
    }

    // Wait between successful calls
    if (i < combos.length - 1) {
      console.log(`  ⏱️  等待 ${DELAY_MS / 1000} 秒...`);
      await sleep(DELAY_MS);
    }
  }

  console.log(`\n🎉 完成！共 ${Object.keys(existing).length} 组数据已保存到 ${OUTPUT_FILE}`);
}

main().catch(console.error);
