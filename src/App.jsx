import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Wallet, Calendar, User, X, Sparkles,
  Map as MapIcon, Coffee, Camera, Plane, ChevronRight, Compass, Sunrise, Moon,
  Flame, Utensils, Store, Ticket, ShoppingBag, Gamepad2, Music, Waves,
  ZoomIn, ZoomOut, Dices, Loader2, BedDouble,
  LogOut, Heart, Share2, Trash2, BookmarkPlus, Github, Settings2
} from 'lucide-react';
import staticItineraries from './staticItineraries.json';
import { supabase, signInWithGitHub, signInWithGoogle, signOut, onAuthStateChange, saveTrip, getMyTrips, deleteTrip } from './lib/supabase';

const ICON_MAP = {
  Coffee, Camera, Plane, Compass, Sunrise, Moon, Wallet,
  Flame, Utensils, Store, Ticket, ShoppingBag, Gamepad2, Music, Waves, MapIcon, BedDouble
};

const DynamicIcon = ({ name, size = 24 }) => {
  const IconComponent = ICON_MAP[name] || MapIcon;
  return <IconComponent size={size} />;
};

// --- 地球 3D 数学投影核心函数 ---
const BASE_RADIUS = 300; 
const CLUSTER_DISTANCE = 64;
const OVERVIEW_ZOOM_THRESHOLD = 1.02;
const DETAIL_ZOOM_THRESHOLD = 2.05;
const CITY_CLUSTER_RELEASE_ZOOM = 2.55;
const MARKER_COLLISION_DISTANCE = 52;
const DEG2RAD = Math.PI / 180;
const BURST_POINTS = '50,5 63,27 90,15 75,42 98,65 70,72 65,98 45,78 20,95 28,68 5,50 30,35 15,10 40,25';
const ZOOM_PRESETS = { macro: 0.84, region: 1.38, city: 2.42 };
const ZOOM_LAYER_ORDER = ['macro', 'region', 'city'];

const getZoomLayer = (zoomValue) => {
  if (zoomValue < OVERVIEW_ZOOM_THRESHOLD) return 'macro';
  if (zoomValue < DETAIL_ZOOM_THRESHOLD) return 'region';
  return 'city';
};

const project = (lon, lat, rotLon, rotLat, currentRadius) => {
  const lambda = lon * DEG2RAD;
  const phi = lat * DEG2RAD;
  const lambda0 = rotLon * DEG2RAD;
  const phi0 = rotLat * DEG2RAD;

  const x = Math.cos(phi) * Math.sin(lambda - lambda0);
  const y = Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * Math.cos(phi) * Math.cos(lambda - lambda0);
  const z = Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * Math.cos(phi) * Math.cos(lambda - lambda0);

  return { x: x * currentRadius, y: -y * currentRadius, z, visible: z > 0 };
};

const getGreatCirclePath = (lon1, lat1, lon2, lat2, rotLon, rotLat, currentRadius) => {
  const p1 = { x: Math.cos(lat1*DEG2RAD)*Math.cos(lon1*DEG2RAD), y: Math.cos(lat1*DEG2RAD)*Math.sin(lon1*DEG2RAD), z: Math.sin(lat1*DEG2RAD) };
  const p2 = { x: Math.cos(lat2*DEG2RAD)*Math.cos(lon2*DEG2RAD), y: Math.cos(lat2*DEG2RAD)*Math.sin(lon2*DEG2RAD), z: Math.sin(lat2*DEG2RAD) };
  
  const dot = p1.x*p2.x + p1.y*p2.y + p1.z*p2.z;
  const omega = Math.acos(Math.max(-1, Math.min(1, dot)));
  if (omega === 0) return "";

  let path = ""; let isFirst = true; const steps = 40; 
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const A = Math.sin((1 - t) * omega) / Math.sin(omega);
    const B = Math.sin(t * omega) / Math.sin(omega);
    
    const x = A * p1.x + B * p2.x; const y = A * p1.y + B * p2.y; const z = A * p1.z + B * p2.z;
    
    const currLat = Math.asin(z) / DEG2RAD;
    const currLon = Math.atan2(y, x) / DEG2RAD;
    const proj = project(currLon, currLat, rotLon, rotLat, currentRadius);
    
    if (proj.visible) {
      if (isFirst) { path += `M ${proj.x} ${proj.y}`; isFirst = false; } else { path += ` L ${proj.x} ${proj.y}`; }
    } else { isFirst = true; }
  }
  return path;
};

