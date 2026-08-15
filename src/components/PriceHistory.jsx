import React, { useState, useMemo, useRef, useEffect } from 'react';
import { TrendingUp, TrendingDown, Minus, ChevronDown, Search, Info, Loader2 } from 'lucide-react';
import { fetchMarketPriceHistory } from '../services/markets';
import { useLanguage } from '../i18n/LanguageContext';
import { productName, productWeight, categoryTitle } from '../i18n/catalog';

/**
 * The Price Tracker.
 *
 * WHAT THIS USED TO BE
 *
 * Every chart on this screen was produced by `generatePriceHistory`, a random
 * walk seeded from the current price. It invented thirty days of rises and
 * falls per product, recomputed whenever the product count changed, and fed the
 * "Rising / Falling / Stable" tallies at the top of the page. None of it had
 * ever happened. A shopper reads a price trend to decide whether to buy today
 * or wait, which makes an invented one worse than no chart at all.
 *
 * WHAT IT IS NOW
 *
 * `GET /markets/:id/price-history` returns what the market actually charged,
 * recorded whenever an owner changes a price (see MarketPriceHistory). Two
 * consequences shape everything below:
 *
 * 1. A point exists only where the price MOVED. So the line is drawn as a step
 *    — the price was that number until the next point, it did not drift towards
 *    it. Interpolating would reintroduce, in the drawing, exactly the invented
 *    intermediate values this replaced.
 *
 * 2. Most products will have no points at all to begin with, because history
 *    only starts accumulating once someone reprices. That is shown as "no
 *    changes recorded", never filled in.
 */

/** Number of pixels the sparkline occupies. */
const SPARK = { width: 120, height: 40 };

/**
 * Turn a change-point series into the corners of a step line.
 *
 * Each change contributes two vertices: the end of the old price's run, and the
 * start of the new one. A trailing vertex extends the last price to "now",
 * because it is still in force.
 */
function toStepPoints(series, now = Date.now()) {
  if (!series?.length) return [];

  const start = new Date(series[0].at).getTime();
  const span = Math.max(1, now - start);
  const at = (time) => (new Date(time).getTime() - start) / span;

  const vertices = [];
  series.forEach((point, index) => {
    const x = at(point.at);
    if (index > 0) {
      // Hold the previous price right up to the moment this one took over.
      vertices.push({ x, price: series[index - 1].pricePaise / 100, at: point.at });
    }
    vertices.push({ x, price: point.pricePaise / 100, at: point.at });
  });

  vertices.push({ x: 1, price: series[series.length - 1].pricePaise / 100, at: now });
  return vertices;
}

