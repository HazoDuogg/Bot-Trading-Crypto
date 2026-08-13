import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const parse = (file) => {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const header = lines.shift().split(',').map((v) => v.trim());
  return lines.map((line) => Object.fromEntries(line.split(',').map((v, i) => [header[i], v.trim()])));
};
const id = (t) => `${t.symbol}|${t.side}|${t.setupType}|${t.entryTimestamp}`;
const baseline = parse(path.join(root, 'data/g3-runs/G3-CENTRAL-trades.csv'));
const candidate = parse(path.join(root, 'data/g3e-runs/G3E_MOMENTUM_DIRECT_BODY_RATIO_0_5-CENTRAL-trades.csv'));
const bMap = new Map(baseline.map((t) => [id(t), t]));
const cMap = new Map(candidate.map((t) => [id(t), t]));
const forensic = new Map(parse(path.join(root, 'data/g3-false-breakout-forensic.csv')).map((r) => [`${r.symbol}|${r.side}|${r.setupType}|${Date.parse(r.entryIso)}`, r]));
const common = baseline.filter((t) => cMap.has(id(t)));
const suppressed = baseline.filter((t) => !cMap.has(id(t)));
const created = candidate.filter((t) => !bMap.has(id(t)));
const pathDiverged = common.filter((t) => { const c = cMap.get(id(t)); return t.exitTimestamp !== c.exitTimestamp || t.exitReason !== c.exitReason || Math.abs(Number(t.netPnl) - Number(c.netPnl)) > 1e-5; });
const rows = [['classification','symbol','side','setupType','entryTimestamp','exitTimestamp','baselineNetPnl','candidateNetPnl','pathStatus']];
for (const t of common) { const c = cMap.get(id(t)); rows.push(['IDENTICAL',t.symbol,t.side,t.setupType,t.entryTimestamp,t.exitTimestamp,t.netPnl,c.netPnl,pathDiverged.includes(t)?'PATH_DIVERGED':'PATH_SAME']); }
for (const t of suppressed) rows.push(['SUPPRESSED',t.symbol,t.side,t.setupType,t.entryTimestamp,t.exitTimestamp,t.netPnl,'','']);
for (const t of created) rows.push(['CREATED',t.symbol,t.side,t.setupType,t.entryTimestamp,t.exitTimestamp,'',t.netPnl,'']);
fs.writeFileSync(path.join(root, 'data/g3e-trade-reconciliation.csv'), rows.map((r) => r.join(',')).join('\n') + '\n');

const scenarios = ['FEE_ONLY','LIGHT','CENTRAL','CONSERVATIVE'];
const oldRows = parse(path.join(root, 'data/g3-candidate-comparison.csv')).filter((r) => r.challenger === 'E0_CURRENT' && scenarios.includes(r.scenario));
const comparison = [['variant','scenario','trades','winRatePct','profitFactor','netPnl','expectancy','maxDdPct','maxDdUsd','momentumDirectTrades']];
for (const scenario of scenarios) {
  const b = oldRows.find((r) => r.scenario === scenario);
  comparison.push(['BASELINE_OFF',scenario,b.trades,b.winRatePct,b.profitFactor,b.netPnl,b.expectancy,'',b.maxDdUsd, scenario === 'CENTRAL' ? '139' : '']);
  const c = JSON.parse(fs.readFileSync(path.join(root, `data/g3e-runs/G3E_MOMENTUM_DIRECT_BODY_RATIO_0_5-${scenario}-summary.json`)));
  comparison.push(['BODY_RATIO_0_5',scenario,c.trades,c.winRate,c.profitFactor,c.netPnl,c.expectancy,c.maxDdPct,c.maxDdUsd,c.bySetup.MOMENTUM_DIRECT?.n ?? 0]);
}
fs.writeFileSync(path.join(root, 'data/g3e-scenario-comparison.csv'), comparison.map((r) => r.join(',')).join('\n') + '\n');

const months = [...new Set([...baseline, ...candidate].map((t) => new Date(Number(t.entryTimestamp)).toISOString().slice(0,7)))];
const sum = (xs) => xs.reduce((a,t) => a + Number(t.netPnl), 0);
const lomo = months.map((m) => ({ month:m, delta: sum(candidate.filter(t=>!new Date(Number(t.entryTimestamp)).toISOString().startsWith(m))) - sum(baseline.filter(t=>!new Date(Number(t.entryTimestamp)).toISOString().startsWith(m))) }));
const suppressedMd = suppressed.filter((t) => t.setupType === 'MOMENTUM_DIRECT');
const falseBlocked = suppressedMd.filter((t) => { const f=forensic.get(id(t)); return f?.breakKind === 'WICK' && f?.returnedThroughEntryWithin6 === 'YES'; });
const goodLost = suppressedMd.filter((t) => Number(t.netPnl) > 0);
const danger = [...fs.readFileSync(path.join(root,'data/danger-zone-log.txt'),'utf8').matchAll(/symbol=(\w+) timestamp=([^\s]+)/g)].map((m)=>({symbol:m[1],ts:Date.parse(m[2])}));
const manipulated = [...fs.readFileSync(path.join(root,'data/manipulated-log.txt'),'utf8').matchAll(/symbol=(\w+) timestamp=([^\s]+)/g)].map((m)=>({symbol:m[1],ts:Date.parse(m[2])}));
const inWindow = (t, events, hours) => events.some((e)=>e.symbol===t.symbol && Number(t.entryTimestamp)>=e.ts && Number(t.entryTimestamp)-e.ts<=hours*3600000);
const windowStats = (trades, events, hours) => { const x=trades.filter(t=>inWindow(t,events,hours)); return {n:x.length,losers:x.filter(t=>Number(t.netPnl)<0).length,net:sum(x)}; };
const extremes = (trades) => [...trades].sort((a,b)=>Math.abs(Number(b.netPnl))-Math.abs(Number(a.netPnl))).slice(0,5).map(t=>Number(t.netPnl));
const report = { common:common.length, suppressed:suppressed.length, created:created.length, pathDiverged:pathDiverged.length, baselineNet:sum(baseline), candidateNet:sum(candidate), reconciliationResidual:sum(candidate)-sum(baseline)+sum(suppressed)-sum(created), baselineMd:baseline.filter(t=>t.setupType==='MOMENTUM_DIRECT').length, candidateMd:candidate.filter(t=>t.setupType==='MOMENTUM_DIRECT').length, mdRetention:candidate.filter(t=>t.setupType==='MOMENTUM_DIRECT').length/baseline.filter(t=>t.setupType==='MOMENTUM_DIRECT').length, falseBreakoutsBlocked:falseBlocked.length, falseBreakoutsBlockedNet:sum(falseBlocked), goodCandidatesLost:goodLost.length, goodCandidatesLostNet:sum(goodLost), lomo, extremeBaseline:extremes(baseline), extremeCandidate:extremes(candidate), dangerBaseline:windowStats(baseline,danger,72), dangerCandidate:windowStats(candidate,danger,72), manipulatedBaseline:windowStats(baseline,manipulated,24), manipulatedCandidate:windowStats(candidate,manipulated,24) };
fs.writeFileSync(path.join(root,'data/g3e-analysis.json'),JSON.stringify(report,null,2)+'\n');
