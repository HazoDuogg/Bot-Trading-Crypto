import { createOrchestrator } from "./core/orchestrator.js";
import { detectRegime } from "./regime/regimeDetector.js";
import { detectDirectionBias } from "./direction/directionFilter.js";
import { detectEntry } from "./entry/entryRouter.js";
import { computeOrderSizes } from "./risk/positionSizer.js";
import { checkExit } from "./exit/exitManager.js";

const orchestrator = createOrchestrator({
  detectRegime,
  detectDirection: detectDirectionBias,
  detectEntry,
  sizePosition: (signal) => computeOrderSizes(signal as never, "UP", 0, 0, 0),
  manageExit: (position, direction, candle) => checkExit(position as never, direction, candle),
});

void orchestrator;
