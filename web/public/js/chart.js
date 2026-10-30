// Stacked-area chart (SVG, no dependencies): X = snapshot time, Y = stacked
// LP / Hold / Outflow — the "AORA shape" where the claimed envelope ramps from
// zero. Colors are the design tokens set in style.css (series follow the
// entity, fixed slot order; identity is carried by the legend + tooltip, never
// color alone).

import { unitsToNumber } from './csv.js';

const M = { top: 16, right: 16, bottom: 28, left: 56 };

function fmtCompact(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'K';
  return String(Math.round(v * 100) / 100);
}

function fmtFull(v) {
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Exact two-decimal percentage of claimed, without Number precision loss. */
function sharePercent(value, claimed) {
  const total = BigInt(claimed ?? 0n);
  let part = BigInt(value ?? 0n);
  if (total <= 0n) return '0.00%';
  if (part < 0n) part = 0n;
  const hundredths = (part * 10000n + total / 2n) / total;
  const whole = hundredths / 100n;
  const frac = (hundredths % 100n).toString().padStart(2, '0');
  return `${whole}.${frac}%`;
}

/** LP/Hold/Transfer-out shares of claimed for one snapshot point. */
export function chartShares(point) {
  return {
    lp: sharePercent(point.lp, point.claimed),
    hold: sharePercent(point.hold, point.claimed),
    outflow: sharePercent(point.outflow, point.claimed),
  };
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function fmtTime(ts, block) {
  if (!ts) return `block ${block}`;
  const d = new Date(ts * 1000);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

function niceTicks(max, n = 4) {
  if (max <= 0) return [0];
  const raw = max / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const ticks = [];
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(v);
  return ticks;
}

const svgNS = 'http://www.w3.org/2000/svg';
function el(name, attrs, parent) {
  const e = document.createElementNS(svgNS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

/**
 * Render the series into `container` (cleared first).
 * series: [{block, timestamp, claimed, hold, lp, outflow}] with BigInt raw values.
 */
export function renderChart(container, series, decimals) {
  container.innerHTML = '';
  if (!series.length) return;

  const pts = series.map((s) => {
    const shares = chartShares(s);
    return {
      block: s.block.toString(),
      ts: s.timestamp || 0,
      lp: Math.max(0, unitsToNumber(s.lp, decimals)),
      hold: Math.max(0, unitsToNumber(s.hold, decimals)),
      outflow: Math.max(0, unitsToNumber(s.outflow, decimals)),
      claimed: unitsToNumber(s.claimed, decimals),
      shares,
    };
  });

  const W = Math.max(560, container.clientWidth || 800);
  const H = 340;
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;

  const yMax = Math.max(...pts.map((p) => p.lp + p.hold + p.outflow), 1e-9) * 1.05;
  const x = (i) => M.left + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
  const y = (v) => M.top + ih - (v / yMax) * ih;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img', 'aria-label': 'Stacked area chart of LP, Hold and Outflow over time' });
  container.appendChild(svg);

  // Gridlines + Y ticks (hairline, recessive).
  const ticks = niceTicks(yMax);
  for (const t of ticks) {
    el('line', { x1: M.left, x2: W - M.right, y1: y(t), y2: y(t), class: 'grid' }, svg);
    const txt = el('text', { x: M.left - 8, y: y(t) + 4, class: 'tick', 'text-anchor': 'end' }, svg);
    txt.textContent = fmtCompact(t);
  }

  // X labels: ~5 evenly spaced. Windows under 2 days keep the time component
  // (date-only labels would all repeat the same day).
  const spanSec = (pts[pts.length - 1].ts || 0) - (pts[0].ts || 0);
  const nx = Math.min(5, pts.length);
  for (let k = 0; k < nx; k++) {
    const i = Math.round((k / Math.max(nx - 1, 1)) * (pts.length - 1));
    const txt = el('text', { x: x(i), y: H - 8, class: 'tick', 'text-anchor': k === 0 ? 'start' : k === nx - 1 ? 'end' : 'middle' }, svg);
    const full = fmtTime(pts[i].ts);
    txt.textContent = pts[i].ts ? (spanSec < 172800 ? full : full.split(',')[0]) : `#${pts[i].block}`;
  }

  // Stack: lp (bottom) -> hold -> outflow (top). Between bands: a 2px
  // surface-color stroke (the "surface gap"); each band's top edge gets a 2px
  // line in its series color.
  const bands = [
    { key: 'lp', cls: 's1' },
    { key: 'hold', cls: 's2' },
    { key: 'outflow', cls: 's3' },
  ];
  const cum = pts.map(() => 0);
  for (const band of bands) {
    const lower = cum.slice();
    for (let i = 0; i < pts.length; i++) cum[i] += pts[i][band.key];
    let dTop = '', dBottomRev = '';
    for (let i = 0; i < pts.length; i++) dTop += `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(cum[i]).toFixed(1)}`;
    for (let i = pts.length - 1; i >= 0; i--) dBottomRev += `L${x(i).toFixed(1)},${y(lower[i]).toFixed(1)}`;
    el('path', { d: dTop + dBottomRev + 'Z', class: `band ${band.cls}` }, svg);
    el('path', { d: dTop, class: `band-gap` }, svg);          // 2px surface gap under the edge
    el('path', { d: dTop, class: `band-edge ${band.cls}` }, svg); // 2px series-colored edge
  }

  // Baseline.
  el('line', { x1: M.left, x2: W - M.right, y1: y(0), y2: y(0), class: 'baseline' }, svg);

  // ---- hover layer: crosshair + tooltip ----
  const cross = el('line', { y1: M.top, y2: M.top + ih, class: 'crosshair', visibility: 'hidden' }, svg);
  const dots = bands.map((b) => el('circle', { r: 4.5, class: `dot ${b.cls}`, visibility: 'hidden' }, svg));

  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.style.display = 'none';
  container.style.position = 'relative';
  container.appendChild(tip);

  const hit = el('rect', { x: M.left, y: M.top, width: iw, height: ih, fill: 'transparent' }, svg);
  hit.addEventListener('mousemove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const scale = W / rect.width;
    const px = (ev.clientX - rect.left) * scale;
    let i = Math.round(((px - M.left) / iw) * (pts.length - 1));
    i = Math.max(0, Math.min(pts.length - 1, i));
    const p = pts[i];
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
    cross.setAttribute('visibility', 'visible');
    let acc = 0;
    [p.lp, p.hold, p.outflow].forEach((v, bi) => {
      acc += v;
      dots[bi].setAttribute('cx', x(i));
      dots[bi].setAttribute('cy', y(acc));
      dots[bi].setAttribute('visibility', 'visible');
    });
    tip.innerHTML =
      `<div class="tip-head">${fmtTime(p.ts, p.block)} · block ${p.block}</div>` +
      `<div><span class="key s1"></span>LP <b>${fmtFull(p.lp)} <span class="tip-pct">${p.shares.lp}</span></b></div>` +
      `<div><span class="key s2"></span>Hold <b>${fmtFull(p.hold)} <span class="tip-pct">${p.shares.hold}</span></b></div>` +
      `<div><span class="key s3"></span>Transfer out <b>${fmtFull(p.outflow)} <span class="tip-pct">${p.shares.outflow}</span></b></div>` +
      `<div class="tip-total">Claimed <b>${fmtFull(p.claimed)}</b></div>`;
    tip.style.display = 'block';
    const cw = container.clientWidth;
    const tx = x(i) / scale; // svg coords -> CSS pixels
    const flip = tx > cw * 0.6;
    tip.style.left = flip ? '' : `${tx + 14}px`;
    tip.style.right = flip ? `${cw - tx + 14}px` : '';
    tip.style.top = `${M.top}px`;
  });
  hit.addEventListener('mouseleave', () => {
    cross.setAttribute('visibility', 'hidden');
    dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
    tip.style.display = 'none';
  });
}

/** Legend markup. Percentages describe the latest chart snapshot. */
export function legendHTML(symbol, latest = null) {
  const sym = escapeHTML(symbol ? symbol.toUpperCase() : 'Token');
  const shares = latest ? chartShares(latest) : null;
  const pct = (value) => shares ? `<b class="legend-pct">${value}</b>` : '';
  return `
    <span class="legend-item"><span class="key s1"></span>${sym} in LP ${pct(shares?.lp)}</span>
    <span class="legend-item"><span class="key s2"></span>${sym} held ${pct(shares?.hold)}</span>
    <span class="legend-item"><span class="key s3"></span>Transfer out ${pct(shares?.outflow)}</span>`;
}
