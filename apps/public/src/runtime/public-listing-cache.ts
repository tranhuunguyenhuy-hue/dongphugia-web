/** Only completed public JSON is shared. No request, Promise, socket or timer. */
export class PublicListingCache {
  private entries = new Map<string, { json: string; expires: number }>()
  private chars = 0
  constructor(private maxChars = 4_000_000, private maxEntries = 128, private ttlMs = 30_000) {}

  get(key: string): string | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (entry.expires <= Date.now()) { this.delete(key); return null }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.json
  }
  set(key: string, json: string) {
    this.delete(key)
    if (json.length > this.maxChars) return
    for (const [oldKey, entry] of this.entries) {
      if (entry.expires <= Date.now()) this.delete(oldKey)
    }
    while (this.entries.size >= this.maxEntries || this.chars + json.length > this.maxChars) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.delete(oldest)
    }
    this.entries.set(key, { json, expires: Date.now() + this.ttlMs })
    this.chars += json.length
  }
  delete(key: string) {
    const entry = this.entries.get(key)
    if (entry) this.chars -= entry.json.length
    this.entries.delete(key)
  }
  clear() { this.entries.clear(); this.chars = 0 }
  get size() { return this.entries.size }
  get retainedChars() { return this.chars }
}
// At most ~8 MB of UTF-16 string payload, plus bounded entry overhead.
export const publicListingCache = new PublicListingCache()
