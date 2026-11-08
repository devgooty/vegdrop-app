/**
 * What the shopper just said, as one intent.
 *
 * This is the whole of the voice agent's understanding, and it is deliberately
 * a keyword matcher rather than a model call. Three reasons, in order of
 * weight:
 *
 * 1. **"Remove everything from my cart" must never be a guess.** An intent
 *    that writes to the cart or moves the screen has to be reached the same
 *    way every time, and be readable by whoever debugs it at 6am.
 * 2. **It answers offline and instantly.** A spoken command that waits on a
 *    round trip is slower than tapping, which is the only thing voice has to
 *    beat.
 * 3. **Anything it does NOT recognise is not an error** — it falls through to
 *    the cooking assistant (`intent: 'cook'`), which IS the model path and is
 *    good at open conversation. So the matcher only has to be sure about the
 *    small set of things that touch the screen, not about language in general.
 *
 * Each keyword set carries three spellings of the same word: the Latin
 * transliteration people actually speak ("vanta", "chupu"), and the Telugu and
 * Devanagari scripts the recogniser returns when it is listening in te-IN or
 * hi-IN. A shopper speaking Telugu to a phone with no Telugu language pack
 * gets back romanised text, so both have to match or the feature works on one
 * handset and not the next.
 */

/** The three steps of how much of the screen the voice agent may drive. */
export const VOICE_MODES = ['off', 'low', 'medium', 'high'];

export const DEFAULT_VOICE_MODE = 'low';

/** The most packs one spoken line may ask for. A misheard number must not fill a basket. */
export const MAX_SPOKEN_QUANTITY = 10;

/**
 * Fold an utterance into comparable words.
 *
 * Punctuation goes, case goes, and runs of whitespace collapse — but nothing
 * is transliterated: Telugu and Devanagari survive as themselves, because the
 * keyword tables hold both scripts.
 *
 * Three things here have each broken a command:
 *
 * - **"n't" becomes " not"** rather than losing its apostrophe to a space.
 *   "don't" used to fold to "don t", which no negation matched, so "I don't
 *   want tomato" went looking for a vegetable called "don t tomato".
 * - **Curly quotes and the Hindi full stop (।) are punctuation.** Recognisers
 *   emit both; left in, "हटाओ।" is a different word from "हटाओ".
 * - **Zero-width joiners go.** Telugu writes "కార్ట్‌లో" with or without a
 *   ZWNJ depending on the keyboard or recogniser, and the two must be one word.
 */
