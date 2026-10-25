import { describe, it, expect } from 'vitest';
import { describeScreen, describeCart, describeHelp } from './voiceScreen';

/**
 * The sentences are asserted as KEYS, not as English.
 *
 * What is worth pinning is which answer a screen produces and which facts
 * travel with it — the wording lives in `translations.js` and changes there
 * without these tests having an opinion. Asserting the English would make
 * every copy edit a failing test, which teaches everyone to re-record the
 * snapshot without reading it.
 */
const t = (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
const keyOf = (sentence) => String(sentence).split(' ')[0];

describe('describeScreen', () => {
  it('names the tab', () => {
    expect(describeScreen({ tab: 'prices' }, t)).toBe('voice.screen.prices');
    expect(describeScreen({ tab: 'orders' }, t)).toBe('voice.screen.orders');
    expect(describeScreen({ tab: 'account' }, t)).toBe('voice.screen.account');
  });

  it('says which market the home screen is showing', () => {
    expect(describeScreen({ tab: 'home', marketName: 'Rythu Bazaar' }, t)).toBe(
      'voice.screen.homeAt {"market":"Rythu Bazaar"}'
    );
  });

  it('describes what is open OVER the tab, not the tab', () => {
    const sentence = describeScreen({ tab: 'home', product: true, productName: 'Tomato' }, t);
    expect(sentence).toBe('voice.screen.productNamed {"name":"Tomato"}');
  });

  it('prefers the topmost layer', () => {
    // Sign-in is over everything, including a basket left open behind it.
    expect(keyOf(describeScreen({ tab: 'home', basket: true, signIn: true }, t))).toBe('voice.screen.signIn');
  });

  it('says what was searched for', () => {
    expect(describeScreen({ tab: 'home', search: true, query: 'palak' }, t)).toBe(
      'voice.screen.searchFor {"query":"palak"}'
    );
    expect(describeScreen({ tab: 'home', search: true }, t)).toBe('voice.screen.search');
  });

  it('answers something for a screen it does not know', () => {
    // Silence is the one answer a voice agent must never give.
    expect(describeScreen({}, t)).toBe('voice.screen.unknown');
    expect(describeScreen({ tab: 'nowhere' }, t)).toBe('voice.screen.unknown');
  });

  it('reads the cart when the cart is the screen', () => {
    expect(describeScreen({ tab: 'cart', cartLines: [] }, t)).toBe('voice.cart.empty');
  });
});

describe('describeCart', () => {
  it('says the cart is empty', () => {
    expect(describeCart({ cartLines: [] }, t)).toBe('voice.cart.empty');
  });

  it('names every line of a short cart, with the total', () => {
    const sentence = describeCart(
      { cartLines: [{ name: 'Tomato', quantity: 2 }, { name: 'Onion', quantity: 1 }], cartTotalPaise: 8500 },
      t
    );
    expect(sentence).toBe(
      'voice.cart.all {"items":"voice.cart.line {\\"name\\":\\"Tomato\\",\\"count\\":2}, Onion","total":"85"}'
    );
  });

  it('summarises a long cart and still counts it exactly', () => {
    const lines = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({ name, quantity: 1 }));
    const sentence = describeCart({ cartLines: lines, cartTotalPaise: 12350 }, t);
    expect(sentence).toBe('voice.cart.someAndMore {"items":"a, b, c, d","more":2,"total":"123.50"}');
  });

  it('says rupees the way a person says them', () => {
    expect(describeCart({ cartLines: [{ name: 'Okra' }], cartTotalPaise: 4000 }, t)).toContain('"total":"40"');
    expect(describeCart({ cartLines: [{ name: 'Okra' }], cartTotalPaise: 4050 }, t)).toContain('"total":"40.50"');
  });

  it('treats a missing quantity as one, not as none', () => {
    expect(describeCart({ cartLines: [{ name: 'Okra' }], cartTotalPaise: 100 }, t)).toContain('"items":"Okra"');
  });
});

describe('describeHelp', () => {
  it('describes the mode that is actually on', () => {
    expect(describeHelp('low', t)).toBe('voice.help.low');
    expect(describeHelp('medium', t)).toBe('voice.help.medium');
    expect(describeHelp('high', t)).toBe('voice.help.high');
    expect(describeHelp('off', t)).toBe('voice.help.off');
  });
});
