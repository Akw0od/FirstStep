import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Wallet, Calendar, User, X, Sparkles,
  Map as MapIcon, Coffee, Camera, Plane, ChevronRight, Compass, Sunrise, Moon,
  Flame, Utensils, Store, Ticket, ShoppingBag, Gamepad2, Music, Waves,
  ZoomIn, ZoomOut, Dices, Loader2, BedDouble
} from 'lucide-react';
import staticItineraries from './staticItineraries.json';

const ICON_MAP = {
  Coffee, Camera, Plane, Compass, Sunrise, Moon,
  Flame, Utensils, Store, Ticket, ShoppingBag, Gamepad2, Music, Waves, MapIcon, BedDouble
};

const DynamicIcon = ({ name, size = 24 }) => {
  const IconComponent = ICON_MAP[name] || MapIcon;
  return <IconComponent size={size} />;
};

// --- 地球 3D 数学投影核心函数 ---
const BASE_RADIUS = 300; 
const DEG2RAD = Math.PI / 180;

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

const estimateFlightCost = (lon1, lat1, lon2, lat2) => {
  if (lon1 === lon2 && lat1 === lat2) return 500; 
  const dist = calculateDistance(lon1, lat1, lon2, lat2);
  let cost = 800 + dist * 0.6; 
  if (Math.abs(lon1 - lon2) > 90) cost += 2000; 
  return Math.round(cost / 100) * 100; 
};

const DEPARTURE_CITIES = [
  { id: 'dep_bj', name: '北京', lon: 116.4, lat: 39.9, icon: '🐼' },
  { id: 'dep_sh', name: '上海', lon: 121.47, lat: 31.23, icon: '🏙️' }, 
  { id: 'dep_gz', name: '广州', lon: 113.26, lat: 23.13, icon: '🥠' }, 
  { id: 'dep_ny', name: '纽约', lon: -74.0, lat: 40.7, icon: '🗽' },
  { id: 'dep_la', name: '洛杉矶', lon: -118.2, lat: 34.0, icon: '🌴' },
  { id: 'dep_lon', name: '伦敦', lon: -0.1, lat: 51.5, icon: '💂' }
];

const DESTINATIONS = [
  { id: 'th', name: '曼谷, 泰国', lon: 100.5, lat: 13.7, baseCost: 3500, daily: 500, icon: '🛺', type: 'food', desc: '热带街头美食大爆炸！高性价比的吃货天堂。' },
  { id: 'jp', name: '东京, 日本', lon: 139.6, lat: 35.6, baseCost: 6500, daily: 800, icon: '🍣', type: 'culture', desc: '二次元发源地！拉面、霓虹灯与疯狂购物。' },
  { id: 'hnl', name: '夏威夷', lon: -157.8, lat: 21.3, baseCost: 11000, daily: 1600, icon: '🏄', type: 'beach', desc: 'Aloha！草裙舞与活火山的热情碰撞。' },
  { id: 'las', name: '拉斯维加斯', lon: -115.1, lat: 36.1, baseCost: 8000, daily: 1500, icon: '🎰', type: 'urban', desc: '罪恶之城！赌场、豪华自助与世界级大秀。' },
  { id: 'sfo', name: '旧金山', lon: -122.4, lat: 37.7, baseCost: 10000, daily: 1100, icon: '🌉', type: 'culture', desc: '金门大桥与陡峭街道，科技与文艺的交汇点。' },
  { id: 'sea', name: '西雅图', lon: -122.3, lat: 47.6, baseCost: 9000, daily: 1100, icon: '☕', type: 'urban', desc: '星巴克故乡，被雨水与咖啡香气浸泡的翡翠之城。' },
  { id: 'gcn', name: '大峡谷', lon: -112.1, lat: 36.0, baseCost: 7000, daily: 800, icon: '🏜️', type: 'nature', desc: '地球上最震撼的裂痕，大自然的鬼斧神工。' },
  { id: 'ysnp', name: '黄石国家公园', lon: -110.5, lat: 44.4, baseCost: 9000, daily: 1200, icon: '🐻', type: 'nature', desc: '间歇泉与野生动物天堂，真正的西部荒野。' },
  { id: 'mia', name: '迈阿密', lon: -80.1, lat: 25.7, baseCost: 9500, daily: 1300, icon: '🦩', type: 'beach', desc: '阳光、沙滩、拉丁风情与彻夜狂欢。' },
  { id: 'chi', name: '芝加哥', lon: -87.6, lat: 41.8, baseCost: 8500, daily: 1000, icon: '🍕', type: 'urban', desc: '深盘披萨与壮丽天际线，风之城的魅力。' },
  { id: 'msy', name: '新奥尔良', lon: -90.0, lat: 29.9, baseCost: 7500, daily: 900, icon: '🎷', type: 'culture', desc: '爵士乐的故乡，巫毒文化与绝妙的南方美食。' }
];

