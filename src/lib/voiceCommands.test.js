import { describe, it, expect } from 'vitest';
import {
  parseVoiceCommand,
  routeVoiceCommand,
  voiceModeAllows,
  extractQuantity,
  normalizeSpoken,
} from './voiceCommands';

/**
 * Things a shopper says to the phone, in the three languages they say them in.
 *
 * Every case here is a sentence somebody would actually speak, not a token
 * exercise — a matcher tuned against invented input passes its own test and
 * fails the market.
 */

const intent = (said) => parseVoiceCommand(said).intent;

describe('navigation', () => {
  it('opens a tab by name', () => {
    expect(parseVoiceCommand('open my cart')).toEqual({ intent: 'navigate', target: 'cart' });
    expect(parseVoiceCommand('show me the prices')).toEqual({ intent: 'navigate', target: 'prices' });
    expect(parseVoiceCommand('go to orders')).toEqual({ intent: 'navigate', target: 'orders' });
  });

  it('understands a bare tab name', () => {
    expect(parseVoiceCommand('offers')).toEqual({ intent: 'navigate', target: 'offers' });
    expect(parseVoiceCommand('account')).toEqual({ intent: 'navigate', target: 'account' });
  });

  it('takes Telugu and Hindi', () => {
    expect(parseVoiceCommand('cart chupu')).toEqual({ intent: 'navigate', target: 'cart' });
    expect(parseVoiceCommand('ధరలు చూపించు')).toEqual({ intent: 'navigate', target: 'prices' });
    expect(parseVoiceCommand('ऑफर दिखाओ')).toEqual({ intent: 'navigate', target: 'offers' });
  });

  it('does not read a named screen as a request to go there', () => {
    // Both of these mention a screen and want an answer, not a journey. The
    // assistant answers a price; the price sheet does not answer "how much".
    expect(intent('what is the price of tomato in the market today')).toBe('cook');
    expect(intent('tomato price enta')).toBe('cook');
  });
});

describe('cart writes', () => {
  it('adds a named item with a count', () => {
    expect(parseVoiceCommand('add two kg tomato')).toEqual({
      intent: 'add_item',
      items: [{ quantity: 2, text: 'tomato' }],
    });
  });

  it('defaults to one, never none', () => {
    expect(parseVoiceCommand('add tomato')).toEqual({
      intent: 'add_item',
      items: [{ quantity: 1, text: 'tomato' }],
    });
  });

  it('adds in Telugu', () => {
    expect(parseVoiceCommand('rendu tomato cart loki veyi')).toEqual({
      intent: 'add_item',
      items: [{ quantity: 2, text: 'tomato' }],
    });
  });

  it('keeps each vegetable with its own count', () => {
    // Split before the counts are read, or this asks for two of something
    // called "tomato 1 onion".
    expect(parseVoiceCommand('add 2 kg tomato and 1 kg onion')).toEqual({
      intent: 'add_item',
      items: [
        { quantity: 2, text: 'tomato' },
        { quantity: 1, text: 'onion' },
      ],
    });
  });

  it('drops the polite tail that follows most spoken commands', () => {
    expect(parseVoiceCommand('okati tomato add chey')).toEqual({
      intent: 'add_item',
      items: [{ quantity: 1, text: 'tomato' }],
    });
  });

  it('reads a refusal as a removal, never an addition', () => {
    // Romanised "do" is not a count, and a negated "want" is not a purchase.
    expect(parseVoiceCommand('i do not want tomato')).toEqual({
      intent: 'remove_item',
      items: [{ quantity: 1, text: 'tomato' }],
    });
    expect(parseVoiceCommand('tomato vaddu')).toMatchObject({ intent: 'remove_item' });
  });

  it('removes a named item', () => {
    expect(parseVoiceCommand('remove the onion')).toEqual({
      intent: 'remove_item',
      items: [{ quantity: 1, text: 'onion' }],
    });
    expect(parseVoiceCommand('tomato తీసేయి')).toMatchObject({ intent: 'remove_item' });
  });

  it('empties the cart when the cart or everything is named', () => {
    expect(intent('clear my cart')).toBe('clear_cart');
    expect(intent('खाली करो कार्ट')).toBe('clear_cart');
    expect(intent('remove everything')).toBe('clear_cart');
    // "clear" alone is as likely to be about a recipe as the cart.
    expect(intent('make it clear')).toBe('cook');
  });

  it('does not mistake "address" for "add"', () => {
    expect(intent('change my delivery address')).toBe('cook');
  });

  it('asks the assistant about an order rather than falling silent', () => {
    // "cancel" is a stop word, but not when it is about something.
    expect(intent('cancel my order')).toBe('cook');
  });
});

