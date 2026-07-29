import React, { useState, useMemo, useRef, useEffect } from 'react';
import { TrendingUp, TrendingDown, Minus, ChevronDown, Search, ArrowUpRight, ArrowDownRight } from 'lucide-react';

// Generate realistic 30-day mock price history for a product
function generatePriceHistory(basePrice, volatility = 0.08, trend = 0) {
  const today = new Date();
  const history = [];
  let price = basePrice * (1 + (Math.random() * 0.1 - 0.05)); // slight starting offset

  for (let i = 29; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    
    // Random walk with slight trend
    const change = (Math.random() - 0.48 + trend) * volatility * basePrice;
    price = Math.max(basePrice * 0.65, Math.min(basePrice * 1.45, price + change));
    
    history.push({
      date: date.toISOString().slice(0, 10),
      dateLabel: date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
      price: Math.round(price * 100) / 100,
    });
  }
  return history;
}

// Sparkline SVG mini chart
function SparkLine({ data, color, width = 120, height = 40 }) {
  const canvasRef = useRef(null);
  
  const prices = data.map(d => d.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;

  const points = prices.map((p, i) => {
    const x = (i / (prices.length - 1)) * width;
    const y = height - ((p - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  }).join(' ');

  const fillPoints = `0,${height} ${points} ${width},${height}`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      {/* Gradient fill */}
      <defs>
        <linearGradient id={`grad-${color.replace('#','')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polygon points={fillPoints} fill={`url(#grad-${color.replace('#','')})`} />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Last point dot */}
      {(() => {
        const lastX = width;
        const lastY = height - ((prices[prices.length - 1] - min) / range) * (height - 4) - 2;
        return <circle cx={lastX} cy={lastY} r="3" fill={color} stroke="white" strokeWidth="1.5" />;
      })()}
    </svg>
  );
}

// Expanded detail chart (taller, with date axis)
function DetailChart({ data, color, width = 300, height = 120 }) {
  const [hoverIndex, setHoverIndex] = useState(null);
  const svgRef = useRef(null);
  
  const prices = data.map(d => d.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;

  const pointsArr = prices.map((p, i) => ({
    x: (i / (prices.length - 1)) * width,
    y: height - 24 - ((p - min) / range) * (height - 32) - 4,
  }));

  const polylinePoints = pointsArr.map(p => `${p.x},${p.y}`).join(' ');
  const fillPoints = `0,${height - 24} ${polylinePoints} ${width},${height - 24}`;

  // X-axis labels: show every 5th day
  const xLabels = data.filter((_, i) => i % 5 === 0 || i === data.length - 1);

  const handlePointerMove = (e) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const idx = Math.round((relX / rect.width) * (prices.length - 1));
    setHoverIndex(Math.max(0, Math.min(idx, prices.length - 1)));
  };

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        width="100%"
        viewBox={`0 0 ${width} ${height}`}
        className="overflow-visible touch-none"
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoverIndex(null)}
      >
        <defs>
          <linearGradient id={`detail-grad-${color.replace('#','')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
          const y = height - 24 - pct * (height - 32) - 4;
          return <line key={pct} x1="0" y1={y} x2={width} y2={y} stroke="#e5e7eb" strokeWidth="0.5" strokeDasharray="4,4" />;
        })}
        
        <polygon points={fillPoints} fill={`url(#detail-grad-${color.replace('#','')})`} />
        <polyline
          points={polylinePoints}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Hover crosshair */}
        {hoverIndex !== null && (
          <>
            <line x1={pointsArr[hoverIndex].x} y1={0} x2={pointsArr[hoverIndex].x} y2={height - 24} stroke={color} strokeWidth="1" strokeDasharray="3,3" opacity="0.5" />
            <circle cx={pointsArr[hoverIndex].x} cy={pointsArr[hoverIndex].y} r="5" fill={color} stroke="white" strokeWidth="2" />
          </>
        )}

        {/* X-axis labels */}
        {xLabels.map((d, i) => {
          const origIdx = data.indexOf(d);
          const x = (origIdx / (prices.length - 1)) * width;
          return (
            <text key={i} x={x} y={height - 4} textAnchor="middle" fontSize="8" fill="#9ca3af" fontWeight="600">
              {d.dateLabel}
            </text>
          );
        })}
      </svg>
      
      {/* Hover tooltip */}
      {hoverIndex !== null && (
        <div
          className="absolute -top-8 bg-gray-900 text-white text-[10px] font-bold px-2 py-1 rounded-lg shadow-lg pointer-events-none whitespace-nowrap z-10"
          style={{ left: `${(hoverIndex / (prices.length - 1)) * 100}%`, transform: 'translateX(-50%)' }}
        >
          ₹{prices[hoverIndex]} · {data[hoverIndex]?.dateLabel}
        </div>
      )}
    </div>
  );
}

export default function PriceHistory({ products = [], categories = [] }) {
  const [expandedId, setExpandedId] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [timeRange, setTimeRange] = useState('30d');

  // Build price history map (memoized, keyed by product id)
  const priceDataMap = useMemo(() => {
    const map = {};
    products.forEach(p => {
      const volatility = p.isOrganic ? 0.06 : 0.1;
      const trend = Math.random() > 0.5 ? 0.005 : -0.003;
      map[p.id] = generatePriceHistory(p.price, volatility, trend);
    });
    return map;
  }, [products.length]); // Regenerate only if product count changes

  // Filter products
  const filteredProducts = useMemo(() => {
    return products.filter(p => {
      const matchesCat = selectedCategory === 'all' || p.categoryId === parseInt(selectedCategory);
      const matchesSearch = searchQuery === '' || p.name.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesCat && matchesSearch;
    });
  }, [products, selectedCategory, searchQuery]);

  const getTrend = (history) => {
    if (!history || history.length < 7) return { direction: 'flat', pct: 0 };
    const recent = history[history.length - 1].price;
    const weekAgo = history[history.length - 7].price;
    const pct = ((recent - weekAgo) / weekAgo) * 100;
    if (pct > 1.5) return { direction: 'up', pct };
    if (pct < -1.5) return { direction: 'down', pct };
    return { direction: 'flat', pct };
  };

  const getMonthChange = (history) => {
    if (!history || history.length < 2) return 0;
    const first = history[0].price;
    const last = history[history.length - 1].price;
    return ((last - first) / first) * 100;
  };

  // Stats
  const risingCount = filteredProducts.filter(p => getTrend(priceDataMap[p.id]).direction === 'up').length;
  const fallingCount = filteredProducts.filter(p => getTrend(priceDataMap[p.id]).direction === 'down').length;
  const stableCount = filteredProducts.filter(p => getTrend(priceDataMap[p.id]).direction === 'flat').length;

  return (
    <section className="px-4 pb-24 space-y-4 animate-fade-in">
      {/* Header Card */}
      <div className="bg-gradient-to-br from-[#1B4D3E] via-[#2D6A4F] to-[#40916C] p-5 rounded-3xl shadow-xl text-white relative overflow-hidden">
        <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full blur-2xl -translate-y-8 translate-x-8" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-white/5 rounded-full blur-2xl translate-y-8 -translate-x-4" />
        
        <div className="relative z-10">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp className="w-5 h-5 text-emerald-300" />
            <h2 className="text-lg font-black tracking-tight">Price Tracker</h2>
          </div>
          <p className="text-emerald-200/80 text-xs font-medium mb-4">30-day price history for all items</p>
          
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-3 text-center border border-white/10">
              <div className="flex items-center justify-center gap-1 mb-1">
                <ArrowUpRight className="w-3.5 h-3.5 text-blue-300" />
                <span className="text-lg font-black">{risingCount}</span>
              </div>
              <span className="text-[10px] text-emerald-200 font-semibold uppercase tracking-wider">Rising</span>
            </div>
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-3 text-center border border-white/10">
              <div className="flex items-center justify-center gap-1 mb-1">
                <ArrowDownRight className="w-3.5 h-3.5 text-green-300" />
                <span className="text-lg font-black">{fallingCount}</span>
              </div>
              <span className="text-[10px] text-emerald-200 font-semibold uppercase tracking-wider">Falling</span>
            </div>
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-3 text-center border border-white/10">
              <div className="flex items-center justify-center gap-1 mb-1">
                <Minus className="w-3.5 h-3.5 text-yellow-300" />
                <span className="text-lg font-black">{stableCount}</span>
              </div>
              <span className="text-[10px] text-emerald-200 font-semibold uppercase tracking-wider">Stable</span>
            </div>
          </div>
        </div>
      </div>

      {/* Search & Filter Bar */}
      <div className="flex gap-2">
        <div className="flex-1 relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search items..."
            className="w-full bg-white border border-gray-200 rounded-xl py-2.5 pl-9 pr-3 text-sm font-medium text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30 focus:border-[#1B4D3E] shadow-sm transition-all"
          />
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-3" />
        </div>
        <select
          value={selectedCategory}
          onChange={(e) => setSelectedCategory(e.target.value)}
          className="bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm font-bold text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30 shadow-sm appearance-none cursor-pointer min-w-[100px]"
        >
          <option value="all">All</option>
          {categories.map(cat => (
            <option key={cat.id} value={cat.id}>{cat.title}</option>
          ))}
        </select>
      </div>

      {/* Product Price Cards */}
      <div className="space-y-3">
        {filteredProducts.length === 0 && (
          <div className="text-center py-12 text-gray-400">
            <TrendingUp className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="font-bold text-sm">No items found</p>
          </div>
        )}

        {filteredProducts.map(product => {
          const history = priceDataMap[product.id] || [];
          const trend = getTrend(history);
          const monthChange = getMonthChange(history);
          const isExpanded = expandedId === product.id;
          const currentPrice = history.length > 0 ? history[history.length - 1].price : product.price;
          const lowestPrice = history.length > 0 ? Math.min(...history.map(h => h.price)) : product.price;
          const highestPrice = history.length > 0 ? Math.max(...history.map(h => h.price)) : product.price;

          const trendColor = trend.direction === 'up' ? '#3B82F6' : trend.direction === 'down' ? '#22C55E' : '#EAB308';
          const trendBg = trend.direction === 'up' ? 'bg-blue-50 text-blue-600 border-blue-100' : trend.direction === 'down' ? 'bg-green-50 text-green-600 border-green-100' : 'bg-yellow-50 text-yellow-600 border-yellow-100';

          return (
            <div
              key={product.id}
              className={`bg-white rounded-2xl shadow-sm border transition-all duration-300 ${
                isExpanded ? 'border-[#1B4D3E]/30 shadow-md' : 'border-gray-100'
              }`}
            >
              {/* Card header - always visible */}
              <button
                onClick={() => setExpandedId(isExpanded ? null : product.id)}
                className="w-full p-3.5 flex items-center gap-3 text-left active:bg-gray-50 transition-colors rounded-2xl"
              >
                {/* Product image */}
                <img
                  src={product.image}
                  alt={product.name}
                  className="w-12 h-12 rounded-xl object-cover border border-gray-100 shrink-0"
                />

                {/* Name + price */}
                <div className="flex-1 min-w-0">
                  <h4 className="font-extrabold text-gray-900 text-sm truncate">{product.name}</h4>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-base font-black text-gray-900">₹{currentPrice}</span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md border ${trendBg} flex items-center gap-0.5`}>
                      {trend.direction === 'up' ? <ArrowUpRight className="w-2.5 h-2.5" /> : trend.direction === 'down' ? <ArrowDownRight className="w-2.5 h-2.5" /> : <Minus className="w-2.5 h-2.5" />}
                      {Math.abs(trend.pct).toFixed(1)}%
                    </span>
                  </div>
                </div>

                {/* Sparkline */}
                <div className="shrink-0">
                  <SparkLine data={history} color={trendColor} width={70} height={30} />
                </div>
              </button>

              {/* Expanded detail */}
              {isExpanded && (
                <div className="px-4 pb-4 pt-1 space-y-3 border-t border-gray-100 animate-fade-in">
                  {/* Interactive chart */}
                  <div className="bg-gray-50 rounded-xl p-3 border border-gray-100">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">30 Day Trend</span>
                      <span className={`text-[10px] font-bold ${monthChange >= 0 ? 'text-blue-500' : 'text-green-500'}`}>
                        {monthChange >= 0 ? '+' : ''}{monthChange.toFixed(1)}% this month
                      </span>
                    </div>
                    <DetailChart data={history} color={trendColor} />
                  </div>

                  {/* Stats row */}
                  <div className="grid grid-cols-3 gap-2">
                    <div className="bg-green-50 rounded-xl p-2.5 text-center border border-green-100">
                      <span className="text-[9px] font-bold text-green-600 uppercase tracking-wider block mb-0.5">Lowest</span>
                      <span className="text-sm font-black text-green-700">₹{lowestPrice.toFixed(0)}</span>
                    </div>
                    <div className="bg-blue-50 rounded-xl p-2.5 text-center border border-blue-100">
                      <span className="text-[9px] font-bold text-blue-600 uppercase tracking-wider block mb-0.5">Average</span>
                      <span className="text-sm font-black text-blue-700">
                        ₹{(history.reduce((s, h) => s + h.price, 0) / history.length).toFixed(0)}
                      </span>
                    </div>
                    <div className="bg-blue-50 rounded-xl p-2.5 text-center border border-blue-100">
                      <span className="text-[9px] font-bold text-blue-600 uppercase tracking-wider block mb-0.5">Highest</span>
                      <span className="text-sm font-black text-blue-700">₹{highestPrice.toFixed(0)}</span>
                    </div>
                  </div>

                  {/* Price table (last 7 days) */}
                  <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
                    <div className="px-3 py-2 bg-gray-50 border-b border-gray-100">
                      <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Last 7 Days</span>
                    </div>
                    <div className="divide-y divide-gray-50">
                      {history.slice(-7).map((h, i) => {
                        const prevPrice = i > 0 ? history.slice(-7)[i - 1].price : h.price;
                        const diff = h.price - prevPrice;
                        return (
                          <div key={h.date} className="flex items-center justify-between px-3 py-2">
                            <span className="text-xs font-semibold text-gray-600">{h.dateLabel}</span>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-gray-900">₹{h.price.toFixed(0)}</span>
                              {diff !== 0 && (
                                <span className={`text-[10px] font-bold ${diff > 0 ? 'text-blue-500' : 'text-green-500'}`}>
                                  {diff > 0 ? '+' : ''}{diff.toFixed(0)}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