// --- 计算两点间的真实物理距离 (公里)，用于估算机票 ---
const calculateDistance = (lon1, lat1, lon2, lat2) => {
  const R = 6371; 
  const dLat = (lat2 - lat1) * DEG2RAD;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

const formatDate = (date) => date.toISOString().split('T')[0];

const getBookingDates = (tripDays) => {
  const depart = new Date();
  depart.setDate(depart.getDate() + 21);
  const ret = new Date(depart);
  ret.setDate(ret.getDate() + tripDays - 1);
  return { depart: formatDate(depart), ret: formatDate(ret) };
};

const buildFlightUrl = (fromCity, toCity, tripDays) => {
  const { depart, ret } = getBookingDates(tripDays);
  return `https://www.google.com/travel/flights?q=Flights+from+${encodeURIComponent(fromCity)}+to+${encodeURIComponent(toCity)}+on+${depart}+return+${ret}`;
};

const buildHotelUrl = (city, tripDays) => {
  const { depart, ret } = getBookingDates(tripDays);
  return `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(city)}&checkin=${depart}&checkout=${ret}&group_adults=2&no_rooms=1`;
};

const estimateFlightCost = (lon1, lat1, lon2, lat2) => {
  if (lon1 === lon2 && lat1 === lat2) return 500; 
  const dist = calculateDistance(lon1, lat1, lon2, lat2);
  let cost = 800 + dist * 0.6; 
  if (Math.abs(lon1 - lon2) > 90) cost += 2000; 
  return Math.round(cost / 100) * 100; 
};

const DEPARTURE_CITIES = [
  { id: 'dep_bj', name: '北京', nameEn: 'Beijing', lon: 116.4, lat: 39.9, icon: '🐼' },
  { id: 'dep_sh', name: '上海', nameEn: 'Shanghai', lon: 121.47, lat: 31.23, icon: '🏙️' },
  { id: 'dep_gz', name: '广州', nameEn: 'Guangzhou', lon: 113.26, lat: 23.13, icon: '🥠' },
  { id: 'dep_ny', name: '纽约', nameEn: 'New York', lon: -74.0, lat: 40.7, icon: '🗽' },
  { id: 'dep_la', name: '洛杉矶', nameEn: 'Los Angeles', lon: -118.2, lat: 34.0, icon: '🌴' },
  { id: 'dep_lon', name: '伦敦', nameEn: 'London', lon: -0.1, lat: 51.5, icon: '💂' }
];

const DESTINATION_REGIONS = [
  { id: 'region_japan', visaKey: 'jp', name: '日本', nameEn: 'Japan', lon: 138.2, lat: 36.2, baseCost: 6800, hotel: 850, daily: 800, icon: '🇯🇵', desc: '霓虹都市、温泉小镇与神社古都一次打包。', descEn: 'Neon cities, hot spring escapes, and temple-filled old capitals in one trip.' },
  { id: 'region_thailand', visaKey: 'th', name: '泰国', nameEn: 'Thailand', lon: 101.0, lat: 15.2, baseCost: 4200, hotel: 350, daily: 500, icon: '🇹🇭', desc: '海岛、夜市、寺庙和按摩，节奏怎么选都成立。', descEn: 'Islands, night markets, temples, and massages with room for any pace.' },
  { id: 'region_california', visaKey: 'us_domestic', name: '加州', nameEn: 'California', lon: -119.5, lat: 36.5, baseCost: 9200, hotel: 1100, daily: 850, icon: '🌴', desc: '公路、海岸、电影工业和永远不嫌多的阳光。', descEn: 'Road trips, coastline, movie culture, and more sunshine than you can spend.' },
  { id: 'region_pnw', visaKey: 'us_domestic', name: '太平洋西北', nameEn: 'Pacific Northwest', lon: -122.7, lat: 45.8, baseCost: 8800, hotel: 950, daily: 750, icon: '🌲', desc: '咖啡、森林、海湾与阴天里的文艺感。', descEn: 'Coffee, forests, bays, and a moody creative atmosphere.' },
  { id: 'region_southwest', visaKey: 'us_domestic', name: '美国西南', nameEn: 'American Southwest', lon: -113.7, lat: 35.8, baseCost: 8200, hotel: 850, daily: 700, icon: '🏜️', desc: '沙漠奇观、公路大片和夸张地貌轮番上场。', descEn: 'Desert drama, road-trip energy, and landscapes that look unreal.' },
  { id: 'region_hawaii', visaKey: 'us_domestic', name: '夏威夷州', nameEn: 'Hawaii', lon: -157.9, lat: 20.9, baseCost: 11200, hotel: 1500, daily: 1000, icon: '🌺', desc: '火山、冲浪、海滩和热带度假状态拉满。', descEn: 'Volcanoes, surf, beaches, and full-power tropical vacation mode.' },
  { id: 'region_florida', visaKey: 'us_domestic', name: '佛罗里达州', nameEn: 'Florida', lon: -81.5, lat: 27.8, baseCost: 9200, hotel: 1050, daily: 800, icon: '🦩', desc: '海风、艺术装饰区和湿地生态一起上。', descEn: 'Sea breeze, art deco color, and wild wetlands in one sweep.' },
  { id: 'region_midwest', visaKey: 'us_domestic', name: '美国中西部', nameEn: 'American Midwest', lon: -88.4, lat: 41.7, baseCost: 8600, hotel: 900, daily: 700, icon: '🏙️', desc: '建筑、湖景、爵士、深盘披萨和大城质感。', descEn: 'Architecture, lake views, jazz, deep-dish, and big-city substance.' },
  { id: 'region_france', visaKey: 'fr', name: '法国', nameEn: 'France', lon: 2.4, lat: 46.6, baseCost: 11800, hotel: 1300, daily: 1000, icon: '🥐', desc: '巴黎街区、南法海岸和博物馆级浪漫。', descEn: 'Paris streets, Riviera light, and museum-grade romance.' },
  { id: 'region_italy', visaKey: 'fr', name: '意大利', nameEn: 'Italy', lon: 12.6, lat: 42.6, baseCost: 11600, hotel: 1200, daily: 950, icon: '🍝', desc: '古迹、咖啡馆、海滨和碳水幸福感。', descEn: 'Ruins, cafes, seaside escapes, and elite carb energy.' },
  { id: 'region_uk', visaKey: 'uk', name: '英国', nameEn: 'United Kingdom', lon: -2.5, lat: 54.0, baseCost: 11300, hotel: 1250, daily: 900, icon: '🎡', desc: '伦敦都市、古堡、酒馆和阴天滤镜。', descEn: 'London energy, old castles, pub culture, and cinematic cloud cover.' },
  { id: 'region_korea', visaKey: 'kr', name: '韩国', nameEn: 'South Korea', lon: 127.8, lat: 36.3, baseCost: 6500, hotel: 750, daily: 700, icon: '🇰🇷', desc: '首尔夜生活、海边城市和高密度好吃。', descEn: 'Seoul nights, coastal cities, and extremely efficient eating.' },
  { id: 'region_australia', visaKey: 'au', name: '澳大利亚', nameEn: 'Australia', lon: 134.0, lat: -25.2, baseCost: 13800, hotel: 1400, daily: 1100, icon: '🇦🇺', desc: '海港城市、珊瑚海岸和野性公路感。', descEn: 'Harbor cities, reef coastlines, and wild long-haul road-trip appeal.' },
  { id: 'region_peru', name: '秘鲁', nameEn: 'Peru', lon: -75.1, lat: -9.2, baseCost: 12800, hotel: 900, daily: 850, icon: '🇵🇪', desc: '高原遗迹、安第斯山脉和拉美风味暴击。', descEn: 'Highland ruins, Andes drama, and a sharp hit of Latin American flavor.' },
  { id: 'region_morocco', name: '摩洛哥', nameEn: 'Morocco', lon: -6.5, lat: 31.8, baseCost: 10600, hotel: 850, daily: 750, icon: '🐫', desc: '老城迷宫、沙漠营地与北非配色审美。', descEn: 'Medina mazes, desert camps, and North African color everywhere.' },
  { id: 'region_china_north', visaKey: 'cn_domestic', name: '华北', nameEn: 'Northern China', lon: 116.4, lat: 39.9, baseCost: 7200, hotel: 780, daily: 620, icon: '🏯', desc: '皇城、长城、胡同和北方城市能量。', descEn: 'Imperial landmarks, the Great Wall, hutongs, and northern city energy.' },
  { id: 'region_china_east', visaKey: 'cn_domestic', name: '华东', nameEn: 'Eastern China', lon: 121.5, lat: 31.2, baseCost: 7600, hotel: 850, daily: 680, icon: '🏙️', desc: '上海天际线、江南水乡和高密度城市节奏。', descEn: 'Shanghai skyline, canal towns, and a polished high-speed city rhythm.' },
  { id: 'region_china_southwest', visaKey: 'cn_domestic', name: '西南中国', nameEn: 'Southwest China', lon: 104.1, lat: 30.7, baseCost: 6800, hotel: 650, daily: 560, icon: '🐼', desc: '川渝烟火、熊猫、雪山和松弛好吃。', descEn: 'Sichuan-Chongqing flavor, pandas, mountain edges, and relaxed eating.' },
  { id: 'region_china_south', visaKey: 'cn_domestic', name: '华南', nameEn: 'Southern China', lon: 113.3, lat: 23.1, baseCost: 7000, hotel: 720, daily: 620, icon: '🥟', desc: '粤式早茶、海岸城市和南方烟火气。', descEn: 'Dim sum mornings, coastal cities, and southern street-life warmth.' },
  { id: 'region_canada_west', visaKey: 'ca', name: '加拿大西部', nameEn: 'Western Canada', lon: -123.1, lat: 49.3, baseCost: 9800, hotel: 1150, daily: 850, icon: '🏔️', desc: '温哥华海湾、雪山和太平洋森林。', descEn: 'Vancouver bays, alpine scenery, and Pacific forest air.' },
  { id: 'region_canada_east', visaKey: 'ca', name: '加拿大东部', nameEn: 'Eastern Canada', lon: -73.6, lat: 45.5, baseCost: 9600, hotel: 1100, daily: 820, icon: '🍁', desc: '湖景大城、法语街区和秋天颜色。', descEn: 'Lake cities, French-speaking streets, and peak autumn color.' },
  { id: 'region_brazil_coast', visaKey: 'br', name: '巴西海岸', nameEn: 'Brazil Coast', lon: -43.2, lat: -22.9, baseCost: 13200, hotel: 980, daily: 820, icon: '🎭', desc: '里约海滩、桑巴和大西洋海岸线。', descEn: 'Rio beaches, samba heat, and Atlantic coastline drama.' },
  { id: 'region_brazil_amazon', visaKey: 'br', name: '亚马逊', nameEn: 'Amazon Brazil', lon: -60.0, lat: -3.1, baseCost: 13600, hotel: 850, daily: 780, icon: '🌿', desc: '雨林河道、生态探险和完全不同的巴西。', descEn: 'River routes, rainforest ecology, and a very different side of Brazil.' },
  { id: 'region_india_north', visaKey: 'in', name: '北印度', nameEn: 'Northern India', lon: 77.2, lat: 28.6, baseCost: 9800, hotel: 650, daily: 520, icon: '🕌', desc: '德里、古堡、集市和北印历史密度。', descEn: 'Delhi, forts, markets, and dense northern history.' },
  { id: 'region_india_south', visaKey: 'in', name: '南印度', nameEn: 'Southern India', lon: 77.6, lat: 12.9, baseCost: 10200, hotel: 720, daily: 560, icon: '🌴', desc: '南印度海岸、咖喱香气和热带城市。', descEn: 'Southern coasts, spice-heavy food, and tropical cities.' },
  { id: 'region_mexico', visaKey: 'mx', name: '墨西哥', nameEn: 'Mexico', lon: -99.1, lat: 19.4, baseCost: 7600, hotel: 720, daily: 600, icon: '🌮', desc: '墨西哥城、彩色街区和古文明遗迹。', descEn: 'Mexico City, saturated streets, and ancient ruins.' },
  { id: 'region_spain', visaKey: 'es', name: '西班牙', nameEn: 'Spain', lon: -3.7, lat: 40.4, baseCost: 11200, hotel: 1100, daily: 850, icon: '💃', desc: '马德里、巴塞罗那、海岸和夜生活。', descEn: 'Madrid, Barcelona, coastlines, and late-night energy.' },
  { id: 'region_germany', visaKey: 'de', name: '德国', nameEn: 'Germany', lon: 10.4, lat: 51.2, baseCost: 11100, hotel: 1100, daily: 850, icon: '🚆', desc: '柏林、火车网络、设计感和啤酒花园。', descEn: 'Berlin, rail networks, design culture, and beer gardens.' },
  { id: 'region_greece', visaKey: 'gr', name: '希腊', nameEn: 'Greece', lon: 22.9, lat: 39.0, baseCost: 11600, hotel: 1050, daily: 850, icon: '🏛️', desc: '爱琴海岛屿、古迹和蓝白色假期。', descEn: 'Aegean islands, ancient ruins, and blue-white holiday light.' },
  { id: 'region_turkey', visaKey: 'tr', name: '土耳其', nameEn: 'Turkey', lon: 35.2, lat: 39.0, baseCost: 10500, hotel: 820, daily: 700, icon: '🎈', desc: '伊斯坦布尔、卡帕多奇亚和东西交汇。', descEn: 'Istanbul, Cappadocia, and the hinge between continents.' },
  { id: 'region_egypt', visaKey: 'eg', name: '埃及', nameEn: 'Egypt', lon: 30.0, lat: 26.8, baseCost: 10800, hotel: 760, daily: 650, icon: '🔺', desc: '金字塔、尼罗河和沙漠文明大片。', descEn: 'Pyramids, the Nile, and desert-scale ancient drama.' },
  { id: 'region_indonesia', visaKey: 'id', name: '印度尼西亚', nameEn: 'Indonesia', lon: 115.2, lat: -8.4, baseCost: 7600, hotel: 520, daily: 500, icon: '🌋', desc: '巴厘岛、火山、海岛和热带慢生活。', descEn: 'Bali, volcanoes, islands, and tropical slow living.' },
  { id: 'region_singapore', visaKey: 'sg', name: '新加坡', nameEn: 'Singapore', lon: 103.8, lat: 1.35, baseCost: 7800, hotel: 1200, daily: 900, icon: '🌃', desc: '花园城市、夜景、熟食中心和高效都市。', descEn: 'Garden-city polish, skyline nights, hawker food, and efficient urbanism.' },
  { id: 'region_vietnam', visaKey: 'vn', name: '越南', nameEn: 'Vietnam', lon: 105.8, lat: 16.0, baseCost: 5200, hotel: 360, daily: 420, icon: '🛵', desc: '河内、岘港、咖啡和摩托车海。', descEn: 'Hanoi, Da Nang, coffee rituals, and scooter-wave streets.' },
  { id: 'region_newzealand', visaKey: 'nz', name: '新西兰', nameEn: 'New Zealand', lon: 174.8, lat: -41.3, baseCost: 14800, hotel: 1300, daily: 950, icon: '⛰️', desc: '南岛山湖、公路和电影级自然。', descEn: 'South Island lakes, road trips, and cinematic nature.' },
  { id: 'region_argentina', visaKey: 'ar', name: '阿根廷', nameEn: 'Argentina', lon: -64.0, lat: -34.0, baseCost: 13600, hotel: 850, daily: 720, icon: '💃', desc: '布宜诺斯艾利斯、探戈和巴塔哥尼亚。', descEn: 'Buenos Aires, tango, and Patagonia-scale wilderness.' }
];

const DESTINATIONS = [
  { id: 'th', regionId: 'region_thailand', name: '曼谷, 泰国', nameEn: 'Bangkok', lon: 100.5, lat: 13.7, baseCost: 3500, hotel: 300, daily: 500, icon: '🛺', type: 'food', desc: '热带街头美食大爆炸！高性价比的吃货天堂。', descEn: 'A tropical street-food overload with unbeatable value for hungry travelers.' },
  { id: 'jp', regionId: 'region_japan', name: '东京, 日本', nameEn: 'Tokyo', lon: 139.6, lat: 35.6, baseCost: 6500, hotel: 800, daily: 800, icon: '🍣', type: 'culture', desc: '二次元发源地！拉面、霓虹灯与疯狂购物。', descEn: 'Anime energy, ramen runs, neon nights, and relentless shopping.' },
  { id: 'osa', regionId: 'region_japan', name: '大阪, 日本', nameEn: 'Osaka', lon: 135.5, lat: 34.7, baseCost: 6200, hotel: 700, daily: 750, icon: '🍢', type: 'food', desc: '道顿堀、章鱼烧与关西式快乐轰炸。', descEn: 'Dotonbori lights, takoyaki runs, and peak Kansai energy.' },
  { id: 'kyo', regionId: 'region_japan', name: '京都, 日本', nameEn: 'Kyoto', lon: 135.8, lat: 35.0, baseCost: 6400, hotel: 820, daily: 760, icon: '⛩️', type: 'culture', desc: '神社、枫叶、町屋和慢一点的日本。', descEn: 'Shrines, maple leaves, machiya lanes, and a slower side of Japan.' },
  { id: 'hnl', regionId: 'region_hawaii', name: '檀香山, 夏威夷', nameEn: 'Honolulu', lon: -157.8, lat: 21.3, baseCost: 11000, hotel: 1500, daily: 1000, icon: '🏄', type: 'beach', desc: 'Aloha！草裙舞与活火山的热情碰撞。', descEn: 'Aloha vibes with hula shows, surf breaks, and volcanic drama.' },
  { id: 'maui', regionId: 'region_hawaii', name: '毛伊岛, 夏威夷', nameEn: 'Maui', lon: -156.3, lat: 20.8, baseCost: 11800, hotel: 1600, daily: 1050, icon: '🌊', type: 'beach', desc: '公路日落、鲸鱼海岸和更松弛的海岛节奏。', descEn: 'Road-to-Hana moods, whale coastlines, and a looser island tempo.' },
  { id: 'las', regionId: 'region_southwest', name: '拉斯维加斯', nameEn: 'Las Vegas', lon: -115.1, lat: 36.1, baseCost: 8000, hotel: 1000, daily: 1000, icon: '🎰', type: 'urban', desc: '罪恶之城！赌场、豪华自助与世界级大秀。', descEn: 'Casino chaos, giant buffets, and world-class shows in the desert.' },
  { id: 'sfo', regionId: 'region_california', name: '旧金山', nameEn: 'San Francisco', lon: -122.4, lat: 37.7, baseCost: 10000, hotel: 1200, daily: 800, icon: '🌉', type: 'culture', desc: '金门大桥与陡峭街道，科技与文艺的交汇点。', descEn: 'Golden Gate views, steep streets, and a tech-meets-arts attitude.' },
  { id: 'sea', regionId: 'region_pnw', name: '西雅图', nameEn: 'Seattle', lon: -122.3, lat: 47.6, baseCost: 9000, hotel: 1000, daily: 800, icon: '☕', type: 'urban', desc: '星巴克故乡，被雨水与咖啡香气浸泡的翡翠之城。', descEn: 'The emerald city of rain, coffee, and waterfront charm.' },
  { id: 'gcn', regionId: 'region_southwest', name: '大峡谷', nameEn: 'Grand Canyon', lon: -112.1, lat: 36.0, baseCost: 7000, hotel: 600, daily: 500, icon: '🏜️', type: 'nature', desc: '地球上最震撼的裂痕，大自然的鬼斧神工。', descEn: 'One of Earth\'s most jaw-dropping natural spectacles.' },
  { id: 'ysnp', regionId: 'region_pnw', name: '黄石国家公园', nameEn: 'Yellowstone', lon: -110.5, lat: 44.4, baseCost: 9000, hotel: 800, daily: 700, icon: '🐻', type: 'nature', desc: '间歇泉与野生动物天堂，真正的西部荒野。', descEn: 'Geysers, wildlife, and raw American wilderness.' },
  { id: 'mia', regionId: 'region_florida', name: '迈阿密', nameEn: 'Miami', lon: -80.1, lat: 25.7, baseCost: 9500, hotel: 1200, daily: 800, icon: '🦩', type: 'beach', desc: '阳光、沙滩、拉丁风情与彻夜狂欢。', descEn: 'Sun, sand, Latin rhythms, and all-night energy.' },
  { id: 'chi', regionId: 'region_midwest', name: '芝加哥', nameEn: 'Chicago', lon: -87.6, lat: 41.8, baseCost: 8500, hotel: 900, daily: 700, icon: '🍕', type: 'urban', desc: '深盘披萨与壮丽天际线，风之城的魅力。', descEn: 'Deep-dish pizza, bold architecture, and skyline drama.' },
  { id: 'msy', regionId: 'region_midwest', name: '新奥尔良', nameEn: 'New Orleans', lon: -90.0, lat: 29.9, baseCost: 7500, hotel: 700, daily: 600, icon: '🎷', type: 'culture', desc: '爵士乐的故乡，巫毒文化与绝妙的南方美食。', descEn: 'Jazz, voodoo lore, and unforgettable Southern food.' },
  { id: 'lax', regionId: 'region_california', name: '洛杉矶, 美国', nameEn: 'Los Angeles', lon: -118.2, lat: 34.0, baseCost: 9000, hotel: 1100, daily: 800, icon: '🎬', type: 'urban', desc: '好莱坞星光大道与圣莫妮卡海滩，追梦人的天使之城。', descEn: 'Hollywood dreams, Santa Monica sunsets, and nonstop ambition.' },
  { id: 'sd', regionId: 'region_california', name: '圣地亚哥, 美国', nameEn: 'San Diego', lon: -117.1, lat: 32.7, baseCost: 8000, hotel: 900, daily: 700, icon: '🐳', type: 'beach', desc: '完美气候、碧蓝海岸与全球顶级动物园的阳光之城。', descEn: 'Perfect weather, blue coastline, and one of the world\'s best zoos.' },
  { id: 'par', regionId: 'region_france', name: '巴黎, 法国', nameEn: 'Paris', lon: 2.35, lat: 48.86, baseCost: 12500, hotel: 1450, daily: 1100, icon: '🗼', type: 'culture', desc: '博物馆、街角咖啡馆和永不过时的浪漫滤镜。', descEn: 'Museums, sidewalk cafes, and romance with no off switch.' },
  { id: 'nic', regionId: 'region_france', name: '尼斯, 法国', nameEn: 'Nice', lon: 7.26, lat: 43.7, baseCost: 12100, hotel: 1400, daily: 1000, icon: '🌞', type: 'beach', desc: '南法海岸线、旧城色彩和蔚蓝海边散步。', descEn: 'Riviera light, pastel old town streets, and endless seaside walking.' },
  { id: 'rom', regionId: 'region_italy', name: '罗马, 意大利', nameEn: 'Rome', lon: 12.5, lat: 41.9, baseCost: 11800, hotel: 1250, daily: 980, icon: '🏛️', type: 'culture', desc: '古罗马遗迹和意面碳水从早轰到晚。', descEn: 'Ancient ruins and pasta-fueled days from morning to midnight.' },
  { id: 'mil', regionId: 'region_italy', name: '米兰, 意大利', nameEn: 'Milan', lon: 9.19, lat: 45.46, baseCost: 11500, hotel: 1180, daily: 940, icon: '👜', type: 'urban', desc: '时装、设计、浓缩咖啡和北意效率感。', descEn: 'Fashion, design, espresso, and crisp northern Italian polish.' },
  { id: 'ldn', regionId: 'region_uk', name: '伦敦, 英国', nameEn: 'London', lon: -0.1, lat: 51.5, baseCost: 11400, hotel: 1280, daily: 930, icon: '🎡', type: 'urban', desc: '剧院、博物馆、红巴士和老派都市气场。', descEn: 'Theater nights, museums, red buses, and heavyweight city energy.' },
  { id: 'edi', regionId: 'region_uk', name: '爱丁堡, 英国', nameEn: 'Edinburgh', lon: -3.19, lat: 55.95, baseCost: 11000, hotel: 1100, daily: 860, icon: '🏰', type: 'culture', desc: '石头城堡、山丘天际线和苏格兰戏剧感。', descEn: 'Stone castles, hilltop skylines, and full Scottish drama.' },
  { id: 'sel', regionId: 'region_korea', name: '首尔, 韩国', nameEn: 'Seoul', lon: 126.98, lat: 37.56, baseCost: 6800, hotel: 780, daily: 720, icon: '🛍️', type: 'urban', desc: '深夜韩食、潮流街区和高密度购物快乐。', descEn: 'Late-night food, trend districts, and extremely efficient shopping.' },
  { id: 'pus', regionId: 'region_korea', name: '釜山, 韩国', nameEn: 'Busan', lon: 129.07, lat: 35.18, baseCost: 6400, hotel: 720, daily: 680, icon: '🌊', type: 'beach', desc: '海边城市、海鲜市场和坡地夜景。', descEn: 'A coastal city with seafood markets and hillside night views.' },
  { id: 'syd', regionId: 'region_australia', name: '悉尼, 澳大利亚', nameEn: 'Sydney', lon: 151.21, lat: -33.87, baseCost: 14200, hotel: 1450, daily: 1150, icon: '🎭', type: 'urban', desc: '海港大桥、歌剧院与海滩生活无缝切换。', descEn: 'Harbor icons, beach access, and an outdoors-first city rhythm.' },
  { id: 'mel', regionId: 'region_australia', name: '墨尔本, 澳大利亚', nameEn: 'Melbourne', lon: 144.96, lat: -37.81, baseCost: 13900, hotel: 1350, daily: 1080, icon: '☕', type: 'culture', desc: '巷子咖啡、艺术街区和南半球文艺浓度。', descEn: 'Laneway coffee, arts districts, and dense southern-hemisphere cool.' },
  { id: 'lim', regionId: 'region_peru', name: '利马, 秘鲁', nameEn: 'Lima', lon: -77.04, lat: -12.05, baseCost: 12600, hotel: 850, daily: 820, icon: '🌮', type: 'food', desc: '海岸悬崖、拉美美食和历史街区一次吃满。', descEn: 'Clifftop coastline, strong food culture, and historic neighborhoods.' },
  { id: 'cus', regionId: 'region_peru', name: '库斯科, 秘鲁', nameEn: 'Cusco', lon: -71.97, lat: -13.53, baseCost: 12900, hotel: 900, daily: 860, icon: '🦙', type: 'nature', desc: '安第斯高地门户，往马丘比丘出发的前站。', descEn: 'Andean gateway city and the launch point for Machu Picchu.' },
  { id: 'rak', regionId: 'region_morocco', name: '马拉喀什, 摩洛哥', nameEn: 'Marrakech', lon: -7.99, lat: 31.63, baseCost: 10700, hotel: 820, daily: 760, icon: '🧿', type: 'culture', desc: '露天市场、庭院旅馆和红城气氛拉满。', descEn: 'Souks, riads, and full-saturation red-city atmosphere.' },
  { id: 'cbl', regionId: 'region_morocco', name: '卡萨布兰卡, 摩洛哥', nameEn: 'Casablanca', lon: -7.59, lat: 33.57, baseCost: 10400, hotel: 780, daily: 720, icon: '🌴', type: 'urban', desc: '海边大城、清真寺地标和北非现代感。', descEn: 'A coastal metropolis with mosque landmarks and a modern edge.' }
];

const REGION_VISUALS = {
  default: { surface: '#fff7ed', tint: '#fde68a', accent: '#f97316', glow: 'rgba(249, 115, 22, 0.18)', route: '#fb923c', stamp: '✦' },
  region_japan: { surface: '#ffe4ef', tint: '#fbcfe8', accent: '#e11d48', glow: 'rgba(244, 114, 182, 0.22)', route: '#fb7185', stamp: '✿' },
  region_thailand: { surface: '#fff3bf', tint: '#fde68a', accent: '#0f766e', glow: 'rgba(20, 184, 166, 0.2)', route: '#f59e0b', stamp: '☀' },
  region_california: { surface: '#ffe7c2', tint: '#fdba74', accent: '#ea580c', glow: 'rgba(251, 146, 60, 0.22)', route: '#f97316', stamp: '☼' },
  region_pnw: { surface: '#ddfbe5', tint: '#86efac', accent: '#166534', glow: 'rgba(34, 197, 94, 0.22)', route: '#22c55e', stamp: '✺' },
  region_southwest: { surface: '#fde7d7', tint: '#fdba74', accent: '#b45309', glow: 'rgba(217, 119, 6, 0.22)', route: '#f97316', stamp: '◌' },
  region_hawaii: { surface: '#ffe0f2', tint: '#f9a8d4', accent: '#db2777', glow: 'rgba(236, 72, 153, 0.24)', route: '#ec4899', stamp: '❀' },
  region_florida: { surface: '#dcfdf4', tint: '#67e8f9', accent: '#0891b2', glow: 'rgba(45, 212, 191, 0.22)', route: '#06b6d4', stamp: '✷' },
  region_midwest: { surface: '#e5eefc', tint: '#bfdbfe', accent: '#1d4ed8', glow: 'rgba(59, 130, 246, 0.18)', route: '#3b82f6', stamp: '✹' },
  region_france: { surface: '#eef4ff', tint: '#dbeafe', accent: '#2563eb', glow: 'rgba(37, 99, 235, 0.18)', route: '#2563eb', stamp: '✧' },
  region_italy: { surface: '#ecfccb', tint: '#bef264', accent: '#4d7c0f', glow: 'rgba(132, 204, 22, 0.2)', route: '#84cc16', stamp: '✣' },
  region_uk: { surface: '#eceff8', tint: '#cbd5e1', accent: '#334155', glow: 'rgba(71, 85, 105, 0.2)', route: '#64748b', stamp: '✥' },
  region_korea: { surface: '#e0f2fe', tint: '#7dd3fc', accent: '#2563eb', glow: 'rgba(56, 189, 248, 0.2)', route: '#38bdf8', stamp: '✦' },
  region_australia: { surface: '#ffedd5', tint: '#fdba74', accent: '#c2410c', glow: 'rgba(251, 146, 60, 0.24)', route: '#f97316', stamp: '✸' },
  region_peru: { surface: '#fef2f2', tint: '#fca5a5', accent: '#b91c1c', glow: 'rgba(248, 113, 113, 0.2)', route: '#ef4444', stamp: '✹' },
  region_morocco: { surface: '#fef3c7', tint: '#fcd34d', accent: '#0f766e', glow: 'rgba(245, 158, 11, 0.22)', route: '#f59e0b', stamp: '✺' },
  region_china_north: { surface: '#fee2e2', tint: '#fca5a5', accent: '#dc2626', glow: 'rgba(239, 68, 68, 0.24)', route: '#ef4444', stamp: '京' },
  region_china_east: { surface: '#fef3c7', tint: '#facc15', accent: '#ca8a04', glow: 'rgba(250, 204, 21, 0.24)', route: '#eab308', stamp: '沪' },
  region_china_southwest: { surface: '#dcfce7', tint: '#86efac', accent: '#16a34a', glow: 'rgba(34, 197, 94, 0.24)', route: '#22c55e', stamp: '川' },
  region_china_south: { surface: '#ffedd5', tint: '#fb923c', accent: '#ea580c', glow: 'rgba(249, 115, 22, 0.24)', route: '#f97316', stamp: '粤' },
  region_canada_west: { surface: '#e0f2fe', tint: '#7dd3fc', accent: '#0369a1', glow: 'rgba(14, 165, 233, 0.22)', route: '#0ea5e9', stamp: '✦' },
  region_canada_east: { surface: '#fee2e2', tint: '#f87171', accent: '#b91c1c', glow: 'rgba(239, 68, 68, 0.2)', route: '#ef4444', stamp: '✷' },
  region_brazil_coast: { surface: '#d9f99d', tint: '#a3e635', accent: '#3f6212', glow: 'rgba(132, 204, 22, 0.24)', route: '#84cc16', stamp: '✹' },
  region_brazil_amazon: { surface: '#bbf7d0', tint: '#4ade80', accent: '#166534', glow: 'rgba(34, 197, 94, 0.26)', route: '#22c55e', stamp: '✺' },
  region_india_north: { surface: '#ffedd5', tint: '#fb923c', accent: '#c2410c', glow: 'rgba(249, 115, 22, 0.24)', route: '#f97316', stamp: '✣' },
  region_india_south: { surface: '#fef9c3', tint: '#fde047', accent: '#a16207', glow: 'rgba(234, 179, 8, 0.24)', route: '#eab308', stamp: '✧' },
  region_mexico: { surface: '#dcfce7', tint: '#86efac', accent: '#15803d', glow: 'rgba(34, 197, 94, 0.22)', route: '#22c55e', stamp: '✦' },
  region_spain: { surface: '#fee2e2', tint: '#fca5a5', accent: '#be123c', glow: 'rgba(244, 63, 94, 0.22)', route: '#f43f5e', stamp: '✷' },
  region_germany: { surface: '#fef3c7', tint: '#fde047', accent: '#111827', glow: 'rgba(17, 24, 39, 0.16)', route: '#111827', stamp: '✹' },
  region_greece: { surface: '#e0f2fe', tint: '#7dd3fc', accent: '#0284c7', glow: 'rgba(14, 165, 233, 0.22)', route: '#0ea5e9', stamp: '✧' },
  region_turkey: { surface: '#ffe4e6', tint: '#fb7185', accent: '#be123c', glow: 'rgba(244, 63, 94, 0.22)', route: '#e11d48', stamp: '✣' },
  region_egypt: { surface: '#fef3c7', tint: '#fbbf24', accent: '#92400e', glow: 'rgba(245, 158, 11, 0.24)', route: '#f59e0b', stamp: '△' },
  region_indonesia: { surface: '#fee2e2', tint: '#f87171', accent: '#b91c1c', glow: 'rgba(239, 68, 68, 0.22)', route: '#ef4444', stamp: '✺' },
  region_singapore: { surface: '#e0f2fe', tint: '#38bdf8', accent: '#0369a1', glow: 'rgba(56, 189, 248, 0.24)', route: '#0ea5e9', stamp: '✦' },
  region_vietnam: { surface: '#dcfce7', tint: '#4ade80', accent: '#15803d', glow: 'rgba(34, 197, 94, 0.22)', route: '#22c55e', stamp: '✸' },
  region_newzealand: { surface: '#e0f2fe', tint: '#67e8f9', accent: '#0e7490', glow: 'rgba(6, 182, 212, 0.22)', route: '#06b6d4', stamp: '✹' },
  region_argentina: { surface: '#dbeafe', tint: '#93c5fd', accent: '#1d4ed8', glow: 'rgba(59, 130, 246, 0.22)', route: '#3b82f6', stamp: '✷' }
};

const DESTINATION_MACRO_HUBS = [
  {
    id: 'macro_north_america',
    name: '北美',
    nameEn: 'North America',
    lon: -104,
    lat: 39,
    icon: '🌎',
    desc: '海岸公路、国家公园和大城文化都集中在这一侧。',
    descEn: 'Road trips, national parks, and heavyweight cities share this side of the planet.',
    primaryRegionId: 'region_california',
    regionIds: ['region_california', 'region_pnw', 'region_southwest', 'region_hawaii', 'region_florida', 'region_midwest', 'region_canada_west', 'region_canada_east', 'region_mexico']
  },
  {
    id: 'macro_latam',
    name: '拉丁美洲',
    nameEn: 'Latin America',
    lon: -63,
    lat: -18,
    icon: '🦜',
    desc: '雨林、高原、探戈和热带海岸的浓烈合集。',
    descEn: 'Rainforest, highlands, tango, and saturated coastlines in one bold sweep.',
    primaryRegionId: 'region_brazil_coast',
    regionIds: ['region_brazil_coast', 'region_brazil_amazon', 'region_peru', 'region_argentina']
  },
  {
    id: 'macro_europe',
    name: '欧洲',
    nameEn: 'Europe',
    lon: 11,
    lat: 48,
    icon: '🏰',
    desc: '古城、美术馆、海岸假期和密集铁路网络。',
    descEn: 'Old capitals, museums, coastlines, and a dense rail web for multi-stop wandering.',
    primaryRegionId: 'region_france',
    regionIds: ['region_france', 'region_italy', 'region_uk', 'region_spain', 'region_germany', 'region_greece', 'region_turkey']
  },
  {
    id: 'macro_africa',
    name: '非洲',
    nameEn: 'Africa',
    lon: 16,
    lat: 22,
    icon: '🐫',
    desc: '沙漠文明、北非色彩和古迹戏剧感集中爆发。',
    descEn: 'Desert drama, North African color, and monument-scale history.',
    primaryRegionId: 'region_morocco',
    regionIds: ['region_morocco', 'region_egypt']
  },
  {
    id: 'macro_east_asia',
    name: '东亚',
    nameEn: 'East Asia',
    lon: 124,
    lat: 34,
    icon: '🪭',
    desc: '中国、日本、韩国一带的城市密度和文化层次最适合逐级探索。',
    descEn: 'China, Japan, and Korea reward gradual zooming with dense cities and layered culture.',
    primaryRegionId: 'region_japan',
    regionIds: ['region_japan', 'region_korea', 'region_china_north', 'region_china_east', 'region_china_southwest', 'region_china_south']
  },
  {
    id: 'macro_south_se_asia',
    name: '南亚与东南亚',
    nameEn: 'South & Southeast Asia',
    lon: 101,
    lat: 16,
    icon: '🛕',
    desc: '寺庙、海岛、香料和高能量街头生活连成一片。',
    descEn: 'Temples, islands, spice-heavy food, and intensely alive street culture.',
    primaryRegionId: 'region_thailand',
    regionIds: ['region_thailand', 'region_india_north', 'region_india_south', 'region_indonesia', 'region_singapore', 'region_vietnam']
  },
  {
    id: 'macro_oceania',
    name: '大洋洲',
    nameEn: 'Oceania',
    lon: 154,
    lat: -29,
    icon: '🪸',
    desc: '海港城市、自然公路和南半球的大尺度风景。',
    descEn: 'Harbor cities, giant landscapes, and road-trip scale scenery in the southern hemisphere.',
    primaryRegionId: 'region_australia',
    regionIds: ['region_australia', 'region_newzealand']
  }
];

const AMBIENT_STARFIELD = [
  { left: '33%', top: '13%', size: 6, delay: '0s' },
  { left: '61%', top: '18%', size: 7, delay: '1.6s' },
  { left: '58%', top: '73%', size: 6, delay: '1.1s' },
  { left: '28%', top: '63%', size: 5, delay: '0.6s' },
  { left: '65%', top: '53%', size: 4, delay: '1.3s' }
];

const FEATURE_REGION_MAP = {
  China: 'region_china_east',
  Japan: 'region_japan',
  Thailand: 'region_thailand',
  USA: 'region_southwest',
  Canada: 'region_canada_west',
  Mexico: 'region_mexico',
  Brazil: 'region_brazil_coast',
  India: 'region_india_north',
  France: 'region_france',
  Italy: 'region_italy',
  England: 'region_uk',
  Ireland: 'region_uk',
  'South Korea': 'region_korea',
  Germany: 'region_germany',
  Spain: 'region_spain',
  Greece: 'region_greece',
  Turkey: 'region_turkey',
  Egypt: 'region_egypt',
  Indonesia: 'region_indonesia',
  Singapore: 'region_singapore',
  Vietnam: 'region_vietnam',
  Australia: 'region_australia',
  'New Zealand': 'region_newzealand',
  Peru: 'region_peru',
  Argentina: 'region_argentina',
  Morocco: 'region_morocco'
};

const getRegionVisual = (regionId) => REGION_VISUALS[regionId] || REGION_VISUALS.default;
const getMacroVisual = (macroHub) => REGION_VISUALS[macroHub?.primaryRegionId] || REGION_VISUALS.default;

const VISA_RULES = {
  CN: { th: { status: 'free', label: '免签' }, jp: { status: 'visa', label: '办签' }, fr: { status: 'visa', label: '申根' }, id: { status: 'voa', label: '落地' }, kr: { status: 'free', label: '免签' }, au: { status: 'visa', label: '办签' }, uk: { status: 'visa', label: '办签' }, us_domestic: { status: 'visa', label: '美签' }, ny: { status: 'visa', label: '美签' }, yvr: { status: 'visa', label: '加签' }, cun: { status: 'visa', label: '美签' }, hnl: { status: 'visa', label: '美签' }, las: { status: 'visa', label: '美签' }, sfo: { status: 'visa', label: '美签' }, sea: { status: 'visa', label: '美签' }, gcn: { status: 'visa', label: '美签' }, ysnp: { status: 'visa', label: '美签' }, mia: { status: 'visa', label: '美签' }, chi: { status: 'visa', label: '美签' }, msy: { status: 'visa', label: '美签' }, lax: { status: 'visa', label: '美签' }, sd: { status: 'visa', label: '美签' } },
  US: { th: { status: 'free', label: '免签' }, jp: { status: 'free', label: '免签' }, fr: { status: 'free', label: '免签' }, id: { status: 'voa', label: '落地' }, kr: { status: 'free', label: '免签' }, au: { status: 'eta', label: 'ETA' }, uk: { status: 'free', label: '免签' }, us_domestic: { status: 'free', label: '国内' }, ny: { status: 'free', label: '国内' }, yvr: { status: 'free', label: '免签' }, cun: { status: 'free', label: '免签' }, hnl: { status: 'free', label: '国内' }, las: { status: 'free', label: '国内' }, sfo: { status: 'free', label: '国内' }, sea: { status: 'free', label: '国内' }, gcn: { status: 'free', label: '国内' }, ysnp: { status: 'free', label: '国内' }, mia: { status: 'free', label: '国内' }, chi: { status: 'free', label: '国内' }, msy: { status: 'free', label: '国内' }, lax: { status: 'free', label: '国内' }, sd: { status: 'free', label: '国内' } }
};

const TRAVEL_STYLES = [
  { id: 'hardcore', name: '特种兵打卡', nameEn: 'Hardcore Sprint', icon: '🏃' },
  { id: 'chill', name: '佛系休闲党', nameEn: 'Chill Wanderer', icon: '🍵' },
  { id: 'resort', name: '度假全躺平', nameEn: 'Resort Mode', icon: '🛏️' },
  { id: 'outdoor', name: '户外狂人', nameEn: 'Outdoor Rush', icon: '🧗' }
];

const DEST_SPECIFIC_ACTIVITIES = {
  sea: { hardcore: [{ title: '派克市场暴走', titleEn: 'Pike Place Blitz', desc: '早上看飞鱼吃第一家星巴克，疯狂暴走！', descEn: 'Start with flying fish and the original Starbucks, then power-walk the city like a machine.', iconName: 'MapIcon' }] },
  hnl: { resort: [{ title: '威基基海滨奢华瘫', titleEn: 'Waikiki Lounge Mode', desc: '包下酒店最前排的沙滩帐篷，一动不动地躺着。', descEn: 'Claim a front-row beach cabana and commit to doing gloriously nothing all day.', iconName: 'Moon' }] },
  las: { hardcore: [{ title: '长街不夜城暴走', titleEn: 'Vegas Strip Marathon', desc: '强刷所有主题酒店，看太阳马戏团大秀！', descEn: 'Grind through themed casinos, neon chaos, and a Cirque du Soleil spectacle before midnight.', iconName: 'Ticket' }] },
  sfo: { chill: [{ title: '叮当车与九曲花街', titleEn: 'Cable Cars and Curves', desc: '挂在复古的叮当车外面吹风，去九曲花街看花。', descEn: 'Hang off a vintage cable car, feel the breeze, and drift toward Lombard Street in no hurry.', iconName: 'Camera' }] },
  lax: {
    hardcore: [{ title: '好莱坞星光大道暴走', titleEn: 'Hollywood Hustle', desc: '从日落大道刷到格里菲斯天文台，拍遍好莱坞标志！', descEn: 'Sprint from Sunset Boulevard to Griffith Observatory and treat the Hollywood sign like a mandatory boss fight.', iconName: 'Camera' }],
    chill: [{ title: '圣莫妮卡海滩发呆', titleEn: 'Santa Monica Slowdown', desc: '在海滩栈道骑车吹海风，看街头艺人表演。', descEn: 'Cruise the beach path, catch the ocean breeze, and watch buskers without checking the time once.', iconName: 'Waves' }]
  },
  sd: {
    outdoor: [{ title: '拉霍亚海岸冲浪', titleEn: 'La Jolla Surf Run', desc: '在La Jolla Shores租板冲浪，和海豹共享海滩！', descEn: 'Rent a board at La Jolla Shores and chase waves while the local seals judge your balance.', iconName: 'Waves' }],
    chill: [{ title: '巴尔博亚公园漫游', titleEn: 'Balboa Park Drift', desc: '在全美最大城市文化公园里逛博物馆、看花园。', descEn: 'Wander through Balboa Park museums and gardens at a pace that barely qualifies as movement.', iconName: 'MapIcon' }]
  }
};

const GENERIC_STYLE_ACTIVITIES = {
  hardcore: [{ title: '极限暴走挑战', titleEn: 'Full-Speed Check-In', desc: '不管多累，脚底磨出水泡也要硬撑着把打卡点刷完！', descEn: 'No excuses, no mercy, no sitting down until every must-see pin has been conquered.', iconName: 'Flame' }],
  chill: [{ title: '漫无目的瞎溜达', titleEn: 'Aimless Wandering', desc: '把所有的攻略和地图全扔掉，走到哪算哪。', descEn: 'Ignore every itinerary, ditch the map, and let the neighborhood decide your next move.', iconName: 'MapIcon' }],
  resort: [{ title: '酒店设施大扫荡', titleEn: 'Resort Takeover', desc: '坚决不出门！去无边泳池拍照，榨干房费的每一分价值。', descEn: 'Refuse to leave the resort, rotate between the infinity pool and spa, and extract full value from the room rate.', iconName: 'Sparkles' }],
  outdoor: [{ title: '租个摩托去野区', titleEn: 'Wild Route Detour', desc: '搞一辆充满划痕的摩托车，向荒郊野外一路狂奔！', descEn: 'Grab something with wheels and head straight for the rough edges of the map.', iconName: 'Compass' }]
};

const UI_COPY = {
  English: {
    pageTitle: 'MAP BOOM!',
    appTitle: 'MAP BOOM!',
    appSubtitle: 'Toon Travel AI Engine',
    settings: 'Settings',
    account: 'Account',
    mapLayers: 'Map layers',
    departuresLayer: 'Departures',
    destinationsLayer: 'Destinations',
    crowdedArea: 'Crowded area',
    crowdedHint: 'Zoom in or pick directly from this list.',
    farSideTitle: 'Far side of globe',
    farSideHint: 'Tap any hidden place to rotate there.',
    clusterCount: (count) => `${count} places here`,
    departureBadge: 'From',
    destinationBadge: 'To',
    language: 'Language',
    myTripsTooltip: 'My trips',
    logoutTooltip: 'Sign out',
    signIn: 'Sign in',
    signInGoogle: 'Sign in with Google',
    signInGithub: 'Sign in with GitHub',
    fromLabel: 'Where from?',
    routeTitle: 'Trip setup',
    tripBrief: 'Trip brief',
    tripBriefHint: 'Pick a stop on the map or from the list, then tune the vibe only if needed.',
    tuneTrip: 'Tune this trip',
    hideTuneTrip: 'Hide trip tuning',
    broadLabel: 'Trip region',
    allRegions: '🌐 Explore all regions',
    selectBroad: 'Pick a country, state, or region...',
    toLabel: 'Where to?',
    specificLabel: 'Specific stop',
    hubsLabel: '🌐 Main Hubs',
    placesLabel: '📍 All Places',
    selectDestination: '🌍 Choose a broad region first or click the map...',
    regionTripTag: 'Whole region',
    styleLabel: 'Pick your vibe',
    budgetLabel: 'Budget (RMB)',
    daysLabel: 'How many days?',
    visaLabel: 'Visa estimator (passport/green card)',
    passportCn: '🇨🇳 Mainland China (CN)',
    passportUs: '🇺🇸 U.S. Passport (US)',
    blindBoxButton: '🎲 Surprise Trip',
    blindBoxTitle: 'Not sure where to go?',
    blindBoxTitleAccent: 'Let AI decide.',
    blindBoxSubtitle: 'Matched from your current budget and travel vibe:',
    budgetShort: 'Budget',
    daysShort: 'Days',
    drawDestination: 'Draw a destination!',
    totalCost: 'Estimated total cost (incl. flights)',
    flightCost: 'Flight',
    hotelCost: 'Hotel',
    dailyCost: 'Daily',
    perNight: '/night',
    perDay: '/day',
    generateButton: 'Generate comic itinerary',
    itineraryHeader: 'BOOM! ITINERARY',
    loadingTitle: 'Generating...',
    loadingDesc: 'Building a custom itinerary for you now.',
    errorTitle: 'Oops! Magic interrupted',
    retry: 'Retry AI',
    retrying: 'Retrying...',
    fallbackError: 'Live AI generation is temporarily unavailable. Loaded a fallback itinerary for now.',
    flightButton: 'Find cheap flights',
    hotelButton: 'Book hotels',
    saved: 'Saved!',
    saving: 'Saving...',
    saveTrip: 'Save this trip',
    myTripsTitle: 'My Trips',
    savedTripsCount: (count) => `${count} saved trip${count === 1 ? '' : 's'}`,
    loading: 'Loading...',
    noSavedTrips: 'No saved trips yet',
    noSavedTripsDesc: 'Generate an itinerary and save it here.',
    copyShare: 'Copy share link',
    delete: 'Delete',
    unknown: 'Unknown',
    daysUnit: 'days',
    tripDays: (count) => `${count} days`,
    visaHeader: 'Visa',
    itineraryPanelFallback: 'Comic itinerary',
    googleFlightsCaption: 'Google Flights',
    bookingCaption: 'Booking.com',
    guideLoading: 'Custom plan incoming'
  },
  中文: {
    pageTitle: '地图爆走！',
    appTitle: '地图爆走！',
    appSubtitle: '漫画旅行 AI 引擎',
    settings: '设置',
    account: '账号',
    mapLayers: '地图图层',
    departuresLayer: '出发地',
    destinationsLayer: '目的地',
    crowdedArea: '高密度区域',
    crowdedHint: '你可以继续放大，或者直接从列表里选择。',
    farSideTitle: '地球背面',
    farSideHint: '点一下隐藏地点就会自动转过去。',
    clusterCount: (count) => `这里有 ${count} 个地点`,
    departureBadge: '出发',
    destinationBadge: '目的',
    language: '语言',
    myTripsTooltip: '我的行程',
    logoutTooltip: '退出登录',
    signIn: '登录',
    signInGoogle: 'Google 登录',
    signInGithub: 'GitHub 登录',
    fromLabel: '从哪里起飞？',
    routeTitle: '路线设置',
    tripBrief: '行程摘要',
    tripBriefHint: '先在地图或列表里选目的地，再按需要展开调整参数。',
    tuneTrip: '微调这趟旅行',
    hideTuneTrip: '收起参数调节',
    broadLabel: '大方向去哪玩？',
    allRegions: '🌐 浏览全部大区',
    selectBroad: '先选国家、州或旅行大区...',
    toLabel: '飞向哪里？',
    specificLabel: '具体落点',
    hubsLabel: '🌐 主要枢纽',
    placesLabel: '📍 所有地点',
    selectDestination: '🌍 先选大区，或者直接点地图...',
    regionTripTag: '整个区域都玩',
    styleLabel: '选个姿势浪？',
    budgetLabel: '弹药包(RMB)',
    daysLabel: '浪几天？',
    visaLabel: '签证测算 (护照/绿卡)',
    passportCn: '🇨🇳 中国大陆 (CN)',
    passportUs: '🇺🇸 美国护照 (US)',
    blindBoxButton: '🎲 盲盒旅行',
    blindBoxTitle: '不知道去哪？',
    blindBoxTitleAccent: '让 AI 替你决定！',
    blindBoxSubtitle: '将根据你当前的弹药包与人设匹配：',
    budgetShort: '预算',
    daysShort: '天数',
    drawDestination: '抽取目的地！',
    totalCost: '总花费预估(含机票)',
    flightCost: '机票',
    hotelCost: '酒店',
    dailyCost: '日常',
    perNight: '/晚',
    perDay: '/天',
    generateButton: '查看漫画行程指南！',
    itineraryHeader: 'BOOM! ITINERARY',
    loadingTitle: '生成中...',
    loadingDesc: '正在为你定制专属疯狂攻略！',
    errorTitle: 'Oops! 魔法中断',
    retry: '重新召唤 AI',
    retrying: '重试中...',
    fallbackError: 'AI 实时生成暂时不可用，已为你加载精选行程',
    flightButton: '抢特价机票！',
    hotelButton: '去预定酒店！',
    saved: '已保存！',
    saving: '保存中...',
    saveTrip: '收藏此行程',
    myTripsTitle: '我的行程',
    savedTripsCount: (count) => `${count} 个已保存的旅行计划`,
    loading: '加载中...',
    noSavedTrips: '还没有保存的行程',
    noSavedTripsDesc: '生成一个行程后点击"收藏"按钮即可保存！',
    copyShare: '复制分享链接',
    delete: '删除',
    unknown: '未知',
    daysUnit: '天',
    tripDays: (count) => `${count}天`,
    visaHeader: '签证',
    itineraryPanelFallback: '漫画行程',
    googleFlightsCaption: 'Google Flights',
    bookingCaption: 'Booking.com',
    guideLoading: '专属攻略生成中'
  }
};

const VISA_LABEL_TRANSLATIONS = {
  English: {
    '免签': 'Visa-free',
    '办签': 'Visa required',
    '申根': 'Schengen visa',
    '落地': 'Visa on arrival',
    '美签': 'U.S. visa',
    '加签': 'Canada visa',
    '国内': 'Domestic',
    'ETA': 'ETA'
  },
  中文: {}
};

const ComicBurst = ({ color = "#fff", className = "" }) => (
  <svg viewBox="0 0 100 100" className={`absolute inset-0 w-full h-full drop-shadow-[4px_4px_0_rgba(0,0,0,1)] ${className}`}>
    <polygon points="50,5 63,27 90,15 75,42 98,65 70,72 65,98 45,78 20,95 28,68 5,50 30,35 15,10 40,25" fill={color} stroke="#000" strokeWidth="6" strokeLinejoin="round"/>
  </svg>
);

const ComicBox = ({ color = "#fff", className = "" }) => (
  <svg viewBox="0 0 100 100" className={`absolute inset-0 w-full h-full drop-shadow-[4px_4px_0_rgba(0,0,0,1)] ${className}`}>
     <rect x="12" y="12" width="76" height="76" rx="12" fill={color} stroke="#000" strokeWidth="6" strokeLinejoin="round"/>
  </svg>
);

const SvgMarkerFace = ({ marker, affordable }) => {
  const isDeparture = marker.markerType === 'departure';
  const isMacroHub = marker.markerType === 'macro';
  const isRegionHub = marker.isRegionHub;
  const regionVisual = marker.regionVisual || REGION_VISUALS.default;
  const fill = isDeparture
    ? '#ffffff'
    : isMacroHub
      ? regionVisual.surface
    : marker.isSelected
      ? regionVisual.surface
      : affordable
        ? regionVisual.tint
        : '#dbe4f0';
  const iconSize = isDeparture ? 18 : isMacroHub ? 28 : isRegionHub ? 30 : marker.isSelected ? 28 : 20;

  return (
    <g className="drop-shadow-[4px_4px_0_rgba(0,0,0,1)]">
      {isMacroHub ? (
        <>
          <circle r="34" fill={fill} stroke="#000" strokeWidth="6" />
          <circle r="46" fill="none" stroke={regionVisual.accent} strokeWidth="3.5" strokeDasharray="8 10" opacity="0.8" />
          <circle r="24" fill={regionVisual.tint} opacity="0.65" />
        </>
      ) : isDeparture || marker.isSelected || isRegionHub ? (
        <polygon
          points={BURST_POINTS}
          fill={fill}
          stroke="#000"
          strokeWidth="6"
          strokeLinejoin="round"
          transform={
            isDeparture
              ? 'translate(-22 -22) scale(0.44)'
              : isRegionHub
                ? 'translate(-30 -30) scale(0.6)'
                : 'translate(-26 -26) scale(0.52)'
          }
        />
      ) : (
        <rect
          x="-24"
          y="-24"
          width="48"
          height="48"
          rx="10"
          fill={fill}
          stroke="#000"
          strokeWidth="6"
          transform={affordable ? 'rotate(3)' : 'rotate(-3)'}
        />
      )}
      {!isDeparture && !isMacroHub && (
        <g transform={isRegionHub ? 'translate(22 -22)' : 'translate(18 -18)'}>
          <circle r="10" fill={regionVisual.surface} stroke="#000" strokeWidth="3" />
          <text
            x="0"
            y="1"
            textAnchor="middle"
            dominantBaseline="central"
            fontSize="11"
            style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: '2px' }}
          >
            {marker.countryIcon || regionVisual.stamp}
          </text>
        </g>
      )}
      {!isDeparture && !isMacroHub && !marker.isSelected && (
        <rect
          x={isRegionHub ? '-22' : '-16'}
          y={isRegionHub ? '24' : '18'}
          width={isRegionHub ? '44' : '32'}
          height="6"
          rx="999"
          fill={regionVisual.accent}
          opacity="0.92"
        />
      )}
      {isMacroHub && (
        <text
          x="0"
          y="28"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="11"
          fontWeight="900"
          fill="#000"
          style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: '2px' }}
        >
          {marker.regionCount || ''}
        </text>
      )}
      <text
        x="0"
        y="1"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={iconSize}
        style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: '3px' }}
      >
        {marker.icon}
      </text>
    </g>
  );
};

