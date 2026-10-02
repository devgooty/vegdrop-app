'use strict';

const config = require('../../config/env');
const { ApiError } = require('../../middleware/errors');
const recipes = require('./recipes');
const proposals = require('./proposals');
const tools = require('./tools');
const { SYSTEM_PROMPT } = require('./systemPrompt');

/**
 * One assistant turn.
 *
 * With OPENAI_API_KEY: a tool-calling model, grounded in the recipe book.
 * Without it — and whenever the provider fails — the local router below, which
 * answers only from the recipe book and the catalog. The local router is what
 * most turns hit when no key is configured, so it has to be right on its own:
 * it says "I don't have that recipe" rather than answering with a near miss,
 * and `test/agentAccuracy.test.js` pins how real phrasing resolves.
 */

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user' && messages[i].content) return String(messages[i].content);
  }
  return '';
}

function reply(text, extra = {}) {
  return { reply: text, cards: [], proposedOrder: null, ...extra };
}

/** "Is bhindi available today?" — not "mooli and carrot available, suggest something". */
function asksAvailability(norm, raw) {
  return RE.availability.test(norm) && RE.availabilityAsk.test(raw.toLowerCase().trim()) && !RE.suggestAsk.test(norm);
}

/* ------------------------------------------------------------ recognisers */

const ORDINALS = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5 };

