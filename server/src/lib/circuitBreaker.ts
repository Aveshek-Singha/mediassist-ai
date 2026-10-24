export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private halfOpenProbe = false;

  constructor(private readonly failureThreshold = 5, private readonly resetAfterMs = 30_000) {}

  get state(): 'closed' | 'open' | 'half-open' {
    if (!this.openedAt) return 'closed';
    if (Date.now() - this.openedAt < this.resetAfterMs) return 'open';
    return 'half-open';
  }

  enter(): void {
    if (this.state === 'open') throw new Error('MediBook circuit is open. Try again shortly.');
    if (this.state === 'half-open') {
      if (this.halfOpenProbe) throw new Error('MediBook circuit is checking recovery. Try again shortly.');
      this.halfOpenProbe = true;
    }
  }

  success(): void {
    this.failures = 0;
    this.openedAt = 0;
    this.halfOpenProbe = false;
  }

  failure(): void {
    this.halfOpenProbe = false;
    this.failures += 1;
    if (this.state === 'half-open' || this.failures >= this.failureThreshold) this.openedAt = Date.now();
  }
}
