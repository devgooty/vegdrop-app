'use strict';

/**
 * Telugu and Hindi names for the seeded catalog, keyed on sku.
 *
 * Keyed on sku rather than on `name` because sku is the stable identity: the
 * English name is editable copy and has already been reworded once, which would
 * silently orphan every translation attached to it.
 *
 * Used twice, and that is the point of the file existing separately from
 * seed.js: once for rows this boot inserts, and once to backfill rows a previous
 * boot already inserted. `seedProducts()` only inserts *missing* skus, so
 * without the backfill every database that has ever run this app — which is all
 * of them — would keep its untranslated rows for good.
 *
 * Names are the everyday market word, not a transliteration of the English:
 * a shopper looking for బెండకాయ is not helped by "ఓక్రా". Where a vegetable
 * genuinely has no common Telugu/Hindi name (zucchini, celery, asparagus) the
 * accepted transliteration is used, because inventing one would be worse.
 */
const PRODUCT_NAME_TRANSLATIONS = {
  'VEG-SPINACH-250': { te: 'పాలకూర', hi: 'पालक' },
  'VEG-BROCCOLI-500': { te: 'బ్రోకలీ', hi: 'ब्रोकली' },
  'VEG-TOMATO-1000': { te: 'టమాటా', hi: 'टमाटर' },
  'VEG-ONION-1000': { te: 'ఉల్లిపాయలు', hi: 'लाल प्याज' },
  'FRT-AVOCADO-350': { te: 'అవకాడో', hi: 'एवोकाडो' },
  'VEG-CHILLI-100': { te: 'పచ్చిమిర్చి', hi: 'हरी मिर्च' },
  'VEG-PEAS-500': { te: 'పచ్చి బఠానీలు', hi: 'हरी मटर' },
  'VEG-BRINJAL-500': { te: 'వంకాయ', hi: 'बैंगन' },
  'VEG-CUCUMBER-500': { te: 'కీరదోస', hi: 'खीरा' },
  'VEG-BOTTLEGOURD-600': { te: 'సొరకాయ', hi: 'लौकी' },
  'VEG-CABBAGE-800': { te: 'క్యాబేజీ', hi: 'पत्ता गोभी' },
  'VEG-CAULIFLOWER-600': { te: 'కాలీఫ్లవర్', hi: 'फूल गोभी' },
  'VEG-CARROT-500': { te: 'క్యారెట్', hi: 'गाजर' },
  'VEG-BEETROOT-500': { te: 'బీట్‌రూట్', hi: 'चुकंदर' },
  'VEG-POTATO-1000': { te: 'బంగాళాదుంప', hi: 'आलू' },
  'VEG-GINGER-200': { te: 'అల్లం', hi: 'अदरक' },
  'VEG-GARLIC-200': { te: 'వెల్లుల్లి', hi: 'लहसुन' },
  'VEG-RIDGEGOURD-500': { te: 'బీరకాయ', hi: 'तुरई' },
  'VEG-BITTERGOURD-500': { te: 'కాకరకాయ', hi: 'करेला' },
  'VEG-OKRA-500': { te: 'బెండకాయ', hi: 'भिंडी' },
  'VEG-CAPSICUM-500': { te: 'పచ్చి క్యాప్సికం', hi: 'शिमला मिर्च' },
  'VEG-SWEETPOTATO-500': { te: 'చిలగడదుంప', hi: 'शकरकंद' },
  'VEG-GREENBEANS-500': { te: 'ఫ్రెంచ్ బీన్స్', hi: 'फ्रेंच बीन्स' },
  'VEG-SPRINGONION-150': { te: 'ఉల్లికాడలు', hi: 'हरा प्याज' },
  'VEG-TURNIP-500': { te: 'టర్నిప్', hi: 'शलगम' },
  'VEG-CORIANDER-100': { te: 'కొత్తిమీర', hi: 'हरा धनिया' },
  'VEG-PUMPKIN-1000': { te: 'గుమ్మడికాయ', hi: 'कद्दू' },
  'VEG-RADISH-500': { te: 'ముల్లంగి', hi: 'मूली' },
  'VEG-MUSHROOM-200': { te: 'బటన్ పుట్టగొడుగులు', hi: 'बटन मशरूम' },
  'VEG-ZUCCHINI-500': { te: 'జుకిని', hi: 'जुकीनी' },
  'VEG-LEEK-250': { te: 'లీక్', hi: 'लीक' },
  'VEG-CELERY-250': { te: 'సెలెరీ', hi: 'सेलेरी' },
  'VEG-RAWBANANA-500': { te: 'అరటికాయ', hi: 'कच्चा केला' },
  'VEG-FENNEL-250': { te: 'సోంపు దుంప', hi: 'सौंफ बल्ब' },
  'VEG-ASPARAGUS-250': { te: 'ఆస్పరాగస్', hi: 'शतावरी' },
  'VEG-LETTUCE-300': { te: 'ఐస్‌బర్గ్ లెట్యూస్', hi: 'आइसबर्ग सलाद पत्ता' },
  'VEG-MUSTARDGREENS-500': { te: 'ఆవాకూర', hi: 'सरसों का साग' },
};

/** The `{ nameTe, nameHi }` for a sku, or empty strings when untranslated. */
function translationsForSku(sku) {
  const entry = PRODUCT_NAME_TRANSLATIONS[sku];
  return { nameTe: entry?.te || '', nameHi: entry?.hi || '' };
}

module.exports = { PRODUCT_NAME_TRANSLATIONS, translationsForSku };
