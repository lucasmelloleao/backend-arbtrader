export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`Circuit breaker aberto: ${name}`);
    this.name = 'CircuitOpenError';
  }
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  constructor(private readonly name: string, options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.openedAt > 0 && Date.now() - this.openedAt < this.resetTimeoutMs) {
      throw new CircuitOpenError(this.name);
    }
    try {
      const result = await operation();
      this.failures = 0;
      this.openedAt = 0;
      return result;
    } catch (error) {
      this.failures += 1;
      if (this.failures >= this.failureThreshold) this.openedAt = Date.now();
      throw error;
    }
  }
}