const VISA_RULES = {
  CN: { th: { status: 'free', label: '免签' }, jp: { status: 'visa', label: '办签' }, fr: { status: 'visa', label: '申根' }, id: { status: 'voa', label: '落地' }, kr: { status: 'free', label: '免签' }, au: { status: 'visa', label: '办签' }, ny: { status: 'visa', label: '美签' }, yvr: { status: 'visa', label: '加签' }, cun: { status: 'visa', label: '美签' }, hnl: { status: 'visa', label: '美签' }, las: { status: 'visa', label: '美签' }, sfo: { status: 'visa', label: '美签' }, sea: { status: 'visa', label: '美签' }, gcn: { status: 'visa', label: '美签' }, ysnp: { status: 'visa', label: '美签' }, mia: { status: 'visa', label: '美签' }, chi: { status: 'visa', label: '美签' }, msy: { status: 'visa', label: '美签' } },
  US: { th: { status: 'free', label: '免签' }, jp: { status: 'free', label: '免签' }, fr: { status: 'free', label: '免签' }, id: { status: 'voa', label: '落地' }, kr: { status: 'free', label: '免签' }, au: { status: 'eta', label: 'ETA' }, ny: { status: 'free', label: '国内' }, yvr: { status: 'free', label: '免签' }, cun: { status: 'free', label: '免签' }, hnl: { status: 'free', label: '国内' }, las: { status: 'free', label: '国内' }, sfo: { status: 'free', label: '国内' }, sea: { status: 'free', label: '国内' }, gcn: { status: 'free', label: '国内' }, ysnp: { status: 'free', label: '国内' }, mia: { status: 'free', label: '国内' }, chi: { status: 'free', label: '国内' }, msy: { status: 'free', label: '国内' } }
};

const TRAVEL_STYLES = [
  { id: 'hardcore', name: '特种兵打卡', icon: '🏃' },
  { id: 'chill', name: '佛系休闲党', icon: '🍵' },
  { id: 'resort', name: '度假全躺平', icon: '🛏️' },
  { id: 'outdoor', name: '户外狂人', icon: '🧗' }
];

const DEST_SPECIFIC_ACTIVITIES = {
  sea: { hardcore: [{ t: '派克市场暴走', d: '早上看飞鱼吃第一家星巴克，疯狂暴走！', icon: <MapIcon size={24}/> }] },
  hnl: { resort: [{ t: '威基基海滨奢华瘫', d: '包下酒店最前排的沙滩帐篷，一动不动地躺着。', icon: <Moon size={24}/> }] },
  las: { hardcore: [{ t: '长街不夜城暴走', d: '强刷所有主题酒店，看太阳马戏团大秀！', icon: <Ticket size={24}/> }] },
  sfo: { chill: [{ t: '叮当车与九曲花街', d: '挂在复古的叮当车外面吹风，去九曲花街看花。', icon: <Camera size={24}/> }] }
};

