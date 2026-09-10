"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
require("dotenv/config");
function required(name) {
    var value = process.env[name];
    if (!value) {
        throw new Error("Missing required env var: ".concat(name));
    }
    return value;
}
function optional(name) {
    return process.env[name];
}
exports.env = {
    binance: {
        url: function () { return required("BINANCE_URL"); },
        testnetUrl: function () { return required("BINANCE_TESTNET_URL"); },
        liveKey: function () { return optional("BINANCE_LIVE_KEY"); },
        liveSecret: function () { return optional("BINANCE_LIVE_SECRET"); },
        testnetKeyEnc: function () { return optional("BINANCE_TESTNET_KEY_ENC"); },
        testnetSecretEnc: function () { return optional("BINANCE_TESTNET_SECRET_ENC"); },
    },
    telegram: {
        botTokenEnc: function () { return optional("TELEGRAM_BOT_TOKEN_ENC"); },
        chatId: function () { return optional("TELEGRAM_CHAT_ID"); },
    },
};