const SvgClusterFace = ({ count, active, items = [] }) => {
  const previewItems = items.slice(0, 3);
  const iconSlots = [
    { x: -16, y: -14 },
    { x: 16, y: -14 },
    { x: 0, y: 14 }
  ];

  return (
  <g className="drop-shadow-[4px_4px_0_rgba(0,0,0,1)]">
    <polygon
      points={BURST_POINTS}
      fill={active ? '#fcd34d' : '#ffffff'}
      stroke="#000"
      strokeWidth="6"
      strokeLinejoin="round"
      transform="translate(-30 -30) scale(0.6)"
    />
    {previewItems.map((item, index) => (
      <g key={`${item.id}-cluster`} transform={`translate(${iconSlots[index].x} ${iconSlots[index].y})`}>
        <circle r="11" fill={item.regionVisual?.surface || '#fff7ed'} stroke="#000" strokeWidth="3" />
        <text
          x="0"
          y="1"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="11"
          style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: '2px' }}
        >
          {item.icon}
        </text>
      </g>
    ))}
    <text
      x="0"
      y={previewItems.length > 0 ? 34 : 2}
      textAnchor="middle"
      dominantBaseline="central"
      fontSize="15"
      fontWeight="900"
      fill="#000"
      style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: '3px' }}
    >
      +{count}
    </text>
  </g>
  );
};

