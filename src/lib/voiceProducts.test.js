import { describe, it, expect } from 'vitest';
import { findSpokenProduct, findCartLine, spokenKey } from './voiceProducts';

/**
 * A spoken vegetable name against the sheet on screen.
 *
 * The rows are the seeded catalog's real names and translations
 * (server/utils/seed.js, server/utils/productTranslations.js), because the
 * shapes that broke this were all in the real data: English names in the
 * plural with a Hindi alias in brackets, two onions and two potatoes, and
 * Telugu and Hindi names the old matcher folded to nothing at all.
 */

const row = (id, name, nameTe, nameHi) => ({ id, name, nameTe, nameHi });

const SHEET = [
  row('tomato', 'Desi Tomatoes (Tamatar)', 'టమాటా', 'टमाटर'),
  row('onion', 'Fresh Red Onions (Pyaaz)', 'ఉల్లిపాయలు', 'लाल प्याज'),
  row('chilli', 'Green Chilli (Hari Mirch)', 'పచ్చిమిర్చి', 'हरी मिर्च'),
  row('carrot', 'Fresh Carrot (Gajar)', 'క్యారెట్', 'गाजर'),
  row('potato', 'Fresh Potato (Aloo)', 'బంగాళాదుంప', 'आलू'),
  row('okra', 'Fresh Okra (Bhindi)', 'బెండకాయ', 'भिंडी'),
  row('capsicum', 'Green Capsicum (Shimla Mirch)', 'పచ్చి క్యాప్సికం', 'शिमला मिर्च'),
  row('sweetpotato', 'Sweet Potato (Shakarkandi)', 'చిలగడదుంప', 'शकरकंद'),
  row('springonion', 'Spring Onion (Hara Pyaaz)', 'ఉల్లికాడలు', 'हरा प्याज'),
  row('peas', 'Fresh Green Peas (Matar)', 'పచ్చి బఠానీలు', 'हरी मटर'),
  row('cauliflower', 'Cauliflower (Phool Gobi)', 'కాలీఫ్లవర్', 'फूल गोभी'),
  row('ketchup', 'Tomato Ketchup', '', ''),
];

const found = (spoken) => findSpokenProduct(spoken, SHEET)?.id ?? null;

describe('English', () => {
  it('finds a vegetable whether it is said in the singular or the plural', () => {
    // "add carrots" and "add potatoes" found nothing: the old match was a
    // substring test, and "fresh carrot gajar" does not contain "carrots".
    expect(found('tomato')).toBe('tomato');
    expect(found('tomatoes')).toBe('tomato');
    expect(found('carrots')).toBe('carrot');
    expect(found('potatoes')).toBe('potato');
    expect(found('chillies')).toBe('chilli');
    expect(found('pea')).toBe('peas');
  });

  it('prefers the plain vegetable over one that merely contains its name', () => {
    expect(found('potato')).toBe('potato');
    expect(found('sweet potato')).toBe('sweetpotato');
    expect(found('onion')).toBe('onion');
    expect(found('spring onion')).toBe('springonion');
    // A spoken "tomato" must not land on the ketchup while tomatoes exist.
    expect(found('tomato')).not.toBe('ketchup');
    expect(found('tomato ketchup')).toBe('ketchup');
  });

  it('takes the Hindi name the catalog carries in brackets', () => {
    expect(found('aloo')).toBe('potato');
    expect(found('pyaaz')).toBe('onion');
    expect(found('bhindi')).toBe('okra');
  });

  it('finds a word that was cut short, but only from its start', () => {
    expect(found('cauli')).toBe('cauliflower');
    expect(found('flower')).toBeNull();
  });
});

describe('Telugu and Hindi', () => {
  it('finds a vegetable named in Telugu script', () => {
    // Every one of these folded to an empty string before, so a Telugu
    // shopper could add nothing by voice at all.
    expect(found('టమాటా')).toBe('tomato');
    expect(found('బెండకాయ')).toBe('okra');
    expect(found('బంగాళాదుంప')).toBe('potato');
  });

  it('allows the Telugu plural and the singular of a plural name', () => {
    expect(found('టమాటాలు')).toBe('tomato');
    expect(found('ఉల్లిపాయ')).toBe('onion');
  });

  it('matches a Telugu compound however the recogniser spaced it', () => {
    expect(found('పచ్చి మిర్చి')).toBe('chilli');
  });

  it('finds a vegetable named in Devanagari', () => {
    expect(found('टमाटर')).toBe('tomato');
    expect(found('आलू')).toBe('potato');
    expect(found('भिंडी')).toBe('okra');
    expect(found('प्याज')).toBe('onion');
  });
});

describe('what never matches', () => {
  it('matches nothing for nothing', () => {
    expect(found('')).toBeNull();
    expect(found('   ')).toBeNull();
    expect(found('!!')).toBeNull();
    expect(found('fresh')).toBeNull();
  });

  it('does not guess at a sentence that names no vegetable', () => {
    expect(found('make sambar')).toBeNull();
    expect(found('mango')).toBeNull();
    expect(found('बादाम')).toBeNull();
  });
});

describe('cart lines', () => {
  const CART = [
    { id: 'onion-1', name: 'Fresh Red Onions (Pyaaz)', nameTe: 'ఉల్లిపాయలు', nameHi: 'लाल प्याज', quantity: 2 },
    { id: 'tomato-500g', name: 'Desi Tomatoes (Tamatar) (500g)', nameTe: 'టమాటా', nameHi: 'टमाटर', quantity: 1 },
  ];

  it('never removes a line for a name it could not read', () => {
    // An empty name "matched" every line — `"anything".includes("")` is true —
    // so a removal spoken in Telugu or Hindi deleted the FIRST line in the
    // cart, whatever was asked for, and said it had.
    expect(findCartLine('', CART)).toBeNull();
    expect(findCartLine('टमाटर की की क्या है', CART)).toBeNull();
    expect(findCartLine('బెండకాయ', CART)).toBeNull();
  });

  it('finds the line in any of the three languages', () => {
    expect(findCartLine('టమాటా', CART)?.id).toBe('tomato-500g');
    expect(findCartLine('टमाटर', CART)?.id).toBe('tomato-500g');
    expect(findCartLine('tomatoes', CART)?.id).toBe('tomato-500g');
    expect(findCartLine('onion', CART)?.id).toBe('onion-1');
  });
});

describe('spokenKey', () => {
  it('keeps every script and drops what is not a letter', () => {
    expect(spokenKey('  Desi Tomatoes (Tamatar)! ')).toBe('desi tomatoes tamatar');
    expect(spokenKey('బీట్‌రూట్')).toBe(spokenKey('బీట్రూట్'));
    expect(spokenKey('टमाटर।')).toBe('टमाटर');
  });
});
