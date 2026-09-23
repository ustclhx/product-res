/** Retain unknown-outcome attempts; retire only after a definitive server response. */
export class CommandKeys {
  private pending = new Map<string, string>();
  begin(identity: string, create: () => string, explicit?: string): string {
    const key = explicit ?? this.pending.get(identity) ?? create();
    this.pending.set(identity, key);
    return key;
  }
  settle(identity: string, status: number): void {
    if (status < 500) this.pending.delete(identity);
  }
}
