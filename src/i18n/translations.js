/**
 * Translation strings.
 *
 * Covers the chrome that is on screen everywhere — bottom navigation, panel
 * headers, and the language picker itself — across all three apps (customer,
 * shopkeeper, delivery), plus the small set of buttons those settings screens
 * share (Save/Cancel/Sign out). It does not cover every string in the apps:
 * product names, order details and the deeper screens stay in English for
 * now. That is a real scope line, not an oversight — translating those
 * accurately is a much larger, ongoing task, and a wrong translation on a
 * price or a delivery address is worse than an English one a shopkeeper or
 * rider already reads today.
 *
 * Language names are never translated — "हिंदी" is shown even when the
 * current language is English or Telugu, so someone who cannot read the
 * current language can still find their own in the list. That is the
 * standard convention for language pickers.
 */

export const LANGUAGES = [
  { code: 'en', nativeName: 'English' },
  { code: 'hi', nativeName: 'हिंदी' },
  { code: 'te', nativeName: 'తెలుగు' },
];

export const DEFAULT_LANGUAGE = 'en';

const STRINGS = {
  // --- Customer bottom nav (BottomNav.jsx) ----------------------------------
  'nav.home': { en: 'Home', hi: 'होम', te: 'హోమ్' },
  'nav.prices': { en: 'Prices', hi: 'भाव', te: 'ధరలు' },
  'nav.cart': { en: 'Cart', hi: 'कार्ट', te: 'కార్ట్' },
  'nav.orders': { en: 'Orders', hi: 'ऑर्डर', te: 'ఆర్డర్లు' },
  'nav.account': { en: 'Account', hi: 'खाता', te: 'ఖాతా' },

  // --- Shopkeeper nav (ShopkeeperPanel.jsx) ---------------------------------
  'nav.products': { en: 'Products', hi: 'उत्पाद', te: 'ఉత్పత్తులు' },
  'nav.analytics': { en: 'Analytics', hi: 'विश्लेषण', te: 'విశ్లేషణ' },
  'nav.profile': { en: 'Profile', hi: 'प्रोफ़ाइल', te: 'ప్రొఫైల్' },

  // --- Delivery nav (DeliveryPanel.jsx) -------------------------------------
  'nav.map': { en: 'Map', hi: 'नक़्शा', te: 'మ్యాప్' },
  'nav.trips': { en: 'Trips', hi: 'ट्रिप', te: 'ట్రిప్‌లు' },

  // --- Delivery panel headers ------------------------------------------------
  'header.dashboard': { en: 'Dashboard', hi: 'डैशबोर्ड', te: 'డాష్‌బోర్డ్' },
  'header.activeTasks': { en: 'Active Tasks', hi: 'सक्रिय कार्य', te: 'యాక్టివ్ టాస్క్‌లు' },
  'header.liveRoute': { en: 'Live Route', hi: 'लाइव रूट', te: 'లైవ్ రూట్' },
  'header.deliveries': { en: 'Deliveries', hi: 'डिलीवरी', te: 'డెలివరీలు' },
  'header.myProfile': { en: 'My Profile', hi: 'मेरी प्रोफ़ाइल', te: 'నా ప్రొఫైల్' },

  // --- Shopkeeper panel headers ----------------------------------------------
  'header.shopSettings': { en: 'Shop Settings', hi: 'दुकान सेटिंग्स', te: 'షాప్ సెట్టింగ్‌లు' },

  // --- Settings / language picker, shared by all three panels ----------------
  'settings.language': { en: 'Language', hi: 'भाषा', te: 'భాష' },
  'settings.languageHint': {
    en: 'Choose the language for menus and buttons across the app.',
    hi: 'ऐप में मेनू और बटन के लिए भाषा चुनें।',
    te: 'యాప్‌లో మెనూలు మరియు బటన్ల కోసం భాషను ఎంచుకోండి.',
  },

  // --- Shared buttons ----------------------------------------------------------
  'common.save': { en: 'Save', hi: 'सहेजें', te: 'సేవ్ చేయండి' },
  'common.cancel': { en: 'Cancel', hi: 'रद्द करें', te: 'రద్దు చేయండి' },
  'common.signOut': { en: 'Sign Out', hi: 'लॉग आउट', te: 'లాగ్ అవుట్' },
};

/**
 * @param {string} key
 * @param {'en'|'hi'|'te'} language
 * @returns {string} the translated string, or the English one if the key
 *   exists but this language is missing it, or the raw key as a last resort
 *   so a typo shows up as visibly wrong text rather than a blank label.
 */
export function translate(key, language) {
  const entry = STRINGS[key];
  if (!entry) return key;
  return entry[language] || entry[DEFAULT_LANGUAGE] || key;
}
