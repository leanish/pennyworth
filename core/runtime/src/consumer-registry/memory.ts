import type { ConsumerRecord, ConsumerRegistry } from "./store.js";

/** In-memory `ConsumerRegistry` for tests and small local-mode setups. */
export class MemoryConsumerRegistry implements ConsumerRegistry {
  readonly #records = new Map<string, ConsumerRecord>();

  constructor(seed: ReadonlyArray<ConsumerRecord> = []) {
    for (const record of seed) {
      this.#records.set(record.consumerId, record);
    }
  }

  async get(consumerId: string): Promise<ConsumerRecord | undefined> {
    return this.#records.get(consumerId);
  }

  async put(record: ConsumerRecord): Promise<void> {
    this.#records.set(record.consumerId, record);
  }
}
