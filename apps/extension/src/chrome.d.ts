declare const chrome: { storage: { local: { get(k: string[]): Promise<Record<string, unknown>>; set(o: Record<string, unknown>): Promise<void> } } };
