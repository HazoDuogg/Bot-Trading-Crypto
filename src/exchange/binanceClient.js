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
exports.createBinanceClient = createBinanceClient;
var env_js_1 = require("../config/env.js");
var MAX_KLINES_LIMIT = 1500;
function createBinanceClient(baseUrl) {
    if (baseUrl === void 0) { baseUrl = env_js_1.env.binance.url(); }
    return {
        getCandles: function (symbol_1, interval_1) {
            return __awaiter(this, arguments, void 0, function (symbol, interval, options) {
                var _a, limit, startTime, endTime, url, res, raw;
                if (options === void 0) { options = {}; }
                return __generator(this, function (_b) {
                    switch (_b.label) {
                        case 0:
                            _a = options.limit, limit = _a === void 0 ? MAX_KLINES_LIMIT : _a, startTime = options.startTime, endTime = options.endTime;
                            url = new URL("/fapi/v1/klines", baseUrl);
                            url.searchParams.set("symbol", symbol);
                            url.searchParams.set("interval", interval);
                            url.searchParams.set("limit", String(limit));
                            if (startTime !== undefined)
                                url.searchParams.set("startTime", String(startTime));
                            if (endTime !== undefined)
                                url.searchParams.set("endTime", String(endTime));
                            return [4 /*yield*/, fetchWithRetry(url)];
                        case 1:
                            res = _b.sent();
                            return [4 /*yield*/, res.json()];
                        case 2:
                            raw = (_b.sent());
                            return [2 /*return*/, raw.map(toCandle)];
                    }
                });
            });
        },
        placeOrder: function () {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    throw new Error("not implemented");
                });
            });
        },
    };
}
function toCandle(raw) {
    return {
        openTime: Number(raw[0]),
        open: Number(raw[1]),
        high: Number(raw[2]),
        low: Number(raw[3]),
        close: Number(raw[4]),
        volume: Number(raw[5]),
        closeTime: Number(raw[6]),
    };
}
function fetchWithRetry(url_1) {
    return __awaiter(this, arguments, void 0, function (url, attempt) {
        var res, retryAfterSec, body;
        if (attempt === void 0) { attempt = 0; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, fetch(url)];
                case 1:
                    res = _a.sent();
                    if (!(res.status === 429 || res.status === 418)) return [3 /*break*/, 3];
                    if (attempt >= 5) {
                        throw new Error("Binance rate-limited after ".concat(attempt, " retries (").concat(res.status, "): ").concat(url.toString()));
                    }
                    retryAfterSec = Number(res.headers.get("retry-after")) || Math.pow(2, attempt);
                    return [4 /*yield*/, sleep(retryAfterSec * 1000)];
                case 2:
                    _a.sent();
                    return [2 /*return*/, fetchWithRetry(url, attempt + 1)];
                case 3:
                    if (!!res.ok) return [3 /*break*/, 5];
                    return [4 /*yield*/, res.text().catch(function () { return ""; })];
                case 4:
                    body = _a.sent();
                    throw new Error("Binance request failed ".concat(res.status, " ").concat(res.statusText, ": ").concat(url.toString(), " ").concat(body));
                case 5: return [2 /*return*/, res];
            }
        });
    });
}
function sleep(ms) {
    return new Promise(function (resolve) { return setTimeout(resolve, ms); });
}
