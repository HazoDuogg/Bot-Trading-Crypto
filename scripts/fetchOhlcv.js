"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var promises_1 = require("node:fs/promises");
var node_path_1 = require("node:path");
var binanceClient_js_1 = require("../src/exchange/binanceClient.js");
// TICKET-05X-REGIME-TEST: BTCUSDT M15/H1/H4, 3 năm (2021-2024), Binance Futures mainnet.
var SYMBOL = "BTCUSDT";
var INTERVALS = ["15m", "1h", "4h"];
var START_TIME = Date.parse("2023-01-01T00:00:00Z");
var END_TIME = Date.parse("2026-01-01T00:00:00Z");
var PAGE_LIMIT = 1500;
var REQUEST_DELAY_MS = 350;
var OUTPUT_DIR = "data";
function sleep(ms) {
    return new Promise(function (resolve) { return setTimeout(resolve, ms); });
}
function fetchRange(client, interval) {
    return __awaiter(this, void 0, void 0, function () {
        var candles, cursor, batch, last;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    candles = [];
                    cursor = START_TIME;
                    _a.label = 1;
                case 1:
                    if (!(cursor < END_TIME)) return [3 /*break*/, 4];
                    return [4 /*yield*/, client.getCandles(SYMBOL, interval, {
                            limit: PAGE_LIMIT,
                            startTime: cursor,
                            endTime: END_TIME,
                        })];
                case 2:
                    batch = _a.sent();
                    if (batch.length === 0)
                        return [3 /*break*/, 4];
                    candles.push.apply(candles, batch);
                    last = batch[batch.length - 1];
                    if (last.closeTime <= cursor)
                        return [3 /*break*/, 4];
                    cursor = last.closeTime + 1;
                    process.stdout.write("\r".concat(interval, ": ").concat(candles.length, " n\u1EBFn, t\u1EDBi ").concat(new Date(cursor).toISOString()));
                    return [4 /*yield*/, sleep(REQUEST_DELAY_MS)];
                case 3:
                    _a.sent();
                    return [3 /*break*/, 1];
                case 4:
                    process.stdout.write("\n");
                    return [2 /*return*/, candles];
            }
        });
    });
}
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var client, _i, INTERVALS_1, interval, candles, outPath;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    client = (0, binanceClient_js_1.createBinanceClient)();
                    return [4 /*yield*/, (0, promises_1.mkdir)(OUTPUT_DIR, { recursive: true })];
                case 1:
                    _a.sent();
                    console.log("Fetching ".concat(SYMBOL, " [").concat(INTERVALS.join(", "), "] t\u1EEB ").concat(new Date(START_TIME).toISOString(), " \u0111\u1EBFn ").concat(new Date(END_TIME).toISOString()));
                    _i = 0, INTERVALS_1 = INTERVALS;
                    _a.label = 2;
                case 2:
                    if (!(_i < INTERVALS_1.length)) return [3 /*break*/, 6];
                    interval = INTERVALS_1[_i];
                    console.log("\n".concat(interval, ":"));
                    return [4 /*yield*/, fetchRange(client, interval)];
                case 3:
                    candles = _a.sent();
                    outPath = node_path_1.default.join(OUTPUT_DIR, "ohlcv-".concat(SYMBOL, "-").concat(interval, ".json"));
                    return [4 /*yield*/, (0, promises_1.writeFile)(outPath, JSON.stringify(candles))];
                case 4:
                    _a.sent();
                    console.log("\u0110\u00E3 l\u01B0u ".concat(candles.length, " n\u1EBFn v\u00E0o ").concat(outPath));
                    _a.label = 5;
                case 5:
                    _i++;
                    return [3 /*break*/, 2];
                case 6: return [2 /*return*/];
            }
        });
    });
}
main().catch(function (err) {
    console.error(err);
    process.exit(1);
});
