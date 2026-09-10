export interface Notifier {
  send(message: string): Promise<void>;
}

export function createTelegramNotifier(): Notifier {
  return {
    async send() {
      throw new Error("not implemented");
    },
  };
}
