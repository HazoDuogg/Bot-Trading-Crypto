import { createOrchestrator } from "./core/orchestrator.js";
import { detectRegime } from "./regime/regimeDetector.js";
import { detectDirection } from "./direction/directionFilter.js";
import { detectEntry } from "./entry/entryRouter.js";
import { sizePosition } from "./risk/positionSizer.js";
import { manageExit } from "./exit/exitManager.js";

const orchestrator = createOrchestrator({
  detectRegime,
  detectDirection,
  detectEntry,
  sizePosition: (signal) => sizePosition(signal as never, 0),
  manageExit: (position, candle) => manageExit(position as never, candle),
});

void orchestrator;
