/**
 * A size-bounded Map kept in recency order: a hit moves to the end, and once
 * the size passes `limit` the least recently used entry is evicted.
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>()
  private readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  get size(): number {
    return this.map.size
  }

  get(key: K): V | undefined {
    const value = this.map.get(key)
    if (value !== undefined) {
      this.map.delete(key)
      this.map.set(key, value)
    }
    return value
  }

  set(key: K, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.limit) {
      // Map iterates in insertion order, so the first key is the least recent.
      this.map.delete(this.map.keys().next().value as K)
    }
  }
}
