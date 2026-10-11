import { createOrchestrator } from "./core/orchestrator.js";

const INITIAL_EQUITY = 10_000; // placeholder starting balance; wiring to a real account is a later ticket

export const orchestrator = createOrchestrator(INITIAL_EQUITY);