function priceExtent(vertices) {
  const prices = vertices.map((v) => v.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  // A price that never changed has zero range; give it a flat line down the middle.
  return { min, max, range: max - min || 1 };
}

function SparkLine({ vertices, color, width = SPARK.width, height = SPARK.height }) {
  const { min, range } = priceExtent(vertices);

  const points = vertices
    .map((v) => `${v.x * width},${height - ((v.price - min) / range) * (height - 4) - 2}`)
    .join(' ');

  const gradientId = `grad-${color.replace('#', '')}`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polygon points={`0,${height} ${points} ${width},${height}`} fill={`url(#${gradientId})`} />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The expanded chart, with a date axis and a marker on each real change. */
function DetailChart({ series, color, width = 300, height = 130 }) {
  const { t, language } = useLanguage();
  const [hover, setHover] = useState(null);
  const svgRef = useRef(null);

  const vertices = useMemo(() => toStepPoints(series), [series]);
  const { min, range } = priceExtent(vertices);

  const y = (price) => height - 28 - ((price - min) / range) * (height - 40) - 4;
  const points = vertices.map((v) => `${v.x * width},${y(v.price)}`).join(' ');

  // Only real changes get a dot; the step corners are drawing, not data.
  const changeDots = series.map((point) => {
    const start = new Date(series[0].at).getTime();
    const span = Math.max(1, Date.now() - start);
    return {
      x: ((new Date(point.at).getTime() - start) / span) * width,
      yPos: y(point.pricePaise / 100),
      point,
    };
  });

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        width="100%"
        viewBox={`0 0 ${width} ${height}`}
        className="overflow-visible touch-none"
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={`detail-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
          const gridY = height - 28 - pct * (height - 40) - 4;
          return (
            <line
              key={pct}
              x1="0" y1={gridY} x2={width} y2={gridY}
              stroke="#e5e7eb" strokeWidth="0.5" strokeDasharray="4,4"
            />
          );
        })}

        <polygon
          points={`0,${height - 28} ${points} ${width},${height - 28}`}
          fill={`url(#detail-${color.replace('#', '')})`}
        />
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {changeDots.map((dot, i) => (
          <circle
            key={i}
            cx={dot.x}
            cy={dot.yPos}
            r={hover === i ? 5.5 : 3.5}
            fill={color}
            stroke="white"
            strokeWidth="2"
            onPointerEnter={() => setHover(i)}
            style={{ cursor: 'pointer' }}
          />
        ))}

        <text x="0" y={height - 6} fontSize="8" fill="#9ca3af" fontWeight="600">
          {formatDay(series[0].at, language)}
        </text>
        <text x={width} y={height - 6} textAnchor="end" fontSize="8" fill="#9ca3af" fontWeight="600">
          {t('price.today')}
        </text>
      </svg>

      {hover !== null && changeDots[hover] && (
        <div
          className="absolute -top-2 bg-gray-900 text-white text-[10px] font-bold px-2 py-1 rounded-lg shadow-lg pointer-events-none whitespace-nowrap z-10"
          style={{ left: `${(changeDots[hover].x / width) * 100}%`, transform: 'translateX(-50%)' }}
        >
          ₹{(changeDots[hover].point.pricePaise / 100).toFixed(2).replace(/\.00$/, '')} ·{' '}
          {changeDots[hover].point.carried
            ? t('price.inForce')
            : formatDay(changeDots[hover].point.at, language)}
        </div>
      )}
    </div>
  );
}

export default function PriceHistory({ products = [], categories = [], market = null }) {
  const { t, language } = useLanguage();
  const [expandedId, setExpandedId] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [windowDays, setWindowDays] = useState(30);

  const [series, setSeries] = useState({});
  const [loading, setLoading] = useState(Boolean(market));
  const [failed, setFailed] = useState(false);

  const marketId = market?.id || null;

  useEffect(() => {
    if (!marketId) {
      setSeries({});
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    setFailed(false);

    fetchMarketPriceHistory(marketId, { days: windowDays })
      .then((data) => {
        if (!cancelled) setSeries(data.series || {});
      })
      .catch(() => {
        // An empty chart is the right answer to "we could not load this"; a
        // generated one is what this screen used to do instead.
        if (!cancelled) {
          setSeries({});
          setFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [marketId, windowDays]);

  const filtered = useMemo(
    () =>
      products.filter((p) => {
        const matchesCat =
          selectedCategory === 'all' || p.categoryId === parseInt(selectedCategory, 10);
        // Match on the English name AND the displayed one. Someone reading a
        // Telugu list types Telugu; someone who knows the produce by its English
        // name types that. Neither should come back empty.
        const query = searchQuery.trim().toLowerCase();
        const matchesSearch =
          query === '' ||
          p.name.toLowerCase().includes(query) ||
          productName(p, language).toLowerCase().includes(query);
        return matchesCat && matchesSearch;
      }),
    [products, selectedCategory, searchQuery, language]
  );

  /** Direction over the window, from the first recorded price to the latest. */
  const trendFor = (productId) => {
    const points = series[productId];
    if (!points || points.length < 2) return { direction: 'flat', pct: 0, tracked: Boolean(points) };

    const first = points[0].pricePaise;
    const last = points[points.length - 1].pricePaise;
    const pct = first === 0 ? 0 : ((last - first) / first) * 100;

    if (pct > 1.5) return { direction: 'up', pct, tracked: true };
    if (pct < -1.5) return { direction: 'down', pct, tracked: true };
    return { direction: 'flat', pct, tracked: true };
  };

  // Counted only over products that actually have a record, so the tallies never
  // imply knowledge of a line nobody has repriced.
  const tracked = filtered.filter((p) => series[p.id]?.length);
  const rising = tracked.filter((p) => trendFor(p.id).direction === 'up').length;
  const falling = tracked.filter((p) => trendFor(p.id).direction === 'down').length;
  const steady = tracked.length - rising - falling;

  return (
    <section className="px-4 pb-24 space-y-4 animate-fade-in">
      <div className="bg-gradient-to-br from-[#1B4D3E] via-[#2D6A4F] to-[#40916C] p-5 rounded-3xl shadow-xl text-white relative overflow-hidden">
        <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full blur-2xl -translate-y-8 translate-x-8" />
        <div className="relative z-10">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp className="w-5 h-5 text-emerald-300" />
            <h2 className="text-lg font-black tracking-tight">{t('price.title')}</h2>
          </div>
          <p className="text-emerald-200/80 text-xs font-medium mb-4">
            {market
              ? t('price.subtitleMarket', { market: market.name, days: windowDays })
              : t('price.subtitleNoMarket')}
          </p>

          <div className="grid grid-cols-3 gap-3">
            <Tally label={t('price.rising')} value={rising} tone="text-rose-300" icon={<TrendingUp className="w-3.5 h-3.5" />} />
            <Tally label={t('price.falling')} value={falling} tone="text-emerald-300" icon={<TrendingDown className="w-3.5 h-3.5" />} />
            <Tally label={t('price.steady')} value={steady} tone="text-white" icon={<Minus className="w-3.5 h-3.5" />} />
          </div>

          {market && (
            <div className="flex gap-1.5 mt-4">
              {[7, 30, 90].map((days) => (
                <button
                  key={days}
                  type="button"
                  onClick={() => setWindowDays(days)}
                  aria-pressed={windowDays === days}
                  className={`px-3 py-1 rounded-lg text-[11px] font-bold transition-colors ${
                    windowDays === days ? 'bg-white text-[#1B4D3E]' : 'bg-white/10 text-emerald-100'
                  }`}
                >
                  {days}d
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {!market && <Notice>{t('price.needMarket')}</Notice>}

      {failed && <Notice>{t('price.loadFailed')}</Notice>}

      {market && !loading && tracked.length === 0 && !failed && (
        <Notice>{t('price.noneRecorded', { market: market.name })}</Notice>
      )}

      <div className="relative">
        <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('price.searchItems')}
          className="w-full bg-white border border-gray-200 rounded-xl py-2.5 pl-9 pr-3 text-sm font-medium text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30 focus:border-[#1B4D3E] shadow-sm transition-all"
        />
      </div>

      {categories.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
          <CategoryChip
            active={selectedCategory === 'all'}
            onClick={() => setSelectedCategory('all')}
            label={t('price.all')}
          />
          {categories.map((c) => (
            <CategoryChip
              key={c.id}
              active={String(selectedCategory) === String(c.id)}
              onClick={() => setSelectedCategory(String(c.id))}
              label={categoryTitle(c, language) || c.name}
            />
          ))}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 text-gray-500 py-10 text-sm font-semibold">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t('price.loading')}
        </div>
      ) : (
        <div className="space-y-2.5">
          {filtered.map((product) => {
            const points = series[product.id];
            const trend = trendFor(product.id);
            const expanded = expandedId === product.id;
            const color =
              trend.direction === 'up' ? '#e11d48' : trend.direction === 'down' ? '#059669' : '#64748b';

            return (
              <article
                key={product.id}
                className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : product.id)}
                  className="w-full p-3.5 flex items-center gap-3 text-left"
                  disabled={!points?.length}
                >
                  {product.image && (
                    <img
                      src={product.image}
                      alt=""
                      className="w-11 h-11 rounded-xl object-cover shrink-0 bg-gray-50"
                      loading="lazy"
                    />
                  )}

                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-sm text-gray-900 truncate">
                      {productName(product, language)}
                    </p>
                    <p className="text-xs text-gray-500">
                      ₹{product.price}{' '}
                      {product.weight ? `· ${productWeight(product.weight, language)}` : ''}
                    </p>
                  </div>

                  {points?.length ? (
                    <>
                      <SparkLine vertices={toStepPoints(points)} color={color} width={70} height={30} />
                      <div className="text-right shrink-0 w-14">
                        <span className={`text-xs font-black ${
                          trend.direction === 'up' ? 'text-rose-600'
                            : trend.direction === 'down' ? 'text-emerald-600' : 'text-gray-400'
                        }`}>
                          {trend.direction === 'flat' ? '—' : `${trend.pct > 0 ? '+' : ''}${trend.pct.toFixed(1)}%`}
                        </span>
                      </div>
                      <ChevronDown
                        className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
                      />
                    </>
                  ) : (
                    <span className="text-[11px] text-gray-400 font-semibold shrink-0">
                      {t('price.noChanges')}
                    </span>
                  )}
                </button>

                {expanded && points?.length > 0 && (
                  <div className="px-3.5 pb-4 pt-1 border-t border-gray-50">
                    <DetailChart series={points} color={color} />
                    <p className="text-[11px] text-gray-400 mt-2 leading-snug">
                      {points.length === 1
                        ? t('price.oneOnRecord')
                        : t('price.changesRecorded', { count: points.length })}
                    </p>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Tally({ label, value, tone, icon }) {
  return (
    <div className="bg-white/10 backdrop-blur-sm rounded-xl p-3 text-center border border-white/10">
      <div className={`flex items-center justify-center gap-1 mb-1 ${tone}`}>{icon}</div>
      <p className="text-xl font-black">{value}</p>
      <p className="text-[10px] text-emerald-200/80 font-bold uppercase tracking-wider">{label}</p>
    </div>
  );
}

function CategoryChip({ active, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap border transition-colors ${
        active
          ? 'bg-[#1B4D3E] text-white border-[#1B4D3E]'
          : 'bg-white text-gray-600 border-gray-200'
      }`}
    >
      {label}
    </button>
  );
}

function Notice({ children }) {
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 flex items-start gap-2.5">
      <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
      <p className="text-[12.5px] text-blue-900 leading-relaxed">{children}</p>
    </div>
  );
}

/**
 * A day on the date axis, in the reader's own script.
 *
 * The locale is derived from the app language rather than the browser's, so a
 * screen the shopper has explicitly set to Telugu does not carry English month
 * names because the phone happens to be en-US. All three are `-IN` regions, so
 * the day-then-month order is the same in each.
 */
function formatDay(iso, language = 'en') {
  const locale = { te: 'te-IN', hi: 'hi-IN' }[language] || 'en-IN';
  return new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}
