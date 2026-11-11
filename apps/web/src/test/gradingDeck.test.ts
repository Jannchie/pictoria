import type { GradingCardPublic } from '@/api'
import { describe, expect, it } from 'vitest'
import { appendCards, EMPTY_DECK, grade, gradeSource, needsRefill, restoreGrade, step, verdict } from '@/shared/gradingDeck'

function card(id: number, reason: GradingCardPublic['reason'] = 'new', previous = 0): GradingCardPublic {
  return { post: { id, filePath: 'd', fileName: `f${id}`, extension: 'jpg', sha256: '', width: 1, height: 1 }, reason, previous, model: 3 }
}

const deckOf = (...ids: number[]) => appendCards(EMPTY_DECK, ids.map(id => card(id)))

describe('gradingdeck', () => {
  it('appending skips pictures already in the deck', () => {
    const deck = appendCards(deckOf(1, 2), [card(2), card(3), card(3)])

    expect(deck.cards.map(c => c.post.id)).toEqual([1, 2, 3])
  })

  it('grading records the grade and moves to the next card', () => {
    const deck = grade(deckOf(1, 2), 4)

    expect(deck.cards[0].given).toBe(4)
    expect(deck.index).toBe(1)
  })

  it('grading the last card keeps the cursor on it', () => {
    const deck = grade(deckOf(1), 5)

    expect(deck.index).toBe(0)
    expect(deck.cards[0].given).toBe(5)
  })

  it('stepping is clamped to the deck', () => {
    const deck = deckOf(1, 2)

    expect(step(deck, -1).index).toBe(0)
    expect(step(step(deck, 1), 1).index).toBe(1)
  })

  it('a failed write puts the old grade back without moving the cursor', () => {
    const graded = grade(deckOf(1, 2), 4)

    const restored = restoreGrade(graded, 1, undefined)

    expect(restored.cards[0].given).toBeUndefined()
    expect(restored.index).toBe(1)
  })

  it('asks for more cards near the end of the deck', () => {
    const ids = Array.from({ length: 20 }, (_, i) => i + 1)

    expect(needsRefill(deckOf(...ids))).toBe(false)
    expect(needsRefill(step(deckOf(...ids), 12))).toBe(true)
    expect(needsRefill(EMPTY_DECK)).toBe(true)
  })

  it('only the first grade of a card is written as a blind judgement', () => {
    const deck = appendCards(EMPTY_DECK, [card(1, 'suspect', 4)])

    expect(gradeSource(deck.cards[0])).toBe('grade:suspect')
    expect(gradeSource(grade(deck, 3).cards[0])).toBeUndefined()
  })

  it('verdict grades the gap between two grades', () => {
    expect([verdict(4, 4), verdict(4, 3), verdict(5, 2)]).toEqual(['same', 'near', 'far'])
  })
})