export function normalizeSpoken(value) {
  return String(value ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/n['’]t\b/g, ' not')
    .replace(/[.,!?;:"'’‘“”`()\[\]{}…।॥]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Telugu and Devanagari phrases that must stand alone as a whole word.
 *
 * Everything else in those scripts matches at the START of a word, so a suffix
 * is allowed ("కార్ట్‌లో", "डालना") but a phrase buried inside a longer word is
 * not. These are the few where even a word-start match is wrong: "बिलकुल"
 * (absolutely) is not a bill, "बंदगोभी" (cabbage) is not "stop", and
 * "వేయించు" (fry) is not "వేయి" (put in).
 * Anything two code units or shorter is also whole-word only — "मत" (don't),
 * "ना", "सब" are too short to be anything but themselves.
 */
const WHOLE_WORD = new Set(['बिल', 'कुल', 'बंद', 'వేయి']);

const patterns = new Map();

/**
 * The one definition of "this phrase appears in this text", shared by `has`
 * and `strip` so that what is matched and what is removed cannot disagree.
 *
 * - Latin: whole words ("add" must not match "address").
 * - Telugu/Devanagari: from the start of a word, suffix allowed. These used to
 *   match ANYWHERE, and Hindi paid for it: कीमत (price) contains मत (don't), so
 *   "टमाटर की कीमत क्या है" was a removal; डालना (to put) contains ना, so
 *   "दो किलो टमाटर डालना" removed the tomatoes it asked for.
 */
function patternFor(phrase) {
  let pattern = patterns.get(phrase);
  if (pattern) return pattern;

  const folded = normalizeSpoken(phrase);
  const escaped = folded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wholeWord = /^[a-z0-9 ]+$/.test(folded) || folded.length <= 2 || WHOLE_WORD.has(folded);
  pattern = folded ? new RegExp(`(^| )${escaped}${wholeWord ? '(?= |$)' : '\\S*'}`, 'g') : null;
  patterns.set(phrase, pattern);
  return pattern;
}

/** A phrase appears as a word (or, in Telugu and Hindi, the start of one). */
function has(text, phrase) {
  const pattern = patternFor(phrase);
  if (!pattern) return false;
  pattern.lastIndex = 0;
  return pattern.test(text);
}

function hasAny(text, phrases) {
  return phrases.some((phrase) => has(text, phrase));
}

/** Where "open X" can go. The first match wins, so order is significance. */
const TARGETS = [
  { target: 'offers', words: ['offer', 'offers', 'discount', 'discounts', 'deal', 'deals', 'coupon', 'rewards', 'reward', 'ఆఫర్', 'ఆఫర్లు', 'తగ్గింపు', 'రివార్డ్', 'ऑफर', 'ऑफ़र', 'छूट', 'डिस्काउंट'] },
  { target: 'cart', words: ['cart', 'basket', 'cartlo', 'కార్ట్', 'బాస్కెట్', 'బుట్ట', 'कार्ट', 'टोकरी', 'बास्केट'] },
  { target: 'orders', words: ['order', 'orders', 'my orders', 'ఆర్డర్', 'ఆర్డర్లు', 'ऑर्डर', 'ऑर्डरों'] },
  { target: 'prices', words: ['price', 'prices', 'rate', 'rates', 'ధర', 'ధరలు', 'రేటు', 'రేట్లు', 'भाव', 'दाम', 'कीमत', 'रेट'] },
  { target: 'cook', words: ['cook', 'cooking', 'recipe', 'recipes', 'vanta', 'vantakam', 'vantalu', 'వంట', 'వంటకం', 'రెసిపీ', 'రెసిపి', 'रसोई', 'रेसिपी', 'खाना'] },
  { target: 'account', words: ['account', 'profile', 'settings', 'ఖాతా', 'ప్రొఫైల్', 'సెట్టింగ్స్', 'खाता', 'प्रोफ़ाइल', 'प्रोफाइल', 'सेटिंग'] },
  { target: 'home', words: ['home', 'home page', 'main page', 'హోమ్', 'మొదటి పేజీ', 'होम', 'मुख्य'] },
  { target: 'search', words: ['search', 'वेतुकु', 'వెతుకు', 'వెతకు', 'खोज', 'सर्च', 'ढूंढ'] },
];

const CART_WORDS = ['cart', 'basket', 'cartlo', 'కార్ట్', 'బాస్కెట్', 'बास्केट', 'कार्ट', 'टोकरी'];

const GO_WORDS = ['open', 'go', 'go to', 'show', 'show me', 'take me', 'view', 'chupu', 'చూపు', 'చూపించు', 'తెరువు', 'వెళ్ళు', 'వెళ్లు', 'kholo', 'खोलो', 'खोल', 'दिखाओ', 'दिखा', 'जाओ', 'चलो'];

/**
 * Words that only say the shopper WANTS something.
 *
 * Kept apart from the other add words because wanting is not always buying:
 * "I want to make sambar" carries one and is a cooking question. A want-word
 * with a cooking word beside it goes to the assistant; "add", "veyi" and
 * "डालो" add whatever else is in the sentence.
 */
const WANT_WORDS = ['want', 'need', 'kavali', 'kaavali', 'chahiye', 'chaiye', 'కావాలి', 'चाहिए'];

const ADD_WORDS = [
  'add', 'put', 'buy', 'kalupu', 'veyi', 'vey', 'veyyi', 'veyandi', 'veyyandi', 'veseyi', 'daalo', 'dalo', 'jodo', 'kharido',
  'కలుపు', 'వేయి', 'వెయ్యి', 'వేయండి', 'చేర్చు', 'डालो', 'डाल', 'जोड़ो', 'जोड़', 'खरीद',
  ...WANT_WORDS,
];

const REMOVE_WORDS = ['remove', 'delete', 'drop', 'take out', 'teesey', 'teeseyi', 'teeseyyi', 'tiseyi', 'tolaginchu', 'vaddu', 'venda', 'hatao', 'nikalo', 'తీసేయి', 'తీసెయ్యి', 'తొలగించు', 'వద్దు', 'हटाओ', 'हटा', 'निकालो', 'निकाल', 'मत', 'नहीं चाहिए'];

const CLEAR_WORDS = ['clear', 'empty', 'clear everything', 'khali', 'ఖాళీ', 'అన్నీ తీసేయి', 'खाली', 'सब हटाओ'];

const READ_WORDS = ['what is this', 'what', 'where am i', 'read', 'tell me', 'describe', 'em', 'emi', 'emundi', 'ekkada', 'ఏమి', 'ఏముంది', 'ఏమున్న', 'ఏవి', 'ఎక్కడ', 'చదువు', 'చెప్పు', 'kya', 'kahan', 'क्या', 'कहाँ', 'कहां', 'बताओ', 'पढ़ो'];

const SCREEN_WORDS = ['screen', 'page', 'here', 'this', 'స్క్రీన్', 'పేజీ', 'ఇక్కడ', 'ఇది', 'स्क्रीन', 'पेज', 'पृष्ठ', 'यहाँ', 'यहां', 'यह'];

/**
 * Words about cooking a dish rather than buying produce.
 *
 * They do not route anywhere by themselves. They stop a want-word from being
 * read as a purchase and "this" from being read as a question about the
 * screen: "what can I make with this" asks for a recipe.
 */
const COOK_WORDS = ['make', 'cook', 'cooking', 'recipe', 'recipes', 'prepare', 'dish', 'vandali', 'vandu', 'vanta', 'వండ', 'వంట', 'రెసిపీ', 'बना', 'पका', 'रेसिपी'];

/**
 * Anything that would spend money. Matched BEFORE the intents that act, so
 * "place the order" can never be routed to something that acts on it.
 */
const PAY_WORDS = ['pay', 'payment', 'checkout', 'check out', 'place order', 'place the order', 'order now', 'buy now', 'upi', 'card', 'chellinpu', 'order pettu', 'order cheyyi', 'order chey', 'order cheyi', 'order karo', 'order kar do', 'చెల్లింపు', 'చెల్లించు', 'డబ్బు', 'ఆర్డర్ చెయ్యి', 'ఆర్డర్ పెట్టు', 'भुगतान', 'पेमेंट', 'पैसा', 'ऑर्डर करो', 'ऑर्डर कर'];

const STOP_WORDS = ['stop', 'cancel', 'quiet', 'shut up', 'never mind', 'aapu', 'ఆపు', 'ఆపండి', 'రద్దు', 'వద్దు ఆపు', 'रुको', 'रुक', 'बंद', 'चुप', 'रद्द'];

const HELP_WORDS = ['help', 'what can you do', 'sahayam', 'సహాయం', 'ఏం చేయగలవు', 'मदद', 'सहायता', 'क्या कर सकते'];

/** Words that name the bill itself — "bill enta" asks about the cart. */
const BILL_WORDS = ['total', 'bill', 'amount', 'మొత్తం', 'బిల్లు', 'कुल', 'बिल'];

/**
 * "How much" — about the bill ONLY when nothing else is named.
 *
 * "tomato enta" is the price of tomatoes, which the assistant answers. It was
 * read as a question about the cart, and the shopper heard their basket total
 * instead of a price.
 */
const HOW_MUCH_WORDS = ['how much', 'enta', 'entha', 'kitna', 'ఎంత', 'कितना'];

/**
 * Spoken counts, 1–10, in the three languages people use here.
 *
 * Romanised Hindi "do" (2) is deliberately absent. "I do not want tomato" was
 * read as two tomatoes, which is the worst shape of bug this file can have —
 * a refusal turned into a purchase. The Devanagari "दो" carries no such
 * collision and stays.
 */
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  oka: 1, okati: 1, rendu: 2, moodu: 3, mudu: 3, naalugu: 4, nalugu: 4, aidu: 5, ayidu: 5,
  ek: 1, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5,
  'ఒకటి': 1, 'ఒక': 1, 'రెండు': 2, 'మూడు': 3, 'నాలుగు': 4, 'ఐదు': 5,
  'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पाँच': 5, 'पांच': 5,
};

/** Words that carry no produce and would otherwise end up in the item name. */
const FILLER = new Set([
  'please', 'na', 'naa', 'nenu', 'nuvvu', 'ki', 'lo', 'loki', 'cart', 'cartlo', 'basket', 'me', 'mein', 'my',
  'i', 'is', 'are', 'of', 'for', 'some', 'that', 'those', 'from', 'more', 'just',
  // "can you add okra" went looking for a vegetable called "can you okra".
  'can', 'could', 'would', 'you',
  'to', 'the', 'a', 'an', 'in', 'into', 'kg', 'kgs', 'kilo', 'kilos', 'kilolu', 'gram', 'grams', 'pack', 'packs',
  'packet', 'packets', 'piece', 'pieces', 'bunch', 'bunches',
  // An amount is a count of the seller's packs, never a weight (services/packs.mjs):
  // "half kg tomato" is one pack of tomatoes, not something called "half tomato".
  'half', 'quarter', 'dozen', 'ara', 'aadha', 'pav',
  // "a bit", "also", "to me" — said around the name, never part of it.
  'konchem', 'koncham', 'kuda', 'kooda', 'inka', 'naaku', 'thoda', 'mujhe',
  // Telugu/Hindi "do it" — a polite tail on almost every spoken command.
  'chey', 'cheyi', 'chei', 'cheyyi', 'karo', 'kar', 'do', 'it',
  'కార్ట్', 'బాస్కెట్', 'లో', 'కి', 'కేజీ', 'కిలో', 'కిలోలు', 'కార్ట్లో', 'చెయ్యి', 'చేయి', 'కొంచెం', 'ఇంకా', 'నాకు',
  'कार्ट', 'टोकरी', 'में', 'मेरे', 'किलो', 'केजी', 'ग्राम', 'करो', 'कर', 'थोड़ा', 'थोड़े', 'मुझे', 'और',
]);

/** "and" in all three — one command can name more than one vegetable. */
const SEPARATORS = ['and', 'also', 'plus', 'mariyu', 'aur', 'మరియు', 'తో', 'और', 'भी'];

/** A refusal reads as a removal, not an addition. */
const NEGATIONS = ['not', 'dont', 'do not', 'no', 'never', 'nahi', 'nahin', 'mat', 'vaddu', 'వద్దు', 'వాడు కాదు', 'नहीं', 'नही', 'मत', 'ना'];

const EVERYTHING_WORDS = ['everything', 'all', 'all of it', 'anni', 'అన్ని', 'అన్నీ', 'sab', 'sab kuch', 'सब', 'सबकुछ', 'सब कुछ'];

/**
 * Whether the sentence refuses something.
 *
 * Two positions are not refusals, and both turned an addition into a removal:
 * a LEADING "no" corrects what came before ("no, add two tomatoes"), and a
 * TRAILING "ना" is Hindi's polite tag ("टमाटर डालो ना" — do add tomatoes).
 * "ना" before the verb ("टमाटर ना डालो") is still "don't".
 */
function isNegated(text) {
  const words = text.split(' ');
  while (words.length > 1 && words[0] === 'no') words.shift();
  if (words.length > 1 && words[words.length - 1] === 'ना') words.pop();
  return hasAny(words.join(' '), NEGATIONS);
}

/**
 * The quantity, and what is left once it is taken out.
 *
 * A count the shopper did not say is 1, never 0 — "add tomato" is one pack,
 * and defaulting to nothing would silently drop the line.
 */
export function extractQuantity(text) {
  const words = normalizeSpoken(text).split(' ').filter(Boolean);
  let quantity = null;
  const rest = [];

  for (const word of words) {
    if (quantity == null && /^\d{1,2}$/.test(word)) {
      quantity = Number(word);
      continue;
    }
    if (quantity == null && NUMBER_WORDS[word] != null) {
      quantity = NUMBER_WORDS[word];
      continue;
    }
    rest.push(word);
  }

  return { quantity: quantity && quantity > 0 ? quantity : 1, rest: rest.join(' ') };
}

/** Take every listed phrase out of the text, by the same rule `has` matches it. */
function strip(text, words) {
  let rest = text;
  for (const word of [...words].sort((a, b) => b.length - a.length)) {
    const pattern = patternFor(word);
    if (pattern) rest = rest.replace(pattern, ' ');
  }
  return rest.replace(/\s+/g, ' ').trim();
}

/**
 * What a piece of a sentence is FOR, which is not something to buy.
 *
 * "add tomatoes for sambar" asks for tomatoes; left in, it asked for a
 * vegetable called "tomatoes sambar" and found nothing. English puts the
 * purpose after "for"; Telugu and Hindi put the dish BEFORE the postposition
 * ("సాంబార్ కోసం", "सांबर के लिए"), so the word in front of it goes too.
 */
function withoutPurpose(piece) {
  return piece
    .replace(/(^| )for( .*)?$/, ' ')
    .replace(/(^| )\S+ (kosam|కోసం|के लिए|ke liye|ke liya)(?= |$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The vegetables one command named, each with its own count.
 *
 * Split before the count is read, or "2 kg tomato and 1 kg onion" asks for two
 * of a thing called "tomato 1 onion". Each piece is then a name the caller
 * resolves against this market's sheet — this file never decides what a
 * vegetable is, only which words were about one.
 */
function namedItems(text, verbs) {
  const rest = strip(text, [...verbs, ...GO_WORDS, ...NEGATIONS]);
  const pattern = new RegExp(`(?:^| )(?:${SEPARATORS.join('|')})(?: |$)`);

  return rest
    .split(pattern)
    .map((piece) => {
      const { quantity, rest: named } = extractQuantity(withoutPurpose(piece));
      const words = named.split(' ').filter((word) => word && !FILLER.has(word));
      return { quantity: Math.min(quantity, MAX_SPOKEN_QUANTITY), text: words.join(' ') };
    })
    .filter((item) => item.text);
}

function namedTarget(text) {
  for (const { target, words } of TARGETS) {
    if (hasAny(text, words)) return target;
  }
  return null;
}

/** Nothing of substance once the given words and filler are taken out. */
function onlyThese(text, words) {
  return strip(text, words)
    .split(' ')
    .every((word) => !word || FILLER.has(word));
}

/** The matched target word and nothing else of substance — "offers", "my cart". */
function isBareTarget(text, target) {
  const words = TARGETS.find((entry) => entry.target === target)?.words || [];
  return onlyThese(text, [...words, ...GO_WORDS]);
}

/**
 * One utterance → one intent.
 *
 * The order of these tests is the design. Payment is checked first so no
 * phrasing of "buy it now" can reach an intent that acts; `stop` is next
 * because it has to work while the agent is mid-sentence; and the fall-through
 * is always `cook`, never a failure, so an unrecognised sentence reaches the
 * assistant that can actually hold a conversation.
 *
 * @returns {{ intent: string, target?: string, text?: string, quantity?: number }}
 */
export function parseVoiceCommand(utterance) {
  const text = normalizeSpoken(utterance);
  if (!text) return { intent: 'none' };

  if (hasAny(text, PAY_WORDS)) return { intent: 'payment', text };

  const target = namedTarget(text);

  /*
   * Is this a purchase? An add word does it, unless the only one is a WANT
   * and the sentence is about cooking — "I want to make sambar" answered
   * "couldn't find make sambar", in the one mode where the shopper could not
   * reach the assistant they were asking.
   */
  const cooking = hasAny(text, COOK_WORDS);
  const explicitAdd = hasAny(text, ADD_WORDS.filter((word) => !WANT_WORDS.includes(word)));
  const buying = explicitAdd || (hasAny(text, WANT_WORDS) && !cooking);

  // "stop" has to work while the agent is talking, so it is early — but only
  // as a command of its own. "Cancel my order" is a question about an order,
  // not a request for silence, and belongs to the assistant; "बंद गोभी डालो"
  // (add cabbage) carries a stop word and an add word, and is an addition.
  if (hasAny(text, STOP_WORDS) && !target && !explicitAdd && text.split(' ').length <= 3) return { intent: 'stop' };
  if (hasAny(text, HELP_WORDS)) return { intent: 'help' };

  /*
   * "Empty the cart" and "remove all the tomatoes" both pair a removal with
   * "all"; only the first is about the whole cart. Whatever survives once the
   * verbs, "all" and the cart are taken out is a vegetable, and naming one
   * means that line goes — not the basket. Reading "all" alone emptied the
   * whole cart to take out one item, in every language.
   */
  const cartNamed = hasAny(text, CART_WORDS);
  const everything = hasAny(text, EVERYTHING_WORDS);
  const clearing = hasAny(text, CLEAR_WORDS);
  if ((clearing || hasAny(text, REMOVE_WORDS)) && (cartNamed || everything)) {
    const items = namedItems(text, [...REMOVE_WORDS, ...CLEAR_WORDS, ...EVERYTHING_WORDS, ...CART_WORDS]);
    if (items.length > 0) return { intent: 'remove_item', items };
    if (everything || clearing) return { intent: 'clear_cart' };
  }

  // A refusal is a removal: "I don't want tomato" must never add one.
  if (hasAny(text, REMOVE_WORDS) || (isNegated(text) && buying)) {
    const items = namedItems(text, [...REMOVE_WORDS, ...ADD_WORDS]);
    if (items.length > 0) return { intent: 'remove_item', items };
    return { intent: 'remove_item', items: [] };
  }

  // "what's in my cart" and "what's the total" are READS of the cart, so they
  // are tested before `add`: "I want to know what is in the cart" carries a
  // want-word and would otherwise try to add "know what is".
  const reading = hasAny(text, READ_WORDS);
  const billNamed = hasAny(text, BILL_WORDS);
  const howMuch = hasAny(text, HOW_MUCH_WORDS);
  if ((reading || billNamed || howMuch) && cartNamed) return { intent: 'read_cart' };
  if (billNamed && !target) return { intent: 'read_cart' };
  if (howMuch && !target && onlyThese(text, [...HOW_MUCH_WORDS, ...READ_WORDS])) return { intent: 'read_cart' };

  if (buying) {
    const items = namedItems(text, ADD_WORDS);
    if (items.length > 0) return { intent: 'add_item', items };
  }

  /*
   * "What offers are there?" is answered by opening the offers.
   *
   * There is no spoken list of offers and there should not be: they change,
   * they carry conditions, and reading them aloud from memory is how a shopper
   * is told about a discount that has expired. Showing the screen is the honest
   * answer to the question, so a question ABOUT offers navigates rather than
   * falling through to the assistant, which knows nothing about them.
   */
  if (reading && target === 'offers') return { intent: 'navigate', target: 'offers' };

  if (reading && !cooking && hasAny(text, SCREEN_WORDS)) return { intent: 'read_screen' };
  if (hasAny(text, ['where am i', 'ekkada unnanu', 'ఎక్కడ ఉన్నాను', 'कहाँ हूँ', 'कहां हूं'])) {
    return { intent: 'read_screen' };
  }

  /*
   * Navigation needs either a go-word or nothing but the tab's own name.
   *
   * The looser rule this replaces — a target plus a short sentence — sent
   * "tomato price enta" to the price sheet, when the shopper was asking what
   * tomatoes cost and the assistant answers exactly that. Naming a screen is
   * not asking to be taken to it.
   */
  if (target && (hasAny(text, GO_WORDS) || isBareTarget(text, target))) {
    return { intent: 'navigate', target };
  }

  return { intent: 'cook', text };
}

/**
 * Which intents each mode may act on.
 *
 * The modes are the shopper's own answer to "how much of my screen may this
 * thing drive", so they are enforced here, in one table, rather than by each
 * handler remembering to check. `low` is the AI Cook tab and nothing else;
 * `medium` adds reading the screen aloud but still changes nothing; `high`
 * drives the app — and `payment` is in NO mode's list, deliberately. Money
 * leaves this account by a tap, every time.
 */
const ALLOWED = {
  off: [],
  low: ['cook', 'stop', 'help', 'none'],
  medium: ['cook', 'stop', 'help', 'none', 'read_screen', 'read_cart'],
  high: ['cook', 'stop', 'help', 'none', 'read_screen', 'read_cart', 'navigate', 'add_item', 'remove_item', 'clear_cart'],
};

export function voiceModeAllows(mode, intent) {
  return (ALLOWED[mode] || []).includes(intent);
}

/**
 * What the agent should do with a parsed command in this mode.
 *
 * `blocked` is not the same as `payment`: the first is "you did not give me
 * this much control" and the second is "nobody gets this much control". Both
 * answer out loud rather than doing nothing, because silence after a spoken
 * command is indistinguishable from a mic that is not working.
 */
export function routeVoiceCommand(utterance, mode) {
  const command = parseVoiceCommand(utterance);
  if (command.intent === 'payment') return { ...command, verdict: 'payment' };
  if (!voiceModeAllows(mode, command.intent)) return { ...command, verdict: 'blocked' };
  return { ...command, verdict: 'allow' };
}

/**
 * Whether asking the model what a sentence meant could change anything in
 * this mode.
 *
 * In `low` it cannot: everything the model may name beyond conversation is
 * blocked there, and the table already catches "stop" and "help". Asking
 * anyway put a round trip in front of every spoken cooking question — and
 * when the model read one as a command, the shopper was told the setting was
 * too low instead of getting an answer from the only thing `low` is for.
 */
export function modelCanHelp(mode) {
  return ['read_screen', 'read_cart', 'navigate', 'add_item', 'remove_item', 'clear_cart'].some((intent) =>
    voiceModeAllows(mode, intent)
  );
}

/**
 * What the model's answer means as a command, in this mode — or null when it
 * is conversation and belongs to the assistant.
 *
 * The server names vegetables `{ name, quantity }`, because that is the shape
 * a model is asked for; the app resolves `{ text, quantity }`, because that is
 * what the keyword table produces. Handing the model's items through
 * unconverted made every model-understood add say "couldn't find", and every
 * model-understood removal resolve an EMPTY name — which matched the first
 * line in the cart and deleted it. So the conversion lives here, in one pure
 * function, with the tests beside it.
 *
 * Everything is re-checked rather than trusted: the server already sanitises,
 * but this is the last step before a handler that changes a cart.
 */
export function routeModelGuess(guess, mode, utterance = '') {
  if (!guess || typeof guess.intent !== 'string') return null;
  const intent = guess.intent;
  if (intent === 'chat' || intent === 'payment' || !voiceModeAllows('high', intent)) return null;

  const command = { intent, text: utterance };

  if (intent === 'navigate') {
    if (typeof guess.target !== 'string' || !guess.target) return null;
    command.target = guess.target;
  }

  if (intent === 'add_item' || intent === 'remove_item') {
    const items = (Array.isArray(guess.items) ? guess.items : [])
      .map((item) => {
        const text = normalizeSpoken(item?.name ?? item?.text ?? '');
        const asked = Number(item?.quantity);
        const quantity = Number.isFinite(asked) && asked >= 1 ? Math.min(Math.round(asked), MAX_SPOKEN_QUANTITY) : 1;
        return { quantity, text };
      })
      .filter((item) => item.text);
    if (items.length === 0) return null;
    command.items = items;
  }

  return { ...command, verdict: voiceModeAllows(mode, intent) ? 'allow' : 'blocked' };
}
