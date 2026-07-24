/**
 * TICKET-076 Phần D — đối soát định kỳ số dư/vị thế THẬT trên sàn với trạng thái bot lưu nội bộ.
 * Chỉ LOG khi lệch — không bao giờ tự "sửa" trạng thái nội bộ hay gọi lệnh nào để khớp lại với sàn
 * (nguyên nhân lệch có thể là: bot lỗi, lệnh SL/TP khớp mà bot chưa nhận kịp, thao tác tay trên sàn,
 * hoặc floating PNL/phí — mỗi trường hợp cần xử lý khác nhau, không thể đoán và tự sửa một chiều).
 */
import type { BinanceOrderExecutor, PositionSide } from './binanceOrderExecutor.js';

export interface InternalPositionSnapshot {
  symbol: string;
  side: PositionSide;
  quantity: number;
}

export interface InternalStateSnapshot {
  balanceUsd: number;
  positions: InternalPositionSnapshot[];
}

export interface ExchangePositionSnapshot {
  symbol: string;
  side: PositionSide;
  quantity: number;
}

export type MismatchType = 'BALANCE_MISMATCH' | 'POSITION_MISSING_INTERNALLY' | 'POSITION_MISSING_ON_EXCHANGE' | 'POSITION_SIDE_MISMATCH' | 'POSITION_SIZE_MISMATCH';

export interface ReconciliationMismatch {
  type: MismatchType;
  detail: string;
}

export interface ReconciliationResult {
  timestamp: number;
  mismatches: ReconciliationMismatch[];
  exchangeBalanceUsd: number;
  internalBalanceUsd: number;
  exchangePositions: ExchangePositionSnapshot[];
  internalPositions: InternalPositionSnapshot[];
}

