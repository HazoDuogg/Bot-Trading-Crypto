import type { SwingPoint } from './types.js';

export type StructureBias = 'HH_HL' | 'LH_LL' | 'UNCLEAR';

// Compares the last two swing highs and last two swing lows to classify market structure.
export function classifyStructure(swingPoints: SwingPoint[]): StructureBias {
  const highs = swingPoints.filter((p) => p.type === 'high');
  const lows = swingPoints.filter((p) => p.type === 'low');
  if (highs.length < 2 || lows.length < 2) return 'UNCLEAR';

  const lastTwoHighs = highs.slice(-2);
  const lastTwoLows = lows.slice(-2);
  const higherHigh = lastTwoHighs[1].price > lastTwoHighs[0].price;
  const higherLow = lastTwoLows[1].price > lastTwoLows[0].price;
  const lowerHigh = lastTwoHighs[1].price < lastTwoHighs[0].price;
  const lowerLow = lastTwoLows[1].price < lastTwoLows[0].price;

  if (higherHigh && higherLow) return 'HH_HL';
  if (lowerHigh && lowerLow) return 'LH_LL';
  return 'UNCLEAR';
}
