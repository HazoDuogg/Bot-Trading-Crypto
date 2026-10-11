import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name];
}

export const env = {
  binance: {
    url: () => required("BINANCE_URL"),
    testnetUrl: () => required("BINANCE_TESTNET_URL"),
    liveKey: () => optional("BINANCE_LIVE_KEY"),
    liveSecret: () => optional("BINANCE_LIVE_SECRET"),
    testnetKeyEnc: () => optional("BINANCE_TESTNET_KEY_ENC"),
    testnetSecretEnc: () => optional("BINANCE_TESTNET_SECRET_ENC"),
  },
  telegram: {
    botTokenEnc: () => optional("TELEGRAM_BOT_TOKEN_ENC"),
    chatId: () => optional("TELEGRAM_CHAT_ID"),
  },
};
