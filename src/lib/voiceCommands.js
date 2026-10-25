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

/**
 * Fold an utterance into comparable words.
 *
 * Punctuation goes, case goes, and runs of whitespace collapse — but nothing
 * is transliterated: Telugu and Devanagari survive as themselves, because the
 * keyword tables hold both scripts.
 */
export function normalizeSpoken(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[.,!?;:"'`()\[\]{}…]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A phrase appears as whole words, not as a fragment inside a longer one. */
function has(text, phrase) {
  if (!phrase) return false;
  // Latin needs a word boundary ("add" must not match "address"); Telugu and
  // Devanagari have no \b that works, so those match as substrings — which is
  // correct for them, since they agglutinate ("కార్ట్‌లో" contains "కార్ట్").
  if (/^[a-z0-9 ]+$/.test(phrase)) {
    return new RegExp(`(^| )${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(text);
  }
  return text.includes(phrase);
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

const GO_WORDS = ['open', 'go', 'go to', 'show', 'show me', 'take me', 'view', 'chupu', 'చూపు', 'చూపించు', 'తెరువు', 'వెళ్ళు', 'వెళ్లు', 'kholo', 'खोलो', 'खोल', 'दिखाओ', 'दिखा', 'जाओ', 'चलो'];

const ADD_WORDS = ['add', 'put', 'buy', 'want', 'kalupu', 'veyi', 'vey', 'కలుపు', 'వేయి', 'వెయ్యి', 'చేర్చు', 'కావాలి', 'डालो', 'डाल', 'जोड़ो', 'जोड़', 'चाहिए', 'खरीद'];

const REMOVE_WORDS = ['remove', 'delete', 'drop', 'take out', 'teesey', 'teeseyi', 'tolaginchu', 'vaddu', 'venda', 'తీసేయి', 'తీసెయ్యి', 'తొలగించు', 'వద్దు', 'हटाओ', 'हटा', 'निकालो', 'निकाल', 'मत', 'नहीं चाहिए'];

const CLEAR_WORDS = ['clear', 'empty', 'clear everything', 'khali', 'ఖాళీ', 'అన్నీ తీసేయి', 'खाली', 'सब हटाओ'];

const READ_WORDS = ['what is this', 'what', 'where am i', 'read', 'tell me', 'describe', 'em', 'emi', 'emundi', 'ekkada', 'ఏమి', 'ఏముంది', 'ఎక్కడ', 'చదువు', 'చెప్పు', 'kya', 'kahan', 'क्या', 'कहाँ', 'कहां', 'बताओ', 'पढ़ो'];

const SCREEN_WORDS = ['screen', 'page', 'here', 'this', 'స్క్రీన్', 'పేజీ', 'ఇక్కడ', 'ఇది', 'स्क्रीन', 'पेज', 'पृष्ठ', 'यहाँ', 'यहां', 'यह'];

/**
 * Anything that would spend money. Matched BEFORE the intents that act, so
 * "place the order" can never be routed to something that acts on it.
 */
const PAY_WORDS = ['pay', 'payment', 'checkout', 'check out', 'place order', 'place the order', 'order now', 'buy now', 'upi', 'card', 'chellinpu', 'చెల్లింపు', 'చెల్లించు', 'డబ్బు', 'ఆర్డర్ చెయ్యి', 'ఆర్డర్ పెట్టు', 'भुगतान', 'पेमेंट', 'पैसा', 'ऑर्डर करो', 'ऑर्डर कर'];

const STOP_WORDS = ['stop', 'cancel', 'quiet', 'shut up', 'never mind', 'aapu', 'ఆపు', 'ఆపండి', 'రద్దు', 'వద్దు ఆపు', 'रुको', 'रुक', 'बंद', 'चुप', 'रद्द'];

const HELP_WORDS = ['help', 'what can you do', 'sahayam', 'సహాయం', 'ఏం చేయగలవు', 'मदद', 'सहायता', 'क्या कर सकते'];

const TOTAL_WORDS = ['total', 'how much', 'bill', 'amount', 'enta', 'ఎంత', 'మొత్తం', 'బిల్లు', 'कितना', 'कुल', 'बिल'];

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
  'i', 'is', 'are', 'of', 'for', 'some', 'that', 'those',
  'to', 'the', 'a', 'an', 'in', 'into', 'kg', 'kilo', 'kilos', 'gram', 'grams', 'pack', 'packs', 'piece', 'pieces',
  // Telugu/Hindi "do it" — a polite tail on almost every spoken command.
  'chey', 'cheyi', 'chei', 'cheyyi', 'karo', 'kar', 'do', 'it',
  'కార్ట్', 'బాస్కెట్', 'లో', 'కి', 'కేజీ', 'కిలో', 'కార్ట్‌లో', 'చెయ్యి', 'చేయి',
  'कार्ट', 'टोकरी', 'में', 'मेरे', 'किलो', 'केजी', 'ग्राम', 'करो', 'कर',
]);

/** "and" in all three — one command can name more than one vegetable. */
const SEPARATORS = ['and', 'also', 'plus', 'mariyu', 'మరియు', 'తో', 'aur', 'और', 'भी'];

/** A refusal reads as a removal, not an addition. */
const NEGATIONS = ['not', "don't", 'dont', 'do not', 'no', 'never', 'vaddu', 'వద్దు', 'వాడు కాదు', 'नहीं', 'नही', 'मत', 'ना'];

const EVERYTHING_WORDS = ['everything', 'all', 'all of it', 'anni', 'అన్ని', 'అన్నీ', 'sab', 'sab kuch', 'सब', 'सबकुछ', 'सब कुछ'];

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

function strip(text, words) {
  let rest = ` ${text} `;
  for (const word of [...words].sort((a, b) => b.length - a.length)) {
    if (/^[a-z0-9' ]+$/.test(word)) {
      rest = rest.replace(new RegExp(`(^| )${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`, 'g'), ' ');
    } else {
      rest = rest.split(word).join(' ');
    }
  }
  return rest.replace(/\s+/g, ' ').trim();
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
      const { quantity, rest: named } = extractQuantity(piece);
      const words = named.split(' ').filter((word) => word && !FILLER.has(word));
      return { quantity, text: words.join(' ') };
    })
    .filter((item) => item.text);
}

function namedTarget(text) {
  for (const { target, words } of TARGETS) {
    if (hasAny(text, words)) return target;
  }
  return null;
}

/** The matched target word and nothing else of substance — "offers", "my cart". */
function isBareTarget(text, target) {
  const words = TARGETS.find((entry) => entry.target === target)?.words || [];
  const rest = strip(text, [...words, ...GO_WORDS])
    .split(' ')
    .filter((word) => word && !FILLER.has(word));
  return rest.length === 0;
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

  // "stop" has to work while the agent is talking, so it is early — but only
  // as a command of its own. "Cancel my order" is a question about an order,
  // not a request for silence, and belongs to the assistant.
  if (hasAny(text, STOP_WORDS) && !target && text.split(' ').length <= 3) return { intent: 'stop' };
  if (hasAny(text, HELP_WORDS)) return { intent: 'help' };

  const cartNamed = hasAny(text, ['cart', 'basket', 'కార్ట్', 'బాస్కెట్', 'बास्केट', 'कार्ट', 'टोकरी']);
  const everything = hasAny(text, EVERYTHING_WORDS);
  if ((hasAny(text, CLEAR_WORDS) || hasAny(text, REMOVE_WORDS)) && (cartNamed || everything)) {
    if (everything || hasAny(text, CLEAR_WORDS)) return { intent: 'clear_cart' };
  }

  // A refusal is a removal: "I don't want tomato" must never add one.
  const negated = hasAny(text, NEGATIONS);
  if (hasAny(text, REMOVE_WORDS) || (negated && hasAny(text, ADD_WORDS))) {
    const items = namedItems(text, [...REMOVE_WORDS, ...ADD_WORDS]);
    if (items.length > 0) return { intent: 'remove_item', items };
    return { intent: 'remove_item', items: [] };
  }

  // "what's in my cart" and "what's the total" are READS of the cart, so they
  // are tested before `add`: "I want to know what is in the cart" carries a
  // want-word and would otherwise try to add "know what is".
  const reading = hasAny(text, READ_WORDS);
  if ((reading || hasAny(text, TOTAL_WORDS)) && cartNamed) return { intent: 'read_cart' };
  if (hasAny(text, TOTAL_WORDS) && !target) return { intent: 'read_cart' };

  if (hasAny(text, ADD_WORDS)) {
    const items = namedItems(text, ADD_WORDS);
    if (items.length > 0) return { intent: 'add_item', items };
  }

  if (reading && hasAny(text, SCREEN_WORDS)) return { intent: 'read_screen' };
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
