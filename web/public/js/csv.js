// Decimal formatting + CSV export.
//
// CRITICAL (the classic bug the repo fixed): the Dune export writes PLAIN
// decimals, never scientific notation. Values like "1.72e+08" make Dune's CSV
// uploader type the column as VARCHAR, which silently breaks SUM/sort in
// charts. Because we format straight from BigInt base units, output here can
// never be scientific.

/** raw base units (BigInt, may be negative) -> plain decimal string. */
export function formatUnits(raw, decimals) {
  const neg = raw < 0n;
  let v = neg ? -raw : raw;
  const denom = 10n ** BigInt(decimals);
  const whole = v / denom;
  let frac = (v % denom).toString().padStart(decimals, '0');
  frac = frac.replace(/0+$/, '');
  const s = frac ? `${whole}.${frac}` : `${whole}`;
  return neg ? '-' + s : s;
}

/** raw base units -> Number (for charting; precision loss acceptable there). */
export function unitsToNumber(raw, decimals) {
  return Number(formatUnits(raw, decimals));
}

function csvField(s) {
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCSV(header, rows) {
  const lines = [header.map(csvField).join(',')];
  for (const r of rows) lines.push(r.map(csvField).join(','));
  return lines.join('\r\n') + '\r\n';
}

/**
 * The merged Dune-ready CSV (mirrors export-dune):
 *   block,timestamp,wallet,partner,claimed,<SYM>_LP,<SYM>_Hold,outflow
 * One row per wallet per block; partner is blank (hand-labeled upstream).
 */
export function buildDuneCSV(snapshots, decimals, symbol) {
  const sym = (symbol || 'TOKEN').toUpperCase();
  const rows = [];
  for (const snap of snapshots) {
    for (const r of snap.rows) {
      const outflow = r.claimed - r.hold - r.lp;
      rows.push([
        snap.block.toString(),
        String(snap.timestamp || ''),
        r.wallet,
        '', // partner
        formatUnits(r.claimed, decimals),
        formatUnits(r.lp, decimals),
        formatUnits(r.hold, decimals),
        formatUnits(outflow, decimals),
      ]);
    }
  }
  return toCSV(
    ['block', 'timestamp', 'wallet', 'partner', 'claimed', `${sym}_LP`, `${sym}_Hold`, 'outflow'],
    rows,
  );
}

/** timeseries.csv equivalent: block,timestamp,claimed,lp,hold,outflow. */
export function buildTimeseriesCSV(series, decimals) {
  const rows = series.map((s) => [
    s.block.toString(),
    String(s.timestamp || ''),
    formatUnits(s.claimed, decimals),
    formatUnits(s.lp, decimals),
    formatUnits(s.hold, decimals),
    formatUnits(s.outflow, decimals),
  ]);
  return toCSV(['block', 'timestamp', 'claimed', 'lp', 'hold', 'outflow'], rows);
}

export function downloadCSV(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
