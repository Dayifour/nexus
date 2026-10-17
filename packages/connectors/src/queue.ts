// File asynchrone : un producteur (callbacks du processus) alimente un consommateur `for await`.
// Mémoire bornée en amont : le superviseur de processus arrête la CLI au-delà de `maxOutputBytes` (pas de
// contre-pression possible sur des callbacks synchrones sans mettre en pause la sortie du processus).

export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters: Array<(r: IteratorResult<T>) => void> = [];
  #done = false;
  /** Le consommateur a cessé de lire (`break`, exception) : la suite est ignorée au lieu de s'accumuler. */
  #closed = false;
  readonly #onReturn: (() => void) | undefined;

  /** `onReturn` : appelé quand le consommateur abandonne la lecture (ex. arrêter le processus producteur). */
  constructor(opts: { onReturn?: () => void } = {}) {
    this.#onReturn = opts.onReturn;
  }

  get closed(): boolean {
    return this.#closed;
  }

  push(item: T): void {
    if (this.#done || this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
  }

  end(): void {
    this.#done = true;
    for (const w of this.#waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
      return: () => {
        this.#closed = true;
        this.#items.length = 0;
        for (const w of this.#waiters.splice(0)) w({ value: undefined, done: true });
        if (!this.#done) this.#onReturn?.();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
