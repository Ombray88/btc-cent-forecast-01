import * as fs from 'fs';
import * as path from 'path';

// BTC Cent Forecast - Final Entry: Pure Persistence (BETA = 0)
// Validation results:
// - Race walk-forward (3 folds): MAE 59,553.07 cents. Dip-bounce gate never activated (0 active folds), falling back to persistence.
// - Practice (5 scorable cases): MAE 47,054.66 cents, worst dollar error 766.97. Gate never activated, tying persistence exactly.
const BETA = 0;

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  let files: string[];
  try {
    files = fs.readdirSync(inputDir).filter(f => f.endsWith('.in')).sort();
  } catch (err) {
    console.error(`Error reading input directory ${inputDir}:`, err);
    return;
  }

  for (const file of files) {
    const inputPath = path.join(inputDir, file);
    let rawContent: string;
    try {
      rawContent = fs.readFileSync(inputPath, 'utf8');
    } catch (err) {
      console.error(`Error reading file ${inputPath}:`, err);
      continue;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawContent);
    } catch (err) {
      console.error(`JSON parse error for ${inputPath}:`, err);
      continue;
    }

    let caseId: string = '';
    let prices: number[] = [];
    let hasValidStructure = false;

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (typeof parsed.case === 'string') {
        caseId = parsed.case;
      }
      if (
        Array.isArray(parsed.markets) &&
        parsed.markets.length === 1 &&
        parsed.markets[0] &&
        Array.isArray(parsed.markets[0].prices)
      ) {
        const rawPrices = parsed.markets[0].prices;
        if (
          rawPrices.length === 4320 &&
          rawPrices.every((p: any) => typeof p === 'number' && Number.isFinite(p) && p > 0)
        ) {
          prices = rawPrices;
          hasValidStructure = true;
        }
      }
    }

    // Fallback if structure is malformed but we have caseId and at least one usable price
    if (!hasValidStructure) {
      if (!caseId && typeof parsed?.case === 'string') {
        caseId = parsed.case;
      }
      // Try to rescue caseId from filename if missing
      if (!caseId) {
        caseId = path.basename(file, '.in');
      }
      // Try to find any valid prices array
      let rescuePrices: number[] = [];
      if (parsed && parsed.markets && Array.isArray(parsed.markets) && parsed.markets[0] && Array.isArray(parsed.markets[0].prices)) {
        rescuePrices = parsed.markets[0].prices.filter((p: any) => typeof p === 'number' && Number.isFinite(p) && p > 0);
      }
      if (rescuePrices.length > 0 && caseId) {
        const lastP = rescuePrices[rescuePrices.length - 1];
        // Create a dummy 4320 prices array filled with lastP for persistence fallback
        prices = new Array(4320).fill(lastP);
        console.error(`Warning: malformed input for ${caseId}, falling back to persistence.`);
      } else {
        console.error(`Skipping invalid case file ${file}: cannot extract valid ID and prices.`);
        continue;
      }
    }

    const Pt = prices[prices.length - 1];
    const N = prices.length; // 4320

    // Log-returns: r_i = log(P_i / P_{i-1}) for i = 1 .. N-1 (4319 returns)
    const returns: number[] = new Array(N - 1);
    for (let i = 1; i < N; i++) {
      returns[i - 1] = Math.log(prices[i] / prices[i - 1]);
    }

    const winsorize = (sub: number[], qLow: number, qHigh: number): number[] => {
      const sorted = [...sub].sort((a, b) => a - b);
      const n = sorted.length;
      const kLow = Math.ceil(n * qLow);
      const kHigh = Math.ceil(n * qHigh);
      const idxLow = Math.max(0, Math.min(n - 1, kLow - 1));
      const idxHigh = Math.max(0, Math.min(n - 1, kHigh - 1));
      const vLow = sorted[idxLow];
      const vHigh = sorted[idxHigh];
      return sub.map(x => Math.max(vLow, Math.min(vHigh, x)));
    };

    const windows = [120, 360, 720];
    const weights: { [key: number]: number } = { 120: 0.50, 360: 0.30, 720: 0.20 };
    const winsorizedResidualsMap: { [key: number]: number[] } = {};
    const meanSqMap: { [key: number]: number } = {};

    for (const W of windows) {
      const subReturns = returns.slice(returns.length - W);
      const sortedSub = [...subReturns].sort((a, b) => a - b);
      const m = subReturns.length;
      let medianW = 0;
      if (m > 0) {
        if (m % 2 === 0) {
          medianW = (sortedSub[m / 2 - 1] + sortedSub[m / 2]) / 2;
        } else {
          medianW = sortedSub[Math.floor(m / 2)];
        }
      }
      const residuals = subReturns.map(r => r - medianW);
      const zW = winsorize(residuals, 0.05, 0.95);
      winsorizedResidualsMap[W] = zW;
      const sumSq = zW.reduce((acc, val) => acc + val * val, 0);
      meanSqMap[W] = m > 0 ? sumSq / m : 0;
    }

    const s360 = Math.sqrt(meanSqMap[360]);

    let sumWeightedMeanSq = 0;
    for (const W of windows) {
      sumWeightedMeanSq += weights[W] * meanSqMap[W];
    }
    const S = Math.sqrt(240) * Math.sqrt(sumWeightedMeanSq);

    // Dip-bounce gate I
    let I = 0;
    // Last 120 minutes of prices: from index N - 1 - 120 to N - 1
    const start120Prices = Math.max(0, N - 1 - 120);
    let maxD = -1;
    let bestV = -1;

    for (let p = start120Prices; p < N - 1; p++) {
      for (let v = p + 1; v <= Math.min(N - 1, p + 30); v++) {
        const drop = Math.log(prices[p] / prices[v]);
        if (drop > 0) {
          if (drop > maxD || (Math.abs(drop - maxD) < 1e-12 && v > bestV)) {
            maxD = drop;
            bestV = v;
          }
        }
      }
    }

    if (maxD > 0 && bestV !== -1) {
      const D = maxD;
      const v = bestV;
      const Pv = prices[v];
      const B = Math.log(Pt / Pv);
      const age = (N - 1) - v;

      // Last 15 minutes of prices: from index N - 1 - 15 to N - 1
      const start15Prices = Math.max(0, N - 1 - 15);
      let min15 = Infinity;
      let max15 = -Infinity;
      for (let i = start15Prices; i < N; i++) {
        if (prices[i] < min15) min15 = prices[i];
        if (prices[i] > max15) max15 = prices[i];
      }
      const logRange15 = Math.log(max15 / min15);

      const R60 = Math.log(Pt / prices[N - 1 - 60]);
      const R240 = Math.log(Pt / prices[N - 1 - 240]);

      // Absolute 1-minute log-return in last 120 minutes
      // Last 120 returns: returns.slice(returns.length - 120)
      const last120Returns = returns.slice(returns.length - 120);
      const maxAbsRet120 = last120Returns.reduce((m, r) => Math.max(m, Math.abs(r)), 0);
      const threshold120 = Math.max(0.003, 8 * s360);

      const condD = D >= 0.005;
      const condB = B >= 0.003;
      const condAge = age >= 15 && age <= 90;
      const cond15Min = min15 >= 1.001 * Pv && logRange15 <= 0.003;
      const condReturns = R60 >= -0.0025 && R240 >= -0.010;
      const condMaxRet = maxAbsRet120 <= threshold120;

      if (condD && condB && condAge && cond15Min && condReturns && condMaxRet) {
        I = 1;
      }
    }

    // Safety guards (force I = 0)
    // 1. Last 10 closes all identical
    let last10Identical = true;
    for (let i = N - 10; i < N; i++) {
      if (prices[i] !== Pt) {
        last10Identical = false;
        break;
      }
    }

    // 2. Fewer than 60 of the last 120 returns are nonzero
    const last120RetCheck = returns.slice(returns.length - 120);
    const nonzeroCount = last120RetCheck.filter(r => r !== 0).length;
    const fewNonzero = nonzeroCount < 60;

    // 3. Any absolute 1-minute log-return in last 720 minutes exceeds 0.02
    const last720Returns = returns.slice(returns.length - 720);
    const maxAbsRet720 = last720Returns.reduce((m, r) => Math.max(m, Math.abs(r)), 0);
    const extremeRet720 = maxAbsRet720 > 0.02;

    if (last10Identical || fewNonzero || extremeRet720) {
      I = 0;
    }

    const mu = I * Math.min(BETA * (maxD > 0 ? maxD : 0), 0.0015, 0.25 * S);
    let rawForecast = Pt * Math.exp(mu);

    // Clamp into [0.00001, 9999999.99999]
    rawForecast = Math.max(0.00001, Math.min(9999999.99999, rawForecast));

    // Round half-up to 5 decimals
    const roundedPrice = Math.round(rawForecast * 100000) / 100000;

    const outputObj = {
      forecasts: [
        {
          case: caseId,
          price: roundedPrice
        }
      ]
    };

    const outFilename = `${caseId}.out`;
    const outputPath = path.join(outputDir, outFilename);
    try {
      fs.writeFileSync(outputPath, JSON.stringify(outputObj) + '\n', 'utf8');
    } catch (err) {
      console.error(`Error writing output file ${outputPath}:`, err);
    }
  }
}

main();