describe('reads', () => {
  it('reads the screen', () => {
    expect(intent('what is on this screen')).toBe('read_screen');
    expect(intent('where am i')).toBe('read_screen');
    expect(intent('ఈ స్క్రీన్ లో ఏముంది')).toBe('read_screen');
    expect(intent('इस स्क्रीन पर क्या है')).toBe('read_screen');
  });

  it('reads the cart', () => {
    expect(intent('what is in my cart')).toBe('read_cart');
    expect(intent('cart lo em undi')).toBe('read_cart');
    expect(intent('how much is the total')).toBe('read_cart');
  });

  it('prefers reading the cart over adding to it', () => {
    // Carries a want-word ("want"), which the add branch would have claimed.
    expect(intent('i want to know what is in the cart')).toBe('read_cart');
  });
});

describe('money is never spoken away', () => {
  it('routes every payment phrasing to the payment verdict', () => {
    for (const said of [
      'pay now',
      'checkout',
      'place the order',
      'buy now',
      'pay by upi',
      'ఆర్డర్ చెయ్యి',
      'भुगतान करो',
    ]) {
      expect(routeVoiceCommand(said, 'high')).toMatchObject({ verdict: 'payment' });
    }
  });

  it('is refused even in the highest mode', () => {
    expect(voiceModeAllows('high', 'payment')).toBe(false);
  });
});

describe('modes', () => {
  it('low hears only the cooking helper', () => {
    expect(routeVoiceCommand('gutti vankaya', 'low')).toMatchObject({ verdict: 'allow', intent: 'cook' });
    expect(routeVoiceCommand('open my cart', 'low')).toMatchObject({ verdict: 'blocked' });
    expect(routeVoiceCommand('what is on this screen', 'low')).toMatchObject({ verdict: 'blocked' });
  });

  it('medium reads the screen but changes nothing', () => {
    expect(routeVoiceCommand('what is on this screen', 'medium')).toMatchObject({ verdict: 'allow' });
    expect(routeVoiceCommand('what is in my cart', 'medium')).toMatchObject({ verdict: 'allow' });
    expect(routeVoiceCommand('add tomato', 'medium')).toMatchObject({ verdict: 'blocked' });
    expect(routeVoiceCommand('open my cart', 'medium')).toMatchObject({ verdict: 'blocked' });
  });

  it('high drives the app', () => {
    for (const said of ['open my cart', 'add tomato', 'remove onion', 'clear my cart', 'what is on this screen']) {
      expect(routeVoiceCommand(said, 'high')).toMatchObject({ verdict: 'allow' });
    }
  });

  it('off hears nothing at all', () => {
    expect(routeVoiceCommand('gutti vankaya', 'off')).toMatchObject({ verdict: 'blocked' });
  });

  it('stop and help work in every mode that listens', () => {
    for (const mode of ['low', 'medium', 'high']) {
      expect(routeVoiceCommand('stop', mode)).toMatchObject({ verdict: 'allow', intent: 'stop' });
      expect(routeVoiceCommand('help', mode)).toMatchObject({ verdict: 'allow', intent: 'help' });
    }
  });
});

describe('helpers', () => {
  it('normalizes without transliterating', () => {
    expect(normalizeSpoken('  Open   my CART! ')).toBe('open my cart');
    expect(normalizeSpoken('కార్ట్ చూపు.')).toBe('కార్ట్ చూపు');
  });

  it('takes a count from digits or words', () => {
    expect(extractQuantity('3 tomato')).toEqual({ quantity: 3, rest: 'tomato' });
    expect(extractQuantity('rendu tomato')).toEqual({ quantity: 2, rest: 'tomato' });
    expect(extractQuantity('दो टमाटर')).toEqual({ quantity: 2, rest: 'टमाटर' });
    // Romanised "do" is NOT two: "I do not want tomato" was read as two.
    expect(extractQuantity('do not want tomato')).toEqual({ quantity: 1, rest: 'do not want tomato' });
    expect(extractQuantity('tomato')).toEqual({ quantity: 1, rest: 'tomato' });
  });

  it('says nothing about an empty utterance', () => {
    expect(parseVoiceCommand('')).toEqual({ intent: 'none' });
    expect(parseVoiceCommand('   ')).toEqual({ intent: 'none' });
  });
});