// ============================================================
// THEMES — visual direction tokens
// 'comic'  = original Sunday-newspaper comic/cartoon vibe (default, preserved)
// 'y2k'    = Chrome Cartography: millennium web aesthetic (new direction)
// Only add here the tokens that actually differ between themes.
// ============================================================
const THEMES = {
  comic: {
    id: 'comic',
    label: 'Classic Comic',
    labelZh: '漫画原版',
    // container
    appBg: '#fff1a8',
    appGradient: 'linear-gradient(180deg, #fff7c8 0%, #ffe98a 46%, #ffd36c 100%)',
    appDotColor: 'rgba(24, 32, 51, 0.2)',
    appDotSize: '26px 26px',
    appTextColor: 'text-slate-900',
    // globe
    oceanFill: '#50bfe8',
    oceanStroke: '#112944',
    oceanStrokeWidth: 6,
    coastStroke: '#112944',
    coastStrokeWidth: 3,
    graticuleStroke: '#8fe0f6',
    graticuleStrokeWidth: 2,
    routeStroke: '#ff6b4a',
    routeStrokeWidth: 4,
  },
  y2k: {
    id: 'y2k',
    label: 'Y2K Chrome',
    labelZh: 'Y2K 千禧',
    // container
    appBg: '#0A1130',
    appGradient: 'linear-gradient(180deg, #0b1438 0%, #0a1130 100%)',
    appDotColor: '#1a2450',
    appDotSize: '18px 18px',
    appTextColor: 'text-slate-100',
    // globe
    oceanFill: '#0B1F44',
    oceanStroke: '#00B5D9',
    oceanStrokeWidth: 2,
    coastStroke: '#C6A6FF',
    coastStrokeWidth: 1.5,
    graticuleStroke: '#00B5D9',
    graticuleStrokeWidth: 1,
    routeStroke: '#C8FF3D',
    routeStrokeWidth: 3,
  },
};

const loadInitialTheme = () => {
  if (typeof window === 'undefined') return 'comic';
  try {
    const saved = window.localStorage.getItem('mapboom.theme');
    if (saved && THEMES[saved]) return saved;
  } catch {}
  return 'comic';
};

