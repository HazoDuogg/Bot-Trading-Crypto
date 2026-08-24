import { findSwingPoints } from '../regime/swingPoints.js';
import type { Candle, SwingPoint } from '../regime/types.js';

export interface KeyZone {
  price: number;
  touchCount: number;
  type: 'support' | 'resistance';
  lastTouchIndex: number;
}

export interface KeyZoneConfig {
  swingPivotWidth: number;
  clusterToleranceAtrMultiplier: number; // TODO_CONFIRM
  minTouches: number; // TODO_CONFIRM, placeholder 2 per ticket
  maxZoneAgeCandles: number; // TODO_CONFIRM
}

// Single-linkage clustering along price, within one swing type at a time: sort by price ascending,
// start a new cluster whenever the gap to the previous point exceeds tolerance. "Age" of a zone is
// measured from the END of h1Candles (the caller's current point in time) — no separate "now" param
// needed since h1Candles is always the truncated, no-look-ahead window up to the current H1 close.
export function findKeyZones(h1Candles: Candle[], atrH1: number, config: KeyZoneConfig): KeyZone[] {
  if (atrH1 <= 0 || h1Candles.length === 0) return [];

  const swings = findSwingPoints(h1Candles, config.swingPivotWidth);
  const now = h1Candles.length - 1;
  const tolerance = config.clusterToleranceAtrMultiplier * atrH1;

  const zones: KeyZone[] = [];
  const types: Array<{ swingType: 'high' | 'low'; zoneType: KeyZone['type'] }> = [
    { swingType: 'high', zoneType: 'resistance' },
    { swingType: 'low', zoneType: 'support' },
  ];

  for (const { swingType, zoneType } of types) {
    const points = swings.filter((p) => p.type === swingType).sort((a, b) => a.price - b.price);

    let cluster: SwingPoint[] = [];
    const flush = () => {
      if (cluster.length === 0) return;
      const avgPrice = cluster.reduce((sum, p) => sum + p.price, 0) / cluster.length;
      const lastTouchIndex = Math.max(...cluster.map((p) => p.index));
      if (cluster.length >= config.minTouches && now - lastTouchIndex <= config.maxZoneAgeCandles) {
        zones.push({ price: avgPrice, touchCount: cluster.length, type: zoneType, lastTouchIndex });
      }
      cluster = [];
    };

    for (const p of points) {
      if (cluster.length === 0 || p.price - cluster[cluster.length - 1].price <= tolerance) {
        cluster.push(p);
      } else {
        flush();
        cluster.push(p);
      }
    }
    flush();
  }

  return zones;
}