function parseServings(norm) {
  // "for 4 hours", "for 10 minutes", "for 1 kg" are not serving counts; reading
  // them as such silently rescaled the recipe and every cart after it.
  const m =
    norm.match(/\b(?:for|serves?|serving|feed|feeds)\s+(\d{1,2})\b(?!\s*(?:min\w*|hour\w*|hr|hrs|sec\w*|day\w*|whistle\w*|kg|g|gm|gram\w*|ml|litre\w*|liter\w*|rupee\w*|rs))/) ||
    norm.match(/\b(\d{1,2})\s*(?:people|persons?|members?|pax|servings?|mandiki|mandi|mandhi|logon|log|peru|perukku|adults?|guests?)\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 12 ? n : null;
}

function parsePick(norm) {
  const bare = norm.match(/^(?:no|number|option|opt|recipe|dish|show|show me|give|give me|tell me|make)?\s*([1-5])(?:st|nd|rd|th)?(?:\s*(?:one|please|pls|recipe))?$/);
  if (bare) return Number(bare[1]);
  const ord = norm.match(/^(?:the\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)(?:\s+one)?(?:\s+please)?$/);
  return ord ? ORDINALS[ord[1]] : null;
}

const RE = {
  greeting:
    /^(?:hi+|hii+|hello+|helo|hey+|hai|namaste|namaskar(?:am)?|vanakkam|ram ram|sat sri akal|salaam|salam|jai shri krishna|good (?:morning|afternoon|evening|night)|hola|yo)(?: (?:there|bro|sir|madam|anna|akka|ji|team|chef|bhai|bhaiya|yaar|dost|didi|garu))*(?: (?:how are you|kaise ho|kya haal hai|ela unnaru|ela unnav|eppadi irukeenga|eppadi irukinga))?$/,
  thanks: /^(?:thanks?|thank you|thx|ty|super|great|nice|ok thanks|dhanyavad|dhanyavaad|dhanyavadalu|nandri)(?: (?:a lot|so much|bro|sir|anna))?$/,
  confirm:
    /^(?:yes|yes please|yes place|yeah|yep|confirm|confirmed|confirm it|confirm order|place|place it|place order|place the order|go ahead|order it|haan|han|haan ji|avunu|sare|sari|done|proceed)$/,
  cancel:
    /^(?:no|nope|cancel|cancel it|cancel the order|cancel order|dont|don t|don t order|dont order|do not order|no dont|no don t|not now|later|stop|leave it|rehne do|nahi|nahee|vaddu|venda|wait)$/,
  orderStatus: /\b(?:order status|status of (?:my )?order|where is my order|track (?:my )?order|my order|delivery status|when will .* (?:arrive|come|deliver))\b/,
  // No bare "missing", "deliver", "kavali" or "venum": those are how people ask
  // for a RECIPE ("sambar recipe venum") or describe a shortage.
  order:
    /\b(?:order|buy|purchase|add (?:to|in) (?:cart|basket)|put in (?:the )?(?:cart|basket)|cart|basket|order missing|kharid\w*|mangwa\w*|mangao|khareed\w*)\b/,
  price: /\b(?:price|prices|cost|costs|rate|rates|how much (?:is|are|for|does)|kitna|kitne|kitni|entha|enta|evvalavu|evlo|dhara|vela|bhav|bhaav|daam)\b/,
  // "Is tomato available?" is a stock question; "mooli and carrot available,
  // something for kids" is telling us what they have.
  availability: /\b(?:available|availability|in stock|stock|dorukutunda|dorukuthunda|milega|milta)\b/,
  availabilityAsk: /^(?:is|are|do you have|do u have|have you got|any|kya)\b|\b(?:hai kya|kya hai|today|aaj|now|unda|undha|ippudu)\b|\?\s*$/,
  suggestAsk: /\b(?:suggest|something|anything|cook|make|recipe|dish|kids|lunch|dinner)\b/,
  question:
    /^(?:can|could|should|why|how|is|are|does|do|what|when|which|will|where)\b|\?\s*$|\b(?:kaise|kese|kyun|kyu|kya karu|kya karun|kya kare|kya karein|kaise karu|kaise kare|kaise bane|kab|enduku|em cheyali|emi cheyali|yen|yaake|enna pannanum)\b/,
  health:
    /\b(?:diabet\w*|sugar patient|blood sugar|bp|blood pressure|cholesterol|weight loss|lose weight|calorie\w*|protein|pregnan\w*|healthy|good for (?:health|diabet\w*|sugar|heart|kidney|weight|skin|hair|eyes)|nutrition\w*|kidney|thyroid|pcos|heart|cure\w*|medicine|iron|ha?emoglobin|vitamins?|ana?emia|immunity|digestion|acidity|constipation|badhta|badhata|uric acid|gout|kidney stones?|allerg\w*|kha sakte|kha sakta|kha sakti|khana chahiye|safe to eat|tinavacha|tinocha|sapidalama)\b/,
  capability: /\b(?:what can you do|what do you do|how can you help|how do you work|who are you|what are you|help me)\b/,
  have:
    /\b(?:i have|i ve|ive got|have got|i got|got some|with|using|use up|leftover|left over|what can i (?:cook|make)|what (?:to|should i|shall i|can we|do i) (?:cook|make)|what to prepare|suggest|suggestions?|ideas?|options?|mere paas|mere pas|hai mere|pada hai|pade hai|pade hain|padi hai|rakha hai|rakhe hai|ghar pe|ghar par|ghar mein|ghar me|at home|in (?:the |my )?fridge|kya banau|kya banaun|kya banaye|kya bana sakte|kuch bata\w*|naa daggara|na daggara|naa daggira|intlo|unnayi|unnai|undi|irukku|iruku|irukkuthu|veettula|le aaya|le aayi|le aaye|le aaye hai|laya|laaye|kharida|kharidi|kharide|bought|tecchanu|techanu|tecchina|vaangi\w*|inka kya|iska kya|inko kya|isko kya|what (?:to|can i|should i) do with|use (?:them|these) up)\b/,
  askDish:
    /\b(?:recipe|recipes|how to|how do i|how can i|make|making|cook|cooking|prepare|banaye|banate|banana|banao|bnana|banti|banta|bante|bnta|banaen|cheyali|cheyyali|cheyadam|chestaru|eppadi|epdi|seivathu|seivadhu)\b/,
  also: /^(?:also|and|plus|aur|inka|innum)\b/,
};

/**
 * Short, accurate answers to the cooking questions people ask most, for when
 * no model is configured. Each is a technique fact rather than a recipe, and
 * each deliberately corrects the common myth where there is one.
 */
const FAQ = [
  {
    /*
      FIRST, deliberately. Bitter bottle gourd contains cucurbitacins and has
      caused real poisonings, including from juice; cooking does not make it
      safe, so the only correct answer is to throw it away. The bitter-gourd
      entry below says the opposite — salt it, squeeze it, cook it — and any
      overlap between the two must resolve to this one.
    */
    test: /\b(?:lauki|bottle gourd|sorakaya|dudhi|doodhi|ghiya|ghia|anapakaya|sorakkai|calabash)\b[\s\S]*\b(?:bitter\w*|kadw\w*|kadv\w*|karwa|karva|chedu|kasappu|kahi)\b|\b(?:bitter\w*|kadw\w*|kadv\w*|karwa|karva)\b[\s\S]*\b(?:lauki|bottle gourd|sorakaya|dudhi|doodhi|ghiya|ghia|anapakaya|sorakkai)\b/,
    answer:
      'Taste bottle gourd before you cook it: cut a small piece from the stem end and touch it to your tongue. If it is even slightly bitter, throw the WHOLE gourd away — do not cook it, and never drink bitter lauki juice. Bitter bottle gourd contains toxic compounds that cooking does not remove, and it can cause severe vomiting and stomach bleeding. A good one tastes mild and faintly sweet.',
  },
  {
    test: /\b(?:boil\w*|cook\w*)\b.*\b(?:potato\w*|aloo)\b|\b(?:potato\w*|aloo)\b.*\bboil\w*/,
    exclude: /\b(?:air ?fry\w*|airfryer|microwave|oven|bake\w*|roast\w*|grill\w*)\b/,
    answer:
      'Boiling potatoes:\n• Whole medium potatoes: 20–25 min in boiling salted water, until a knife slides in with no resistance.\n• 1-inch cubes: 8–10 min.\n• Pressure cooker: whole medium potatoes with water just covering them, 3–4 whistles on medium, then let the pressure drop on its own.\nDrain well and let them steam dry a minute before mashing or frying.',
  },
  {
    test: /\b(?:bhindi|okra|bendakaya|vendakkai|lady ?finger|ladies finger)\b.*\b(?:slim\w*|stick\w*|sticky|lacy|gooey|chipchip\w*)\b|\b(?:slim\w*|sticky|stick\w*)\b.*\b(?:bhindi|okra|bendakaya|vendakkai)\b/,
    answer:
      'Keeping bhindi from going slimy:\n• Wash it, then dry every piece completely (towel, or air-dry 30 min) BEFORE cutting.\n• Wipe the knife now and then; cut thick rounds, not thin slices.\n• Cook uncovered on medium-high, in a wide pan, without crowding.\n• Add salt and anything sour (tomato, amchur, lemon, curd) only near the end.',
  },
  {
    // Anchored on the vegetable: an unanchored "reduce … bitter" answered for
    // bottle gourd, cucumber and anything else with the salt-and-squeeze trick.
    test: /\b(?:karela|karele|bitter gourd|bittergourd|bitter melon|kakarakaya|kakara|pavakkai|hagalakayi)\b[\s\S]*\b(?:bitter\w*|kadva\w*|kadwa\w*|kadwi|chedu|kasappu)\b|\b(?:bitter\w*|kadva\w*|kadwa\w*|reduce|remove|less)\b[\s\S]*\b(?:karela|karele|bitter gourd|bittergourd|kakarakaya|pavakkai)\b/,
    answer:
      'Taking the edge off bitter gourd:\n• Lightly scrape the rough ridges, slice, and remove large hard seeds.\n• Rub with salt (and a pinch of turmeric), rest 20–30 min, then squeeze out the water firmly.\n• Cooking it with onion, a little jaggery, or tamarind balances what bitterness remains — some bitterness is the point of the vegetable.',
  },
  {
    test: /\b(?:brinjal|baingan|vankaya|eggplant|kathirikai)\b.*\b(?:black|brown|dark|colou?r)\b/,
    answer: 'Cut brinjal darkens in air. Drop the pieces into a bowl of water with a pinch of salt as you cut, and drain just before cooking.',
  },
  {
    test: /\b(?:store|storing|stored|keep|keeping|fresh|last)\b.*\b(?:coriander|dhaniya|kothimeera|cilantro)\b|\b(?:coriander|dhaniya|kothimeera)\b.*\b(?:store|storing|fridge|fresh|last|wilt\w*)\b/,
    answer:
      'Keeping coriander fresh: pick out wilted or yellow sprigs, cut off the roots, and wrap it UNWASHED in a dry paper towel or cloth inside a closed box in the fridge. It keeps 7–10 days. Wash only what you are about to use.',
  },
  {
    test: /\b(?:dal|daal|pappu|toor|tur|arhar)\b.*\b(?:whistle\w*|pressure|soak\w*|water|how long|boil\w*)\b|\b(?:whistle\w*|soak\w*)\b.*\b(?:dal|daal|pappu)\b/,
    answer:
      'Cooking toor dal: rinse 2–3 times; soaking 20–30 min is optional but speeds it up. Pressure-cook 1 cup dal with 2½–3 cups water, a pinch of turmeric and a few drops of oil, 3–4 whistles on medium, and let the pressure release naturally. It should mash smoothly with a ladle.',
  },
  {
    test: /\btoo (?:much )?salt\w*|\bover ?salt\w*|\btoo salty\b|\bextra salt\b|\bu?ppu ekkuva\w*|\buppu jaasthi\w*|\bnamak (?:zyada|jyada|jada)\b|\b(?:zyada|jyada) namak\b|\bsalt (?:is )?(?:more|high|extra)\b/,
    answer:
      'Too salty: add more of the unsalted base — boiled potato or vegetable pieces, a little tomato purée, water or coconut milk for a gravy, or curd/cream in North Indian gravies — and cook a few more minutes. (A raw potato dropped in to "absorb" salt removes very little.)',
  },
  {
    test: /\btoo (?:much )?spic\w*|\btoo hot\b|\bextra (?:chilli|spic\w*)|\bkaram ekkuva\w*|\b(?:zyada|jyada) (?:teekha|mirch)|\b(?:teekha|mirch) (?:zyada|jyada)\b/,
    answer:
      'Too spicy: stir in curd, cream, coconut milk or a spoon of ghee, and a pinch of sugar or jaggery; adding more of the base vegetable or a squeeze of lemon also helps. Serve with plain rice or curd on the side.',
  },
  {
    test: /\b(?:rice|chawal|pulao|pulav|biryani|annam)\b.*\b(?:stick\w*|sticky|chipak\w*|mushy|lumpy|khila|separate|grainy|gila|gilla|muddha)\b|\b(?:chipak\w*|khila khila)\b/,
    answer:
      'For separate, non-sticky grains (pulao, biryani, fried rice):\n• Rinse the rice 3–4 times until the water runs almost clear, then soak basmati 20–30 min and drain well.\n• Use less water than for plain rice — about 1½–1¾ cups per cup of soaked basmati.\n• Once the water is in, stir only once; cook covered on the lowest heat, then rest 5–10 min before fluffing gently with a fork.\n• For fried rice, use rice cooked earlier and cooled completely.',
  },
  {
    test: /\b(?:arbi|arvi|taro|colocasia|chamagadda|seppankizhangu)\b.*\b(?:itch\w*|khujli|khujali|jalan|durada|duradha|arippu)\b/,
    answer:
      'Arbi (taro) itch: the skin and raw flesh contain calcium oxalate crystals that irritate. Rub a little oil on your hands or wear gloves before peeling — or boil/pressure-cook the arbi in its skin first, then peel; cooked arbi does not itch. If your hands itch, rinse them and rub on a little salt-water or tamarind water. Always cook arbi fully; undercooked arbi itches in the throat.',
  },
  {
    // A gravy word is required: "my rotis are too thick" and "dosa batter is
    // too thick" are not this question.
    test: /\b(?:gravy|curry|sambar|rasam|dal|daal|pappu|kuzhambu|sauce|kura|soup)\b[\s\S]*\b(?:too (?:thin|watery|runny|thick)|patli|patla|gaadhi|gadhi|gaadha)\b|\b(?:too (?:thin|watery|runny|thick)|patli|patla|gaadhi|gaadha)\b[\s\S]*\b(?:gravy|curry|sambar|rasam|dal|daal|pappu|kuzhambu|kura)\b/,
    answer:
      'Gravy consistency: too thin — simmer uncovered a few minutes, stirring, or mash a few cooked pieces into it. Too thick — add HOT water a little at a time and bring it back to a boil.',
  },
  {
    test: /\b(?:clean|wash|worm\w*|insect\w*|cut\w*)\b.*\b(?:cauliflower|gobi|gobhi)\b|\b(?:cauliflower|gobi)\b.*\b(?:clean|wash|worm\w*|insect\w*)\b/,
    answer:
      'Cleaning cauliflower: remove the leaves, cut the florets off the stem, and soak them 10–15 min in hot salted water with a pinch of turmeric — any insects float out. Rinse under running water and drain.',
  },
  {
    test: /\b(?:rice)\b.*\b(?:water|ratio|how much water|whistle\w*)\b/,
    answer:
      'Rice to water: Sona Masoori / everyday rice — 1 cup rice to 2–2½ cups water, 2–3 whistles on medium. Basmati soaked 20–30 min — 1 cup to 1½–1¾ cups water, covered on the lowest heat for 12–15 min, then rest 5 min before opening.',
  },
  {
    test: /\b(?:instead of|substitut\w*|replace\w*|alternative|don t have|dont have|no)\b.*\b(?:tamarind|imli|chintapandu|puli)\b|\b(?:tamarind|imli|chintapandu)\b.*\b(?:instead|substitut\w*|replace\w*|alternative)\b/,
    answer:
      'Instead of tamarind: lemon juice works — stir it in AFTER you switch off the heat (boiled lemon turns bitter), a little at a time, tasting as you go. For rasam, sambar or pulusu, an extra ripe tomato or a little amchur added while cooking also gives sourness. The flavour will be brighter and less deep than tamarind.',
  },
  {
    test: /\b(?:instead of|substitut\w*|replace\w*|alternative|don t have|dont have|no)\b.*\b(?:fresh cream|cream|malai)\b/,
    answer:
      'Instead of cream in a gravy: blend 8–10 cashews soaked 15 min in hot water into a smooth paste, or stir in whisked full-fat milk with a small knob of butter at the end on low heat. Thick curd also works — whisk it smooth and add off the heat so it does not split.',
  },
  {
    test: /\b(?:store|storing|keep|keeping)\b.*\b(?:tomato\w*|onion\w*|potato\w*)\b/,
    answer:
      'Storing: onions and potatoes in a cool, dark, airy place — but NOT together (onions make potatoes sprout). Tomatoes at room temperature out of the sun until ripe; refrigerate only once fully ripe, and use within a few days.',
  },
];

/* -------------------------------------------------------------- formatting */

function recipeReply(detail) {
  const meta = [`${detail.minutes} min`, `for ${detail.servings}`, detail.cuisine].filter(Boolean).join(' · ');
  const produce = detail.ingredients.filter((i) => i.produce && !i.optional).map((i) => i.name);
  return (
    `**${detail.name}** — ${meta}\n` +
    (produce.length ? `Vegetables: ${[...new Set(produce)].join(', ')}\n` : '') +
    (detail.servesWith ? `Serve with ${detail.servesWith}.\n` : '') +
    `\nFull ingredients, steps and tips are in the card below. Say **order missing ingredients** to get the vegetables, or **for 4 people** to rescale.`
  );
}

function vegetarianAlternatives(norm) {
  const pick = [];
  if (/biryani|biriyani/.test(norm)) pick.push('veg-biryani');
  if (/fried rice/.test(norm)) pick.push('veg-fried-rice');
  if (/noodle/.test(norm)) pick.push('veg-hakka-noodles');
  if (/soup/.test(norm)) pick.push('veg-clear-soup', 'tomato-soup');
  if (/manchurian|chilli|chili|65|fry/.test(norm)) pick.push('chilli-mushroom', 'gobi-manchurian');
  if (/pulao|pulav/.test(norm)) pick.push('veg-pulao');
  if (/cutlet|tikki|kebab|kabab/.test(norm)) pick.push('veg-cutlet', 'aloo-tikki');
  pick.push('paneer-butter-masala', 'mushroom-masala', 'matar-paneer');
  const known = new Set(recipes.RECIPES.map((r) => r.id));
  return [...new Set(pick)]
    .filter((id) => known.has(id))
    .slice(0, 3)
    .map((id, i) => ({ index: i + 1, ...cardFor(id) }));
}

function cardFor(id) {
  const r = recipes.getRecipe(id, recipes.DEFAULT_SERVINGS);
  return { id: r.id, name: r.name, minutes: r.minutes, difficulty: r.difficulty, cuisine: r.cuisine, dishType: r.dishType, matchScore: null, covered: r.vegetables, missing: [] };
}

/* ------------------------------------------------------------ the router */

async function showRecipe(session, recipeId, servings) {
  const detail = await tools.getRecipeTool({ recipeId, servings });
  session.lastRecipeId = detail.id;
  return reply(recipeReply(detail), { cards: [{ type: 'recipe', ...detail }] });
}

async function proposeFor(user, session, recipeId, context) {
  try {
    const preview = await tools.proposeOrderTool(user, {
      recipeId,
      servings: session.servings,
      haveVegetables: session.vegetables,
      marketId: context.marketId,
      shopId: context.shopId,
      paymentMethod: context.paymentMethod || 'cod',
    });
    session.lastRecipeId = recipeId;
    const detail = recipes.getRecipe(recipeId, session.servings);
    const notes = [];
    if (preview.alreadyHave?.length) notes.push(`Left out what you have: ${preview.alreadyHave.join(', ')}.`);
    const unavailable = preview.lines.filter((l) => l.missingFromCatalog).map((l) => l.name);
    if (unavailable.length) notes.push(`Not sold on VegDrop right now: ${unavailable.join(', ')}.`);
    if (preview.lines.some((l) => l.lowStock)) notes.push('Some items are running low and may be short.');
    return reply(
      `Here's a cart for **${detail.name}** (for ${preview.servings}).\n` +
        `Total ₹${preview.total}${preview.deliveryFee ? ` including ₹${preview.deliveryFee} delivery` : ' (free delivery)'}.\n` +
        (notes.length ? `\n${notes.join('\n')}\n` : '') +
        `\nTap **Confirm order** below (or reply **confirm**) to place it.`,
      { cards: [{ type: 'proposal', ...preview }], proposedOrder: preview }
    );
  } catch (err) {
    return reply(err.message || 'Could not build that cart.');
  }
}

async function haveReply(session, vegetables) {
  const { matches } = await tools.listMatchingRecipesTool({ vegetables, servings: session.servings });
  session.lastMatches = matches;
  const names = vegetables.join(', ');
  if (!matches.length) {
    return reply(
      `I don't have a tested recipe built around **${names}** yet. Tell me another vegetable you have, or name a dish you'd like to cook.`
    );
  }
  return reply(
    `With **${names}** you can make these — tap one (or reply with its number) for the full recipe:`,
    { cards: matches.map((m) => ({ type: 'recipe_match', ...m })) }
  );
}

async function runLocalTurn(user, messages, context = {}) {
  const text = lastUserText(messages);
  const norm = recipes.normalize(text);
  const session = proposals.getSession(user._id);
  const wordCount = norm ? norm.split(' ').length : 0;

  const servings = parseServings(norm);
  if (servings) session.servings = servings;

  if (!norm) {
    // Not "say something": a message in Telugu or Devanagari script normalizes
    // away to nothing, and telling that customer they sent nothing is wrong.
    if (/\p{L}/u.test(text)) {
      return reply(
        "Sorry — I can only read messages typed in English letters at the moment. Please write the dish or vegetable that way (for example *gutti vankaya*, *aloo gobi*), and I'll help."
      );
    }
    return reply('Tell me a dish you want to cook, or the vegetables you have.');
  }

  /*
    1. Confirm a pending preview.

    A confirm counts ONLY as the reply to the preview itself. "yes", "haan" and
    "done" are ordinary answers to "Did you mean one of these?" or to a question
    the customer asked afterwards — and the preview had a ten-minute life, so a
    yes three turns later was placing an order for a dish that had long left the
    screen, charged against whatever the cart held at the time. So the pending
    id is taken at the top of every turn and only put back by the branch that
    re-proposes: any turn that is not an immediate confirm discards it.
  */
  const pendingProposalId = session.lastProposalId;
  session.lastProposalId = null;

  if (pendingProposalId && RE.confirm.test(norm)) {
    try {
      const placed = await tools.confirmOrderTool(user, {
        proposalId: pendingProposalId,
        address: context.address,
        lat: context.lat,
        lng: context.lng,
      });
      return reply(
        `Order placed ✅\n\n${placed.itemCount} item${placed.itemCount === 1 ? '' : 's'}\nOrder ${placed.orderNumber}\nTotal ₹${placed.totalAmount}\nStatus: ${placed.status}\n\nYou can track it under Orders.`,
        { cards: [{ type: 'order', ...placed }] }
      );
    } catch (err) {
      // The preview survives a failure the customer can act on (no address
      // saved, an item just sold out) so Confirm works after they fix it.
      if (proposals.peekProposal(pendingProposalId, user._id)) session.lastProposalId = pendingProposalId;
      return reply(err.message || 'Could not place that order.');
    }
  }

  // An explicit "no" / "cancel" answers the preview and clears it (done above).
  if (pendingProposalId && RE.cancel.test(norm)) {
    proposals.dropProposal(pendingProposalId, user._id);
    return reply('Cancelled — nothing ordered. Tell me what you want to cook next.');
  }

  // A bare yes or no with nothing pending is an answer to a question that has
  // gone; it is not a dish name, and reading it as one said "I have no recipe
  // for **yes**".
  if (RE.confirm.test(norm) || RE.cancel.test(norm)) {
    return reply(
      session.lastRecipeId
        ? 'There is nothing waiting to be confirmed. Say **order missing ingredients** if you want the vegetables for that dish.'
        : "There's nothing waiting to be confirmed. Name a dish, or tell me which vegetables you have."
    );
  }

  // 2. "Where is my order" — the Orders screen is the source of truth.
  if (RE.orderStatus.test(norm)) {
    return reply('You can see live status for every order under **Orders** (Account → Orders). I can help you cook something meanwhile!');
  }

  const dishMatches = recipes.findRecipesByDishName(text, { limit: 5 });
  const confident = recipes.isConfidentMatch(dishMatches);

  /*
    3. Put a dish's vegetables in a cart.

    Guarded hard, because this branch ends in a confirmable cart. "recipe
    kavali" and "sambar venum" are Telugu and Tamil for "I want the recipe",
    not "buy it"; a message that also asks HOW to cook is a recipe request;
    and a request to deliver or a mention of a missing item is not an order on
    its own. Each of those built a cart for whatever dish was last on screen.
  */
  const wantsOrder =
    RE.order.test(norm) &&
    // "I don't want to order anything" says the opposite; cleanQuery removes
    // negated spans, so the order verb has to survive that to count.
    RE.order.test(recipes.cleanQuery(text)) &&
    !RE.price.test(norm) &&
    !asksAvailability(norm, text) &&
    !RE.cancel.test(norm);

  if (wantsOrder) {
    let recipeId = null;
    // Only an explicitly marked number is a pick. A bare digit is far more
    // often a quantity or a serving count — "order the ingredients for 4
    // servings" built a cart for dish #4 of a list from three turns ago.
    const pick = norm.match(/\b(?:number|option|opt|no|#)\s*([1-5])\b/) || norm.match(/\b([1-5])(?:st|nd|rd|th)\b/);
    if (confident) recipeId = dishMatches[0].id;
    else if (pick && session.lastMatches.length) recipeId = session.lastMatches.find((m) => m.index === Number(pick[1]))?.id || null;
    // The recipe on screen, before any list behind it.
    if (!recipeId) recipeId = session.lastRecipeId || (session.lastMatches.length === 1 ? session.lastMatches[0].id : null);
    if (recipeId) return proposeFor(user, session, recipeId, context);
    if (session.lastMatches.length > 1) {
      return reply('Which dish should I order for? Reply e.g. **order number 2**.', {
        cards: session.lastMatches.map((m) => ({ type: 'recipe_match', ...m })),
      });
    }
    return reply('Tell me the dish first (e.g. *aloo gobi*) and I will put its vegetables in a cart for you.');
  }

  // 4. Picking from the last list.
  const pick = parsePick(norm);
  if (pick && session.lastMatches.length) {
    const chosen = session.lastMatches.find((m) => m.index === pick);
    if (chosen) return showRecipe(session, chosen.id, session.servings);
    return reply(`Pick a number from 1 to ${session.lastMatches.length}.`);
  }

  // 5. Small talk.
  if (RE.greeting.test(norm) || (RE.capability.test(norm) && !recipes.extractVegetables(text).length && !confident)) {
    return reply(
      'Hi! 👋 I can help you cook.\n\n• Name a dish — *gutti vankaya*, *aloo gobi*, *palak paneer*\n• Or tell me what you have — *I have potato and beans*\n• Ask a question — *how to stop bhindi getting sticky*\n\nThen I can put the vegetables in your cart.'
    );
  }
  if (RE.thanks.test(norm)) return reply('Happy cooking! 🍲 Ask me anytime.');

  /*
    6. Meat, egg, fish.

    Not when a vegetarian dish in the book was clearly named: these words are
    only ever matched as whole words in roman text, and the same spelling means
    something else elsewhere — "maadi kodi" is Kannada for "please make" while
    `kodi` alone is Telugu for chicken, and "egg plant" is a brinjal.
  */
  if (recipes.isNonVegRequest(text) && !confident) {
    const alts = vegetarianAlternatives(norm);
    session.lastMatches = alts;
    return reply(
      `VegDrop's recipes are all vegetarian, so I can't help with that one. Close vegetarian options — tap one for the recipe:`,
      { cards: alts.map((m) => ({ type: 'recipe_match', ...m })) }
    );
  }

  const vegetables = recipes.extractVegetables(text);

  // 7. Health — no medical claims.
  if (RE.health.test(norm)) {
    const base =
      "I can't give medical or diet advice — please check with your doctor or a dietitian for that. I'm happy to help you cook it, though.";
    if (vegetables.length) {
      const out = await haveReply(session, vegetables);
      return { ...out, reply: `${base}\n\n${out.reply}` };
    }
    return reply(base);
  }

  // 8. Prices from the live catalog.
  if ((RE.price.test(norm) || asksAvailability(norm, text)) && !confident) {
    if (!vegetables.length) return reply('Which vegetable? e.g. *price of tomato*.');
    const rows = await tools.searchCatalog({ query: text, limit: 6 });
    if (!rows.length) return reply(`I couldn't find ${vegetables.join(', ')} on VegDrop right now.`);
    const lines = rows.map(
      (r) => `• **${r.name}** — ₹${r.price} per ${r.weight}${r.inStock ? '' : ' (out of stock)'}`
    );
    return reply(`Current prices:\n${lines.join('\n')}\n\nPrices can differ slightly by market.`);
  }

  // 9. Technique questions with a known, accurate answer.
  const faq = FAQ.find((f) => f.test.test(norm) && !f.exclude?.test(norm));
  if (faq && !confident) return reply(faq.answer);

  // 10. "for 4 people" on its own rescales the last recipe.
  if (servings && session.lastRecipeId && !dishMatches.length && !vegetables.length) {
    return showRecipe(session, session.lastRecipeId, servings);
  }

  // 11. Dish or vegetables?
  const tokens = recipes.tokenize(recipes.cleanQuery(text));
  const onlyVegetables = tokens.length > 0 && tokens.every((t) => t.startsWith('veg:'));
  const saysHave = RE.have.test(norm);

  // "aloo matar" is two vegetables AND a dish name; a typed dish name wins —
  // as it does in "veg clear soup with celery", where "with" is not "I have".
  // So does an unknown dish someone asks to make ("misal pav ghar pe banana hai").
  const namedDish = dishMatches.some((m) => m.exact);
  const namesADish = confident && dishMatches[0].namesDish;
  const asksForUnknownDish = RE.askDish.test(norm) && recipes.unknownWords(text).length > 0 && !namedDish;
  if (
    vegetables.length &&
    !asksForUnknownDish &&
    ((saysHave && !namesADish) || (onlyVegetables && !confident && !namedDish))
  ) {
    const list = RE.also.test(norm) ? [...new Set([...session.vegetables, ...vegetables])] : vegetables;
    session.vegetables = list;
    return haveReply(session, list);
  }

  if (confident) return showRecipe(session, dishMatches[0].id, session.servings);

  const unknown = recipes.unknownWords(text);
  const looksLikeDishRequest = RE.askDish.test(norm) || tokens.some((t) => t.startsWith('form:')) || wordCount <= 3;

  // A question we have no tested answer for gets an honest "not sure" — not a
  // made-up answer, and not "no recipe for 'freeze puree'".
  if (RE.question.test(text.toLowerCase().trim()) && !RE.askDish.test(norm) && !dishMatches.some((m) => m.exact) && !(dishMatches[0]?.matchScore >= 85)) {
    return reply(
      "I'm not sure about that one, and I'd rather not guess. I can give you tested recipes, suggest dishes from the vegetables you have, tell you today's prices, and answer common kitchen questions (boiling, storing, fixing salt or spice)."
    );
  }

  if (dishMatches.length) {
    session.lastMatches = dishMatches;
    const cards = dishMatches.map((m) => ({ type: 'recipe_match', ...m }));
    // A word we have never heard of ("bagara baingan") is a dish we do not
    // have — say so, and offer the near ones as what they are: other dishes.
    if (unknown.length && !namedDish && dishMatches[0].matchScore < 85) {
      return reply(
        `I don't have a tested recipe for **${recipes.surfaceWords(recipes.cleanQuery(text)).join(' ')}** yet, so I won't guess at one. Closest dishes I do have:`,
        { cards }
      );
    }
    return reply('Did you mean one of these? Tap one (or reply with its number) for the recipe.', { cards });
  }

  // Nothing matched: every content word is "unknown" to this request, even one
  // that happens to appear in some alias ("dosa" in "chutney for dosa").
  const asking = dishMatches.length ? unknown : tokens.filter((t) => !t.includes(':'));
  if (looksLikeDishRequest && asking.length) {
    // Quote the dish as they typed it ("dal makhani restaurant"), not the
    // leftover unknown tokens ("makhani restaurant").
    const asked = recipes.surfaceWords(recipes.cleanQuery(text)).join(' ') || asking.join(' ');
    const base = `I don't have a tested recipe for **${asked}** yet, so I won't guess at one.`;
    if (vegetables.length) {
      const out = await haveReply(session, vegetables);
      return { ...out, reply: `${base} Here's what I can do with ${vegetables.join(', ')}:\n\n${out.reply}` };
    }
    return reply(`${base} Try another dish, or tell me which vegetables you have and I'll suggest what to cook.`);
  }

  if (vegetables.length) {
    session.vegetables = vegetables;
    return haveReply(session, vegetables);
  }

  return reply(
    "I'm your VegDrop cooking helper 🥕\n\n" +
      '• Name a dish → *gutti vankaya*, *aloo gobi*, *sambar*\n' +
      "• Or list what you have → *I have potato and beans* — I'll suggest dishes\n" +
      '• Ask → *how long to boil potatoes*\n' +
      '• Say **order missing ingredients** → cart preview'
  );
}

/* ------------------------------------------------------------- model path */

function sessionNote(session) {
  const parts = [`Default servings: ${session.servings}.`];
  if (session.lastRecipeId) parts.push(`Last recipe shown: ${session.lastRecipeId}.`);
  if (session.vegetables.length) parts.push(`Vegetables the customer said they have: ${session.vegetables.join(', ')}.`);
  if (session.lastMatches.length) {
    parts.push(`Last numbered list: ${session.lastMatches.map((m) => `${m.index}=${m.id}`).join(', ')}.`);
  }
  return parts.join(' ');
}

async function runOpenAiTurn(user, messages, context = {}) {
  const apiKey = config.agent.apiKey;
  const model = config.agent.model;
  const session = proposals.getSession(user._id);
  const servings = parseServings(recipes.normalize(lastUserText(messages)));
  if (servings) session.servings = servings;

  const openaiMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: `Session: ${sessionNote(session)}` },
    ...messages.slice(-12).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || ''),
    })),
  ];

  let proposedOrder = null;
  const cards = [];
  let guard = 0;

  while (guard < 6) {
    guard += 1;
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        messages: openaiMessages,
        tools: tools.TOOL_DEFS,
        tool_choice: 'auto',
      }),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('[agent] openai error', response.status, body?.error);
      throw new ApiError(502, 'The cooking assistant is busy. Please try again.', 'AGENT_PROVIDER_ERROR');
    }

    const choice = body.choices?.[0]?.message;
    if (!choice) {
      throw new ApiError(502, 'The cooking assistant returned an empty reply.', 'AGENT_PROVIDER_ERROR');
    }

    if (choice.tool_calls?.length) {
      openaiMessages.push(choice);
      for (const call of choice.tool_calls) {
        const name = call.function?.name;
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || '{}');
        } catch {
          args = {};
        }
        if (name === 'propose_order') {
          // Who we are buying from, and how it is paid for, come from the
          // signed-in app context — never from the model, which has no tool
          // that returns a market or shop id and so can only invent one.
          args.marketId = context.marketId;
          args.shopId = context.shopId;
          args.paymentMethod = context.paymentMethod === 'wallet' ? 'wallet' : 'cod';
          if (!args.servings) args.servings = session.servings;
          if (!Array.isArray(args.haveVegetables) && session.vegetables.length) args.haveVegetables = session.vegetables;
        }
        if ((name === 'get_recipe' || name === 'list_matching_recipes' || name === 'find_recipes_by_name') && !args.servings) {
          args.servings = session.servings;
        }
        let result;
        try {
          result = await tools.executeTool(user, name, args);
        } catch (err) {
          result = { error: err.message || 'Tool failed', code: err.code };
        }
        if (name === 'propose_order' && result?.proposalId) {
          proposedOrder = result;
          cards.push({ type: 'proposal', ...result });
        }
        if ((name === 'list_matching_recipes' || name === 'find_recipes_by_name') && result?.matches) {
          session.lastMatches = result.matches;
          if (name === 'list_matching_recipes') session.vegetables = recipes.extractVegetables((args.vegetables || []).join(', '));
          // A confident name lookup is followed by get_recipe, whose card says it all.
          if (!(name === 'find_recipes_by_name' && recipes.isConfidentMatch(result.matches))) {
            for (const m of result.matches) cards.push({ type: 'recipe_match', ...m });
          }
        }
        if (name === 'get_recipe' && result?.id) {
          session.lastRecipeId = result.id;
          cards.push({ type: 'recipe', ...result });
        }
        openaiMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      continue;
    }

    return {
      reply: choice.content || 'Done.',
      cards,
      proposedOrder,
    };
  }

  return {
    reply: 'I gathered the details above — tell me what you want next.',
    cards,
    proposedOrder,
  };
}

async function runTurn(user, messages, context = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ApiError(400, 'Send at least one message.', 'VALIDATION_ERROR');
  }

  /*
    A pending preview is settled by the local branch on BOTH paths.

    The screen and the local router both invite "confirm", but on the model path
    that word reached the model, which has no confirm tool — so it answered as
    if the order were placed, or said nothing useful, while the preview quietly
    stayed pending. Placing an order is not a decision to delegate to a model in
    any case: one function decides it, and it is the one with the attempt rules.
  */
  const pending = proposals.getSession(user._id).lastProposalId;
  const settles = pending && (RE.confirm.test(recipes.normalize(lastUserText(messages))) || RE.cancel.test(recipes.normalize(lastUserText(messages))));

  if (config.agent.configured && !config.isTest && !settles) {
    try {
      return await runOpenAiTurn(user, messages, context);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'AGENT_PROVIDER_ERROR') {
        // Fall through to local so the user is not stuck mid-chat.
        console.warn('[agent] falling back to local turn', err.message);
      } else {
        throw err;
      }
    }
  }

  return runLocalTurn(user, messages, context);
}

module.exports = { runTurn, runLocalTurn, parseServings, parsePick };
