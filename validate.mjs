import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

function main() {
  const repoDir = process.cwd();
  const raceKitNdjsonGz = '/home/hatch/workspace/makefun-audit/btc-race-24h-20261113-2314-kit/btc-race-24h-20261113-2314-kit/dataset/bars/CBBTC.ndjson.gz';
  const practiceInputdir = '/home/hatch/workspace/makefun-audit/btc-cent-forecast-01-work/btc-cent-forecast-01-kit/input';

  // a. Read the race bars
  console.log('Reading race bars from:', raceKitNdjsonGz);
  const gzBuf = fs.readFileSync(raceKitNdjsonGz);
  const ndjsonBuf = zlib.gunzipSync(gzBuf);
  const lines = ndjsonBuf.toString('utf8').split('\n').filter(l => l.trim().length > 0);
  
  const closes = [];
  const times = [];
  for (const line of lines) {
    const obj = JSON.parse(line);
    closes.push(Number(obj.c) / 100000);
    times.push(obj.t);
  }
  console.log(`Loaded ${closes.length} race bars.`);

  // b. Walk-forward folds
  // Note the padding is inert by design: the forecaster's features only use the last 720 returns,
  // so flat padding in front cannot change any feature except one boundary zero in the 720 window.
  const foldConfigs = [
    { id: 'w0', checkpoint: 719, targetIndex: 959 },
    { id: 'w1', checkpoint: 959, targetIndex: 1199 },
    { id: 'w2', checkpoint: 1199, targetIndex: 1439 }
  ];

  const foldsDir = fs.mkdtempSync(path.join(repoDir, 'folds-temp-'));
  const foldOutputsDir = fs.mkdtempSync(path.join(repoDir, 'folds-out-'));

  const foldData = [];
  for (const fc of foldConfigs) {
    const cp = fc.checkpoint;
    const target = closes[fc.targetIndex];
    const subCloses = closes.slice(0, cp + 1);
    const needed = 4320 - subCloses.length;
    const padding = new Array(needed).fill(subCloses[0]);
    const prices = padding.concat(subCloses);

    const atIso = new Date(times[cp]).toISOString();
    const startIso = new Date(times[0]).toISOString();

    const caseObj = {
      at: atIso,
      case: fc.id,
      competition: 'btc-cent-forecast-01',
      horizon_minutes: 240,
      markets: [
        {
          id: 'btc-usdc',
          name: 'BTC/USDC',
          start: startIso,
          prices: prices
        }
      ]
    };

    const caseFile = path.join(foldsDir, `${fc.id}.in`);
    fs.writeFileSync(caseFile, JSON.stringify(caseObj) + '\n', 'utf8');

    foldData.push({
      id: fc.id,
      checkpoint: cp,
      persistencePrice: closes[cp],
      target: target
    });
  }

  // c. Beta sweep
  const betas = [0, 0.10, 0.20, 0.30];
  const mainTsContent = fs.readFileSync(path.join(repoDir, 'main.ts'), 'utf8');
  const betaResults = [];

  for (const beta of betas) {
    const tempBetaDir = fs.mkdtempSync(path.join(repoDir, `beta-temp-${beta}-`));
    const modifiedMain = mainTsContent.replace(/const\s+BETA\s*=\s*[^;]+;/g, `const BETA = ${beta};`);
    const tempMainPath = path.join(tempBetaDir, 'main.ts');
    fs.writeFileSync(tempMainPath, modifiedMain, 'utf8');

    // Run node on tempMainPath
    const res = spawnSync('node', [tempMainPath], {
      env: {
        ...process.env,
        MAKEFUN_INPUT_DIR: foldsDir,
        MAKEFUN_OUTPUT_DIR: foldOutputsDir
      },
      encoding: 'utf8'
    });

    if (res.status !== 0) {
      console.error(`Error running beta ${beta}:`, res.stderr);
    }

    let foldErrors = [];
    let persistenceFoldErrors = [];
    let signalActiveCount = 0;
    let improvedCount = 0;

    for (let i = 0; i < foldData.length; i++) {
      const fd = foldData[i];
      const outFile = path.join(foldOutputsDir, `${fd.id}.out`);
      let forecastPrice = fd.persistencePrice;
      if (fs.existsSync(outFile)) {
        try {
          const outParsed = JSON.parse(fs.readFileSync(outFile, 'utf8'));
          forecastPrice = outParsed.forecasts[0].price;
        } catch (e) {
          // fallback to persistence
        }
      }

      const err = Math.abs(forecastPrice - fd.target);
      const persistenceErr = Math.abs(fd.persistencePrice - fd.target);
      foldErrors.push(err);
      persistenceFoldErrors.push(persistenceErr);

      const signalActive = Math.abs(forecastPrice - fd.persistencePrice) > 1e-5;
      if (signalActive) signalActiveCount++;
      if (err < persistenceErr) improvedCount++;
    }

    const meanErr = foldErrors.reduce((a, b) => a + b, 0) / foldErrors.length;
    const raceMaeCents = 100 * meanErr;

    const meanPersistenceErr = persistenceFoldErrors.reduce((a, b) => a + b, 0) / persistenceFoldErrors.length;
    const persistenceMaeCents = 100 * meanPersistenceErr;
    const maeVsPersPct = persistenceMaeCents > 0 ? ((raceMaeCents - persistenceMaeCents) / persistenceMaeCents) * 100 : 0;

    // Check max worsening across folds
    let maxWorsening = 0;
    for (let i = 0; i < foldErrors.length; i++) {
      const diff = foldErrors[i] - persistenceFoldErrors[i];
      if (diff > maxWorsening) maxWorsening = diff;
    }

    betaResults.push({
      beta,
      foldErrors,
      persistenceFoldErrors,
      raceMaeCents,
      persistenceMaeCents,
      maeVsPersPct,
      signalActiveCount,
      improvedCount,
      maxWorsening
    });

    // Cleanup fold outputs for next beta
    try {
      for (const fd of foldData) {
        const outFile = path.join(foldOutputsDir, `${fd.id}.out`);
        if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
      }
    } catch (e) {}
  }

  // Print Per-Beta Table
  console.log('\n--- BETA SWEEP RESULTS (Race Folds) ---');
  console.log('Beta | Fold 0 Err ($) | Fold 1 Err ($) | Fold 2 Err ($) | Race MAE (cents) | vs Persistence (%) | Active Folds | Improved Folds');
  console.log('------------------------------------------------------------------------------------------------------------------------');
  for (const br of betaResults) {
    const f0 = br.foldErrors[0].toFixed(2);
    const f1 = br.foldErrors[1].toFixed(2);
    const f2 = br.foldErrors[2].toFixed(2);
    const mae = br.raceMaeCents.toFixed(2);
    const vsPers = br.maeVsPersPct.toFixed(2) + '%';
    console.log(`${br.beta.toFixed(2).padEnd(4)} | ${f0.padStart(14)} | ${f1.padStart(14)} | ${f2.padStart(14)} | ${mae.padStart(16)} | ${vsPers.padStart(18)} | ${String(br.signalActiveCount).padStart(12)} | ${String(br.improvedCount).padStart(14)}`);
  }

  // d. Frozen gate
  // pick the smallest positive beta that satisfies ALL of:
  // - race MAE at least 5% below persistence race MAE (raceMaeCents <= 0.95 * persistenceMaeCents)
  // - signal active in at least 2 folds (signalActiveCount >= 2)
  // - at least 2 folds improved versus persistence (improvedCount >= 2)
  // - no fold worsened by more than 0.25 times the persistence race MAE (maxWorsening <= 0.25 * persistenceMaeCents / 100)
  const persRaceMaeCents = betaResults.find(b => b.beta === 0).raceMaeCents;
  let chosenBeta = 0;
  let gateReason = 'Default to beta 0: no positive beta satisfied all frozen gate criteria.';

  const positiveBetas = betaResults.filter(b => b.beta > 0);
  for (const pb of positiveBetas) {
    const cond1 = pb.raceMaeCents <= 0.95 * persRaceMaeCents;
    const cond2 = pb.signalActiveCount >= 2;
    const cond3 = pb.improvedCount >= 2;
    const maxWorseningAllowed = 0.25 * (persRaceMaeCents / 100);
    const cond4 = pb.maxWorsening <= maxWorseningAllowed;

    console.log(`\nEvaluating beta ${pb.beta}:`);
    console.log(`  - MAE <= 95% pers (${pb.raceMaeCents.toFixed(2)} <= ${(0.95 * persRaceMaeCents).toFixed(2)}): ${cond1}`);
    console.log(`  - Signal active >= 2 folds (${pb.signalActiveCount} >= 2): ${cond2}`);
    console.log(`  - Improved >= 2 folds (${pb.improvedCount} >= 2): ${cond3}`);
    console.log(`  - Max worsening <= 0.25 * pers MAE ($${pb.maxWorsening.toFixed(2)} <= $${maxWorseningAllowed.toFixed(2)}): ${cond4}`);

    if (cond1 && cond2 && cond3 && cond4) {
      chosenBeta = pb.beta;
      gateReason = `Selected smallest positive beta ${pb.beta} satisfying all frozen gate criteria.`;
      break;
    }
  }

  console.log(`\nChosen Beta from Race Gate: ${chosenBeta}`);
  console.log(`Gate Reason: ${gateReason}`);

  // e. Practice check (run ONCE for chosen beta only)
  // p00..p04 targets are last price of p01..p05. p05 has no known target, check validity only.
  const practiceOutDir = fs.mkdtempSync(path.join(repoDir, 'practice-out-'));
  const tempPracticeBetaDir = fs.mkdtempSync(path.join(repoDir, `practice-beta-${chosenBeta}-`));
  const modifiedMainPractice = mainTsContent.replace(/const\s+BETA\s*=\s*[^;]+;/g, `const BETA = ${chosenBeta};`);
  const tempPracticeMainPath = path.join(tempPracticeBetaDir, 'main.ts');
  fs.writeFileSync(tempPracticeMainPath, modifiedMainPractice, 'utf8');

  const practiceRes = spawnSync('node', [tempPracticeMainPath], {
    env: {
      ...process.env,
      MAKEFUN_INPUT_DIR: practiceInputdir,
      MAKEFUN_OUTPUT_DIR: practiceOutDir
    },
    encoding: 'utf8'
  });

  if (practiceRes.status !== 0) {
    console.error('Error running practice files:', practiceRes.stderr);
  }

  // Load practice inputs to get persistence prices and targets
  const practiceFiles = ['p00.in', 'p01.in', 'p02.in', 'p03.in', 'p04.in', 'p05.in'];
  const practiceData = [];
  for (let i = 0; i < practiceFiles.length; i++) {
    const fName = practiceFiles[i];
    const raw = fs.readFileSync(path.join(practiceInputdir, fName), 'utf8');
    const parsed = JSON.parse(raw);
    const prices = parsed.markets[0].prices;
    const lastPrice = prices[prices.length - 1];
    practiceData.push({
      caseId: parsed.case,
      persistencePrice: lastPrice
    });
  }

  // Targets for p00..p04
  const scorableTargets = [];
  for (let i = 0; i < 5; i++) {
    // target for p0i is last price of p0(i+1)
    // Wait, let's verify: "targets for p00..p04 are the last price of the NEXT practice file (p01..p05)"
    // p00 target = last price of p01
    // p01 target = last price of p02
    // p02 target = last price of p03
    // p03 target = last price of p04
    // p04 target = last price of p05
    scorableTargets.push(practiceData[i + 1].persistencePrice);
  }

  const chosenPracticeErrors = [];
  const persistencePracticeErrors = [];
  const practiceTableRows = [];

  for (let i = 0; i < 5; i++) {
    const caseId = practiceData[i].caseId;
    const target = scorableTargets[i];
    const persPrice = practiceData[i].persistencePrice;

    const outFile = path.join(practiceOutDir, `${caseId}.out`);
    let forecastPrice = persPrice;
    if (fs.existsSync(outFile)) {
      try {
        const outParsed = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        forecastPrice = outParsed.forecasts[0].price;
      } catch (e) {}
    }

    const chosenErr = Math.abs(forecastPrice - target);
    const persErr = Math.abs(persPrice - target);

    chosenPracticeErrors.push(chosenErr);
    persistencePracticeErrors.push(persErr);

    practiceTableRows.push({
      caseId,
      forecast: forecastPrice,
      persistence: persPrice,
      target,
      chosenErr,
      persErr
    });
  }

  const chosenMaeCents = 100 * (chosenPracticeErrors.reduce((a, b) => a + b, 0) / 5);
  const persMaeCents = 100 * (persistencePracticeErrors.reduce((a, b) => a + b, 0) / 5);
  const worstDollarError = Math.max(...chosenPracticeErrors);

  console.log('\n--- PRACTICE CHECK RESULTS (5 Scorable Cases: p00 - p04) ---');
  console.log('Case | Forecast ($) | Persistence ($) | Target ($) | Chosen Err ($) | Persistence Err ($)');
  console.log('-----------------------------------------------------------------------------------');
  for (const r of practiceTableRows) {
    console.log(`${r.caseId.padEnd(4)} | ${r.forecast.toFixed(2).padStart(12)} | ${r.persistence.toFixed(2).padStart(15)} | ${r.target.toFixed(2).padStart(10)} | ${r.chosenErr.toFixed(2).padStart(14)} | ${r.persErr.toFixed(2).padStart(19)}`);
  }
  console.log(`\nChosen Practice MAE (cents): ${chosenMaeCents.toFixed(2)}`);
  console.log(`Persistence Practice MAE (cents): ${persMaeCents.toFixed(2)}`);
  console.log(`Worst Dollar Error ($): ${worstDollarError.toFixed(2)}`);

  // Practice Gate: chosen MAE at least 2% below persistence AND worst error at most $766.97. If it fails, fall back to beta 0.
  const practiceGateMaeCondition = chosenMaeCents <= 0.98 * persMaeCents;
  const practiceGateWorstErrorCondition = worstDollarError <= 766.97;
  console.log(`\nPractice Gate Checks for Beta ${chosenBeta}:`);
  console.log(`  - MAE at least 2% below persistence (${chosenMaeCents.toFixed(2)} <= ${(0.98 * persMaeCents).toFixed(2)}): ${practiceGateMaeCondition}`);
  console.log(`  - Worst error <= $766.97 ($${worstDollarError.toFixed(2)} <= $766.97): ${practiceGateWorstErrorCondition}`);

  let finalBeta = chosenBeta;
  if (!(practiceGateMaeCondition && practiceGateWorstErrorCondition)) {
    console.log('Practice gate FAILED. Falling back to beta 0.');
    finalBeta = 0;
  } else {
    console.log('Practice gate PASSED.');
  }

  console.log(`\nFINAL DECISION: BETA = ${finalBeta}`);

  // Cleanup temp dirs
  try {
    fs.rmSync(foldsDir, { recursive: true, force: true });
    fs.rmSync(foldOutputsDir, { recursive: true, force: true });
    fs.rmSync(practiceOutDir, { recursive: true, force: true });
  } catch (e) {}
}

main();
