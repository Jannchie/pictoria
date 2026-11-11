/**
 * The grading page's deck, as pure state transitions — the view owns the
 * network and the keys, this owns "what is on screen and what did you give it".
 *
 * A deck only grows: cards the user has passed stay in it so ← can go back and
 * fix a slip. `given` is the grade given *this session*; `previous` and `model`
 * are what the page reveals once a grade is in (the grading is blind).
 */
import type { GradingCardPublic } from '@/api'

export interface GradingCard extends GradingCardPublic {
  /** The grade given in this session; absent until graded. */
  given?: number
}

export interface GradingDeck {
  cards: GradingCard[]
  index: number
}

export const EMPTY_DECK: GradingDeck = { cards: [], index: 0 }

/** Refill when this few ungraded cards are left ahead of the cursor. */
export const LOW_WATER = 8

/** Append a fetched batch, dropping pictures the deck already holds. */
export function appendCards(deck: GradingDeck, batch: GradingCardPublic[]): GradingDeck {
  const held = new Set(deck.cards.map(c => c.post.id))
  const fresh = batch.filter((c) => {
    if (held.has(c.post.id)) {
      return false
    }
    held.add(c.post.id)
    return true
  })
  return fresh.length > 0 ? { ...deck, cards: [...deck.cards, ...fresh] } : deck
}

/** Move the cursor by `delta`, clamped to the deck. */
export function step(deck: GradingDeck, delta: number): GradingDeck {
  const index = Math.min(Math.max(deck.index + delta, 0), Math.max(deck.cards.length - 1, 0))
  return index === deck.index ? deck : { ...deck, index }
}

/** Record a grade on the card under the cursor and move on to the next one. */
export function grade(deck: GradingDeck, value: number): GradingDeck {
  const card = deck.cards[deck.index]
  if (!card) {
    return deck
  }
  const cards = deck.cards.with(deck.index, { ...card, given: value })
  return step({ ...deck, cards }, 1)
}

/** Put a card's grade back to what it was (the write failed). */
export function restoreGrade(deck: GradingDeck, postId: number, given: number | undefined): GradingDeck {
  const at = deck.cards.findIndex(c => c.post.id === postId)
  if (at === -1) {
    return deck
  }
  return { ...deck, cards: deck.cards.with(at, { ...deck.cards[at], given }) }
}

export function needsRefill(deck: GradingDeck): boolean {
  return deck.cards.length - deck.index <= LOW_WATER
}

/**
 * The `source` a grade is written with. Only a card's FIRST grade in a session
 * is a blind judgement; going back to fix it happens with the previous grade
 * and the model's on screen, so it is written as an ordinary correction
 * (no source) and stays out of the agreement figures.
 */
export function gradeSource(card: GradingCard): `grade:${GradingCard['reason']}` | undefined {
  return card.given === undefined ? `grade:${card.reason}` : undefined
}

export type Verdict = 'same' | 'near' | 'far'

/** How a revealed grade compares with the one just given. */
export function verdict(given: number, other: number): Verdict {
  const gap = Math.abs(given - other)
  return gap === 0 ? 'same' : (gap === 1 ? 'near' : 'far')
}
