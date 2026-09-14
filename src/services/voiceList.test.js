import { describe, it, expect } from 'vitest';
import { parseSpokenList, mergeItems, isDonePhrase, splitIntoItems } from './voiceList';

/**
 * What one utterance adds to a dictated list. These are the rules a shopper
 * meets out loud, so each case is something a person would actually say.
 */

const catalog = {
  products: [
    { id: 'p1', name: 'Lettuce', categoryId: 'c1' },
    { id: 'p2', name: 'Tomato', categoryId: 'c1' },
    { id: 'p3', name: 'Okra (Bhindi)', categoryId: 'c1' },
  ],
  categories: [{ id: 'c1', title: 'Vegetables' }],
};

describe('parseSpokenList', () => {
  it('takes one spoken item', () => {
    expect(parseSpokenList(['tomato'], catalog)).toEqual({ done: false, items: ['tomato'] });
  });

  it('prefers the guess this market sells over the recogniser’s favourite', () => {
    expect(parseSpokenList(['let us', 'lettuce'], catalog).items).toEqual(['lettuce']);
  });

  it('drops what people say around the item', () => {
    expect(parseSpokenList(['I need tomato.'], catalog).items).toEqual(['tomato']);
  });

  it('splits two items said at once', () => {
    expect(parseSpokenList(['tomato and onion'], catalog).items).toEqual(['tomato', 'onion']);
    expect(parseSpokenList(['milk, bread and eggs'], catalog).items).toEqual(['milk', 'bread', 'eggs']);
  });

  it('treats "done" and its equivalents as tapping OK', () => {
    for (const phrase of ['done', 'OK', 'okay.', "That's all", 'bas', 'हो गया', 'చాలు']) {
      expect(parseSpokenList([phrase], catalog)).toEqual({ done: true, items: [] });
    }
  });

  it('does not mistake an item that starts like "ok" for finishing', () => {
    expect(isDonePhrase('okra')).toBe(false);
    expect(parseSpokenList(['okra'], catalog)).toEqual({ done: false, items: ['okra'] });
  });

  it('adds nothing for filler said between items', () => {
    expect(parseSpokenList(['next'], catalog).items).toEqual([]);
    expect(parseSpokenList(['next item'], catalog).items).toEqual([]);
    expect(parseSpokenList([], catalog)).toEqual({ done: false, items: [] });
  });

  it('keeps items in other scripts rather than erasing them', () => {
    // search's `normalize` is Latin-only; a Telugu item must still reach the list.
    expect(parseSpokenList(['టమాటా'], catalog).items).toEqual(['టమాటా']);
  });
});

describe('mergeItems', () => {
  it('appends in spoken order and skips a repeat', () => {
    expect(mergeItems(['tomato', 'onion'], ['Tomato', 'potato'])).toEqual(['tomato', 'onion', 'potato']);
  });

  it('does not collapse different items in a non-Latin script into one', () => {
    expect(mergeItems(['టమాటా'], ['ఉల్లిపాయ'])).toEqual(['టమాటా', 'ఉల్లిపాయ']);
  });
});

describe('splitIntoItems', () => {
  it('still returns a single item with no separator', () => {
    expect(splitIntoItems('get ginger')).toEqual(['get ginger']);
  });
});