export interface StateReconcilerConfig {
  executor: Pick<BinanceOrderExecutor, 'getAccountInfo' | 'getPositionRisk'>;
  getInternalState: () => InternalStateSnapshot;
  intervalMs?: number; // ticket: "mỗi 5-10 phút" — default giữa khoảng đó
  // TODO_CONFIRM (PM): dung sai so sánh balance — floating PNL/phí funding khiến balance sàn dao
  // động liên tục dù bot không lệch gì; 1% (gợi ý kỹ thuật, chưa phải số PM chốt) tránh báo động giả
  // liên tục nhưng vẫn bắt được lệch thật.
  balanceTolerancePct?: number;
  // TODO_CONFIRM (PM): dung sai so sánh khối lượng vị thế — chênh lệch làm tròn lot size sàn.
  quantityTolerance?: number;
  onMismatch?: (result: ReconciliationResult) => void;
  onClean?: (result: ReconciliationResult) => void;
  onError?: (err: Error) => void;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

const DEFAULT_INTERVAL_MS = 7 * 60_000; // 7 phút — giữa khoảng "5-10 phút" ticket yêu cầu
const DEFAULT_BALANCE_TOLERANCE_PCT = 0.01; // TODO_CONFIRM, xem doc field ở trên
const DEFAULT_QUANTITY_TOLERANCE = 1e-8;

interface RawAccountInfo {
  totalWalletBalance?: string;
}

interface RawPositionRiskEntry {
  symbol?: string;
  positionAmt?: string;
}

function parseExchangeBalance(raw: unknown): number {
  const body = raw as RawAccountInfo;
  const v = Number(body?.totalWalletBalance);
  if (!Number.isFinite(v)) throw new Error(`stateReconciler: không đọc được totalWalletBalance từ getAccountInfo(): ${JSON.stringify(raw)}`);
  return v;
}

function parseExchangePositions(raw: unknown): ExchangePositionSnapshot[] {
  const entries = raw as RawPositionRiskEntry[];
  if (!Array.isArray(entries)) throw new Error(`stateReconciler: getPositionRisk() không trả về mảng: ${JSON.stringify(raw)}`);
  return entries
    .map((e) => ({ symbol: e.symbol ?? '', amt: Number(e.positionAmt) }))
    .filter((e) => Number.isFinite(e.amt) && e.amt !== 0)
    .map((e) => ({ symbol: e.symbol, side: (e.amt > 0 ? 'LONG' : 'SHORT') as PositionSide, quantity: Math.abs(e.amt) }));
}

export function compareStates(
  exchangeBalanceUsd: number,
  exchangePositions: ExchangePositionSnapshot[],
  internal: InternalStateSnapshot,
  balanceTolerancePct: number,
  quantityTolerance: number,
): ReconciliationMismatch[] {
  const mismatches: ReconciliationMismatch[] = [];

  const balanceDiff = Math.abs(exchangeBalanceUsd - internal.balanceUsd);
  const balanceToleranceUsd = Math.max(exchangeBalanceUsd, internal.balanceUsd) * balanceTolerancePct;
  if (balanceDiff > balanceToleranceUsd) {
    mismatches.push({
      type: 'BALANCE_MISMATCH',
      detail: `Sàn=${exchangeBalanceUsd.toFixed(2)} USD, nội bộ=${internal.balanceUsd.toFixed(2)} USD, lệch=${balanceDiff.toFixed(2)} USD (dung sai ${(balanceTolerancePct * 100).toFixed(1)}%)`,
    });
  }

  const exchangeBySymbol = new Map(exchangePositions.map((p) => [p.symbol, p]));
  const internalBySymbol = new Map(internal.positions.map((p) => [p.symbol, p]));
  const allSymbols = new Set([...exchangeBySymbol.keys(), ...internalBySymbol.keys()]);

  for (const symbol of allSymbols) {
    const ex = exchangeBySymbol.get(symbol);
    const int = internalBySymbol.get(symbol);

    if (ex && !int) {
      mismatches.push({ type: 'POSITION_MISSING_INTERNALLY', detail: `${symbol}: sàn có vị thế ${ex.side} qty=${ex.quantity}, nội bộ KHÔNG có — có thể là lệnh tay trên sàn hoặc bot bỏ sót` });
      continue;
    }
    if (int && !ex) {
      mismatches.push({ type: 'POSITION_MISSING_ON_EXCHANGE', detail: `${symbol}: nội bộ nghĩ đang có vị thế ${int.side} qty=${int.quantity}, sàn KHÔNG có — có thể đã bị SL/TP khớp mà bot chưa cập nhật` });
      continue;
    }
    if (ex && int) {
      if (ex.side !== int.side) {
        mismatches.push({ type: 'POSITION_SIDE_MISMATCH', detail: `${symbol}: sàn=${ex.side}, nội bộ=${int.side}` });
      } else if (Math.abs(ex.quantity - int.quantity) > quantityTolerance) {
        mismatches.push({ type: 'POSITION_SIZE_MISMATCH', detail: `${symbol} (${ex.side}): sàn qty=${ex.quantity}, nội bộ qty=${int.quantity}, lệch=${Math.abs(ex.quantity - int.quantity)}` });
      }
    }
  }

  return mismatches;
}

/** Đối soát định kỳ — chỉ đọc (getAccountInfo/getPositionRisk luôn được phép, không bị chặn bởi dryRun) và log, không bao giờ ghi/sửa gì. */
export class StateReconciler {
  private readonly config: Required<Pick<StateReconcilerConfig, 'executor' | 'getInternalState' | 'intervalMs' | 'balanceTolerancePct' | 'quantityTolerance' | 'setIntervalFn' | 'clearIntervalFn'>> &
    Pick<StateReconcilerConfig, 'onMismatch' | 'onClean' | 'onError'>;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: StateReconcilerConfig) {
    this.config = {
      executor: config.executor,
      getInternalState: config.getInternalState,
      intervalMs: config.intervalMs ?? DEFAULT_INTERVAL_MS,
      balanceTolerancePct: config.balanceTolerancePct ?? DEFAULT_BALANCE_TOLERANCE_PCT,
      quantityTolerance: config.quantityTolerance ?? DEFAULT_QUANTITY_TOLERANCE,
      onMismatch: config.onMismatch,
      onClean: config.onClean,
      onError: config.onError,
      setIntervalFn: config.setIntervalFn ?? setInterval,
      clearIntervalFn: config.clearIntervalFn ?? clearInterval,
    };
  }

  async reconcileOnce(): Promise<ReconciliationResult> {
    const [accountRaw, positionRiskRaw] = await Promise.all([this.config.executor.getAccountInfo(), this.config.executor.getPositionRisk()]);
    const exchangeBalanceUsd = parseExchangeBalance(accountRaw);
    const exchangePositions = parseExchangePositions(positionRiskRaw);
    const internal = this.config.getInternalState();

    const mismatches = compareStates(exchangeBalanceUsd, exchangePositions, internal, this.config.balanceTolerancePct, this.config.quantityTolerance);

    const result: ReconciliationResult = {
      timestamp: Date.now(),
      mismatches,
      exchangeBalanceUsd,
      internalBalanceUsd: internal.balanceUsd,
      exchangePositions,
      internalPositions: internal.positions,
    };

    if (mismatches.length > 0) {
      console.warn(`[stateReconciler] LỆCH TRẠNG THÁI (${mismatches.length}): ${mismatches.map((m) => `${m.type}: ${m.detail}`).join(' | ')}`);
      this.config.onMismatch?.(result);
    } else {
      this.config.onClean?.(result);
    }
    return result;
  }

  private async tick(): Promise<void> {
    try {
      await this.reconcileOnce();
    } catch (err) {
      console.error(`[stateReconciler] lỗi khi đối soát: ${(err as Error).message}`);
      this.config.onError?.(err as Error);
    }
  }

  start(): void {
    if (this.timer) return;
    void this.tick(); // đối soát ngay lần đầu, không chờ hết chu kỳ
    this.timer = this.config.setIntervalFn(() => void this.tick(), this.config.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      this.config.clearIntervalFn(this.timer);
      this.timer = null;
    }
  }
}
