import { describe, it, expect } from 'vitest';
import {
  parseVoiceCommand,
  routeVoiceCommand,
  routeModelGuess,
  modelCanHelp,
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

  it('answers a question about offers by opening them', () => {
    // There is no spoken list of offers, deliberately: they change and carry
    // conditions, and reciting them from memory is how someone is told about a
    // discount that has expired.
    expect(parseVoiceCommand('what offers are there')).toEqual({ intent: 'navigate', target: 'offers' });
    expect(parseVoiceCommand('ఆఫర్లు ఏమున్నాయి')).toEqual({
      intent: 'navigate',
      target: 'offers',
    });
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

  it('removes one vegetable when "all" is about that vegetable, not the cart', () => {
    // "all the tomatoes" names tomatoes. Reading "all" as "everything" emptied
    // the whole cart to take out one line, in every language.
    expect(parseVoiceCommand('remove all the tomatoes')).toEqual({
      intent: 'remove_item',
      items: [{ quantity: 1, text: 'tomatoes' }],
    });
    expect(parseVoiceCommand('remove all onions from cart')).toEqual({
      intent: 'remove_item',
      items: [{ quantity: 1, text: 'onions' }],
    });
    expect(parseVoiceCommand('tomato anni teesey')).toEqual({
      intent: 'remove_item',
      items: [{ quantity: 1, text: 'tomato' }],
    });
    expect(parseVoiceCommand('सब टमाटर हटाओ')).toEqual({
      intent: 'remove_item',
      items: [{ quantity: 1, text: 'टमाटर' }],
    });
    // With nothing named, "all" still means the cart.
    expect(intent('remove all')).toBe('clear_cart');
    expect(intent('అన్నీ తీసేయి')).toBe('clear_cart');
  });

  it('hears "don\'t" as a refusal, whichever apostrophe the recogniser used', () => {
    for (const said of ["i don't want tomato", 'i don’t want tomato']) {
      expect(parseVoiceCommand(said)).toEqual({
        intent: 'remove_item',
        items: [{ quantity: 1, text: 'tomato' }],
      });
    }
  });

  it('reads a leading "no" as a correction, not a refusal', () => {
    expect(parseVoiceCommand('no, add two tomatoes')).toEqual({
      intent: 'add_item',
      items: [{ quantity: 2, text: 'tomatoes' }],
    });
    expect(intent('add no onion')).toBe('remove_item');
  });

  it('keeps Hindi additions as additions', () => {
    // "डालना" (to put) contains ना, and "डालो ना" ends with the polite tag ना.
    // Both were read as "don't put" — an addition turned into a removal.
    expect(parseVoiceCommand('दो किलो टमाटर डालना')).toEqual({
      intent: 'add_item',
      items: [{ quantity: 2, text: 'टमाटर' }],
    });
    expect(parseVoiceCommand('टमाटर डालो ना')).toEqual({
      intent: 'add_item',
      items: [{ quantity: 1, text: 'टमाटर' }],
    });
    // A ना before the verb is still "don't".
    expect(intent('टमाटर ना डालो')).toBe('remove_item');
    expect(intent('टमाटर मत डालो')).toBe('remove_item');
  });

  it('does not find a Hindi word inside a longer one', () => {
    // कीमत (price) contains मत (don't): a price question became a removal.
    expect(intent('टमाटर की कीमत क्या है')).toBe('cook');
    // बंद गोभी is cabbage, not "stop".
    expect(parseVoiceCommand('बंद गोभी डालो')).toMatchObject({ intent: 'add_item' });
    // बिलकुल (absolutely) is not a bill.
    expect(intent('बिलकुल सही')).toBe('cook');
  });

  it('takes romanised Telugu verbs and drops chatter around the name', () => {
    expect(parseVoiceCommand('onions kavali')).toEqual({
      intent: 'add_item',
      items: [{ quantity: 1, text: 'onions' }],
    });
    expect(parseVoiceCommand('rendu tomato konchem veyyi')).toEqual({
      intent: 'add_item',
      items: [{ quantity: 2, text: 'tomato' }],
    });
    expect(parseVoiceCommand('can you add some okra')).toEqual({
      intent: 'add_item',
      items: [{ quantity: 1, text: 'okra' }],
    });
    expect(parseVoiceCommand('vankaya rendu kilolu veyyi')).toEqual({
      intent: 'add_item',
      items: [{ quantity: 2, text: 'vankaya' }],
    });
  });

  it('does not read "fry" as "put in"', () => {
    // వేయించు (fry) starts with వేయి (put in). A recipe question added tomatoes.
    expect(intent('టమాటా వేయించు')).toBe('cook');
    expect(intent('టమాటా వేయి')).toBe('add_item');
  });

  it('sends a cooking wish to the assistant rather than the cart', () => {
    // "want" is an add word, but "I want to make sambar" is not a purchase —
    // it answered "couldn't find make sambar".
    expect(intent('i want to make sambar')).toBe('cook');
    expect(intent('i want to cook biryani')).toBe('cook');
    expect(intent('what can i make with this')).toBe('cook');
    // An explicit add still adds, cooking word or not.
    expect(intent('add tomato for curry')).toBe('add_item');
  });

  it('drops what the vegetables are for', () => {
    // Left in, these asked for vegetables called "tomatoes sambar".
    expect(parseVoiceCommand('add 2 tomatoes for sambar')).toEqual({
      intent: 'add_item',
      items: [{ quantity: 2, text: 'tomatoes' }],
    });
    expect(parseVoiceCommand('సాంబార్ కోసం టమాటా వేయి')).toEqual({
      intent: 'add_item',
      items: [{ quantity: 1, text: 'టమాటా' }],
    });
    expect(parseVoiceCommand('सांबर के लिए टमाटर डालो')).toEqual({
      intent: 'add_item',
      items: [{ quantity: 1, text: 'टमाटर' }],
    });
  });

  it('never asks for more than ten packs of one thing', () => {
    expect(parseVoiceCommand('add 50 tomatoes')).toEqual({
      intent: 'add_item',
      items: [{ quantity: 10, text: 'tomatoes' }],
    });
  });
});

describe('what the model understood', () => {
  it('turns its { name } items into the { text } items the app resolves', () => {
    // Passed through unconverted, every model-understood add said "couldn't
    // find", and every removal resolved an empty name — which matched, and
    // deleted, the first line in the cart.
    expect(
      routeModelGuess({ intent: 'add_item', items: [{ name: 'Brinjal', quantity: 2 }] }, 'high', 'vankaya rendu veyyi')
    ).toEqual({
      intent: 'add_item',
      items: [{ quantity: 2, text: 'brinjal' }],
      text: 'vankaya rendu veyyi',
      verdict: 'allow',
    });
  });

  it('clamps a misheard count and drops nameless items', () => {
    const routed = routeModelGuess(
      { intent: 'remove_item', items: [{ name: 'onion', quantity: 400 }, { name: '  ' }, { quantity: 3 }] },
      'high'
    );
    expect(routed.items).toEqual([{ quantity: 10, text: 'onion' }]);
  });

  it('hands conversation, payment and anything unknown back to the assistant', () => {
    expect(routeModelGuess({ intent: 'chat', reply: 'hi' }, 'high')).toBeNull();
    expect(routeModelGuess({ intent: 'payment' }, 'high')).toBeNull();
    expect(routeModelGuess({ intent: 'place_order' }, 'high')).toBeNull();
    expect(routeModelGuess({ intent: 'add_item', items: [] }, 'high')).toBeNull();
    expect(routeModelGuess({ intent: 'navigate' }, 'high')).toBeNull();
    expect(routeModelGuess(null, 'high')).toBeNull();
  });

  it('is not asked at all where nothing it could say would be allowed', () => {
    expect(modelCanHelp('off')).toBe(false);
    expect(modelCanHelp('low')).toBe(false);
    expect(modelCanHelp('medium')).toBe(true);
    expect(modelCanHelp('high')).toBe(true);
  });

  it('is held to the same mode ceiling as the keyword table', () => {
    expect(routeModelGuess({ intent: 'navigate', target: 'cart' }, 'medium')).toMatchObject({ verdict: 'blocked' });
    expect(routeModelGuess({ intent: 'read_cart' }, 'medium')).toMatchObject({ verdict: 'allow' });
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

  it('reads the bill only when the bill is what was asked about', () => {
    expect(intent('how much')).toBe('read_cart');
    expect(intent('bill enta')).toBe('read_cart');
    expect(intent('how much is my bill')).toBe('read_cart');
    // "how much is tomato" asks a price, which the assistant answers. It used
    // to read out the cart.
    expect(intent('tomato enta')).toBe('cook');
    expect(intent('how much is onion today')).toBe('cook');
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
    // The Hindi full stop, and the joiners Telugu keyboards and recognisers
    // put in or leave out of the same word.
    expect(normalizeSpoken('टमाटर हटाओ।')).toBe('टमाटर हटाओ');
    expect(normalizeSpoken('కార్ట్‌లో')).toBe(normalizeSpoken('కార్ట్లో'));
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