export default function App() {
  const [theme, setThemeState] = useState(loadInitialTheme);
  const t = THEMES[theme] || THEMES.comic;
  const isComicTheme = theme === 'comic';
  const setTheme = (next) => {
    if (!THEMES[next]) return;
    setThemeState(next);
    try { window.localStorage.setItem('mapboom.theme', next); } catch {}
  };

  const uiStyles = useMemo(() => ({
    panelShell: {
      background: isComicTheme ? 'linear-gradient(180deg, rgba(255,255,247,0.98), rgba(255,244,196,0.96))' : 'rgba(8, 20, 53, 0.92)',
      borderColor: isComicTheme ? '#112944' : '#78d6ff',
      boxShadow: isComicTheme ? '0 24px 60px rgba(17, 41, 68, 0.2)' : '0 28px 64px rgba(0, 0, 0, 0.45)',
      backdropFilter: 'blur(16px)',
    },
    sectionShell: {
      background: isComicTheme ? 'linear-gradient(180deg, rgba(255,255,252,0.96), rgba(255,248,218,0.98))' : 'linear-gradient(180deg, rgba(15,24,64,0.96), rgba(9,17,46,0.96))',
      borderColor: isComicTheme ? '#112944' : '#5dbde9',
      boxShadow: isComicTheme ? '0 12px 28px rgba(17, 41, 68, 0.14)' : '0 14px 30px rgba(0, 0, 0, 0.32)',
    },
    fieldShell: {
      background: isComicTheme ? 'rgba(255,255,255,0.96)' : 'rgba(11,31,68,0.9)',
      borderColor: isComicTheme ? '#112944' : '#8bdcff',
      boxShadow: isComicTheme ? '0 6px 0 rgba(17, 41, 68, 0.14)' : '0 0 0 1px rgba(139,220,255,0.25)',
    },
    accentShell: {
      background: isComicTheme ? 'linear-gradient(135deg, #fff176 0%, #ffcf5c 100%)' : 'linear-gradient(135deg, rgba(200,255,61,0.16) 0%, rgba(0,181,217,0.18) 100%)',
      borderColor: isComicTheme ? '#112944' : '#c8ff3d',
      boxShadow: isComicTheme ? '0 10px 24px rgba(255, 107, 74, 0.18)' : '0 10px 24px rgba(0, 0, 0, 0.34)',
    },
    strongButton: {
      background: isComicTheme ? 'linear-gradient(135deg, #ff6b4a 0%, #ff3d77 100%)' : 'linear-gradient(135deg, #00b5d9 0%, #7b61ff 100%)',
      borderColor: isComicTheme ? '#112944' : '#d8f5ff',
      boxShadow: isComicTheme ? '0 12px 26px rgba(255, 61, 119, 0.28)' : '0 14px 30px rgba(0, 0, 0, 0.35)',
      color: '#fff',
    },
    softChip: {
      background: isComicTheme ? 'rgba(255,255,255,0.78)' : 'rgba(9,17,46,0.84)',
      borderColor: isComicTheme ? 'rgba(17,41,68,0.58)' : 'rgba(120,214,255,0.7)',
    },
    softDivider: {
      borderColor: isComicTheme ? 'rgba(17, 41, 68, 0.18)' : 'rgba(120,214,255,0.2)',
    },
  }), [isComicTheme]);

  const [budget, setBudget] = useState(30000);
  const [days, setDays] = useState(5);
  const [language, setLanguage] = useState('English');
  const [passport, setPassport] = useState('US');
  const [travelStyle, setTravelStyle] = useState('chill');
  const [departureId, setDepartureId] = useState('dep_ny');
  const [selectedRegionId, setSelectedRegionId] = useState('all');
  
  const [zoom, setZoom] = useState(1.2); 
  const currentRadius = BASE_RADIUS * zoom;
  const zoomLayer = useMemo(() => getZoomLayer(zoom), [zoom]);

  const [aiItineraries, setAiItineraries] = useState({});
  const [isAILoading, setIsAILoading] = useState(false);
  const [apiError, setApiError] = useState(null);

  const [showBlindBox, setShowBlindBox] = useState(false);
  const [isShuffling, setIsShuffling] = useState(false);
  const [shuffleDest, setShuffleDest] = useState(DESTINATIONS[0]);
  const [mapLayerVisibility, setMapLayerVisibility] = useState({ departures: true, destinations: true });
  const [selectedClusterId, setSelectedClusterId] = useState(null);
  const [showTripTuning, setShowTripTuning] = useState(false);
  const [showFarSidePanel, setShowFarSidePanel] = useState(false);

  // --- Auth & Trip Saving State ---
  const [user, setUser] = useState(null);
  const [showMyTrips, setShowMyTrips] = useState(false);
  const [savedTrips, setSavedTrips] = useState([]);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [isLoadingTrips, setIsLoadingTrips] = useState(false);

  const ALL_PLACES = useMemo(() => [...DEPARTURE_CITIES, ...DESTINATIONS], []);
  const ALL_DESTINATION_PLACES = useMemo(() => [...DESTINATION_REGIONS, ...DESTINATIONS], []);
  const regionIds = useMemo(() => new Set(DESTINATION_REGIONS.map((region) => region.id)), []);
  const regionsById = useMemo(() => new Map(DESTINATION_REGIONS.map((region) => [region.id, region])), []);
  const departure = useMemo(() => ALL_PLACES.find(d => d.id === departureId), [departureId, ALL_PLACES]);
  const selectedRegion = useMemo(() => (
    selectedRegionId === 'all' ? null : DESTINATION_REGIONS.find((region) => region.id === selectedRegionId)
  ), [selectedRegionId]);
  
  const [selectedDest, setSelectedDest] = useState(null);
  const [showItinerary, setShowItinerary] = useState(false);
  const [hoveredMarkerId, setHoveredMarkerId] = useState(null);
  const [hoveredRegionId, setHoveredRegionId] = useState(null);

  const [popupOffset, setPopupOffset] = useState({ x: 0, y: 0 });
  const [isDraggingPopup, setIsDraggingPopup] = useState(false);
  const dragPopupStart = useRef({ x: 0, y: 0, initOffsetX: 0, initOffsetY: 0 });

  const [rotation, setRotation] = useState({ lon: -100, lat: 40 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, lon: 0, lat: 0 });
  const reqFrame = useRef(null);
  
  const [mapLines, setMapLines] = useState([]);
  const [mapFeatures, setMapFeatures] = useState([]);
  const [isMapLoading, setIsMapLoading] = useState(true);

  // --- Auth State Listener ---
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
    });
    const { data: { subscription } } = onAuthStateChange((session) => {
      setUser(session?.user ?? null);
    });
    return () => subscription.unsubscribe();
  }, []);

  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const isEnglish = language === 'English';
  const ui = UI_COPY[language];
  const zoomLayerLabels = useMemo(() => ({
    macro: isEnglish ? 'Continents' : '大洲视图',
    region: isEnglish ? 'Countries / Regions' : '国家 / 地区',
    city: isEnglish ? 'Cities' : '城市细节'
  }), [isEnglish]);
  const zoomLayerHint = useMemo(() => ({
    macro: isEnglish ? 'Wheel in to reveal country clusters.' : '继续滚轮放大，会展开国家和地区层。',
    region: isEnglish ? 'Zoom deeper for city stops and routes.' : '再放大一点，就会展开城市和具体停靠点。',
    city: isEnglish ? 'Close range: city stops and route targets.' : '近景模式：显示城市停靠点和具体路线。'
  }), [isEnglish]);
  const globeStyles = useMemo(() => ({
    atmosphereGlow: isComicTheme ? '#9ad9f1' : '#36d9ff',
    atmosphereGlowEdge: isComicTheme ? '#fef6e4' : '#d7f9ff',
    atmosphereShadow: isComicTheme ? 'rgba(22, 50, 77, 0.18)' : 'rgba(0, 0, 0, 0.42)',
    previewRoute: isComicTheme ? 'rgba(240, 124, 91, 0.52)' : 'rgba(200, 255, 61, 0.6)',
    focusHalo: isComicTheme ? '#fff0b3' : '#84f3ff',
    focusRing: isComicTheme ? '#f07c5b' : '#c8ff3d',
    focusCore: isComicTheme ? '#ffffff' : '#dffbff',
    orbitStroke: isComicTheme ? 'rgba(22, 50, 77, 0.14)' : 'rgba(120, 214, 255, 0.18)',
    orbitFill: isComicTheme ? 'rgba(255, 255, 255, 0.82)' : 'rgba(9, 17, 46, 0.84)',
  }), [isComicTheme]);
  const getPlaceName = useCallback((place) => {
    if (!place) return '';
    return isEnglish ? (place.nameEn || place.name) : place.name;
  }, [isEnglish]);
  const getPlaceShortName = useCallback((place) => {
    if (!place) return '';
    return isEnglish ? (place.nameEn || place.name) : place.name.split(',')[0];
  }, [isEnglish]);
  const getPlaceDescription = useCallback((place) => {
    if (!place) return '';
    return isEnglish ? (place.descEn || place.desc || '') : (place.desc || '');
  }, [isEnglish]);
  const getTravelStyleName = useCallback((styleId) => {
    const style = TRAVEL_STYLES.find((item) => item.id === styleId);
    if (!style) return styleId;
    return isEnglish ? (style.nameEn || style.name) : style.name;
  }, [isEnglish]);
  const formatBudgetLabel = useCallback((amount) => (
    amount >= 10000
      ? `¥${(amount / 10000).toFixed(amount % 10000 === 0 ? 0 : 1)}w`
      : `¥${amount.toLocaleString()}`
  ), []);
  const getVisaLabel = useCallback((passportCode, place) => {
    if (!place) return ui.unknown;
    const region = place.regionId ? DESTINATION_REGIONS.find((item) => item.id === place.regionId) : null;
    const visaKey = place.visaKey || region?.visaKey || place.id;
    const rule = VISA_RULES[passportCode]?.[visaKey];
    if (!rule) return ui.unknown;
    if (!isEnglish) return rule.label || ui.unknown;
    return VISA_LABEL_TRANSLATIONS.English[rule.label] || rule.label || ui.unknown;
  }, [isEnglish, ui.unknown]);
  const formatTripTitle = useCallback((fromPlace, toPlace, tripDays) => {
    const from = getPlaceName(fromPlace);
    const to = getPlaceName(toPlace);
    return isEnglish ? `${from} → ${to} ${tripDays} days` : `${from} → ${to} ${tripDays}天`;
  }, [getPlaceName, isEnglish]);
  const itineraryCacheKey = useMemo(() => (
    selectedDest ? `${selectedDest.id}-${days}-${travelStyle}-${language}` : null
  ), [selectedDest, days, travelStyle, language]);

  useEffect(() => {
    document.title = ui.pageTitle;
  }, [ui.pageTitle]);

  const handleLogin = async (provider = 'github') => {
    try {
      setShowSettingsMenu(false);
      if (provider === 'google') await signInWithGoogle();
      else await signInWithGitHub();
    } catch (e) { console.error('Login failed:', e); }
  };

  const handleLogout = async () => {
    try { await signOut(); setUser(null); setSavedTrips([]); setShowSettingsMenu(false); } catch (e) { console.error('Logout failed:', e); }
  };

  const handleSaveTrip = async () => {
    if (!user || !selectedDest) return;
    setIsSaving(true);
    try {
      const itinerary = displayedItinerary;
      await saveTrip({
        destination: getPlaceName(selectedDest),
        destination_id: selectedDest.id,
        departure: getPlaceName(departure),
        departure_id: departureId,
        style: travelStyle,
        days,
        budget,
        itinerary,
        title: formatTripTitle(departure, selectedDest, days)
      });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (e) { console.error('Save failed:', e); }
    setIsSaving(false);
  };

  const handleLoadMyTrips = async () => {
    if (!user) return;
    setShowSettingsMenu(false);
    setShowMyTrips(true);
    setIsLoadingTrips(true);
    try {
      const { trips } = await getMyTrips();
      setSavedTrips(trips || []);
    } catch (e) { console.error('Load trips failed:', e); }
    setIsLoadingTrips(false);
  };

  const handleDeleteTrip = async (tripId) => {
    try {
      await deleteTrip(tripId);
      setSavedTrips(prev => prev.filter(t => t.id !== tripId));
    } catch (e) { console.error('Delete failed:', e); }
  };

  const toggleMapLayer = useCallback((layer) => {
    setSelectedClusterId(null);
    setMapLayerVisibility((prev) => {
      const next = { ...prev, [layer]: !prev[layer] };
      if (!next.departures && !next.destinations) return prev;
      return next;
    });
  }, []);

  const handleLoadSavedTrip = (trip) => {
    const dest = ALL_DESTINATION_PLACES.find(d => d.id === trip.destination_id);
    if (dest) {
      if (DESTINATION_REGIONS.some((region) => region.id === dest.id)) {
        handleRegionChange(dest.id);
        setSelectedDest(dest);
      } else {
        handleMarkerClick(dest);
      }
      setDays(trip.days || 5);
      setTravelStyle(trip.style || 'chill');
      setBudget(trip.budget || 30000);
      if (trip.departure_id) setDepartureId(trip.departure_id);
    }
    setShowMyTrips(false);
  };

  const copyShareLink = (shareId) => {
    const url = `${window.location.origin}?share=${shareId}`;
    navigator.clipboard.writeText(url);
  };

  useEffect(() => {
    fetch('https://cdn.jsdelivr.net/gh/holtzy/D3-graph-gallery@master/DATA/world.geojson')
      .then(r => r.json())
      .then(data => {
        const lines = [];
        const features = [];
        data.features.forEach(feature => {
          if (!feature.geometry) return;
          const type = feature.geometry.type;
          const coords = feature.geometry.coordinates;
          const name = feature.properties?.name;
          if (type === 'Polygon') {
            lines.push(coords[0]);
            features.push({ name, polygons: [coords[0]] });
          }
          else if (type === 'MultiPolygon') {
            coords.forEach(poly => lines.push(poly[0]));
            features.push({ name, polygons: coords.map((poly) => poly[0]) });
          }
        });
        setMapLines(lines);
        setMapFeatures(features);
        setIsMapLoading(false);
      })
      .catch((e) => {
        console.error("地图轮廓加载失败:", e);
        setIsMapLoading(false);
      });
  }, []);

  const calculateTotalCost = useCallback((dest, tripDays) => {
    const flightCost = estimateFlightCost(departure.lon, departure.lat, dest.lon, dest.lat);
    const nights = tripDays - 1;
    const hotelCost = nights * dest.hotel;
    const livingCost = tripDays * dest.daily;
    return flightCost + hotelCost + livingCost;
  }, [departure]);

  // --- 先调 DeepSeek API 实时生成，失败则 fallback 到静态数据 ---
  const handleGenerateItinerary = async () => {
    if (isAILoading) return;
    setShowItinerary(true);
    setApiError(null);
    if (!selectedDest) return;

    if (itineraryCacheKey && aiItineraries[itineraryCacheKey]) return;

    setIsAILoading(true);

    // 1) 尝试调用 DeepSeek API
    try {
      const totalBudget = calculateTotalCost(selectedDest, days);
      const res = await fetch('/api/generate-itinerary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          destination: getPlaceName(selectedDest),
          style: travelStyle,
          days,
          budget: totalBudget,
          departure: getPlaceName(departure),
          language
        })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.itinerary && data.itinerary.length > 0) {
          setAiItineraries(prev => ({ ...prev, [itineraryCacheKey]: data.itinerary }));
          setIsAILoading(false);
          return;
        }
      }
      // API 返回非 ok，进入 fallback
    } catch (e) {
      // 网络错误等，进入 fallback
    }

    // 2) Fallback: 使用预生成的静态数据
    let fallbackItinerary = itineraryDays;
    if (!isEnglish) {
      const staticKey = `${selectedDest.id}-${travelStyle}`;
      const fullItinerary = staticItineraries[staticKey];
      if (fullItinerary && fullItinerary.length > 0) {
        fallbackItinerary = fullItinerary.slice(0, days).map((day, i) => ({
          ...day,
          day: i + 1
        }));
        if (days < fullItinerary.length && fullItinerary.length >= 14) {
          const lastDay = { ...fullItinerary[fullItinerary.length - 1], day: days };
          fallbackItinerary[fallbackItinerary.length - 1] = lastDay;
        }
      }
    }

    if (fallbackItinerary && fallbackItinerary.length > 0) {
      setAiItineraries(prev => ({ ...prev, [itineraryCacheKey]: fallbackItinerary }));
      setApiError('fallback');
    }

    setIsAILoading(false);
  };

  const handleMouseDown = (e) => {
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, lon: rotation.lon, lat: rotation.lat };
  };

  const handleMouseMove = (e) => {
    if (isDraggingPopup) {
      setPopupOffset({
        x: dragPopupStart.current.initOffsetX + (e.clientX - dragPopupStart.current.x),
        y: dragPopupStart.current.initOffsetY + (e.clientY - dragPopupStart.current.y)
      });
      return; 
    }
    if (!isDragging) return;
    const dragFactor = 0.4 / zoom; 
    let newLat = dragStart.current.lat + (e.clientY - dragStart.current.y) * dragFactor;
    setRotation({ 
      lon: dragStart.current.lon - (e.clientX - dragStart.current.x) * dragFactor, 
      lat: Math.max(-80, Math.min(80, newLat)) 
    });
  };

  const handleMouseUp = () => { setIsDragging(false); setIsDraggingPopup(false); };

  const handlePopupMouseDown = (e) => {
    e.stopPropagation();
    setIsDraggingPopup(true);
    dragPopupStart.current = { x: e.clientX, y: e.clientY, initOffsetX: popupOffset.x, initOffsetY: popupOffset.y };
  };

  const handleWheel = (e) => {
    setZoom(z => Math.max(0.6, Math.min(4.0, z - e.deltaY * 0.002)));
  };

  const animateToTarget = useCallback((targetLon, targetLat) => {
    let currentLon = rotation.lon; let currentLat = rotation.lat;
    let diffLon = ((targetLon - currentLon + 540) % 360) - 180;
    
    const step = () => {
      currentLon += diffLon * 0.12; currentLat += (targetLat - currentLat) * 0.12;
      setRotation({ lon: currentLon, lat: currentLat });
      diffLon = ((targetLon - currentLon + 540) % 360) - 180;
      if (Math.abs(diffLon) > 0.5 || Math.abs(targetLat - currentLat) > 0.5) reqFrame.current = requestAnimationFrame(step);
    };
    if (reqFrame.current) cancelAnimationFrame(reqFrame.current);
    reqFrame.current = requestAnimationFrame(step);
  }, [rotation]);

  const handleRegionChange = useCallback((regionId) => {
    setSelectedClusterId(null);
    setHoveredMarkerId(null);
    setHoveredRegionId(null);
    if (regionId === 'all') {
      setSelectedRegionId('all');
      if (selectedDest && (selectedDest.regionId || DESTINATION_REGIONS.some((region) => region.id === selectedDest.id))) {
        setSelectedDest(null);
        setShowItinerary(false);
      }
      setZoom(1.2);
      return;
    }

    const region = DESTINATION_REGIONS.find((item) => item.id === regionId);
    if (!region) return;

    setSelectedRegionId(regionId);
    animateToTarget(region.lon, region.lat);
    setZoom(1.8);
    if (selectedDest && selectedDest.regionId !== regionId && selectedDest.id !== regionId) {
      setSelectedDest(region);
      setShowItinerary(false);
      setPopupOffset({ x: 0, y: 0 });
    }
  }, [animateToTarget, selectedDest]);

  const handleDepartureSelect = useCallback((place) => {
    setSelectedClusterId(null);
    setHoveredMarkerId(place.id);
    setHoveredRegionId(null);
    setDepartureId(place.id);
    animateToTarget(place.lon, place.lat);
    setZoom(1.5);
    if (selectedDest?.id === place.id) {
      setSelectedDest(null);
      setShowItinerary(false);
    }
  }, [animateToTarget, selectedDest]);

  const handleMacroHubSelect = useCallback((macroHub) => {
    setSelectedClusterId(null);
    setHoveredMarkerId(macroHub.id);
    setHoveredRegionId(null);
    setSelectedRegionId('all');
    setSelectedDest(null);
    animateToTarget(macroHub.lon, macroHub.lat);
    setZoom(ZOOM_PRESETS.region);
    setShowItinerary(false);
    setPopupOffset({ x: 0, y: 0 });
  }, [animateToTarget]);

  const handleRegionSelect = useCallback((region) => {
    setSelectedClusterId(null);
    setHoveredMarkerId(region.id);
    setHoveredRegionId(region.id);
    setSelectedRegionId(region.id);
    animateToTarget(region.lon, region.lat);
    setZoom(ZOOM_PRESETS.city);
    setShowItinerary(false);
    setSelectedDest(region);
    setPopupOffset({ x: 0, y: 0 });
  }, [animateToTarget]);

  const handleMarkerClick = (dest) => {
    setSelectedClusterId(null);
    setHoveredMarkerId(dest.id);
    setHoveredRegionId(dest.regionId || null);
    if (dest.regionId) setSelectedRegionId(dest.regionId);
    animateToTarget(dest.lon, dest.lat);
    if (dest.regionId) setZoom((current) => Math.max(current, ZOOM_PRESETS.city));
    setShowItinerary(false);
    setSelectedDest(dest);
    setPopupOffset({ x: 0, y: 0 }); 
  };

  const cycleOrbitalView = useCallback(() => {
    const currentIndex = ZOOM_LAYER_ORDER.indexOf(zoomLayer);
    const nextLayer = ZOOM_LAYER_ORDER[(currentIndex + 1) % ZOOM_LAYER_ORDER.length];
    const focalPlace = selectedDest || selectedRegion || departure;
    setZoom(ZOOM_PRESETS[nextLayer]);
    if (focalPlace) animateToTarget(focalPlace.lon, focalPlace.lat);
  }, [zoomLayer, selectedDest, selectedRegion, departure, animateToTarget]);

  const triggerBlindBox = () => {
    setIsShuffling(true);
    const candidateDestinations = selectedRegionId === 'all'
      ? DESTINATIONS
      : DESTINATIONS.filter((dest) => dest.regionId === selectedRegionId);
    const affordableDests = candidateDestinations.filter(d => calculateTotalCost(d, days) <= budget);
    const targetPool = affordableDests.length > 0 ? affordableDests : candidateDestinations;
    
    let count = 0;
    const interval = setInterval(() => {
      setShuffleDest(candidateDestinations[Math.floor(Math.random() * candidateDestinations.length)] || DESTINATIONS[Math.floor(Math.random() * DESTINATIONS.length)]);
      count++;
      if (count > 20) {
        clearInterval(interval);
        setIsShuffling(false);
        setShowBlindBox(false);
        const finalChoice = targetPool[Math.floor(Math.random() * targetPool.length)];
        handleMarkerClick(finalChoice);
        setZoom(2.5); 
      }
    }, 80);
  };

  const graticules = useMemo(() => {
    const lines = [];
    for (let lat = -80; lat <= 80; lat += 20) {
      let path = ""; let isFirst = true;
      for (let lon = -180; lon <= 180; lon += 5) {
        const p = project(lon, lat, rotation.lon, rotation.lat, currentRadius);
        if (p.visible) { if (isFirst) { path += `M ${p.x} ${p.y}`; isFirst = false; } else { path += ` L ${p.x} ${p.y}`; } } else { isFirst = true; }
      }
      if (path) lines.push(path);
    }
    for (let lon = -180; lon < 180; lon += 20) {
      let path = ""; let isFirst = true;
      for (let lat = -90; lat <= 90; lat += 5) {
        const p = project(lon, lat, rotation.lon, rotation.lat, currentRadius);
        if (p.visible) { if (isFirst) { path += `M ${p.x} ${p.y}`; isFirst = false; } else { path += ` L ${p.x} ${p.y}`; } } else { isFirst = true; }
      }
      if (path) lines.push(path);
    }
    return lines;
  }, [rotation, currentRadius]);

  const coastLines = useMemo(() => {
    const paths = [];
    mapLines.forEach(ring => {
      let currentPath = ""; let isDrawing = false;
      for (let i = 0; i < ring.length; i++) {
        const p = project(ring[i][0], ring[i][1], rotation.lon, rotation.lat, currentRadius);
        if (p.visible) {
          if (!isDrawing) { currentPath += `M ${p.x} ${p.y} `; isDrawing = true; } else { currentPath += `L ${p.x} ${p.y} `; }
        } else { isDrawing = false; }
      }
      if (currentPath) paths.push(currentPath);
    });
    return paths;
  }, [mapLines, rotation, currentRadius]);

  const focusedCityRegionId = useMemo(() => {
    if (selectedRegionId !== 'all') return selectedRegionId;
    if (selectedDest?.regionId) return selectedDest.regionId;
    if (selectedDest && regionIds.has(selectedDest.id)) return selectedDest.id;
    if (hoveredRegionId) return hoveredRegionId;
    return null;
  }, [selectedRegionId, selectedDest, hoveredRegionId, regionIds]);

  const visibleDestinationPlaces = useMemo(() => {
    if (zoomLayer === 'macro') {
      return DESTINATION_MACRO_HUBS.map((hub) => ({
        ...hub,
        markerType: 'macro',
        regionVisual: getMacroVisual(hub),
        regionCount: `${hub.regionIds.length}`
      }));
    }

    if (zoomLayer === 'region') {
      return DESTINATION_REGIONS.map((place) => ({
        ...place,
        markerType: 'destination'
      }));
    }

    const focusedRegion = focusedCityRegionId ? regionsById.get(focusedCityRegionId) : null;
    const cityStops = focusedCityRegionId
      ? DESTINATIONS.filter((place) => place.regionId === focusedCityRegionId)
      : DESTINATIONS;

    return [
      ...(focusedRegion ? [{ ...focusedRegion, markerType: 'destination' }] : []),
      ...cityStops.map((place) => ({
        ...place,
        markerType: 'destination'
      }))
    ];
  }, [zoomLayer, focusedCityRegionId, regionsById]);

  const visibleSpecificDestinations = useMemo(() => {
    if (selectedRegionId === 'all') return [];
    return [
      ...DESTINATION_REGIONS.filter((region) => region.id === selectedRegionId),
      ...DESTINATIONS.filter((place) => place.regionId === selectedRegionId)
    ];
  }, [selectedRegionId]);

  const baseMapPlaces = useMemo(() => ([
    ...(mapLayerVisibility.destinations ? visibleDestinationPlaces : [])
  ]), [mapLayerVisibility, visibleDestinationPlaces]);

  const projectedMapMarkers = useMemo(() => {
    const baseMarkers = baseMapPlaces
      .map((place, index) => {
        const projection = project(place.lon, place.lat, rotation.lon, rotation.lat, currentRadius);
        if (!projection.visible) return null;
        const isDestination = place.markerType === 'destination';
        const isMacroHub = place.markerType === 'macro';
        const estCost = isDestination ? calculateTotalCost(place, days) : null;
        const regionId = isMacroHub
          ? null
          : place.regionId || (regionIds.has(place.id) ? place.id : null);
        const region = regionId ? regionsById.get(regionId) : null;
        const regionVisual = place.regionVisual || getRegionVisual(regionId);
        const isSelected = selectedDest?.id === place.id;
        const isHovered = hoveredMarkerId === place.id;
        const isRegionHovered = Boolean(regionId) && hoveredRegionId === regionId;
        return {
          ...place,
          index,
          baseX: projection.x,
          baseY: projection.y,
          x: projection.x,
          y: projection.y,
          isDestination,
          isMacroHub,
          isSelected,
          isHovered,
          regionId,
          regionVisual,
          countryIcon: region?.icon || place.icon,
          isRegionHub: regionIds.has(place.id),
          isRegionHovered,
          estCost,
          isAffordable: isDestination ? estCost <= budget : true
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const score = (marker) => (marker.isSelected ? 100 : 0) + (marker.isDestination ? 10 : 0);
        return score(b) - score(a);
      });

    const placedMarkers = [];
    baseMarkers.forEach((marker, idx) => {
      const overlapping = placedMarkers.filter((placed) => (
        Math.hypot(marker.x - placed.x, marker.y - placed.y) < (marker.isMacroHub ? 84 : marker.isRegionHub ? 62 : MARKER_COLLISION_DISTANCE)
      ));

      if (overlapping.length > 0) {
        const angle = ((idx * 137.5) % 360) * (Math.PI / 180);
        const radius = marker.isMacroHub ? 26 + overlapping.length * 10 : 14 + overlapping.length * 8;
        marker.x += Math.cos(angle) * radius;
        marker.y += Math.sin(angle) * radius;
      }

      placedMarkers.push(marker);
    });

    return placedMarkers;
  }, [baseMapPlaces, rotation, currentRadius, selectedDest, calculateTotalCost, days, budget, hoveredMarkerId, hoveredRegionId, regionIds, regionsById]);

  const hiddenMapMarkers = useMemo(() => (
    baseMapPlaces
      .map((place) => {
        const projection = project(place.lon, place.lat, rotation.lon, rotation.lat, currentRadius);
        if (projection.visible) return null;
        return {
          ...place,
          isDestination: place.markerType === 'destination'
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const score = (marker) => (marker.isDestination ? 10 : 0) + (selectedDest?.id === marker.id ? 100 : 0);
        return score(b) - score(a);
      })
  ), [baseMapPlaces, rotation, currentRadius, selectedDest]);

  const { renderedMapMarkers, mapClusters } = useMemo(() => {
    if (projectedMapMarkers.length === 0) {
      return { renderedMapMarkers: [], mapClusters: [] };
    }

    if (zoomLayer !== 'city') {
      return { renderedMapMarkers: projectedMapMarkers, mapClusters: [] };
    }

    if (zoom > CITY_CLUSTER_RELEASE_ZOOM) {
      return { renderedMapMarkers: projectedMapMarkers, mapClusters: [] };
    }

    const clusters = [];
    projectedMapMarkers.forEach((marker) => {
      const existing = clusters.find((cluster) => (
        Math.hypot(marker.baseX - cluster.baseX, marker.baseY - cluster.baseY) < CLUSTER_DISTANCE
      ));

      if (existing) {
        existing.items.push(marker);
        existing.baseX = existing.items.reduce((sum, item) => sum + item.baseX, 0) / existing.items.length;
        existing.baseY = existing.items.reduce((sum, item) => sum + item.baseY, 0) / existing.items.length;
        existing.x = existing.items.reduce((sum, item) => sum + item.x, 0) / existing.items.length;
        existing.y = existing.items.reduce((sum, item) => sum + item.y, 0) / existing.items.length;
        existing.lon = existing.items.reduce((sum, item) => sum + item.lon, 0) / existing.items.length;
        existing.lat = existing.items.reduce((sum, item) => sum + item.lat, 0) / existing.items.length;
      } else {
        clusters.push({
          id: `cluster-${marker.id}`,
          baseX: marker.baseX,
          baseY: marker.baseY,
          x: marker.x,
          y: marker.y,
          lon: marker.lon,
          lat: marker.lat,
          items: [marker]
        });
      }
    });

    return {
      renderedMapMarkers: clusters.filter((cluster) => cluster.items.length === 1).map((cluster) => cluster.items[0]),
      mapClusters: clusters.filter((cluster) => cluster.items.length > 1)
    };
  }, [projectedMapMarkers, zoom, zoomLayer]);
  const selectedCluster = useMemo(() => (
    mapClusters.find((cluster) => cluster.id === selectedClusterId) || null
  ), [mapClusters, selectedClusterId]);
  const previewMarker = useMemo(() => (
    renderedMapMarkers.find((marker) => marker.id === hoveredMarkerId && marker.isDestination) || null
  ), [renderedMapMarkers, hoveredMarkerId]);
  const previewTarget = useMemo(() => (
    previewMarker && previewMarker.id !== selectedDest?.id ? previewMarker : null
  ), [previewMarker, selectedDest]);
  const selectedFocusPoint = useMemo(() => {
    if (!selectedDest) return null;
    const projectedSelected = projectedMapMarkers.find((marker) => marker.id === selectedDest.id);
    if (projectedSelected) return projectedSelected;
    const projection = project(selectedDest.lon, selectedDest.lat, rotation.lon, rotation.lat, currentRadius);
    return projection.visible ? { x: projection.x, y: projection.y } : null;
  }, [selectedDest, projectedMapMarkers, rotation, currentRadius]);
  const activeRegionAuraId = hoveredRegionId || (selectedRegionId !== 'all' ? selectedRegionId : null);
  const selectedFocusStyle = useMemo(() => {
    if (!selectedDest) return REGION_VISUALS.default;
    const regionId = selectedDest.regionId || (regionIds.has(selectedDest.id) ? selectedDest.id : null);
    return getRegionVisual(regionId);
  }, [selectedDest, regionIds]);
  const activeRegionAura = useMemo(() => {
    if (!activeRegionAuraId) return null;
    const region = regionsById.get(activeRegionAuraId);
    if (!region) return null;
    const projection = project(region.lon, region.lat, rotation.lon, rotation.lat, currentRadius);
    if (!projection.visible) return null;
    return { ...projection, region, visual: getRegionVisual(region.id) };
  }, [activeRegionAuraId, rotation, currentRadius, regionsById]);
  const projectedCountryFills = useMemo(() => {
    if (mapFeatures.length === 0) return [];

    const fills = [];
    mapFeatures.forEach((feature, featureIndex) => {
      const regionId = FEATURE_REGION_MAP[feature.name];
      if (!regionId) return;

      const visual = getRegionVisual(regionId);
      const isActive = activeRegionAuraId === regionId;
      const isSelected = selectedDest?.regionId === regionId || selectedDest?.id === regionId || selectedRegionId === regionId;
      const opacity = isActive ? 0.58 : isSelected ? 0.42 : 0.22;
      const strokeOpacity = isActive ? 0.8 : isSelected ? 0.58 : 0.28;

      feature.polygons.forEach((ring, ringIndex) => {
        let path = '';
        let hasVisiblePoint = false;
        let started = false;

        for (let i = 0; i < ring.length; i++) {
          const point = project(ring[i][0], ring[i][1], rotation.lon, rotation.lat, currentRadius);
          if (!point.visible) {
            if (started) {
              path += ' Z ';
              started = false;
            }
            continue;
          }

          hasVisiblePoint = true;
          if (!started) {
            path += `M ${point.x} ${point.y} `;
            started = true;
          } else {
            path += `L ${point.x} ${point.y} `;
          }
        }

        if (started) path += ' Z';
        if (!hasVisiblePoint || !path.trim()) return;

        fills.push({
          id: `${feature.name}-${featureIndex}-${ringIndex}`,
          d: path,
          fill: visual.tint,
          stroke: visual.accent,
          glow: visual.glow,
          opacity,
          strokeOpacity
        });
      });
    });

    return fills;
  }, [mapFeatures, rotation, currentRadius, activeRegionAuraId, selectedDest, selectedRegionId]);
  useEffect(() => {
    if (selectedClusterId && !selectedCluster) {
      setSelectedClusterId(null);
    }
  }, [selectedClusterId, selectedCluster]);

  const itineraryDays = useMemo(() => {
    if (!selectedDest) return [];
    const estTotalCost = calculateTotalCost(selectedDest, days);
    const isLuxury = budget > estTotalCost * 1.5; 
    const isBudget = budget < estTotalCost * 1.1; 
    const cityName = getPlaceShortName(selectedDest);
    
    const arrivalText = isEnglish
      ? (isLuxury
          ? `VIP pickup at the airport, a seamless check-in at one of ${cityName}'s most lavish suites, then champagne before your first walk.`
          : isBudget
            ? `Budget mode activated: bus from the airport, clever check-in at a high-rated hostel in ${cityName}, and straight into food-hunting mode.`
            : `Smooth landing, city transfer, boutique hotel check-in, and just enough energy left for a first neighborhood roam.`)
      : (isLuxury
          ? `💰土豪驾到：高级黑车司机在机场举牌接机，直接入驻${cityName}最顶级的奢华五星套房或私人别墅，开香槟！`
          : isBudget
            ? `🎒极限穷游：提着破旧行李箱挤上了便宜的机场大巴，入驻${cityName}一家评分极高的神仙青旅，准备干饭！`
            : `🚕平稳落地：搭乘出租车一路看风景前往市区，办理入住一家极具特色的高分精品酒店，放下行李出发。`);
    const departText = isEnglish
      ? (isLuxury
          ? 'Private airport transfer, lounge snacks, one last round of indulgent shopping, and a very smug ride home.'
          : isBudget
            ? 'Convenience-store snacks, a hustle to the airport, and one final photo scroll before boarding back to reality.'
            : 'Squeeze in some city-center souvenir shopping, then head to the airport for check-in and the flight home.')
      : (isLuxury
          ? '专车送至机场VIP通道，在头等舱休息室吃着高级茶点，买几个名牌包，完美结束这趟奢华之旅。'
          : isBudget
            ? '去街角便利店买点便宜零食，狂奔去挤公交前往机场，翻看着一路拍下的照片准备登机回家打工。'
            : '上午再去市中心采买一波当地特色伴手礼，随后前往机场办理退税与托运，准备返程。');

    const specificPool = DEST_SPECIFIC_ACTIVITIES[selectedDest.id]?.[travelStyle] || [];
    const genericStylePool = GENERIC_STYLE_ACTIVITIES[travelStyle] || [];
    const genericBasePool = [{
      title: '压马路乱逛',
      titleEn: 'Street-Level Roaming',
      desc: '用双脚丈量城市',
      descEn: 'Measure the city one stubborn step at a time.',
      iconName: 'Compass'
    }];
    const richPool = [...specificPool, ...genericStylePool, ...genericBasePool];

    const it = [];
    for (let i = 1; i <= days; i++) {
      if (i === 1) {
        it.push({
          day: i,
          title: isEnglish ? `BOOM! Land in ${cityName}` : `BOOM! 空降${cityName}`,
          desc: arrivalText,
          iconName: 'Plane'
        });
      } else if (i === days) {
        it.push({
          day: i,
          title: isEnglish ? 'Pack Up and Fly Home' : '打包牛马回家',
          desc: departText,
          iconName: 'Wallet'
        });
      }
      else {
        const activity = richPool[(i - 2) % richPool.length];
        it.push({
          day: i,
          title: isEnglish ? (activity.titleEn || activity.title) : activity.title,
          desc: isEnglish ? (activity.descEn || activity.desc) : activity.desc,
          iconName: activity.iconName || 'MapIcon'
        });
      }
    }
    return it;
  }, [selectedDest, days, budget, travelStyle, calculateTotalCost, getPlaceShortName, isEnglish]);

  const displayedItinerary = useMemo(() => (
    itineraryCacheKey ? (aiItineraries[itineraryCacheKey] || itineraryDays) : itineraryDays
  ), [aiItineraries, itineraryCacheKey, itineraryDays]);
  const briefPlace = selectedDest || selectedRegion;

  return (
    <div
      className={`relative w-full h-screen min-h-[700px] overflow-hidden font-sans ${t.appTextColor} select-none`}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={() => {
        handleMouseUp();
        setHoveredMarkerId(null);
        setHoveredRegionId(null);
      }}
      onWheel={handleWheel}
      style={{
        backgroundColor: t.appBg,
        backgroundImage: `${t.appGradient}, radial-gradient(${t.appDotColor} 1.8px, transparent 1.8px)`,
        backgroundSize: `100% 100%, ${t.appDotSize}`,
      }}
      data-theme={theme}
    >
      <style>
        {`
          @keyframes gentle-float {
            0% { transform: translateY(0px); }
            100% { transform: translateY(-3px); }
          }
          @keyframes stamp-drift {
            0%, 100% { transform: translateY(0px) rotate(0deg); }
            50% { transform: translateY(-8px) rotate(2deg); }
          }
          @keyframes twinkle {
            0%, 100% { opacity: 0.25; transform: scale(0.85); }
            50% { opacity: 0.9; transform: scale(1.05); }
          }
          @keyframes orbital-spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
          @keyframes orbital-counter-spin {
            from { transform: translate(-50%, -50%) rotate(0deg); }
            to { transform: translate(-50%, -50%) rotate(-360deg); }
          }
          @keyframes orbital-beam {
            0%, 100% { opacity: 0.25; transform: scaleY(0.92); }
            50% { opacity: 0.78; transform: scaleY(1.04); }
          }
          .btn-crazy-rainbow {
            animation: gentle-float 2.2s infinite alternate ease-in-out !important;
            background: linear-gradient(135deg, #f3e8d3 0%, #d9bf97 100%) !important;
            color: #263746 !important;
            text-shadow: none !important;
            box-shadow: 0 16px 34px rgba(111, 90, 62, 0.14) !important;
          }
          .btn-crazy-rainbow:hover {
            animation-duration: 1.1s !important;
          }
          .panel-scrollbar {
            scrollbar-width: thin;
            overscroll-behavior: contain;
          }
          .panel-scrollbar::-webkit-scrollbar {
            width: 10px;
          }
          .panel-scrollbar::-webkit-scrollbar-track {
            background: transparent;
          }
          .panel-scrollbar::-webkit-scrollbar-thumb {
            background: rgba(148, 163, 184, 0.45);
            border-radius: 999px;
            border: 2px solid transparent;
            background-clip: padding-box;
          }
          .text-balance {
            text-wrap: balance;
          }
        `}
      </style>

      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {AMBIENT_STARFIELD.map((star, index) => (
          <span
            key={`star-${index}`}
            className="absolute rounded-full"
            style={{
              left: star.left,
              top: star.top,
              width: `${star.size}px`,
              height: `${star.size}px`,
              background: isComicTheme ? '#fffef8' : '#e0f2fe',
              boxShadow: isComicTheme ? '0 0 0 2px rgba(23, 32, 51, 0.08)' : '0 0 14px rgba(125, 211, 252, 0.45)',
              animation: `twinkle 3.8s ease-in-out ${star.delay} infinite`
            }}
          ></span>
        ))}
        <div className="absolute -left-20 top-8 h-72 w-72 rounded-full bg-white/44 blur-3xl"></div>
        <div className="absolute left-[22%] top-[14%] h-52 w-52 rounded-full bg-[#e3cfb0]/24 blur-3xl"></div>
        <div className="absolute right-[-6rem] top-[16%] h-[22rem] w-[22rem] rounded-full bg-[#95b8c0]/16 blur-3xl"></div>
        <div className="absolute bottom-[-5rem] left-[18%] h-60 w-60 rounded-full bg-[#c07a5e]/10 blur-3xl"></div>
      </div>

      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="relative h-[860px] w-[860px] max-w-[92vw] max-h-[92vw]">
          <div className="absolute inset-[4.5rem] rounded-full border-2 border-dashed border-black/15"></div>
          <div className="absolute inset-[1.75rem] rounded-full border border-white/70"></div>
          <div className="absolute right-[8%] top-[13%] pointer-events-auto">
            <div className="rounded-[28px] border-[3px] border-black bg-white/92 px-4 py-3 shadow-[6px_6px_0_0_#000] backdrop-blur">
              <p className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-500">
                {isEnglish ? 'Map depth' : '地图层级'}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {ZOOM_LAYER_ORDER.map((layerKey) => (
                  <span
                    key={layerKey}
                    className={`rounded-full border-[3px] border-black px-3 py-1 text-[11px] font-black shadow-[2px_2px_0_0_#000] ${
                      zoomLayer === layerKey ? 'text-white' : 'text-slate-900'
                    }`}
                    style={{
                      background: zoomLayer === layerKey
                        ? (layerKey === 'macro' ? '#2563eb' : layerKey === 'region' ? '#ff8a3d' : '#ec4899')
                        : '#fffdf7'
                    }}
                  >
                    {zoomLayerLabels[layerKey]}
                  </span>
                ))}
              </div>
              <p className="mt-3 max-w-[15rem] text-[11px] font-bold leading-5 text-slate-600">
                {zoomLayerHint[zoomLayer]}
              </p>
            </div>
          </div>

          <div className="absolute inset-0 motion-safe:animate-[orbital-spin_20s_linear_infinite]">
            <div className="absolute left-1/2 top-[6%] h-[11rem] w-[2px] -translate-x-1/2 origin-bottom bg-gradient-to-b from-[#0f172a] via-[#0f172a]/55 to-transparent opacity-[0.55] motion-safe:animate-[orbital-beam_2.8s_ease-in-out_infinite]"></div>
            <button
              type="button"
              onClick={cycleOrbitalView}
              onWheel={(e) => e.stopPropagation()}
              className="pointer-events-auto absolute left-1/2 top-[6%] h-24 w-24 rounded-full border-[4px] border-black bg-white text-black shadow-[8px_8px_0_0_#000] transition-transform hover:scale-105 active:scale-95 motion-safe:animate-[orbital-counter-spin_20s_linear_infinite]"
              style={{
                background: zoomLayer === 'macro'
                  ? 'linear-gradient(135deg, #dbeafe 0%, #93c5fd 100%)'
                  : zoomLayer === 'region'
                    ? 'linear-gradient(135deg, #fff3bf 0%, #ffb74d 100%)'
                    : 'linear-gradient(135deg, #ffe4ef 0%, #f9a8d4 100%)'
              }}
              aria-label={isEnglish ? 'Cycle orbital detail mode' : '切换轨道细节模式'}
              title={isEnglish ? 'Orbital scout: cycle depth' : '轨道卫星：切换地图层级'}
            >
              <span className="absolute inset-2 rounded-full border-2 border-black/20"></span>
              <span className="absolute left-1/2 top-1/2 h-3 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black"></span>
              <span className="absolute left-[18%] top-1/2 h-7 w-3 -translate-y-1/2 rounded-full bg-black"></span>
              <span className="absolute right-[18%] top-1/2 h-7 w-3 -translate-y-1/2 rounded-full bg-black"></span>
              <span className="absolute left-1/2 top-[20%] -translate-x-1/2 text-3xl">🛰️</span>
              <span className="absolute inset-x-0 bottom-3 text-center text-[10px] font-black uppercase tracking-[0.22em]">
                {zoomLayer === 'macro' ? '01' : zoomLayer === 'region' ? '02' : '03'}
              </span>
            </button>
          </div>
        </div>
      </div>

      <div className="absolute inset-0 flex items-center justify-center">
        <svg viewBox="-400 -400 800 800" className={`w-[750px] h-[750px] overflow-visible cursor-grab active:cursor-grabbing transition-transform ${isDragging ? 'scale-[1.02]' : 'scale-100'}`} onMouseDown={handleMouseDown}>
          <defs>
            <radialGradient id="globe-atmosphere-gradient">
              <stop offset="52%" stopColor={globeStyles.atmosphereGlow} stopOpacity="0" />
              <stop offset="78%" stopColor={globeStyles.atmosphereGlow} stopOpacity={isComicTheme ? '0.14' : '0.2'} />
              <stop offset="100%" stopColor={globeStyles.atmosphereGlowEdge} stopOpacity={isComicTheme ? '0.26' : '0.32'} />
            </radialGradient>
            <radialGradient id="globe-focus-gradient">
              <stop offset="0%" stopColor={globeStyles.focusCore} stopOpacity="0.95" />
              <stop offset="38%" stopColor={globeStyles.focusHalo} stopOpacity={isComicTheme ? '0.42' : '0.34'} />
              <stop offset="100%" stopColor={globeStyles.focusHalo} stopOpacity="0" />
            </radialGradient>
            <filter id="globe-soft-blur" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="16" />
            </filter>
          </defs>

          <circle r={currentRadius * 1.16} fill="url(#globe-atmosphere-gradient)" opacity={isDragging ? 0.8 : 1} />
          <circle r={currentRadius * 1.04} fill="none" stroke={globeStyles.atmosphereGlowEdge} strokeOpacity={isComicTheme ? 0.18 : 0.26} strokeWidth={8} />
          <circle r={currentRadius} fill={t.oceanFill} stroke={t.oceanStroke} strokeWidth={t.oceanStrokeWidth} />
          <path d={`M -${currentRadius*0.6} -${currentRadius*0.6} A ${currentRadius} ${currentRadius} 0 0 1 0 -${currentRadius} A ${currentRadius*0.8} ${currentRadius*0.8} 0 0 0 -${currentRadius*0.6} -${currentRadius*0.6} Z`} fill="#fff" opacity={theme === 'y2k' ? 0.12 : 0.3} />

          <g>
            {projectedCountryFills.map((shape) => (
              <g key={shape.id}>
                <path d={shape.d} fill={shape.glow} opacity={shape.opacity * 0.72} />
                <path d={shape.d} fill={shape.fill} fillOpacity={shape.opacity} stroke={shape.stroke} strokeOpacity={shape.strokeOpacity} strokeWidth="1.25" strokeLinejoin="round" />
              </g>
            ))}
          </g>

          <g>
            {(isMapLoading || coastLines.length === 0)
              ? graticules.map((d, i) => <path key={i} d={d} fill="none" stroke={t.graticuleStroke} strokeWidth={t.graticuleStrokeWidth} strokeDasharray="10,10" />)
              : coastLines.map((d, i) => <path key={i} d={d} fill="none" stroke={t.coastStroke} strokeWidth={t.coastStrokeWidth} strokeLinecap="round" strokeLinejoin="round" />)}
          </g>
          
          <circle r={currentRadius} fill="none" stroke={globeStyles.atmosphereShadow} strokeWidth={40 * zoom} strokeDasharray={`${Math.PI*currentRadius} ${Math.PI*currentRadius}`} transform="rotate(-45)" />

          {activeRegionAura && (
            <g transform={`translate(${activeRegionAura.x}, ${activeRegionAura.y})`} pointerEvents="none">
              <circle r={currentRadius * 0.24} fill={activeRegionAura.visual.glow} filter="url(#globe-soft-blur)" opacity="0.75" />
            </g>
          )}

          {previewTarget && (
            <path
              d={getGreatCirclePath(departure.lon, departure.lat, previewTarget.lon, previewTarget.lat, rotation.lon, rotation.lat, currentRadius)}
              fill="none"
              stroke={previewTarget.regionVisual?.route || globeStyles.previewRoute}
              strokeWidth={Math.max(2.5, t.routeStrokeWidth - 0.5)}
              strokeDasharray="8,14"
              strokeLinecap="round"
              opacity="0.9"
              pointerEvents="none"
            >
              <animate attributeName="stroke-dashoffset" from="66" to="0" dur="1.8s" repeatCount="indefinite" />
            </path>
          )}

          {selectedDest && (selectedDest.lon !== departure.lon || selectedDest.lat !== departure.lat) && (
            <path d={getGreatCirclePath(departure.lon, departure.lat, selectedDest.lon, selectedDest.lat, rotation.lon, rotation.lat, currentRadius)}
              fill="none" stroke={t.routeStroke} strokeWidth={t.routeStrokeWidth} strokeDasharray="12,12" strokeLinecap="round" className={theme === 'y2k' ? 'drop-shadow-[0_0_6px_rgba(200,255,61,0.8)]' : 'drop-shadow-[4px_4px_0_rgba(0,0,0,1)]'}>
              <animate attributeName="stroke-dashoffset" from="100" to="0" dur="1.5s" repeatCount="indefinite" />
            </path>
          )}

          {selectedFocusPoint && (
            <g transform={`translate(${selectedFocusPoint.x}, ${selectedFocusPoint.y})`} pointerEvents="none">
              <circle r={currentRadius * 0.11} fill="url(#globe-focus-gradient)">
                <animate attributeName="r" values={`${currentRadius * 0.085};${currentRadius * 0.14};${currentRadius * 0.085}`} dur="2.6s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.95;0.42;0.95" dur="2.6s" repeatCount="indefinite" />
              </circle>
              <circle r={currentRadius * 0.06} fill="none" stroke={selectedFocusStyle.accent} strokeOpacity="0.92" strokeWidth="2.5" strokeDasharray="6 10">
                <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="10s" repeatCount="indefinite" />
              </circle>
            </g>
          )}

          {(() => {
            const depProj = project(departure.lon, departure.lat, rotation.lon, rotation.lat, currentRadius);
            if (!depProj.visible) return null;
            return (
              <g transform={`translate(${depProj.x}, ${depProj.y})`} className="pointer-events-none">
                <foreignObject x="-30" y="-30" width="60" height="60" className="overflow-visible">
                  <div className="w-full h-full flex items-center justify-center relative"><ComicBurst color="#fff" /><span className="relative z-10 text-2xl drop-shadow-sm">{departure.icon}</span></div>
                </foreignObject>
                <text y="42" textAnchor="middle" fill="#000" fontSize="16" fontWeight="900" style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: '5px' }}>{getPlaceShortName(departure)}</text>
              </g>
            );
          })()}

          {renderedMapMarkers.map((marker) => {
            return (
              <g
                key={marker.id}
                transform={`translate(${marker.x}, ${marker.y})`}
                className="cursor-pointer group"
                onMouseEnter={() => {
                  setHoveredMarkerId(marker.id);
                  setHoveredRegionId(marker.regionId || null);
                }}
                onMouseLeave={() => {
                  setHoveredMarkerId((current) => (current === marker.id ? null : current));
                  setHoveredRegionId((current) => (current === marker.regionId ? null : current));
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (marker.markerType === 'departure') handleDepartureSelect(marker);
                  else if (marker.markerType === 'macro') handleMacroHubSelect(marker);
                  else if (regionIds.has(marker.id)) handleRegionSelect(marker);
                  else handleMarkerClick(marker);
                }}
              >
                {(marker.x !== marker.baseX || marker.y !== marker.baseY) && (
                  <path
                    d={`M 0 0 L ${marker.baseX - marker.x} ${marker.baseY - marker.y}`}
                    stroke="#000"
                    strokeWidth="2"
                    strokeDasharray="4,4"
                    opacity="0.35"
                    pointerEvents="none"
                  />
                )}

                {(marker.isRegionHovered || marker.isHovered || marker.isSelected) && (
                  <g pointerEvents="none">
                    <circle
                      r={marker.isMacroHub ? 54 : marker.isSelected ? 42 : marker.isRegionHovered ? 38 : 28}
                      fill={marker.isSelected ? 'url(#globe-focus-gradient)' : marker.regionVisual?.glow || REGION_VISUALS.default.glow}
                      opacity={marker.isMacroHub ? 0.68 : marker.isSelected ? 0.78 : marker.isHovered ? 0.74 : 0.58}
                    />
                    <circle
                      r={marker.isMacroHub ? 38 : marker.isSelected ? 28 : 22}
                      fill="none"
                      stroke={marker.isSelected ? selectedFocusStyle.accent : marker.regionVisual?.accent || REGION_VISUALS.default.accent}
                      strokeOpacity={marker.isSelected ? 0.88 : 0.54}
                      strokeWidth="2"
                      strokeDasharray={marker.isSelected ? '7 10' : '5 9'}
                    >
                      <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur={marker.isSelected ? '8s' : '11s'} repeatCount="indefinite" />
                    </circle>
                  </g>
                )}

                <g className={`transition-transform duration-200 ${marker.isHovered || marker.isSelected ? 'scale-[1.18]' : 'group-hover:scale-110'}`}>
                  <SvgMarkerFace marker={marker} affordable={marker.isAffordable} />
                </g>
                <foreignObject
                  x={marker.isMacroHub ? '-92' : '-74'}
                  y={marker.isMacroHub ? '42' : '32'}
                  width={marker.isMacroHub ? '184' : '148'}
                  height="42"
                  className="overflow-visible pointer-events-none"
                >
                  <div className="flex items-center justify-center">
                    <span
                      className={`px-3 py-1 rounded-full border-[3px] border-black shadow-[3px_3px_0_0_#000] ${marker.isMacroHub ? 'text-[12px]' : 'text-[11px]'} font-black whitespace-nowrap ${
                        marker.isSelected ? 'text-white' : 'text-slate-900'
                      }`}
                      style={{
                        background: marker.isSelected ? (marker.regionVisual?.accent || '#314657') : (marker.regionVisual?.surface || '#fff')
                      }}
                    >
                      {getPlaceShortName(marker)}
                    </span>
                  </div>
                </foreignObject>
              </g>
            );
          })}

          {mapClusters.map((cluster) => (
            <g
              key={cluster.id}
              transform={`translate(${cluster.x}, ${cluster.y})`}
              className="cursor-pointer group"
              onClick={(e) => {
                e.stopPropagation();
                setSelectedClusterId(cluster.id);
                animateToTarget(cluster.lon, cluster.lat);
                setZoom((prev) => Math.max(prev, ZOOM_PRESETS.city));
              }}
            >
              <g className="transition-transform duration-200 group-hover:scale-110">
                <SvgClusterFace count={cluster.items.length} active={selectedClusterId === cluster.id} items={cluster.items} />
              </g>
            </g>
          ))}
        </svg>
      </div>

      {hiddenMapMarkers.length > 0 && (
        <div
          onWheel={(e) => e.stopPropagation()}
          className="absolute left-1/2 bottom-6 -translate-x-1/2 z-20 flex flex-col items-center gap-2 pointer-events-auto"
        >
          {showFarSidePanel && (
            <div className="w-[min(42rem,calc(100vw-10rem))] bg-white/95 backdrop-blur border-4 border-black rounded-2xl shadow-[8px_8px_0_0_#000] px-4 py-3">
              <div className="flex items-baseline justify-between gap-3 mb-2">
                <p className="text-[11px] font-bold text-slate-500">{ui.farSideHint}</p>
                <button
                  onClick={() => setShowFarSidePanel(false)}
                  className="text-[10px] font-black text-slate-500 hover:text-black"
                  aria-label="close"
                >
                  <X size={14} strokeWidth={3} />
                </button>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {hiddenMapMarkers.map((marker) => (
                  <button
                    key={`hidden-${marker.id}`}
                    onClick={() => {
                      if (marker.markerType === 'departure') handleDepartureSelect(marker);
                      else if (marker.markerType === 'macro') handleMacroHubSelect(marker);
                      else if (DESTINATION_REGIONS.some((region) => region.id === marker.id)) handleRegionSelect(marker);
                      else handleMarkerClick(marker);
                      setShowFarSidePanel(false);
                    }}
                    className="shrink-0 flex items-center gap-2 px-3 py-2 bg-[#f8fafc] border-2 border-black rounded-xl shadow-[2px_2px_0_0_#000] hover:-translate-y-0.5 transition-transform"
                  >
                    <span className="text-lg leading-none">{marker.icon}</span>
                    <span className="text-xs font-black text-black whitespace-nowrap">{getPlaceShortName(marker)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <button
            onClick={() => setShowFarSidePanel((prev) => !prev)}
            className="flex items-center gap-2 px-4 py-2 bg-white border-4 border-black rounded-full shadow-[4px_4px_0_0_#000] hover:-translate-y-0.5 transition-transform"
            aria-expanded={showFarSidePanel}
          >
            <span className="text-sm">◐</span>
            <span className="text-[11px] font-black uppercase text-black">{ui.farSideTitle}</span>
            <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full border-2 border-black bg-[#fef08a] text-black leading-none">
              {hiddenMapMarkers.length}
            </span>
          </button>
        </div>
      )}

      <div 
        onWheel={(e) => e.stopPropagation()} 
        className="absolute right-6 top-1/2 -translate-y-1/2 flex flex-col gap-4 z-20 pointer-events-auto"
      >
        <div className="flex flex-col gap-2 bg-white border-4 border-black rounded-2xl shadow-[6px_6px_0_0_#000] p-1.5">
          <button onClick={() => setZoom(z => Math.min(4.0, z + 0.4))} className="w-12 h-12 bg-[#22d3ee] hover:bg-[#06b6d4] rounded-xl flex items-center justify-center text-black border-2 border-black transition-colors active:scale-90"><ZoomIn size={24} strokeWidth={3}/></button>
          <div className="w-full h-1 bg-black rounded-full opacity-20 my-1"></div>
          <button onClick={() => setZoom(z => Math.max(0.6, z - 0.4))} className="w-12 h-12 bg-[#f472b6] hover:bg-[#ec4899] rounded-xl flex items-center justify-center text-black border-2 border-black transition-colors active:scale-90"><ZoomOut size={24} strokeWidth={3}/></button>
        </div>
      </div>

      <div
        onWheel={(e) => e.stopPropagation()}
        className="absolute top-6 right-6 z-30 pointer-events-auto"
      >
        <div className="relative">
          <button
            onClick={() => setShowSettingsMenu((prev) => !prev)}
            className="w-14 h-14 rounded-2xl border-[2.5px] hover:-translate-y-0.5 active:translate-y-0.5 transition-all flex items-center justify-center"
            style={uiStyles.panelShell}
            aria-label={ui.settings}
            title={ui.settings}
          >
            <Settings2 size={24} strokeWidth={3} />
          </button>

          {showSettingsMenu && (
            <div className="absolute right-0 top-full mt-3 w-64 rounded-[24px] border-[2.5px] p-4 space-y-4" style={uiStyles.panelShell}>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500 mb-2">{ui.mapLayers}</p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => toggleMapLayer('departures')}
                    className={`px-3 py-2 rounded-2xl border text-[11px] font-semibold transition-colors ${
                      mapLayerVisibility.departures ? 'text-black' : 'text-slate-400'
                    }`}
                    style={mapLayerVisibility.departures ? uiStyles.accentShell : uiStyles.fieldShell}
                  >
                    {ui.departuresLayer}
                  </button>
                  <button
                    onClick={() => toggleMapLayer('destinations')}
                    className={`px-3 py-2 rounded-2xl border text-[11px] font-semibold transition-colors ${
                      mapLayerVisibility.destinations ? 'text-black' : 'text-slate-400'
                    }`}
                    style={mapLayerVisibility.destinations ? uiStyles.accentShell : uiStyles.fieldShell}
                  >
                    {ui.destinationsLayer}
                  </button>
                </div>
              </div>

              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500 mb-2">{ui.language}</p>
                <div className="rounded-2xl p-1 border" style={uiStyles.fieldShell}>
                  <div className="flex items-center gap-1">
                    {['English', '中文'].map((option) => (
                      <button
                        key={option}
                        onClick={() => { setLanguage(option); setShowSettingsMenu(false); }}
                        className={`flex-1 px-3 py-2 rounded-xl text-[11px] font-black transition-all ${
                          language === option
                            ? 'text-black border'
                            : 'text-slate-500 hover:bg-white/60'
                        }`}
                        style={language === option ? uiStyles.accentShell : undefined}
                        aria-label={`${ui.language}: ${option}`}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500 mb-2">{isEnglish ? 'THEME' : '主题'}</p>
                <div className="rounded-2xl p-1 border" style={uiStyles.fieldShell}>
                  <div className="flex items-center gap-1">
                    {Object.values(THEMES).map((option) => (
                      <button
                        key={option.id}
                        onClick={() => setTheme(option.id)}
                        className={`flex-1 px-3 py-2 rounded-xl text-[11px] font-black transition-all ${
                          theme === option.id
                            ? 'text-black border'
                            : 'text-slate-500 hover:bg-white/60'
                        }`}
                        style={theme === option.id ? uiStyles.accentShell : undefined}
                        aria-label={`theme: ${option.label}`}
                      >
                        {isEnglish ? option.label : option.labelZh}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="border-t border-dashed pt-4" style={uiStyles.softDivider}>
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500 mb-2">{ui.account}</p>
                {user ? (
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={handleLoadMyTrips}
                      className="flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-2xl border transition-colors active:translate-y-0.5 text-xs font-bold"
                      style={uiStyles.accentShell}
                      title={ui.myTripsTooltip}
                    >
                      <Heart size={14} strokeWidth={3}/> {ui.myTripsTooltip}
                    </button>
                    <button
                      onClick={handleLogout}
                      className="flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-2xl border transition-colors active:translate-y-0.5 text-xs font-bold"
                      style={uiStyles.fieldShell}
                      title={ui.logoutTooltip}
                    >
                      <LogOut size={14} strokeWidth={3}/> {ui.logoutTooltip}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <button
                      onClick={() => handleLogin('google')}
                      className="w-full px-4 py-2.5 flex items-center justify-center gap-2 text-xs font-bold text-black rounded-2xl border transition-colors"
                      style={uiStyles.accentShell}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                      {ui.signInGoogle}
                    </button>
                    <button
                      onClick={() => handleLogin('github')}
                      className="w-full px-4 py-2.5 flex items-center justify-center gap-2 text-xs font-bold text-white rounded-2xl border transition-colors"
                      style={uiStyles.strongButton}
                    >
                      <Github size={14} strokeWidth={3}/> {ui.signInGithub}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {selectedCluster && (
        <div
          onWheel={(e) => e.stopPropagation()}
          className="absolute top-24 right-6 z-30 w-72 rounded-[24px] border-[2.5px] p-4 pointer-events-auto"
          style={uiStyles.panelShell}
        >
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">{ui.crowdedArea}</p>
              <h3 className="text-base font-black text-black">{ui.clusterCount(selectedCluster.items.length)}</h3>
              <p className="text-[11px] font-medium text-slate-500 mt-1">{ui.crowdedHint}</p>
            </div>
            <button
              onClick={() => setSelectedClusterId(null)}
              className="p-1.5 border rounded-full transition-colors"
              style={uiStyles.softChip}
            >
              <X size={14} strokeWidth={3} />
            </button>
          </div>

          <div className="panel-scrollbar max-h-64 overflow-y-auto space-y-2 pr-1">
            {selectedCluster.items.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  if (item.markerType === 'departure') handleDepartureSelect(item);
                  else if (DESTINATION_REGIONS.some((region) => region.id === item.id)) handleRegionSelect(item);
                  else handleMarkerClick(item);
                }}
                className="w-full flex items-center gap-3 p-2.5 rounded-2xl border text-left transition-transform hover:-translate-y-0.5"
                style={uiStyles.fieldShell}
              >
                <div className="w-10 h-10 rounded-2xl border flex items-center justify-center text-lg shrink-0" style={uiStyles.softChip}>
                  {item.icon}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border" style={item.markerType === 'departure' ? uiStyles.softChip : uiStyles.accentShell}>
                      {item.markerType === 'departure' ? ui.departureBadge : ui.destinationBadge}
                    </span>
                    {item.isDestination && (
                      <span className="text-[10px] font-semibold text-slate-500">¥{item.estCost}</span>
                    )}
                  </div>
                  <p className="text-sm font-black text-black truncate mt-1">{getPlaceName(item)}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <button 
        onWheel={(e) => e.stopPropagation()}
        onClick={() => setShowBlindBox(true)} 
        className="absolute right-6 bottom-8 px-5 py-3.5 btn-crazy-rainbow border-[2.5px] rounded-[22px] active:translate-y-1 transition-all flex items-center justify-center gap-3 z-20 pointer-events-auto group origin-center"
        style={{ borderColor: uiStyles.accentShell.borderColor }}
      >
        <Dices size={28} strokeWidth={2.6} className="group-hover:rotate-12 transition-transform"/>
        <span className="text-lg font-bold tracking-[0.02em]">{ui.blindBoxButton}</span>
      </button>

      <div 
        onWheel={(e) => e.stopPropagation()}
        className="absolute top-6 left-6 z-20 w-[22rem] max-w-[calc(100vw-3rem)] max-h-[calc(100vh-3rem)] p-5 rounded-[30px] border-[3px] pointer-events-auto flex flex-col overflow-hidden"
        style={uiStyles.panelShell}
      >
        <div className="mb-4 shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-2xl text-black" style={uiStyles.accentShell}><Compass size={24} strokeWidth={2.6}/></div>
            <div>
              <h1 className="text-[2rem] font-black text-black tracking-[-0.04em] leading-none uppercase text-balance">{ui.appTitle}</h1>
              <p className="text-[10px] font-semibold text-slate-500 mt-1 uppercase tracking-[0.18em]">{ui.appSubtitle}</p>
            </div>
          </div>
        </div>

        <div className="panel-scrollbar flex-1 min-h-0 overflow-y-auto pr-2 -mr-2 pb-1">
          <div className="space-y-4">
          <div className="rounded-[24px] border-[2.5px] p-4" style={uiStyles.sectionShell}>
            <div className="flex items-center justify-between mb-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">{ui.routeTitle}</p>
              <span className="text-[10px] font-bold px-2.5 py-1 rounded-full border max-w-[10rem] truncate text-slate-700" style={uiStyles.softChip}>
                {selectedDest
                  ? `${getPlaceShortName(departure)} → ${getPlaceShortName(selectedDest)}`
                  : selectedRegion
                    ? `${getPlaceShortName(departure)} → ${getPlaceShortName(selectedRegion)}`
                    : '🌍'}
              </span>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-[11px] font-bold text-slate-700 mb-1.5 flex items-center gap-1.5"><MapIcon size={14} strokeWidth={2.6} /> {ui.fromLabel}</label>
                <select value={departureId} onChange={(e) => { setDepartureId(e.target.value); const newDep = ALL_PLACES.find(d => d.id === e.target.value); if(newDep) { animateToTarget(newDep.lon, newDep.lat); setZoom(1.5); } }} className="w-full p-3 rounded-2xl text-sm font-semibold text-black focus:outline-none focus:ring-4 cursor-pointer transition-shadow" style={{ ...uiStyles.fieldShell, '--tw-ring-color': isComicTheme ? '#f4b8c5' : '#72d8ff' }}>
                  <optgroup label={ui.hubsLabel}>{DEPARTURE_CITIES.map(c => <option key={c.id} value={c.id}>{c.icon} {getPlaceName(c)}</option>)}</optgroup>
                  <optgroup label={ui.placesLabel}>{DESTINATIONS.map(c => <option key={c.id} value={c.id}>{c.icon} {getPlaceName(c)}</option>)}</optgroup>
                </select>
              </div>

              <div>
                <label className="text-[11px] font-bold text-slate-700 mb-1.5 flex items-center gap-1.5"><Compass size={14} strokeWidth={2.6} /> {ui.broadLabel}</label>
                <select
                  value={selectedRegionId}
                  onChange={(e) => handleRegionChange(e.target.value)}
                  className="w-full p-3 rounded-2xl text-sm font-semibold text-black focus:outline-none focus:ring-4 cursor-pointer transition-shadow"
                  style={{ ...uiStyles.fieldShell, '--tw-ring-color': isComicTheme ? '#bcead5' : '#72d8ff' }}
                >
                  <option value="all">{ui.allRegions}</option>
                  {DESTINATION_REGIONS.map((region) => (
                    <option key={region.id} value={region.id}>{region.icon} {getPlaceName(region)}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-[11px] font-bold text-slate-700 mb-1.5 flex items-center gap-1.5"><Plane size={14} strokeWidth={2.6} /> {ui.specificLabel}</label>
                <select
                  value={selectedDest?.id || ''}
                  onChange={(e) => {
                    const dest = visibleSpecificDestinations.find((item) => item.id === e.target.value);
                    if (!dest) return;
                    if (DESTINATION_REGIONS.some((region) => region.id === dest.id)) handleRegionSelect(dest);
                    else handleMarkerClick(dest);
                  }}
                  disabled={selectedRegionId === 'all'}
                  className="w-full p-3 rounded-2xl text-sm font-semibold text-black focus:outline-none focus:ring-4 cursor-pointer transition-shadow disabled:opacity-60 disabled:cursor-not-allowed"
                  style={{ ...uiStyles.fieldShell, '--tw-ring-color': isComicTheme ? '#f2d27c' : '#c8ff3d' }}
                >
                  <option value="" disabled>{ui.selectDestination}</option>
                  {visibleSpecificDestinations.map((place) => (
                    <option key={place.id} value={place.id}>
                      {place.icon} {getPlaceName(place)} {DESTINATION_REGIONS.some((region) => region.id === place.id) ? `· ${ui.regionTripTag}` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-wrap gap-1.5 pt-3 border-t border-dashed" style={uiStyles.softDivider}>
                <span className="px-2.5 py-1 rounded-full border text-[10px] font-semibold text-slate-700" style={uiStyles.softChip}>
                  {TRAVEL_STYLES.find((s) => s.id === travelStyle)?.icon} {getTravelStyleName(travelStyle)}
                </span>
                <span className="px-2.5 py-1 rounded-full border text-[10px] font-semibold text-slate-700" style={uiStyles.softChip}>
                  {days}{isEnglish ? 'd' : '天'}
                </span>
                <span className="px-2.5 py-1 rounded-full border text-[10px] font-semibold text-[#b2554e]" style={uiStyles.softChip}>
                  {formatBudgetLabel(budget)}
                </span>
                {selectedDest && (
                  <span className="px-2.5 py-1 rounded-full border text-[10px] font-semibold text-slate-700" style={uiStyles.softChip}>
                    {getVisaLabel(passport, selectedDest)}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="rounded-[24px] border-[2.5px] overflow-hidden" style={uiStyles.sectionShell}>
            <button
              onClick={() => setShowTripTuning((prev) => !prev)}
              className="w-full flex items-center justify-between gap-3 px-4 py-3.5 transition-colors"
              style={{ background: isComicTheme ? 'rgba(255,255,255,0.66)' : 'rgba(15,24,64,0.85)' }}
            >
              <div className="flex items-center gap-2">
                <Sparkles size={16} strokeWidth={2.6} />
                <span className="text-sm font-bold text-black">
                  {showTripTuning ? ui.hideTuneTrip : ui.tuneTrip}
                </span>
              </div>
              <ChevronRight
                size={18}
                strokeWidth={2.6}
                className={`transition-transform ${showTripTuning ? 'rotate-90' : ''}`}
              />
            </button>

            {showTripTuning && (
              <div className="p-4 space-y-4 border-t" style={{ ...uiStyles.softDivider, background: isComicTheme ? 'rgba(252,249,243,0.82)' : 'rgba(9,17,46,0.92)' }}>
                <div>
                  <label className="text-xs font-bold text-slate-700 mb-2 flex items-center gap-1.5"><Sparkles size={14} strokeWidth={2.6}/> {ui.styleLabel}</label>
                  <div className="grid grid-cols-2 gap-2">
                    {TRAVEL_STYLES.map(s => (
                      <button key={s.id} onClick={() => setTravelStyle(s.id)}
                        className={`py-2.5 px-2 text-[11px] font-semibold rounded-2xl border-[2.5px] transition-all duration-150 active:translate-y-0.5
                        ${travelStyle === s.id ? 'text-black' : 'text-slate-700 hover:-translate-y-0.5'}`}
                        style={travelStyle === s.id ? uiStyles.accentShell : uiStyles.fieldShell}>
                        {s.icon} {isEnglish ? (s.nameEn || s.name) : s.name}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="pt-1 border-t" style={uiStyles.softDivider}>
                  <div className="flex justify-between items-end mb-1">
                    <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5"><Wallet size={14} strokeWidth={2.6}/> {ui.budgetLabel}</label>
                    <span className="text-[#b2554e] font-bold text-sm px-2.5 py-1 rounded-full border" style={uiStyles.softChip}>¥{budget.toLocaleString()}</span>
                  </div>
                  <input type="range" min="5000" max="100000" step="5000" value={budget} onChange={(e) => setBudget(Number(e.target.value))} className="w-full h-3 rounded-full appearance-none cursor-pointer accent-[#f07c5b] outline-none mt-2 bg-slate-200"/>
                </div>

                <div>
                  <label className="text-xs font-bold text-slate-700 mb-2 flex items-center gap-1.5"><Calendar size={14} strokeWidth={2.6}/> {ui.daysLabel}</label>
                  <div className="flex gap-2">
                    {[3, 5, 7, 10, 14].map(d => (
                      <button key={d} onClick={() => setDays(d)} className={`flex-1 py-2 text-sm rounded-2xl border-[2.5px] transition-all duration-150 active:translate-y-0.5 ${days === d ? 'font-bold text-black' : 'font-semibold text-slate-700 hover:-translate-y-0.5'}`} style={days === d ? uiStyles.accentShell : uiStyles.fieldShell}>{d}</button>
                    ))}
                  </div>
                </div>

                <div className="pt-2 border-t border-dashed" style={uiStyles.softDivider}>
                  <label className="text-[10px] font-semibold text-slate-500 uppercase mb-1 flex items-center gap-1"><User size={12} strokeWidth={2}/> {ui.visaLabel}</label>
                  <select value={passport} onChange={(e) => setPassport(e.target.value)} className="w-full p-2.5 rounded-2xl text-xs font-semibold text-slate-700 focus:outline-none cursor-pointer transition-colors" style={uiStyles.fieldShell}>
                    <option value="CN">{ui.passportCn}</option><option value="US">{ui.passportUs}</option>
                  </select>
                </div>
              </div>
            )}
          </div>
        </div>
        </div>
      </div>

      {selectedDest && !showBlindBox && (
        <div 
          onWheel={(e) => e.stopPropagation()}
          className={`absolute bottom-6 left-1/2 w-96 p-1.5 rounded-[26px] border-[2.5px] z-30 pointer-events-auto
          ${isDraggingPopup ? 'transition-none cursor-grabbing' : 'transition-transform duration-300 cursor-grab'}`}
          style={{
            ...uiStyles.panelShell,
            transform: `translate(calc(-50% + ${popupOffset.x}px), calc(${showItinerary ? '150%' : '0px'} + ${popupOffset.y}px))`,
          }}
          onMouseDown={handlePopupMouseDown}
        >
          <div className="w-16 h-2 bg-slate-200 border-2 border-black rounded-full mx-auto mb-1.5 pointer-events-none"></div>

          <div className="relative rounded-[22px] p-5 overflow-hidden border-[2.5px]" style={uiStyles.accentShell}>
            <button onMouseDown={(e) => e.stopPropagation()} onClick={() => setSelectedDest(null)} className="absolute top-2 right-2 p-1.5 rounded-full text-black transition-colors z-20 active:translate-y-1" style={uiStyles.fieldShell}><X size={16} strokeWidth={3} /></button>
            <div className="absolute -bottom-8 -right-4 text-8xl opacity-30 pointer-events-none">{selectedDest.icon}</div>
            
            <h2 className="text-3xl font-black text-black tracking-tight mb-3 uppercase relative z-10">{getPlaceName(selectedDest)}</h2>
            
            <div className="flex items-center gap-3 relative z-10 mb-4">
               <span className="px-3 py-1 rounded-full text-sm font-semibold border" style={uiStyles.softChip}>{isEnglish ? `${days} DAYS` : `${days}天`}</span>
               <span className={`px-3 py-1 rounded-full text-sm font-semibold border uppercase ${(() => {
                 const region = selectedDest.regionId ? DESTINATION_REGIONS.find((item) => item.id === selectedDest.regionId) : null;
                 const visaKey = selectedDest.visaKey || region?.visaKey || selectedDest.id;
                 const status = VISA_RULES[passport]?.[visaKey]?.status;
                 return status === 'free' ? 'text-[#0f766e]' : status === 'voa' ? 'text-[#9a6700]' : 'text-[#b91c1c]';
               })()}`} style={uiStyles.softChip}>{getVisaLabel(passport, selectedDest)}</span>
            </div>

            <div className="rounded-[22px] p-4 relative z-10 border-[2.5px]" style={uiStyles.fieldShell}>
              <div className="flex justify-between items-end mb-2 border-b pb-2" style={uiStyles.softDivider}>
                <span className="font-black text-sm uppercase">{ui.totalCost}</span>
                <span className={`text-2xl font-black ${calculateTotalCost(selectedDest, days) > budget ? 'text-[#ef4444]' : 'text-[#10b981]'}`}>¥{calculateTotalCost(selectedDest, days).toLocaleString()}</span>
              </div>
              
              <div className="flex justify-between items-center text-[10px] text-slate-500 font-bold mb-2 flex-wrap gap-1">
                <span>✈️ {ui.flightCost}: ¥{estimateFlightCost(departure.lon, departure.lat, selectedDest.lon, selectedDest.lat)}</span>
                <span>🏨 {ui.hotelCost}: ¥{selectedDest.hotel}{ui.perNight}</span>
                <span>🍜 {ui.dailyCost}: ¥{selectedDest.daily}{ui.perDay}</span>
              </div>
              
              <p className="text-sm font-medium text-slate-700 leading-relaxed pointer-events-none">{getPlaceDescription(selectedDest)}</p>
            </div>

            <button disabled={isAILoading} onMouseDown={(e) => e.stopPropagation()} onClick={handleGenerateItinerary} className="w-full mt-4 py-3 text-lg font-bold rounded-[20px] border-[2.5px] active:translate-y-1 transition-all flex items-center justify-center gap-2 relative z-20 disabled:opacity-60 disabled:cursor-not-allowed" style={uiStyles.strongButton}>
              <Sparkles strokeWidth={2.6}/> {ui.generateButton}
            </button>
          </div>
        </div>
      )}

      <div 
        onWheel={(e) => e.stopPropagation()}
        className={`panel-scrollbar absolute top-0 right-0 w-[450px] h-full transition-transform duration-300 ease-out z-40 overflow-y-auto border-l-[2.5px] ${showItinerary ? 'translate-x-0' : 'translate-x-full'}`}
        style={{ ...uiStyles.panelShell, borderRadius: 0, boxShadow: isComicTheme ? '-18px 0 42px rgba(15, 23, 42, 0.16)' : '-18px 0 42px rgba(0, 0, 0, 0.34)' }}
      >
        {selectedDest && (
          <div className="pb-10 relative">
            <div className="sticky top-0 z-10 p-6 flex items-center justify-between border-b" style={{ ...uiStyles.sectionShell, borderRadius: 0, boxShadow: 'none' }}>
              <div>
                <h2 className="text-2xl font-black text-black tracking-[-0.04em] bg-white/80 inline-block px-3 py-1.5 rounded-2xl border" style={uiStyles.softChip}>{ui.itineraryHeader}</h2>
                <div className="flex items-center gap-2 mt-3">
                  <span className="px-2.5 py-1 rounded-full text-xs font-semibold border text-slate-700" style={uiStyles.softChip}>{getPlaceShortName(selectedDest)}</span>
                  <span className="px-2.5 py-1 rounded-full text-xs font-semibold border text-slate-700" style={uiStyles.accentShell}>{TRAVEL_STYLES.find(s=>s.id===travelStyle)?.icon} {getTravelStyleName(travelStyle)}</span>
                </div>
              </div>
              <button onClick={() => setShowItinerary(false)} className="p-2 rounded-full text-black transition-colors active:translate-y-1" style={uiStyles.fieldShell}><X size={24} strokeWidth={3} /></button>
            </div>

            <div className="p-6 space-y-6">
              {isAILoading ? (
                <div className="flex flex-col items-center justify-center py-20 gap-6">
                  <div className="relative">
                    <Loader2 size={48} className="animate-spin text-[#f472b6]" strokeWidth={3}/>
                    <div className="absolute inset-0 flex items-center justify-center"><Sparkles size={20} className="text-[#22d3ee] animate-pulse"/></div>
                  </div>
                  <div className="text-center">
                    <h3 className="text-xl font-black uppercase text-black mb-2">{ui.loadingTitle}</h3>
                    <p className="text-sm font-bold text-slate-500">{ui.loadingDesc}</p>
                  </div>
                </div>
              ) : (
                <>
                  {/* API 报错时展示漫画风错误提示框 */}
                  {apiError && (
                    <div className="bg-[#fee2e2] border-4 border-black rounded-xl p-4 mb-4 shadow-[4px_4px_0_0_#000] relative overflow-hidden">
                      <div className="absolute -top-4 -right-2 text-6xl opacity-20 transform rotate-12">💥</div>
                      <p className="font-black text-black text-lg mb-1 flex items-center gap-2"><Flame className="text-[#ef4444]" size={20}/> {ui.errorTitle}</p>
                      <p className="text-sm font-bold text-slate-700 leading-tight mb-3">{apiError === 'fallback' ? ui.fallbackError : apiError}</p>
                      <button disabled={isAILoading} onClick={handleGenerateItinerary} className={`text-xs ${isAILoading ? 'bg-gray-300 cursor-not-allowed' : 'bg-white hover:bg-[#fcd34d]'} text-black px-4 py-2 rounded-lg border-2 border-black font-black active:translate-y-1 shadow-[2px_2px_0_0_#000] transition-colors`}>
                        {isAILoading ? `⏳ ${ui.retrying}` : `🔄 ${ui.retry}`}
                      </button>
                    </div>
                  )}

                  {/* 这里使用了短路逻辑：如果 AI 返回了数据就用 AI 的，否则回退使用本地自动计算的假行程 */}
                  {displayedItinerary.map((day, idx) => (
                    <div key={idx} className={`relative p-5 rounded-[24px] border-[2.5px] hover:-translate-y-1 transition-transform ${idx % 2 === 0 ? 'rotate-[0.35deg]' : '-rotate-[0.35deg]'}`} style={uiStyles.sectionShell}>
                      <div className="absolute -top-4 -left-4 w-12 h-12 rounded-full border-[2.5px] flex items-center justify-center text-xl font-black z-10" style={uiStyles.fieldShell}>{day.day}</div>
                      <div className="absolute -top-6 right-4 w-14 h-14 rounded-full border-[2.5px] flex items-center justify-center text-black z-10" style={uiStyles.accentShell}>
                        {/* 兼容 AI 的返回数据（纯字符串）和本地数据 */}
                        {day.iconName ? <DynamicIcon name={day.iconName} size={28}/> : (day.icon || <MapIcon size={28}/>)}
                      </div>
                      <div className="mt-4">
                        <h3 className="text-lg font-black text-black mb-2 border-b-2 border-slate-900/70 inline-block pb-1">{day.title}</h3>
                        <p className="text-sm font-medium text-slate-600 leading-relaxed p-3 rounded-[18px] border whitespace-pre-line" style={uiStyles.fieldShell}>{day.desc}</p>
                        {day.hotel && (
                          <div className="mt-2 flex items-start gap-1.5 text-xs font-medium text-slate-500">
                            <BedDouble size={14} className="mt-0.5 shrink-0 text-[#8b5cf6]"/>
                            <span>{day.hotel}</span>
                          </div>
                        )}
                        {day.highlights && day.highlights.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {day.highlights.map((h, i) => (
                              <span key={i} className="text-xs font-semibold text-black px-2 py-1 rounded-full border" style={uiStyles.accentShell}>⭐ {h}</span>
                            ))}
                          </div>
                        )}
                        {day.cost && (
                          <div className="mt-2 text-xs font-black text-[#059669] flex items-center gap-1">
                            <Wallet size={14}/>{day.cost}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>

            <div className="px-6 mt-2 mb-8 flex flex-col gap-3">
              <button
                onClick={() => window.open(buildFlightUrl(departure.nameEn, selectedDest.nameEn, days), '_blank')}
                className="w-full py-3.5 bg-[#38bdf8] hover:bg-[#0ea5e9] text-black text-lg font-black uppercase rounded-2xl border-4 border-black shadow-[6px_6px_0_0_#000] active:translate-y-1.5 transition-all flex justify-center items-center gap-2"
              >
                <Plane size={24} strokeWidth={3}/> {ui.flightButton}
              </button>
              <p className="text-[10px] text-slate-400 font-bold text-center -mt-1">{ui.googleFlightsCaption} · {getPlaceName(departure)} → {getPlaceName(selectedDest)} · {isEnglish ? `${days} days round trip` : `${days}天往返`}</p>

              <button
                onClick={() => window.open(buildHotelUrl(selectedDest.nameEn, days), '_blank')}
                className="w-full py-3.5 bg-[#4ade80] hover:bg-[#22c55e] text-black text-lg font-black uppercase rounded-2xl border-4 border-black shadow-[6px_6px_0_0_#000] active:translate-y-1.5 transition-all flex justify-center items-center gap-2"
              >
                <BedDouble size={24} strokeWidth={3}/> {ui.hotelButton}
              </button>
              <p className="text-[10px] text-slate-400 font-bold text-center -mt-1">{ui.bookingCaption} · {getPlaceName(selectedDest)} · {isEnglish ? `${days - 1} nights` : `${days - 1}晚`}</p>

              {/* Save Trip Button */}
              {user ? (
                <button
                  onClick={handleSaveTrip}
                  disabled={isSaving}
                  className={`w-full py-3.5 ${saveSuccess ? 'bg-[#10b981]' : isSaving ? 'bg-gray-400' : 'bg-[#a855f7] hover:bg-[#9333ea]'} text-white text-lg font-black uppercase rounded-2xl border-4 border-black shadow-[6px_6px_0_0_#000] active:translate-y-1.5 transition-all flex justify-center items-center gap-2`}
                >
                  {saveSuccess ? <><Heart size={24} strokeWidth={3}/> {ui.saved}</> : isSaving ? <><Loader2 size={24} className="animate-spin"/> {ui.saving}</> : <><BookmarkPlus size={24} strokeWidth={3}/> {ui.saveTrip}</>}
                </button>
              ) : (
                <div className="flex gap-2">
                <button
                  onClick={() => handleLogin('google')}
                  className="flex-1 py-3.5 bg-white hover:bg-[#f1f5f9] text-black text-sm font-black uppercase rounded-2xl border-4 border-black shadow-[6px_6px_0_0_#000] active:translate-y-1.5 transition-all flex justify-center items-center gap-2"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                  {ui.signInGoogle}
                </button>
                <button
                  onClick={() => handleLogin('github')}
                  className="flex-1 py-3.5 bg-[#1e293b] hover:bg-black text-white text-sm font-black uppercase rounded-2xl border-4 border-black shadow-[6px_6px_0_0_#000] active:translate-y-1.5 transition-all flex justify-center items-center gap-2"
                >
                  <Github size={20} strokeWidth={3}/> {isEnglish ? 'GitHub' : 'GitHub'}
                </button>
              </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ===== My Trips Modal ===== */}
      {showMyTrips && (
        <div onWheel={(e) => e.stopPropagation()} className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-[480px] max-h-[80vh] bg-white border-8 border-black rounded-3xl shadow-[15px_15px_0_0_#a855f7] overflow-hidden flex flex-col">
            <div className="bg-[#a855f7] border-b-8 border-black p-6 flex items-center justify-between shrink-0">
              <div>
                <h2 className="text-2xl font-black text-black uppercase tracking-widest bg-white inline-block px-3 py-1 border-4 border-black shadow-[4px_4px_0_0_#000] transform -rotate-2">{ui.myTripsTitle}</h2>
                <p className="text-xs font-bold text-white mt-2">{ui.savedTripsCount(savedTrips.length)}</p>
              </div>
              <button onClick={() => setShowMyTrips(false)} className="p-2 bg-white border-4 border-black rounded-full text-black hover:bg-[#fbbf24] transition-colors shadow-[4px_4px_0_0_#000] active:translate-y-1 active:shadow-none"><X size={24} strokeWidth={4}/></button>
            </div>
            <div className="p-6 overflow-y-auto flex-1 space-y-4">
              {isLoadingTrips ? (
                <div className="flex flex-col items-center justify-center py-16 gap-4">
                  <Loader2 size={40} className="animate-spin text-[#a855f7]" strokeWidth={3}/>
                  <p className="text-sm font-bold text-slate-500">{ui.loading}</p>
                </div>
              ) : savedTrips.length === 0 ? (
                <div className="text-center py-16">
                  <div className="text-6xl mb-4">🗺️</div>
                  <p className="text-lg font-black text-black mb-2">{ui.noSavedTrips}</p>
                  <p className="text-sm font-bold text-slate-500">{ui.noSavedTripsDesc}</p>
                </div>
              ) : (
                savedTrips.map(trip => (
                  <div key={trip.id} className="bg-[#f8fafc] border-4 border-black rounded-2xl p-4 shadow-[4px_4px_0_0_#000] hover:-translate-y-0.5 transition-transform">
                    <div className="flex justify-between items-start mb-2">
                      <div className="flex-1 cursor-pointer" onClick={() => handleLoadSavedTrip(trip)}>
                        <h3 className="text-base font-black text-black">{trip.title || `${trip.departure} → ${trip.destination}`}</h3>
                        <div className="flex gap-2 mt-1 flex-wrap">
                          <span className="text-[10px] font-bold bg-[#e0e7ff] text-slate-700 px-2 py-0.5 rounded border border-slate-300">{isEnglish ? `${trip.days} days` : `${trip.days}天`}</span>
                          <span className="text-[10px] font-bold bg-[#dcfce7] text-slate-700 px-2 py-0.5 rounded border border-slate-300">{getTravelStyleName(trip.style) || trip.style}</span>
                          <span className="text-[10px] font-bold text-slate-400">{new Date(trip.created_at).toLocaleDateString(isEnglish ? 'en-US' : 'zh-CN')}</span>
                        </div>
                      </div>
                      <div className="flex gap-1.5 shrink-0 ml-2">
                        <button onClick={() => copyShareLink(trip.share_id)} className="p-1.5 bg-[#38bdf8] border-2 border-black rounded-lg hover:bg-[#0ea5e9] transition-colors shadow-[2px_2px_0_0_#000] active:translate-y-0.5" title={ui.copyShare}>
                          <Share2 size={14} strokeWidth={3} className="text-white"/>
                        </button>
                        <button onClick={() => handleDeleteTrip(trip.id)} className="p-1.5 bg-[#f87171] border-2 border-black rounded-lg hover:bg-[#ef4444] transition-colors shadow-[2px_2px_0_0_#000] active:translate-y-0.5" title={ui.delete}>
                          <Trash2 size={14} strokeWidth={3} className="text-white"/>
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {showBlindBox && (
        <div 
          onWheel={(e) => e.stopPropagation()}
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
        >
          <div className="w-[400px] bg-white border-8 border-black rounded-3xl shadow-[15px_15px_0_0_#f472b6] p-8 text-center relative overflow-hidden animate-in zoom-in-90 duration-300">
            <div className="absolute inset-0 opacity-10 pointer-events-none" style={{ backgroundImage: 'radial-gradient(#000 2px, transparent 2px)', backgroundSize: '16px 16px' }}></div>
            
            <button onClick={() => !isShuffling && setShowBlindBox(false)} className="absolute top-4 right-4 p-2 bg-white border-4 border-black rounded-full text-black hover:bg-[#f87171] transition-colors shadow-[4px_4px_0_0_#000] active:translate-y-1 z-20">
              <X size={20} strokeWidth={4} />
            </button>

            <h2 className="text-3xl font-black text-black tracking-tight uppercase mb-2 relative z-10">
              {ui.blindBoxTitle}<br/>{ui.blindBoxTitleAccent}
            </h2>
            <p className="text-sm font-bold text-slate-500 mb-8 relative z-10">{ui.blindBoxSubtitle}</p>

            <div className="flex justify-center gap-4 mb-8 relative z-10">
               <div className="bg-[#e0e7ff] border-4 border-black rounded-xl px-4 py-2 shadow-[4px_4px_0_0_#000]">
                  <span className="block text-[10px] font-black text-slate-500 uppercase">{ui.budgetShort}</span>
                  <span className="text-lg font-black text-[#ec4899]">¥{budget.toLocaleString()}</span>
               </div>
               <div className="bg-[#dcfce7] border-4 border-black rounded-xl px-4 py-2 shadow-[4px_4px_0_0_#000]">
                  <span className="block text-[10px] font-black text-slate-500 uppercase">{ui.daysShort}</span>
                  <span className="text-lg font-black text-black">{isEnglish ? `${days} days` : `${days} 天`}</span>
               </div>
               <div className="bg-[#fef08a] border-4 border-black rounded-xl px-4 py-2 shadow-[4px_4px_0_0_#000] flex items-center">
                  <span className="text-2xl">{TRAVEL_STYLES.find(s=>s.id===travelStyle)?.icon}</span>
               </div>
            </div>

            {isShuffling && (
              <div className="bg-black text-white border-4 border-black rounded-2xl py-6 mb-8 relative z-10 overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-[shimmer_0.5s_infinite]"></div>
                <div className="text-6xl mb-2 animate-bounce">{shuffleDest.icon}</div>
                <div className="text-xl font-black tracking-widest">{getPlaceName(shuffleDest)}</div>
              </div>
            )}

            {!isShuffling && (
               <button onClick={triggerBlindBox} className="w-full py-4 bg-[#fcd34d] hover:bg-[#fbbf24] text-black text-2xl font-black uppercase rounded-2xl border-4 border-black shadow-[8px_8px_0_0_#000] active:translate-y-2 active:shadow-none transition-all flex items-center justify-center gap-3 relative z-10">
                  <Flame size={28} strokeWidth={4}/> {ui.drawDestination}
               </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