const GENERIC_STYLE_ACTIVITIES = {
  hardcore: [{ t: '极限暴走挑战', d: '不管多累，脚底磨出水泡也要硬撑着把打卡点刷完！', icon: <Flame size={24}/> }],
  chill: [{ t: '漫无目的瞎溜达', d: '把所有的攻略和地图全扔掉，走到哪算哪。', icon: <MapIcon size={24}/> }],
  resort: [{ t: '酒店设施大扫荡', d: '坚决不出门！去无边泳池拍照，榨干房费的每一分价值。', icon: <Sparkles size={24}/> }],
  outdoor: [{ t: '租个摩托去野区', d: '搞一辆充满划痕的摩托车，向荒郊野外一路狂奔！', icon: <Compass size={24}/> }]
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

export default function App() {
  const [budget, setBudget] = useState(30000); 
  const [days, setDays] = useState(5);
  const [passport, setPassport] = useState('US');
  const [travelStyle, setTravelStyle] = useState('chill');
  const [departureId, setDepartureId] = useState('dep_ny');
  
  const [zoom, setZoom] = useState(1.2); 
  const currentRadius = BASE_RADIUS * zoom;

  const [aiItineraries, setAiItineraries] = useState({});
  const [isAILoading, setIsAILoading] = useState(false);
  const [apiError, setApiError] = useState(null);

  const [showBlindBox, setShowBlindBox] = useState(false);
  const [isShuffling, setIsShuffling] = useState(false);
  const [shuffleDest, setShuffleDest] = useState(DESTINATIONS[0]);

  const ALL_PLACES = useMemo(() => [...DEPARTURE_CITIES, ...DESTINATIONS], []);
  const departure = useMemo(() => ALL_PLACES.find(d => d.id === departureId), [departureId, ALL_PLACES]);
  
  const [selectedDest, setSelectedDest] = useState(null);
  const [showItinerary, setShowItinerary] = useState(false);

  const [popupOffset, setPopupOffset] = useState({ x: 0, y: 0 });
  const [isDraggingPopup, setIsDraggingPopup] = useState(false);
  const dragPopupStart = useRef({ x: 0, y: 0, initOffsetX: 0, initOffsetY: 0 });

  const [rotation, setRotation] = useState({ lon: -100, lat: 40 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, lon: 0, lat: 0 });
  const reqFrame = useRef(null);
  
  const [mapLines, setMapLines] = useState([]);
  const [isMapLoading, setIsMapLoading] = useState(true);

  useEffect(() => {
    fetch('https://cdn.jsdelivr.net/gh/holtzy/D3-graph-gallery@master/DATA/world.geojson')
      .then(r => r.json())
      .then(data => {
        const lines = [];
        data.features.forEach(feature => {
          if (!feature.geometry) return;
          const type = feature.geometry.type;
          const coords = feature.geometry.coordinates;
          if (type === 'Polygon') lines.push(coords[0]);
          else if (type === 'MultiPolygon') coords.forEach(poly => lines.push(poly[0]));
        });
        setMapLines(lines);
        setIsMapLoading(false);
      })
      .catch((e) => {
        console.error("地图轮廓加载失败:", e);
        setIsMapLoading(false);
      });
  }, []);

  const calculateTotalCost = useCallback((dest, tripDays) => {
    const flightCost = estimateFlightCost(departure.lon, departure.lat, dest.lon, dest.lat);
    const livingCost = (tripDays - 1) * dest.daily; 
    return flightCost + livingCost;
  }, [departure]);

  // --- 先调 DeepSeek API 实时生成，失败则 fallback 到静态数据 ---
  const handleGenerateItinerary = async () => {
    if (isAILoading) return;
    setShowItinerary(true);
    setApiError(null);
    if (!selectedDest) return;

    const cacheKey = `${selectedDest.id}-${days}-${travelStyle}`;
    if (aiItineraries[cacheKey]) return;

    setIsAILoading(true);

    // 1) 尝试调用 DeepSeek API
    try {
      const totalBudget = calculateTotalCost(selectedDest, days);
      const res = await fetch('/api/generate-itinerary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          destination: selectedDest.name,
          style: travelStyle,
          days,
          budget: totalBudget,
          departure: departure.name
        })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.itinerary && data.itinerary.length > 0) {
          setAiItineraries(prev => ({ ...prev, [cacheKey]: data.itinerary }));
          setIsAILoading(false);
          return;
        }
      }
      // API 返回非 ok，进入 fallback
    } catch (e) {
      // 网络错误等，进入 fallback
    }

    // 2) Fallback: 使用预生成的静态数据
    const staticKey = `${selectedDest.id}-${travelStyle}`;
    const fullItinerary = staticItineraries[staticKey];

    if (fullItinerary && fullItinerary.length > 0) {
      const sliced = fullItinerary.slice(0, days).map((day, i) => ({
        ...day,
        day: i + 1
      }));
      if (days < fullItinerary.length && fullItinerary.length >= 14) {
        const lastDay = { ...fullItinerary[fullItinerary.length - 1], day: days };
        sliced[sliced.length - 1] = lastDay;
      }
      setAiItineraries(prev => ({ ...prev, [cacheKey]: sliced }));
      setApiError('AI 实时生成暂时不可用，已为你加载精选行程');
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

  const handleMarkerClick = (dest) => {
    animateToTarget(dest.lon, dest.lat);
    setShowItinerary(false);
    setSelectedDest(dest);
    setPopupOffset({ x: 0, y: 0 }); 
  };

  const triggerBlindBox = () => {
    setIsShuffling(true);
    const affordableDests = DESTINATIONS.filter(d => calculateTotalCost(d, days) <= budget);
    const targetPool = affordableDests.length > 0 ? affordableDests : DESTINATIONS;
    
    let count = 0;
    const interval = setInterval(() => {
      setShuffleDest(DESTINATIONS[Math.floor(Math.random() * DESTINATIONS.length)]);
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

  const itineraryDays = useMemo(() => {
    if (!selectedDest) return [];
    const estTotalCost = calculateTotalCost(selectedDest, days);
    const isLuxury = budget > estTotalCost * 1.5; 
    const isBudget = budget < estTotalCost * 1.1; 
    const cityName = selectedDest.name.split(',')[0];
    
    const arrivalText = isLuxury ? `💰土豪驾到：高级黑车司机在机场举牌接机，直接入驻${cityName}最顶级的奢华五星套房或私人别墅，开香槟！` 
      : isBudget ? `🎒极限穷游：提着破旧行李箱挤上了便宜的机场大巴，入驻${cityName}一家评分极高的神仙青旅，准备干饭！`
      : `🚕平稳落地：搭乘出租车一路看风景前往市区，办理入住一家极具特色的高分精品酒店，放下行李出发。`;
    const departText = isLuxury ? "专车送至机场VIP通道，在头等舱休息室吃着高级茶点，买几个名牌包，完美结束这趟奢华之旅。" 
      : isBudget ? "去街角便利店买点便宜零食，狂奔去挤公交前往机场，翻看着一路拍下的照片准备登机回家打工。"
      : "上午再去市中心采买一波当地特色伴手礼，随后前往机场办理退税与托运，准备返程。";

    const specificPool = DEST_SPECIFIC_ACTIVITIES[selectedDest.id]?.[travelStyle] || [];
    const genericStylePool = GENERIC_STYLE_ACTIVITIES[travelStyle] || [];
    const genericBasePool = [{ t: '压马路乱逛', d: '用双脚丈量城市', iconName: 'Compass' }];
    const richPool = [...specificPool, ...genericStylePool, ...genericBasePool];

    const it = [];
    for (let i = 1; i <= days; i++) {
      if (i === 1) it.push({ day: i, title: `BOOM! 空降${cityName}`, desc: arrivalText, iconName: 'Plane' });
      else if (i === days) it.push({ day: i, title: "打包牛马回家", desc: departText, iconName: 'Wallet' });
      else {
        const activity = richPool[(i - 2) % richPool.length];
        it.push({ day: i, title: activity.t, desc: activity.d, iconName: activity.iconName || 'MapIcon', icon: activity.icon });
      }
    }
    return it;
  }, [selectedDest, days, budget, travelStyle, calculateTotalCost]);

  return (
    <div 
      className="relative w-full h-screen min-h-[700px] bg-[#fef08a] overflow-hidden font-sans text-slate-900 select-none"
      onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp} onWheel={handleWheel}
      style={{ backgroundImage: 'radial-gradient(#eab308 2px, transparent 2px)', backgroundSize: '24px 24px' }}
    >
      <style>
        {`
          @keyframes rainbow-flash {
            0% { background-color: #ef4444; border-color: #fff; transform: rotate(-2deg) scale(1); }
            20% { background-color: #f97316; border-color: #000; transform: rotate(2deg) scale(1.05); }
            40% { background-color: #eab308; border-color: #fff; transform: rotate(-2deg) scale(1); }
            60% { background-color: #22c55e; border-color: #000; transform: rotate(2deg) scale(1.05); }
            80% { background-color: #3b82f6; border-color: #fff; transform: rotate(-2deg) scale(1); }
            100% { background-color: #a855f7; border-color: #000; transform: rotate(2deg) scale(1.05); }
          }
          .btn-crazy-rainbow {
            animation: rainbow-flash 0.6s infinite alternate ease-in-out !important;
            color: white !important;
            text-shadow: 2px 2px 0px #000 !important;
          }
          .btn-crazy-rainbow:hover {
            animation-duration: 0.08s !important;
          }
        `}
      </style>

      <div className="absolute inset-0 flex items-center justify-center">
        <svg viewBox="-400 -400 800 800" className={`w-[750px] h-[750px] overflow-visible cursor-grab active:cursor-grabbing transition-transform ${isDragging ? 'scale-[1.02]' : 'scale-100'}`} onMouseDown={handleMouseDown}>
          <circle r={currentRadius} fill="#38bdf8" stroke="#000" strokeWidth="8" />
          <path d={`M -${currentRadius*0.6} -${currentRadius*0.6} A ${currentRadius} ${currentRadius} 0 0 1 0 -${currentRadius} A ${currentRadius*0.8} ${currentRadius*0.8} 0 0 0 -${currentRadius*0.6} -${currentRadius*0.6} Z`} fill="#fff" opacity="0.3" />

          <g>
            {(isMapLoading || coastLines.length === 0) 
              ? graticules.map((d, i) => <path key={i} d={d} fill="none" stroke="#0ea5e9" strokeWidth="3" strokeDasharray="10,10" />)
              : coastLines.map((d, i) => <path key={i} d={d} fill="none" stroke="#1e293b" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />)}
          </g>
          
          <circle r={currentRadius} fill="none" stroke="rgba(0,0,0,0.15)" strokeWidth={40 * zoom} strokeDasharray={`${Math.PI*currentRadius} ${Math.PI*currentRadius}`} transform="rotate(-45)" />

          {selectedDest && (selectedDest.lon !== departure.lon || selectedDest.lat !== departure.lat) && (
            <path d={getGreatCirclePath(departure.lon, departure.lat, selectedDest.lon, selectedDest.lat, rotation.lon, rotation.lat, currentRadius)}
              fill="none" stroke="#ec4899" strokeWidth="6" strokeDasharray="12,12" strokeLinecap="round" className="drop-shadow-[4px_4px_0_rgba(0,0,0,1)]">
              <animate attributeName="stroke-dashoffset" from="100" to="0" dur="1.5s" repeatCount="indefinite" />
            </path>
          )}

          {(() => {
            const depProj = project(departure.lon, departure.lat, rotation.lon, rotation.lat, currentRadius);
            if (!depProj.visible) return null;
            return (
              <g transform={`translate(${depProj.x}, ${depProj.y})`} className="pointer-events-none">
                <foreignObject x="-30" y="-30" width="60" height="60" className="overflow-visible">
                  <div className="w-full h-full flex items-center justify-center relative"><ComicBurst color="#fff" /><span className="relative z-10 text-2xl drop-shadow-sm">{departure.icon}</span></div>
                </foreignObject>
                <text y="42" textAnchor="middle" fill="#000" fontSize="16" fontWeight="900" style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: '5px' }}>{departure.name}</text>
              </g>
            );
          })()}

          {DESTINATIONS.map(dest => {
            const p = project(dest.lon, dest.lat, rotation.lon, rotation.lat, currentRadius);
            if (!p.visible) return null;
            const estCost = calculateTotalCost(dest, days);
            const isAffordable = estCost <= budget;
            const isSelected = selectedDest?.id === dest.id;

            return (
              <g key={dest.id} transform={`translate(${p.x}, ${p.y})`} className="cursor-pointer group" onClick={(e) => { e.stopPropagation(); handleMarkerClick(dest); }}>
                <foreignObject x="-40" y="-75" width="80" height="35" className={`overflow-visible transition-all duration-200 ${isSelected ? 'opacity-100 -translate-y-2' : 'opacity-0 group-hover:opacity-100 group-hover:-translate-y-2 pointer-events-none'}`}>
                  <div className={`flex items-center justify-center w-full h-8 border-4 border-black rounded shadow-[4px_4px_0_0_#000] text-xs font-black ${isAffordable ? 'bg-[#4ade80] text-black' : 'bg-[#f87171] text-black'}`}>¥{estCost}</div>
                </foreignObject>
                <foreignObject x="-30" y="-30" width="60" height="60" className="overflow-visible">
                  <div className="w-full h-full flex items-center justify-center relative transition-transform duration-200">
                    {isSelected ? (
                      <><ComicBurst color="#fcd34d" className="scale-125 transition-transform" /><span className="relative z-10 text-3xl transition-transform scale-110 drop-shadow-sm">{dest.icon}</span></>
                    ) : isAffordable ? (
                      <div className="relative w-12 h-12 flex items-center justify-center group-hover:scale-110 transition-transform"><ComicBox color="#a7f3d0" className="rotate-3 group-hover:rotate-12 transition-transform" /><span className="relative z-10 text-xl">{dest.icon}</span></div>
                    ) : (
                      <div className="relative w-12 h-12 flex items-center justify-center grayscale group-hover:grayscale-0 group-hover:scale-110 transition-all"><ComicBox color="#cbd5e1" className="-rotate-3 group-hover:rotate-0 transition-transform" /><span className="relative z-10 text-xl">{dest.icon}</span></div>
                    )}
                  </div>
                </foreignObject>
              </g>
            );
          })}
        </svg>
      </div>

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

      <button 
        onWheel={(e) => e.stopPropagation()}
        onClick={() => setShowBlindBox(true)} 
        className="absolute right-6 bottom-8 px-6 py-4 btn-crazy-rainbow border-4 border-black rounded-2xl shadow-[8px_8px_0_0_#000] active:translate-y-2 active:shadow-none flex items-center justify-center gap-3 z-20 pointer-events-auto group origin-center"
      >
        <Dices size={32} strokeWidth={3} className="text-white group-hover:rotate-12 transition-transform"/>
        <span className="text-xl font-black uppercase tracking-wider text-white">🎲 盲盒旅行</span>
      </button>

      <div 
        onWheel={(e) => e.stopPropagation()}
        className="absolute top-6 left-6 w-80 bg-white p-6 rounded-2xl border-4 border-black shadow-[8px_8px_0_0_#000] z-20 pointer-events-auto"
      >
        <div className="flex items-center gap-3 mb-5">
          <div className="p-2 bg-[#f472b6] border-4 border-black rounded-xl text-black shadow-[4px_4px_0_0_#000]"><Compass size={28} strokeWidth={3}/></div>
          <div><h1 className="text-2xl font-black text-black tracking-tight leading-none uppercase">MAP BOOM!</h1><p className="text-[10px] font-bold text-slate-500 mt-1 uppercase">Toon Travel AI Engine</p></div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-xs font-black text-black uppercase mb-1 flex items-center gap-1.5"><MapIcon size={14} strokeWidth={3} /> 从哪里起飞？</label>
            <select value={departureId} onChange={(e) => { setDepartureId(e.target.value); const newDep = ALL_PLACES.find(d => d.id === e.target.value); if(newDep) { animateToTarget(newDep.lon, newDep.lat); setZoom(1.5); } }} className="w-full p-2.5 bg-[#e0e7ff] border-4 border-black rounded-xl text-sm font-bold text-black focus:outline-none focus:ring-4 focus:ring-[#f472b6] shadow-[4px_4px_0_0_#000] cursor-pointer">
              <optgroup label="🌐 主要枢纽">{DEPARTURE_CITIES.map(c => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}</optgroup>
              <optgroup label="📍 所有地点">{DESTINATIONS.map(c => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}</optgroup>
            </select>
          </div>

          <div>
            <label className="text-xs font-black text-black uppercase mb-1 flex items-center gap-1.5"><Plane size={14} strokeWidth={3} /> 飞向哪里？</label>
            <select value={selectedDest?.id || ''} onChange={(e) => { const dest = ALL_PLACES.find(d => d.id === e.target.value); if(dest) handleMarkerClick(dest); }} className="w-full p-2.5 bg-[#fef08a] border-4 border-black rounded-xl text-sm font-bold text-black focus:outline-none focus:ring-4 focus:ring-[#f472b6] shadow-[4px_4px_0_0_#000] cursor-pointer">
              <option value="" disabled>🌍 点击地图或在此选择...</option>
              {ALL_PLACES.filter(c => c.id !== departureId).map(c => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
            </select>
          </div>

          <div>
            <label className="text-xs font-black text-black uppercase mb-2 flex items-center gap-1.5"><Sparkles size={14} strokeWidth={3}/> 选个姿势浪？</label>
            <div className="grid grid-cols-2 gap-2">
              {TRAVEL_STYLES.map(s => (
                <button key={s.id} onClick={() => setTravelStyle(s.id)} 
                  className={`py-2 px-1 text-[11px] font-black rounded-xl border-4 border-black transition-all duration-100 active:translate-y-1 active:shadow-none
                  ${travelStyle === s.id ? 'bg-[#fcd34d] text-black shadow-[4px_4px_0_0_#000]' : 'bg-white text-black hover:bg-slate-100 shadow-[2px_2px_0_0_#000]'}`}>
                  {s.icon} {s.name}
                </button>
              ))}
            </div>
          </div>

          <div className="pt-2 border-t-4 border-black">
            <div className="flex justify-between items-end mb-1">
              <label className="text-xs font-black text-black uppercase flex items-center gap-1.5"><Wallet size={14} strokeWidth={3}/> 弹药包(RMB)</label>
              <span className="text-[#ec4899] font-black text-lg bg-[#fce7f3] px-2 py-0.5 border-2 border-black rounded shadow-[2px_2px_0_0_#000]">¥{budget.toLocaleString()}</span>
            </div>
            <input type="range" min="5000" max="100000" step="5000" value={budget} onChange={(e) => setBudget(Number(e.target.value))} className="w-full h-4 bg-black rounded-full appearance-none cursor-pointer accent-[#22d3ee] shadow-[2px_2px_0_0_rgba(0,0,0,0.5)] outline-none mt-2"/>
          </div>

          <div>
            <label className="text-xs font-black text-black uppercase mb-2 flex items-center gap-1.5"><Calendar size={14} strokeWidth={3}/> 浪几天？</label>
            <div className="flex gap-2">
              {[3, 5, 7, 10, 14].map(d => (
                <button key={d} onClick={() => setDays(d)} className={`flex-1 py-1.5 text-sm font-black rounded-xl border-4 border-black transition-all duration-100 active:translate-y-1 active:shadow-none ${days === d ? 'bg-[#22d3ee] text-black shadow-[4px_4px_0_0_#000]' : 'bg-white text-black hover:bg-slate-100 shadow-[2px_2px_0_0_#000]'}`}>{d}</button>
              ))}
            </div>
          </div>

          <div className="pt-3 border-t-2 border-dashed border-slate-300">
            <label className="text-[10px] font-bold text-slate-500 uppercase mb-1 flex items-center gap-1"><User size={12} strokeWidth={2}/> 签证测算 (护照/绿卡)</label>
            <select value={passport} onChange={(e) => setPassport(e.target.value)} className="w-full p-1.5 bg-slate-50 border-2 border-slate-300 rounded-lg text-xs font-bold text-slate-600 focus:outline-none cursor-pointer hover:border-black transition-colors">
              <option value="CN">🇨🇳 中国大陆 (CN)</option><option value="US">🇺🇸 美国护照 (US)</option>
            </select>
          </div>
        </div>
      </div>

      {selectedDest && !showBlindBox && (
        <div 
          onWheel={(e) => e.stopPropagation()}
          className={`absolute bottom-6 left-1/2 w-96 bg-white p-1.5 rounded-2xl border-4 border-black shadow-[10px_10px_0_0_#000] z-30 pointer-events-auto
          ${isDraggingPopup ? 'transition-none cursor-grabbing' : 'transition-transform duration-300 cursor-grab'}`}
          style={{ transform: `translate(calc(-50% + ${popupOffset.x}px), calc(${showItinerary ? '150%' : '0px'} + ${popupOffset.y}px))` }}
          onMouseDown={handlePopupMouseDown}
        >
          <div className="w-16 h-2 bg-slate-200 border-2 border-black rounded-full mx-auto mb-1.5 pointer-events-none"></div>

          <div className="relative bg-[#fef08a] border-4 border-black rounded-xl p-5 overflow-hidden">
            <button onMouseDown={(e) => e.stopPropagation()} onClick={() => setSelectedDest(null)} className="absolute top-2 right-2 p-1.5 bg-white border-4 border-black rounded-full text-black hover:bg-[#f87171] transition-colors shadow-[2px_2px_0_0_#000] z-20 active:translate-y-1 active:shadow-none"><X size={16} strokeWidth={4} /></button>
            <div className="absolute -bottom-8 -right-4 text-8xl opacity-30 pointer-events-none">{selectedDest.icon}</div>
            
            <h2 className="text-3xl font-black text-black tracking-tight mb-3 uppercase relative z-10">{selectedDest.name}</h2>
            
            <div className="flex items-center gap-3 relative z-10 mb-4">
               <span className="px-3 py-1 bg-white border-4 border-black rounded-lg text-sm font-black shadow-[4px_4px_0_0_#000]">{days} DAYS</span>
               <span className={`px-3 py-1 rounded-lg text-sm font-black border-4 border-black shadow-[4px_4px_0_0_#000] uppercase ${VISA_RULES[passport][selectedDest.id]?.status === 'free' ? 'bg-[#4ade80]' : VISA_RULES[passport][selectedDest.id]?.status === 'voa' ? 'bg-[#facc15]' : 'bg-[#f87171]'}`}>{VISA_RULES[passport][selectedDest.id]?.label || '未知'}</span>
            </div>

            <div className="bg-white border-4 border-black rounded-xl p-4 shadow-[4px_4px_0_0_#000] relative z-10">
              <div className="flex justify-between items-end mb-2 border-b-4 border-black pb-2">
                <span className="font-black text-sm uppercase">总花费预估(含机票)</span>
                <span className={`text-2xl font-black ${calculateTotalCost(selectedDest, days) > budget ? 'text-[#ef4444]' : 'text-[#10b981]'}`}>¥{calculateTotalCost(selectedDest, days).toLocaleString()}</span>
              </div>
              
              <div className="flex justify-between items-center text-[10px] text-slate-500 font-bold mb-2">
                <span>✈️ 机票约: ¥{estimateFlightCost(departure.lon, departure.lat, selectedDest.lon, selectedDest.lat)}</span>
                <span>🏨 每日约: ¥{selectedDest.daily}</span>
              </div>
              
              <p className="text-sm font-bold text-slate-700 leading-tight pointer-events-none">{selectedDest.desc}</p>
            </div>

            <button disabled={isAILoading} onMouseDown={(e) => e.stopPropagation()} onClick={handleGenerateItinerary} className={`w-full mt-4 py-3 ${isAILoading ? 'bg-gray-400 cursor-not-allowed' : 'bg-[#a855f7] hover:bg-[#9333ea]'} text-white text-lg font-black uppercase rounded-xl border-4 border-black shadow-[4px_4px_0_0_#000] active:translate-y-1 active:shadow-none transition-all flex items-center justify-center gap-2 relative z-20`}>
              <Sparkles strokeWidth={3}/> 查看漫画行程指南！
            </button>
          </div>
        </div>
      )}

      <div 
        onWheel={(e) => e.stopPropagation()}
        className={`absolute top-0 right-0 w-[450px] h-full bg-[#f8fafc] border-l-8 border-black shadow-[-15px_0_0_0_rgba(0,0,0,1)] transition-transform duration-300 ease-out z-40 overflow-y-auto ${showItinerary ? 'translate-x-0' : 'translate-x-full'}`}
      >
        {selectedDest && (
          <div className="pb-10 relative">
            <div className="sticky top-0 z-10 bg-[#f472b6] border-b-8 border-black p-6 flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-black text-black uppercase tracking-widest bg-white inline-block px-3 py-1 border-4 border-black shadow-[4px_4px_0_0_#000] transform -rotate-2">BOOM! ITINERARY</h2>
                <div className="flex items-center gap-2 mt-3">
                  <span className="bg-black text-white px-2 py-0.5 rounded text-xs font-bold">{selectedDest.name.split(',')[0]}</span>
                  <span className="bg-[#fcd34d] text-black border-2 border-black px-2 py-0.5 rounded text-xs font-bold shadow-[2px_2px_0_0_#000]">{TRAVEL_STYLES.find(s=>s.id===travelStyle)?.icon} {TRAVEL_STYLES.find(s=>s.id===travelStyle)?.name}</span>
                </div>
              </div>
              <button onClick={() => setShowItinerary(false)} className="p-2 bg-white border-4 border-black rounded-full text-black hover:bg-[#fbbf24] transition-colors shadow-[4px_4px_0_0_#000] active:translate-y-1 active:shadow-none"><X size={24} strokeWidth={4} /></button>
            </div>

            <div className="p-6 space-y-6">
              {isAILoading ? (
                <div className="flex flex-col items-center justify-center py-20 gap-6">
                  <div className="relative">
                    <Loader2 size={48} className="animate-spin text-[#f472b6]" strokeWidth={3}/>
                    <div className="absolute inset-0 flex items-center justify-center"><Sparkles size={20} className="text-[#22d3ee] animate-pulse"/></div>
                  </div>
                  <div className="text-center">
                    <h3 className="text-xl font-black uppercase text-black mb-2">生成中...</h3>
                    <p className="text-sm font-bold text-slate-500">正在为你定制专属疯狂攻略！</p>
                  </div>
                </div>
              ) : (
                <>
                  {/* API 报错时展示漫画风错误提示框 */}
                  {apiError && (
                    <div className="bg-[#fee2e2] border-4 border-black rounded-xl p-4 mb-4 shadow-[4px_4px_0_0_#000] relative overflow-hidden">
                      <div className="absolute -top-4 -right-2 text-6xl opacity-20 transform rotate-12">💥</div>
                      <p className="font-black text-black text-lg mb-1 flex items-center gap-2"><Flame className="text-[#ef4444]" size={20}/> Oops! 魔法中断</p>
                      <p className="text-sm font-bold text-slate-700 leading-tight mb-3">{apiError}</p>
                      <button disabled={isAILoading} onClick={handleGenerateItinerary} className={`text-xs ${isAILoading ? 'bg-gray-300 cursor-not-allowed' : 'bg-white hover:bg-[#fcd34d]'} text-black px-4 py-2 rounded-lg border-2 border-black font-black active:translate-y-1 shadow-[2px_2px_0_0_#000] transition-colors`}>
                        {isAILoading ? '⏳ 重试中...' : '🔄 重新召唤 AI'}
                      </button>
                    </div>
                  )}

                  {/* 这里使用了短路逻辑：如果 AI 返回了数据就用 AI 的，否则回退使用本地自动计算的假行程 */}
                  {(aiItineraries[`${selectedDest?.id}-${days}-${travelStyle}`] || itineraryDays).map((day, idx) => (
                    <div key={idx} className={`relative bg-white border-4 border-black p-5 rounded-2xl shadow-[8px_8px_0_0_#000] transform hover:-translate-y-1 transition-transform ${idx % 2 === 0 ? 'rotate-1' : '-rotate-1'}`}>
                      <div className="absolute -top-4 -left-4 w-12 h-12 bg-[#22d3ee] border-4 border-black rounded-full shadow-[4px_4px_0_0_#000] flex items-center justify-center text-xl font-black z-10">{day.day}</div>
                      <div className="absolute -top-6 right-4 w-14 h-14 bg-[#facc15] border-4 border-black rounded-full shadow-[4px_4px_0_0_#000] flex items-center justify-center text-black z-10">
                        {/* 兼容 AI 的返回数据（纯字符串）和本地数据 */}
                        {day.iconName ? <DynamicIcon name={day.iconName} size={28}/> : (day.icon || <MapIcon size={28}/>)}
                      </div>
                      <div className="mt-4">
                        <h3 className="text-lg font-black text-black uppercase mb-2 border-b-4 border-black inline-block pb-1">{day.title}</h3>
                        <p className="text-sm font-bold text-slate-600 leading-relaxed bg-[#f1f5f9] p-3 rounded-xl border-2 border-black whitespace-pre-line">{day.desc}</p>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>

            <div className="px-6 mt-2 mb-8 flex flex-col gap-3">
              <button 
                onClick={() => window.open(`https://www.skyscanner.net/`, '_blank')} 
                className="w-full py-3.5 bg-[#38bdf8] hover:bg-[#0ea5e9] text-black text-lg font-black uppercase rounded-2xl border-4 border-black shadow-[6px_6px_0_0_#000] active:translate-y-1.5 transition-all flex justify-center items-center gap-2"
              >
                <Plane size={24} strokeWidth={3}/> 抢特价机票！
              </button>
              
              <button 
                onClick={() => window.open(`https://www.booking.com/`, '_blank')} 
                className="w-full py-3.5 bg-[#4ade80] hover:bg-[#22c55e] text-black text-lg font-black uppercase rounded-2xl border-4 border-black shadow-[6px_6px_0_0_#000] active:translate-y-1.5 transition-all flex justify-center items-center gap-2"
              >
                <BedDouble size={24} strokeWidth={3}/> 去预定酒店！
              </button>
            </div>
          </div>
        )}
      </div>

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
              不知道去哪？<br/>让 AI 替你决定！
            </h2>
            <p className="text-sm font-bold text-slate-500 mb-8 relative z-10">将根据你当前的弹药包与人设匹配：</p>

            <div className="flex justify-center gap-4 mb-8 relative z-10">
               <div className="bg-[#e0e7ff] border-4 border-black rounded-xl px-4 py-2 shadow-[4px_4px_0_0_#000]">
                  <span className="block text-[10px] font-black text-slate-500 uppercase">预算</span>
                  <span className="text-lg font-black text-[#ec4899]">¥{budget.toLocaleString()}</span>
               </div>
               <div className="bg-[#dcfce7] border-4 border-black rounded-xl px-4 py-2 shadow-[4px_4px_0_0_#000]">
                  <span className="block text-[10px] font-black text-slate-500 uppercase">天数</span>
                  <span className="text-lg font-black text-black">{days} 天</span>
               </div>
               <div className="bg-[#fef08a] border-4 border-black rounded-xl px-4 py-2 shadow-[4px_4px_0_0_#000] flex items-center">
                  <span className="text-2xl">{TRAVEL_STYLES.find(s=>s.id===travelStyle)?.icon}</span>
               </div>
            </div>

            {isShuffling && (
              <div className="bg-black text-white border-4 border-black rounded-2xl py-6 mb-8 relative z-10 overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-[shimmer_0.5s_infinite]"></div>
                <div className="text-6xl mb-2 animate-bounce">{shuffleDest.icon}</div>
                <div className="text-xl font-black tracking-widest">{shuffleDest.name}</div>
              </div>
            )}

            {!isShuffling && (
               <button onClick={triggerBlindBox} className="w-full py-4 bg-[#fcd34d] hover:bg-[#fbbf24] text-black text-2xl font-black uppercase rounded-2xl border-4 border-black shadow-[8px_8px_0_0_#000] active:translate-y-2 active:shadow-none transition-all flex items-center justify-center gap-3 relative z-10">
                  <Flame size={28} strokeWidth={4}/> 抽取目的地！
               </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}