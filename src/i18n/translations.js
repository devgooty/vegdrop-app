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
  'common.back': { en: 'Back', hi: 'वापस', te: 'వెనుకకు' },
  'common.change': { en: 'Change', hi: 'बदलें', te: 'మార్చు' },
  'common.close': { en: 'Close', hi: 'बंद करें', te: 'మూసివేయి' },

  // --- Header (Header.jsx) ---------------------------------------------------
  'header.searchLabel': { en: 'Search the shop', hi: 'दुकान में खोजें', te: 'షాప్‌లో వెతకండి' },
  'header.searchPlaceholder': {
    en: 'Search harvest...',
    hi: 'ताज़ी उपज खोजें...',
    te: 'తాజా పంట కోసం వెతకండి...',
  },
  'header.clearSearch': { en: 'Clear search', hi: 'खोज हटाएँ', te: 'వెతుకులాట తొలగించు' },
  'header.openWallet': { en: 'Open VegWallet', hi: 'VegWallet खोलें', te: 'VegWallet తెరవండి' },

  // --- Delivery address bar (HomeHeroBanner.jsx) -----------------------------
  'delivery.deliverTo': { en: 'Deliver to:', hi: 'यहाँ डिलीवरी:', te: 'ఇక్కడికి డెలివరీ:' },
  // Two English wordings for the same label — "Deliver to:" once there is an
  // address, "Delivery to:" before. Kept as separate keys so the English is
  // unchanged; both read the same in Telugu and Hindi.
  'delivery.deliveryTo': { en: 'Delivery to:', hi: 'यहाँ डिलीवरी:', te: 'ఇక్కడికి డెలివరీ:' },
  'delivery.setAddress': {
    en: 'Set your delivery address',
    hi: 'अपना डिलीवरी पता डालें',
    te: 'మీ డెలివరీ చిరునామా పెట్టండి',
  },
  'delivery.detectGps': { en: 'Detect GPS', hi: 'GPS पता लगाएँ', te: 'GPS గుర్తించు' },
  'delivery.locating': { en: 'Locating...', hi: 'पता लगाया जा रहा है...', te: 'గుర్తిస్తోంది...' },
  'delivery.noGeolocation': {
    en: 'Geolocation is not supported by your browser.',
    hi: 'आपका ब्राउज़र लोकेशन का समर्थन नहीं करता।',
    te: 'మీ బ్రౌజర్ లొకేషన్‌ను సపోర్ట్ చేయదు.',
  },

  // --- Home hero carousel (HomeHeroBanner.jsx) -------------------------------
  'hero.dailyHarvest': { en: 'DAILY FARM HARVEST', hi: 'रोज़ की ताज़ी उपज', te: 'రోజువారీ తాజా పంట' },
  'hero.expressDelivery': { en: 'EXPRESS DELIVERY', hi: 'एक्सप्रेस डिलीवरी', te: 'ఎక్స్‌ప్రెస్ డెలివరీ' },
  'hero.weekendBazzar': { en: 'WEEKEND BAZZAR', hi: 'वीकेंड बाज़ार', te: 'వీకెండ్ బజార్' },
  'hero.organicTitle': {
    en: '100% Organic Fresh Produce',
    hi: '100% जैविक ताज़ी उपज',
    te: '100% సేంద్రియ తాజా ఉత్పత్తులు',
  },
  'hero.organicSub': {
    en: 'Handpicked this morning from Nilgiri partner farms',
    hi: 'आज सुबह नीलगिरि साझेदार खेतों से चुनी गई',
    te: 'ఈ ఉదయం నీలగిరి భాగస్వామ్య పొలాల నుండి ఏరినవి',
  },
  'hero.expressTitle': {
    en: '15-Minute Doorstep Delivery',
    hi: '15 मिनट में घर तक डिलीवरी',
    te: '15 నిమిషాల్లో ఇంటి వద్దకు డెలివరీ',
  },
  'hero.expressSub': {
    en: 'Temperature controlled cold-chain express delivery',
    hi: 'तापमान नियंत्रित कोल्ड-चेन एक्सप्रेस डिलीवरी',
    te: 'ఉష్ణోగ్రత నియంత్రిత కోల్డ్-చైన్ ఎక్స్‌ప్రెస్ డెలివరీ',
  },
  'hero.exoticTitle': {
    en: 'Exotic Fruit & Veggie Special',
    hi: 'विदेशी फल और सब्ज़ी स्पेशल',
    te: 'ఎగ్జాటిక్ పండ్లు & కూరగాయల స్పెషల్',
  },
  'hero.exoticSub': {
    en: 'Avocados, Blueberries, Baby Spinach & Herbs',
    hi: 'एवोकाडो, ब्लूबेरी, बेबी पालक और जड़ी-बूटियाँ',
    te: 'అవకాడో, బ్లూబెర్రీ, బేబీ పాలకూర & మూలికలు',
  },
  'hero.flat20': { en: 'Flat 20% OFF', hi: 'सीधे 20% छूट', te: 'ఫ్లాట్ 20% తగ్గింపు' },
  'hero.freeDelivery200': {
    en: 'Free Delivery on ₹200+',
    hi: '₹200+ पर मुफ़्त डिलीवरी',
    te: '₹200+ పై ఉచిత డెలివరీ',
  },
  'hero.upto35': { en: 'Up to 35% OFF', hi: '35% तक छूट', te: '35% వరకు తగ్గింపు' },
  'hero.shopNow': { en: 'Shop Now', hi: 'अभी खरीदें', te: 'ఇప్పుడే కొనండి' },
  'hero.useCode': { en: 'Use Code:', hi: 'कोड लगाएँ:', te: 'కోడ్ వాడండి:' },

  // --- Categories (Categories.jsx) -------------------------------------------
  'categories.title': { en: 'Categories', hi: 'श्रेणियाँ', te: 'విభాగాలు' },
  'categories.farmSections': {
    en: '{count} Farm Sections',
    hi: '{count} खेत विभाग',
    te: '{count} వ్యవసాయ విభాగాలు',
  },
  'categories.explore': { en: 'Explore harvest', hi: 'उपज देखें', te: 'పంటను చూడండి' },
  'categories.noMarkets': {
    en: 'No markets deliver here yet',
    hi: 'यहाँ अभी कोई बाज़ार डिलीवरी नहीं करता',
    te: 'ఇక్కడికి ఇంకా ఏ మార్కెట్ డెలివరీ చేయడం లేదు',
  },
  'categories.noMarketsHint': {
    en: 'We are opening in new areas all the time.',
    hi: 'हम लगातार नए इलाकों में खुल रहे हैं।',
    te: 'మేము ఎప్పటికప్పుడు కొత్త ప్రాంతాల్లో ప్రారంభిస్తున్నాము.',
  },

  // --- Product card / detail --------------------------------------------------
  'product.add': { en: 'Add', hi: 'जोड़ें', te: 'చేర్చు' },
  'product.soldOut': { en: 'Sold Out', hi: 'स्टॉक ख़त्म', te: 'స్టాక్ అయిపోయింది' },
  'product.organic': { en: 'Organic', hi: 'जैविक', te: 'సేంద్రియం' },
  'product.today': { en: 'Today', hi: 'आज', te: 'ఈరోజు' },
  'product.selectWeight': { en: 'Select Weight', hi: 'वज़न चुनें', te: 'బరువు ఎంచుకోండి' },
  'product.baseQuantity': { en: 'Base Quantity:', hi: 'मूल मात्रा:', te: 'ప్రాథమిక పరిమాణం:' },
  'product.mrp': { en: 'M.R.P:', hi: 'एम.आर.पी:', te: 'ఎం.ఆర్.పి:' },
  'product.save': { en: 'Save {percent}%', hi: '{percent}% बचाएँ', te: '{percent}% ఆదా' },
  'product.reviews': {
    en: '({count} verified customer reviews)',
    hi: '({count} सत्यापित ग्राहक समीक्षाएँ)',
    te: '({count} ధృవీకరించిన కస్టమర్ సమీక్షలు)',
  },
  'product.pesticideFree': { en: '100% Pesticide Free', hi: '100% कीटनाशक मुक्त', te: '100% పురుగుమందులు లేనివి' },
  'product.pesticideFreeSub': { en: 'Lab tested clean harvest', hi: 'लैब में जाँची गई साफ़ उपज', te: 'ల్యాబ్‌లో పరీక్షించిన శుభ్రమైన పంట' },
  'product.fastDelivery': { en: '15-Min Delivery', hi: '15 मिनट डिलीवरी', te: '15 నిమిషాల డెలివరీ' },
  'product.fastDeliverySub': { en: 'Cold chain fresh express', hi: 'कोल्ड चेन फ्रेश एक्सप्रेस', te: 'కోల్డ్ చైన్ ఫ్రెష్ ఎక్స్‌ప్రెస్' },
  'product.storyTitle': { en: 'Harvest Story & Details', hi: 'उपज की कहानी और विवरण', te: 'పంట కథ & వివరాలు' },
  'product.share': { en: 'Share {name}', hi: '{name} साझा करें', te: '{name} షేర్ చేయండి' },
  'product.backTo': { en: 'Back to {category}', hi: '{category} पर वापस', te: '{category}కి వెనుకకు' },
  'product.category': { en: 'Category', hi: 'श्रेणी', te: 'విభాగం' },
  'product.moreFrom': { en: 'More from {category}', hi: '{category} से और', te: '{category} నుండి మరిన్ని' },
  'product.thisSection': { en: 'this section', hi: 'इस विभाग', te: 'ఈ విభాగం' },
  'product.alsoLike': { en: 'You might also like', hi: 'ये भी पसंद आ सकते हैं', te: 'ఇవి కూడా నచ్చవచ్చు' },

  // --- My Orders (CustomerOrders.jsx) ------------------------------------------
  //
  // Order line item names are NOT translated here. A cart line stores the name
  // as it stood when the order was placed, and that record is what the market
  // and the rider packed against — rewriting it per reader would make the
  // customer's copy of an order disagree with everyone else's.
  'orders.title': { en: 'My Orders', hi: 'मेरे ऑर्डर', te: 'నా ఆర్డర్లు' },
  'orders.subtitle': {
    en: 'Track purchases & subscriptions',
    hi: 'ख़रीद और सदस्यता देखें',
    te: 'కొనుగోళ్లు, సబ్‌స్క్రిప్షన్‌లు చూడండి',
  },
  'orders.tabRecent': { en: 'Recent Orders', hi: 'हाल के ऑर्डर', te: 'ఇటీవలి ఆర్డర్లు' },
  'orders.tabScheduled': { en: 'Scheduled Deliveries', hi: 'निर्धारित डिलीवरी', te: 'షెడ్యూల్ చేసిన డెలివరీలు' },
  'orders.noneTitle': { en: 'No Orders Yet!', hi: 'अभी कोई ऑर्डर नहीं!', te: 'ఇంకా ఆర్డర్లు లేవు!' },
  'orders.noneBody': {
    en: 'You haven’t placed any orders with VegDrop yet. Start exploring fresh produce!',
    hi: 'आपने अभी तक VegDrop पर कोई ऑर्डर नहीं किया। ताज़ी उपज देखना शुरू करें!',
    te: 'మీరు ఇంకా VegDropలో ఏ ఆర్డర్ చేయలేదు. తాజా పంటను చూడటం మొదలుపెట్టండి!',
  },
  'orders.startShopping': { en: 'Start Shopping', hi: 'ख़रीदारी शुरू करें', te: 'కొనుగోలు మొదలుపెట్టండి' },
  'orders.online': { en: 'Online', hi: 'ऑनलाइन', te: 'ఆన్‌లైన్' },
  'orders.orderItems': { en: 'Order Items', hi: 'ऑर्डर की वस्तुएँ', te: 'ఆర్డర్ వస్తువులు' },
  'orders.cancel': { en: 'Cancel order', hi: 'ऑर्डर रद्द करें', te: 'ఆర్డర్ రద్దు చేయండి' },
  'orders.sourcingRetry': {
    en: 'Checking another market nearby (try {attempt}).',
    hi: 'पास का दूसरा बाज़ार देखा जा रहा है (प्रयास {attempt})।',
    te: 'దగ్గరలోని మరో మార్కెట్‌ను చూస్తున్నాం (ప్రయత్నం {attempt}).',
  },
  'orders.sourcingFirst': {
    en: 'Finding a stall to fill your order. This usually takes under a minute.',
    hi: 'आपका ऑर्डर पूरा करने के लिए दुकान खोजी जा रही है। इसमें आम तौर पर एक मिनट से कम लगता है।',
    te: 'మీ ఆర్డర్ పూర్తి చేయడానికి దుకాణం వెతుకుతున్నాం. సాధారణంగా నిమిషం లోపే అవుతుంది.',
  },
  'orders.partialAvailable': {
    en: '{available} of {total} items are available here.',
    hi: '{total} में से {available} वस्तुएँ यहाँ उपलब्ध हैं।',
    te: '{total}లో {available} వస్తువులు ఇక్కడ అందుబాటులో ఉన్నాయి.',
  },
  'orders.partialMissing': { en: 'Not available: {items}.', hi: 'उपलब्ध नहीं: {items}।', te: 'అందుబాటులో లేవు: {items}.' },
  'orders.partialSend': { en: 'Send the {count} available', hi: 'उपलब्ध {count} भेजें', te: 'అందుబాటులో ఉన్న {count} పంపండి' },
  'orders.partialRefund': { en: ' · ₹{amount} back', hi: ' · ₹{amount} वापस', te: ' · ₹{amount} తిరిగి' },
  'orders.partialPayLess': { en: ' · pay ₹{amount} less', hi: ' · ₹{amount} कम दें', te: ' · ₹{amount} తక్కువ చెల్లించండి' },
  'orders.partialRetry': {
    en: 'Try another market for everything',
    hi: 'पूरे ऑर्डर के लिए दूसरा बाज़ार आज़माएँ',
    te: 'మొత్తానికి మరో మార్కెట్ ప్రయత్నించండి',
  },
  'orders.packingNote': {
    en: 'Accepted — your order is being packed and can no longer be cancelled.',
    hi: 'स्वीकार — आपका ऑर्डर पैक हो रहा है और अब रद्द नहीं किया जा सकता।',
    te: 'ఆమోదించారు — మీ ఆర్డర్ ప్యాక్ అవుతోంది, ఇక రద్దు చేయలేరు.',
  },
  // Four keys rather than two with a "was/were" placeholder: an English verb
  // slotted into a Hindi or Telugu sentence lands in the wrong place and in the
  // wrong script, and neither language inflects this the way English does.
  'orders.droppedRefundedOne': {
    en: ' {items} could not be sourced and was refunded.',
    hi: ' {items} नहीं मिल सका और उसका पैसा वापस कर दिया गया।',
    te: ' {items} దొరకలేదు, ఆ డబ్బు తిరిగి ఇచ్చేశాం.',
  },
  'orders.droppedRefundedMany': {
    en: ' {items} could not be sourced and were refunded.',
    hi: ' {items} नहीं मिल सके और उनका पैसा वापस कर दिया गया।',
    te: ' {items} దొరకలేదు, ఆ డబ్బు తిరిగి ఇచ్చేశాం.',
  },
  'orders.droppedRemovedOne': {
    en: ' {items} could not be sourced and was removed.',
    hi: ' {items} नहीं मिल सका और उसे हटा दिया गया।',
    te: ' {items} దొరకలేదు, దాన్ని తీసేశాం.',
  },
  'orders.droppedRemovedMany': {
    en: ' {items} could not be sourced and were removed.',
    hi: ' {items} नहीं मिल सके और उन्हें हटा दिया गया।',
    te: ' {items} దొరకలేదు, వాటిని తీసేశాం.',
  },
  'orders.awaitingRider': {
    en: 'Packed and waiting for a rider.',
    hi: 'पैक हो चुका है, राइडर का इंतज़ार है।',
    te: 'ప్యాక్ అయ్యింది, రైడర్ కోసం ఎదురుచూస్తోంది.',
  },
  'orders.collecting': {
    en: 'Your rider is collecting from the stalls.',
    hi: 'आपका राइडर दुकानों से सामान ले रहा है।',
    te: 'మీ రైడర్ దుకాణాల నుండి తీసుకుంటున్నారు.',
  },
  'orders.failedNote': {
    en: 'No stall nearby could fill this one, so it was cancelled and your money refunded. Try a different market.',
    hi: 'पास की कोई दुकान इसे पूरा नहीं कर सकी, इसलिए यह रद्द हो गया और आपका पैसा वापस कर दिया गया। दूसरा बाज़ार आज़माएँ।',
    te: 'దగ్గరలోని ఏ దుకాణమూ దీన్ని పూర్తి చేయలేకపోయింది, కాబట్టి రద్దు చేసి మీ డబ్బు తిరిగి ఇచ్చేశాం. వేరే మార్కెట్ ప్రయత్నించండి.',
  },
  'orders.trackLive': { en: 'Track Your Order Live 🚴', hi: 'अपना ऑर्डर लाइव देखें 🚴', te: 'మీ ఆర్డర్‌ను లైవ్‌లో చూడండి 🚴' },

  // Market fulfilment stages
  'stage.sourcing': { en: 'Finding a stall', hi: 'दुकान खोजी जा रही है', te: 'దుకాణం వెతుకుతోంది' },
  'stage.partial_review': { en: 'Needs your answer', hi: 'आपके जवाब का इंतज़ार', te: 'మీ సమాధానం కావాలి' },
  'stage.packing': { en: 'Being packed', hi: 'पैक हो रहा है', te: 'ప్యాక్ అవుతోంది' },
  'stage.awaiting_rider': { en: 'Ready for pickup', hi: 'पिकअप के लिए तैयार', te: 'పికప్‌కు సిద్ధం' },
  'stage.collecting': { en: 'Rider collecting', hi: 'राइडर ले रहा है', te: 'రైడర్ తీసుకుంటున్నారు' },
  'stage.dispatched': { en: 'On the way', hi: 'रास्ते में', te: 'దారిలో ఉంది' },
  'stage.delivered': { en: 'Delivered', hi: 'पहुँच गया', te: 'డెలివరీ అయ్యింది' },
  'stage.failed': { en: 'Could not fill', hi: 'पूरा नहीं हो सका', te: 'పూర్తి కాలేదు' },
  'stage.cancelled': { en: 'Cancelled', hi: 'रद्द', te: 'రద్దు' },
  'stage.awaitingRiderLong': { en: 'Waiting for a rider', hi: 'राइडर का इंतज़ार', te: 'రైడర్ కోసం ఎదురుచూపు' },
  'stage.hint.sourcing': {
    en: 'Stalls in the market are deciding who can fill this.',
    hi: 'बाज़ार की दुकानें तय कर रही हैं कि इसे कौन पूरा कर सकता है।',
    te: 'దీన్ని ఎవరు పూర్తి చేయగలరో మార్కెట్‌లోని దుకాణాలు నిర్ణయిస్తున్నాయి.',
  },
  'stage.hint.packing': {
    en: 'Your vegetables are being bagged.',
    hi: 'आपकी सब्ज़ियाँ थैले में रखी जा रही हैं।',
    te: 'మీ కూరగాయలను సంచిలో సర్దుతున్నారు.',
  },
  'stage.hint.awaiting_rider': {
    en: 'Packed, and waiting for someone to collect it.',
    hi: 'पैक हो चुका है, कोई लेने आए इसका इंतज़ार है।',
    te: 'ప్యాక్ అయ్యింది, ఎవరైనా తీసుకెళ్లడం కోసం ఎదురుచూపు.',
  },
  'stage.hint.collecting': {
    en: 'A rider is walking the stalls to pick everything up.',
    hi: 'एक राइडर सब कुछ लेने के लिए दुकानों में घूम रहा है।',
    te: 'ఒక రైడర్ అన్నీ తీసుకోవడానికి దుకాణాల్లో తిరుగుతున్నారు.',
  },
  'stage.hint.dispatched': { en: 'It has left the market.', hi: 'यह बाज़ार से निकल चुका है।', te: 'ఇది మార్కెట్ నుండి బయలుదేరింది.' },

  // Scheduled deliveries
  'sched.all': { en: 'All', hi: 'सभी', te: 'అన్నీ' },
  'sched.daily': { en: 'Daily', hi: 'रोज़ाना', te: 'ప్రతిరోజూ' },
  'sched.weekly': { en: 'Weekly', hi: 'साप्ताहिक', te: 'వారానికి' },
  'sched.monthly': { en: 'Monthly', hi: 'मासिक', te: 'నెలకు' },
  'sched.dailyDelivery': { en: '📅 Daily Delivery', hi: '📅 रोज़ाना डिलीवरी', te: '📅 ప్రతిరోజూ డెలివరీ' },
  'sched.weeklyDelivery': { en: '🗓️ Weekly Delivery', hi: '🗓️ साप्ताहिक डिलीवरी', te: '🗓️ వారానికి డెలివరీ' },
  'sched.monthlyDelivery': { en: '📆 Monthly Delivery', hi: '📆 मासिक डिलीवरी', te: '📆 నెలకు డెలివరీ' },
  'sched.generic': { en: 'Scheduled', hi: 'निर्धारित', te: 'షెడ్యూల్ చేసినది' },
  'sched.pickDate': { en: 'Pick Date', hi: 'तारीख़ चुनें', te: 'తేదీ ఎంచుకోండి' },
  'sched.pickDates': { en: 'Pick Dates', hi: 'तारीख़ें चुनें', te: 'తేదీలు ఎంచుకోండి' },
  'sched.hintWeekly': {
    en: 'Select 3 to 7 days for weekly delivery',
    hi: 'साप्ताहिक डिलीवरी के लिए 3 से 7 दिन चुनें',
    te: 'వారానికి డెలివరీ కోసం 3 నుండి 7 రోజులు ఎంచుకోండి',
  },
  'sched.hintMonthly': { en: 'Select at least 15 days', hi: 'कम से कम 15 दिन चुनें', te: 'కనీసం 15 రోజులు ఎంచుకోండి' },
  'sched.hintDaily': {
    en: 'Schedule your cart for delivery',
    hi: 'अपनी टोकरी की डिलीवरी तय करें',
    te: 'మీ బుట్ట డెలివరీని షెడ్యూల్ చేయండి',
  },
  'sched.deliveryDate': { en: 'Delivery Date', hi: 'डिलीवरी की तारीख़', te: 'డెలివరీ తేదీ' },
  'sched.needMoreOne': { en: 'Please select 1 more day.', hi: 'कृपया 1 दिन और चुनें।', te: 'దయచేసి మరో 1 రోజు ఎంచుకోండి.' },
  'sched.needMore': {
    en: 'Please select at least {count} more days.',
    hi: 'कृपया कम से कम {count} दिन और चुनें।',
    te: 'దయచేసి కనీసం మరో {count} రోజులు ఎంచుకోండి.',
  },
  'sched.summaryDays': { en: 'Order Summary ({count} days)', hi: 'ऑर्डर सारांश ({count} दिन)', te: 'ఆర్డర్ సారాంశం ({count} రోజులు)' },
  'sched.summaryOneDay': { en: 'Order Summary (1 day)', hi: 'ऑर्डर सारांश (1 दिन)', te: 'ఆర్డర్ సారాంశం (1 రోజు)' },
  'sched.itemCount': { en: '{count} items', hi: '{count} वस्तुएँ', te: '{count} వస్తువులు' },
  'sched.cartEmpty': { en: 'Your cart is empty.', hi: 'आपकी टोकरी खाली है।', te: 'మీ బుట్ట ఖాళీగా ఉంది.' },
  'sched.cartEmptyHint': {
    en: 'Add items to schedule a delivery.',
    hi: 'डिलीवरी तय करने के लिए वस्तुएँ जोड़ें।',
    te: 'డెలివరీ షెడ్యూల్ చేయడానికి వస్తువులు జోడించండి.',
  },
  'sched.goToStore': { en: 'Go to Store', hi: 'दुकान पर जाएँ', te: 'షాప్‌కు వెళ్లండి' },
  'sched.totalForDays': { en: 'Total for {count} days:', hi: '{count} दिन का कुल:', te: '{count} రోజుల మొత్తం:' },
  'sched.total': { en: 'Total:', hi: 'कुल:', te: 'మొత్తం:' },
  'sched.scheduleDelivery': { en: 'Schedule Delivery', hi: 'डिलीवरी तय करें', te: 'డెలివరీ షెడ్యూల్ చేయండి' },
  'sched.noneAll': { en: 'No Active Schedules', hi: 'कोई सक्रिय शेड्यूल नहीं', te: 'యాక్టివ్ షెడ్యూల్‌లు లేవు' },
  'sched.noneFiltered': { en: 'No {frequency} Schedules', hi: 'कोई {frequency} शेड्यूल नहीं', te: '{frequency} షెడ్యూల్‌లు లేవు' },
  'sched.noneAllBody': {
    en: 'Subscribe to your daily essentials to automate your deliveries!',
    hi: 'रोज़ की ज़रूरतों की सदस्यता लें और डिलीवरी अपने आप होने दें!',
    te: 'రోజువారీ అవసరాలకు సబ్‌స్క్రైబ్ చేసి డెలివరీలను ఆటోమేటిక్ చేసుకోండి!',
  },
  'sched.noneFilteredBody': {
    en: 'You don’t have any {frequency} delivery schedules yet.',
    hi: 'आपके पास अभी कोई {frequency} डिलीवरी शेड्यूल नहीं है।',
    te: 'మీకు ఇంకా ఏ {frequency} డెలివరీ షెడ్యూల్ లేదు.',
  },
  'sched.explore': { en: 'Explore Essentials', hi: 'ज़रूरी सामान देखें', te: 'అవసరమైనవి చూడండి' },
  'sched.existing': { en: 'Existing Schedules', hi: 'मौजूदा शेड्यूल', te: 'ఉన్న షెడ్యూల్‌లు' },
  'sched.active': { en: 'Active', hi: 'सक्रिय', te: 'యాక్టివ్' },
  'sched.paused': { en: 'Paused', hi: 'रुका हुआ', te: 'ఆపివేసినది' },
  'sched.nextDelivery': { en: 'Next Delivery: {date}', hi: 'अगली डिलीवरी: {date}', te: 'తదుపరి డెలివరీ: {date}' },
  'sched.pricedOnDay': { en: 'priced on the day', hi: 'उसी दिन की क़ीमत', te: 'ఆ రోజు ధర ప్రకారం' },
  'sched.subscribedItems': { en: 'Subscribed Items', hi: 'सदस्यता की वस्तुएँ', te: 'సబ్‌స్క్రైబ్ చేసిన వస్తువులు' },
  'sched.item': { en: 'Item', hi: 'वस्तु', te: 'వస్తువు' },
  'sched.pause': { en: 'Pause Delivery', hi: 'डिलीवरी रोकें', te: 'డెలివరీ ఆపండి' },
  'sched.resume': { en: 'Resume Delivery', hi: 'डिलीवरी फिर शुरू करें', te: 'డెలివరీ మళ్లీ మొదలుపెట్టండి' },
  'sched.cancelSubscription': { en: 'Cancel Subscription', hi: 'सदस्यता रद्द करें', te: 'సబ్‌స్క్రిప్షన్ రద్దు చేయండి' },
  'sched.confirmStop': {
    en: 'Stop this repeat delivery? Orders already placed are unaffected.',
    hi: 'यह दोहराई जाने वाली डिलीवरी बंद करें? पहले से किए गए ऑर्डर पर कोई असर नहीं होगा।',
    te: 'ఈ పునరావృత డెలివరీని ఆపాలా? ఇప్పటికే చేసిన ఆర్డర్లపై ఎలాంటి ప్రభావం ఉండదు.',
  },
  'sched.errChange': {
    en: 'Could not change that repeat delivery.',
    hi: 'वह दोहराई जाने वाली डिलीवरी बदली नहीं जा सकी।',
    te: 'ఆ పునరావృత డెలివరీని మార్చలేకపోయాం.',
  },
  'sched.errStop': {
    en: 'Could not stop that repeat delivery.',
    hi: 'वह दोहराई जाने वाली डिलीवरी रोकी नहीं जा सकी।',
    te: 'ఆ పునరావృత డెలివరీని ఆపలేకపోయాం.',
  },
  'sched.maxWeekly': {
    en: 'You can select up to 7 days maximum for a weekly schedule.',
    hi: 'साप्ताहिक शेड्यूल के लिए ज़्यादा से ज़्यादा 7 दिन चुने जा सकते हैं।',
    te: 'వారపు షెడ్యూల్‌కు గరిష్ఠంగా 7 రోజులు మాత్రమే ఎంచుకోగలరు.',
  },
  'sched.maxMonthly': {
    en: 'You can select up to 30 days maximum.',
    hi: 'ज़्यादा से ज़्यादा 30 दिन चुने जा सकते हैं।',
    te: 'గరిష్ఠంగా 30 రోజులు మాత్రమే ఎంచుకోగలరు.',
  },
  'orders.progressTitle': { en: 'Order progress', hi: 'ऑर्डर की प्रगति', te: 'ఆర్డర్ పురోగతి' },
  'orders.progressSub': { en: 'Order #{id} • {name}', hi: 'ऑर्डर #{id} • {name}', te: 'ఆర్డర్ #{id} • {name}' },
  'orders.deliveringTo': { en: 'Delivering to', hi: 'यहाँ डिलीवरी', te: 'ఇక్కడికి డెలివరీ' },

  // What a standing order actually does, in words (services/schedules.js).
  // Weekday names come from `toLocaleDateString`, not a table here — the
  // browser already knows them in every locale and would only go stale if
  // copied.
  'recur.everyDay': { en: 'Every day', hi: 'हर दिन', te: 'ప్రతిరోజూ' },
  'recur.weekly': { en: 'Weekly', hi: 'साप्ताहिक', te: 'వారానికి' },
  'recur.monthly': { en: 'Monthly', hi: 'मासिक', te: 'నెలకు' },
  'recur.everyDays': { en: 'Every {days}', hi: 'हर {days}', te: 'ప్రతి {days}' },
  'recur.monthlyOn': {
    en: 'Monthly on the {days}',
    hi: 'हर महीने {days} को',
    te: 'ప్రతి నెలా {days}న',
  },
  'recur.and': { en: ' and ', hi: ' और ', te: ' మరియు ' },

  // --- Purchase history (AccountHistory.jsx) -----------------------------------
  'history.lifetimeSpent': { en: 'Total Lifetime Spent', hi: 'कुल आजीवन ख़र्च', te: 'మొత్తం జీవితకాల ఖర్చు' },
  'history.totalOrders': { en: 'Total Orders', hi: 'कुल ऑर्डर', te: 'మొత్తం ఆర్డర్లు' },
  'history.itemsPurchased': { en: 'Items Purchased', hi: 'ख़रीदी वस्तुएँ', te: 'కొన్న వస్తువులు' },
  'history.recent': { en: 'Recent Order History', hi: 'हाल का ऑर्डर इतिहास', te: 'ఇటీవలి ఆర్డర్ చరిత్ర' },
  'history.none': { en: 'No orders yet', hi: 'अभी कोई ऑर्डर नहीं', te: 'ఇంకా ఆర్డర్లు లేవు' },
  'history.noneHint': {
    en: 'Your history will appear here once you buy something.',
    hi: 'कुछ ख़रीदते ही आपका इतिहास यहाँ दिखने लगेगा।',
    te: 'మీరు ఏదైనా కొన్న వెంటనే మీ చరిత్ర ఇక్కడ కనిపిస్తుంది.',
  },
  'history.cash': { en: 'Cash', hi: 'नक़द', te: 'నగదు' },
  // The coarse order status, as the server words it.
  'status.Pending': { en: 'Pending', hi: 'लंबित', te: 'పెండింగ్' },
  'status.Preparing': { en: 'Preparing', hi: 'तैयार हो रहा है', te: 'సిద్ధమవుతోంది' },
  'status.OutForDelivery': { en: 'Out for Delivery', hi: 'डिलीवरी के लिए निकला', te: 'డెలివరీకి బయలుదేరింది' },
  'status.Delivered': { en: 'Delivered', hi: 'पहुँच गया', te: 'డెలివరీ అయ్యింది' },
  'status.Cancelled': { en: 'Cancelled', hi: 'रद्द', te: 'రద్దు' },

  // --- VegWallet (WalletModal.jsx) ---------------------------------------------
  //
  // A ledger row's `label` and `note` are NOT here. They arrive from the server
  // already worded ("Order VD-1043 payment"), so translating them means adding
  // keys server-side and sending one — not guessing at the wording client-side.
  'wallet.availableBalance': { en: 'Available Balance', hi: 'उपलब्ध बैलेंस', te: 'అందుబాటులో ఉన్న బ్యాలెన్స్' },
  'wallet.addMoney': { en: 'Add Money', hi: 'पैसे जोड़ें', te: 'డబ్బు జోడించండి' },
  'wallet.history': { en: 'History', hi: 'इतिहास', te: 'చరిత్ర' },
  'wallet.recent': { en: 'Recent Transactions', hi: 'हाल के लेन-देन', te: 'ఇటీవలి లావాదేవీలు' },
  'wallet.noTransactions': { en: 'No transactions yet.', hi: 'अभी कोई लेन-देन नहीं।', te: 'ఇంకా లావాదేవీలు లేవు.' },
  'wallet.balShort': { en: 'Bal ₹{amount}', hi: 'बैलेंस ₹{amount}', te: 'బ్యాలెన్స్ ₹{amount}' },
  'wallet.balanceAfter': { en: 'Balance ₹{amount}', hi: 'बैलेंस ₹{amount}', te: 'బ్యాలెన్స్ ₹{amount}' },
  'wallet.backToWallet': { en: 'Back to Wallet', hi: 'वॉलेट पर वापस', te: 'వాలెట్‌కి వెనుకకు' },
  'wallet.rechargeTitle': { en: 'Recharge Wallet', hi: 'वॉलेट रिचार्ज', te: 'వాలెట్ రీఛార్జ్' },
  'wallet.rechargeSub': {
    en: 'Enter amount to add via secure checkout',
    hi: 'सुरक्षित चेकआउट से जोड़ने के लिए राशि डालें',
    te: 'సురక్షిత చెక్అవుట్ ద్వారా జోడించడానికి మొత్తాన్ని నమోదు చేయండి',
  },
  'wallet.amountLabel': { en: 'Amount (₹)', hi: 'राशि (₹)', te: 'మొత్తం (₹)' },
  'wallet.quickSelect': { en: 'Quick Select Amount', hi: 'तुरंत राशि चुनें', te: 'త్వరిత మొత్తం ఎంపిక' },
  'wallet.payViaUpi': { en: 'Pay via UPI app', hi: 'UPI ऐप से भुगतान', te: 'UPI యాప్ ద్వారా చెల్లించండి' },
  'wallet.secured': {
    en: 'Secured by Razorpay • Min ₹10 • Max ₹50,000',
    hi: 'Razorpay से सुरक्षित • कम से कम ₹10 • ज़्यादा से ज़्यादा ₹50,000',
    te: 'Razorpay ద్వారా సురక్షితం • కనిష్ఠం ₹10 • గరిష్ఠం ₹50,000',
  },
  'wallet.waiting': { en: 'Waiting for payment…', hi: 'भुगतान का इंतज़ार…', te: 'చెల్లింపు కోసం వేచి ఉంది…' },
  'wallet.addAmount': { en: 'Add ₹{amount}', hi: '₹{amount} जोड़ें', te: '₹{amount} జోడించండి' },
  'wallet.otherMethods': {
    en: 'Card, netbanking & more',
    hi: 'कार्ड, नेटबैंकिंग और अन्य',
    te: 'కార్డ్, నెట్‌బ్యాంకింగ్ & మరిన్ని',
  },
  'wallet.historyTitle': { en: 'Transaction History', hi: 'लेन-देन इतिहास', te: 'లావాదేవీల చరిత్ర' },
  'wallet.enterAmount': { en: 'Enter an amount to add.', hi: 'जोड़ने के लिए राशि डालें।', te: 'జోడించాల్సిన మొత్తాన్ని నమోదు చేయండి.' },
  'wallet.minTopUp': { en: 'The smallest top-up is ₹10.', hi: 'सबसे कम रिचार्ज ₹10 है।', te: 'కనీస రీఛార్జ్ ₹10.' },
  'wallet.maxTopUp': { en: 'The largest top-up is ₹50,000.', hi: 'सबसे ज़्यादा रिचार्ज ₹50,000 है।', te: 'గరిష్ఠ రీఛార్జ్ ₹50,000.' },
  'wallet.cancelled': {
    en: 'Payment was cancelled. Nothing was charged.',
    hi: 'भुगतान रद्द हो गया। कुछ भी नहीं कटा।',
    te: 'చెల్లింపు రద్దైంది. ఏమీ కట్ కాలేదు.',
  },
  'wallet.unconfirmed': {
    en: 'We could not confirm the payment. If you were charged it will appear in your balance shortly.',
    hi: 'हम भुगतान की पुष्टि नहीं कर सके। अगर पैसे कटे हैं तो वे जल्द ही आपके बैलेंस में दिखेंगे।',
    te: 'చెల్లింపును నిర్ధారించలేకపోయాం. డబ్బు కట్ అయితే త్వరలో మీ బ్యాలెన్స్‌లో కనిపిస్తుంది.',
  },

  // --- Category detail (CategoryDetailView.jsx) --------------------------------
  'categoryView.items': { en: '{count} Items', hi: '{count} वस्तुएँ', te: '{count} వస్తువులు' },
  'categoryView.itemOne': { en: '1 Item', hi: '1 वस्तु', te: '1 వస్తువు' },
  'categoryView.freshHarvest': { en: 'Fresh Harvest', hi: 'ताज़ी उपज', te: 'తాజా పంట' },
  'categoryView.farmFresh': { en: '100% Farm Fresh', hi: '100% खेत से ताज़ा', te: '100% పొలం నుండి తాజా' },
  'categoryView.blurb': {
    en: 'Handpicked daily fresh produce directly from local organic farms',
    hi: 'स्थानीय जैविक खेतों से सीधे, रोज़ हाथ से चुनी ताज़ी उपज',
    te: 'స్థానిక సేంద్రియ పొలాల నుండి నేరుగా, ప్రతిరోజూ చేతితో ఎంచిన తాజా పంట',
  },
  'categoryView.searchIn': {
    en: 'Search in {category}...',
    hi: '{category} में खोजें...',
    te: '{category}లో వెతకండి...',
  },
  'categoryView.mostPopular': { en: 'Most Popular', hi: 'सबसे लोकप्रिय', te: 'అత్యంత ప్రసిద్ధం' },
  'categoryView.noneMatching': {
    en: 'No items found in this section matching your filter.',
    hi: 'इस विभाग में आपके फ़िल्टर से मेल खाती कोई वस्तु नहीं मिली।',
    te: 'ఈ విభాగంలో మీ ఫిల్టర్‌కు సరిపోయే వస్తువులు దొరకలేదు.',
  },
  'product.harvestDetails': { en: 'Harvest Details', hi: 'उपज विवरण', te: 'పంట వివరాలు' },
  'product.certifiedOrganic': {
    en: '100% Certified Organic',
    hi: '100% प्रमाणित जैविक',
    te: '100% ధృవీకరించిన సేంద్రియం',
  },
  'product.decrease': { en: 'Decrease', hi: 'घटाएँ', te: 'తగ్గించు' },
  'product.increase': { en: 'Increase', hi: 'बढ़ाएँ', te: 'పెంచు' },
  'product.storyBody': {
    en: 'Freshly harvested from organic partner farms in Ooty and Nilgiri hills. Grown using sustainable composting without chemical pesticides. Rich in essential vitamins, minerals, and natural antioxidants.',
    hi: 'ऊटी और नीलगिरि की पहाड़ियों के जैविक साझेदार खेतों से ताज़ा तोड़ी गई उपज। रासायनिक कीटनाशकों के बिना, टिकाऊ खाद से उगाई गई। ज़रूरी विटामिन, खनिज और प्राकृतिक एंटीऑक्सीडेंट से भरपूर।',
    te: 'ఊటీ, నీలగిరి కొండల్లోని సేంద్రియ భాగస్వామ్య పొలాల నుండి తాజాగా కోసినవి. రసాయన పురుగుమందులు లేకుండా, స్థిరమైన కంపోస్టుతో పండించినవి. అవసరమైన విటమిన్లు, ఖనిజాలు, సహజ యాంటీఆక్సిడెంట్లు సమృద్ధిగా ఉన్నాయి.',
  },

  // --- The stall's own photo of the produce (ProductDetailView) ----------------
  'freshPhoto.title': {
    en: 'Photographed at the market',
    hi: 'बाज़ार में ली गई तस्वीर',
    te: 'మార్కెట్‌లో తీసిన ఫోటో',
  },
  'freshPhoto.alt': {
    en: 'The produce currently on the stall',
    hi: 'दुकान पर अभी रखी उपज',
    te: 'ప్రస్తుతం దుకాణంలో ఉన్న పంట',
  },
  'freshPhoto.caption': {
    en: 'Taken {age} by a stall in this market — not a catalogue picture.',
    hi: 'इस बाज़ार की एक दुकान ने {age} ली — यह कैटलॉग की तस्वीर नहीं है।',
    te: 'ఈ మార్కెట్‌లోని ఒక దుకాణం {age} తీసింది — ఇది కేటలాగ్ ఫోటో కాదు.',
  },
  'freshPhoto.ageToday': { en: 'today', hi: 'आज', te: 'ఈరోజు' },
  'freshPhoto.ageMinutes': {
    en: '{count} minutes ago',
    hi: '{count} मिनट पहले',
    te: '{count} నిమిషాల క్రితం',
  },
  'freshPhoto.ageHourOne': { en: '1 hour ago', hi: '1 घंटा पहले', te: '1 గంట క్రితం' },
  'freshPhoto.ageHours': { en: '{count} hours ago', hi: '{count} घंटे पहले', te: '{count} గంటల క్రితం' },
  'freshPhoto.ageYesterday': { en: 'yesterday', hi: 'कल', te: 'నిన్న' },

  // --- Basket (CartModal.jsx) -------------------------------------------------
  'cart.title': { en: 'Your Basket ({count})', hi: 'आपकी टोकरी ({count})', te: 'మీ బుట్ట ({count})' },
  'cart.empty': { en: 'Your basket is empty.', hi: 'आपकी टोकरी खाली है।', te: 'మీ బుట్ట ఖాళీగా ఉంది.' },
  'cart.closeBasket': { en: 'Close basket', hi: 'टोकरी बंद करें', te: 'బుట్ట మూసివేయి' },
  'cart.subtotal': { en: 'Subtotal', hi: 'उप-योग', te: 'ఉప మొత్తం' },
  'cart.deliveryFee': { en: 'Delivery Fee', hi: 'डिलीवरी शुल्क', te: 'డెలివరీ ఛార్జీ' },
  'cart.free': { en: 'FREE', hi: 'मुफ़्त', te: 'ఉచితం' },
  'cart.grandTotal': { en: 'Grand Total', hi: 'कुल योग', te: 'మొత్తం' },
  'cart.deliveringTo': { en: 'Delivering to', hi: 'यहाँ डिलीवरी', te: 'ఇక్కడికి డెలివరీ' },
  'cart.noAddress': { en: 'No delivery address yet', hi: 'अभी कोई डिलीवरी पता नहीं', te: 'ఇంకా డెలివరీ చిరునామా లేదు' },
  'cart.noAddressHint': {
    en: 'Set one from the address bar at the top of the shop.',
    hi: 'दुकान के ऊपर पता बार से इसे सेट करें।',
    te: 'షాప్ పైన ఉన్న చిరునామా బార్ నుండి దీన్ని పెట్టండి.',
  },
  'cart.selectPayment': { en: 'Select Payment Method', hi: 'भुगतान का तरीका चुनें', te: 'చెల్లింపు విధానం ఎంచుకోండి' },
  'cart.cod': { en: 'Cash on Delivery', hi: 'डिलीवरी पर नकद', te: 'డెలివరీ సమయంలో నగదు' },
  'cart.codSub': { en: 'Pay at Doorstep', hi: 'घर पर भुगतान करें', te: 'ఇంటి వద్ద చెల్లించండి' },
  'cart.walletBalance': { en: 'Bal: ₹{amount}', hi: 'शेष: ₹{amount}', te: 'బ్యాలెన్స్: ₹{amount}' },
  'cart.placeOrder': { en: 'Place Order • ₹{total} ({method})', hi: 'ऑर्डर करें • ₹{total} ({method})', te: 'ఆర్డర్ చేయండి • ₹{total} ({method})' },
  'cart.payWith': { en: 'Pay ₹{amount} • {method}', hi: '₹{amount} चुकाएँ • {method}', te: '₹{amount} చెల్లించండి • {method}' },
  'cart.waitingPayment': { en: 'Waiting for payment…', hi: 'भुगतान का इंतज़ार…', te: 'చెల్లింపు కోసం వేచి ఉంది…' },
  'cart.cannotPlace': { en: 'Cannot place this order yet', hi: 'यह ऑर्डर अभी नहीं हो सकता', te: 'ఈ ఆర్డర్ ఇంకా చేయలేరు' },
  'cart.confirmed': { en: 'Order Confirmed!', hi: 'ऑर्डर पक्का!', te: 'ఆర్డర్ ఖరారైంది!' },
  'cart.confirmedSub': {
    en: 'Your fresh produce will be delivered to your doorstep in 15-20 minutes.',
    hi: 'आपकी ताज़ी उपज 15-20 मिनट में आपके घर पहुँचेगी।',
    te: 'మీ తాజా ఉత్పత్తులు 15-20 నిమిషాల్లో మీ ఇంటికి చేరుతాయి.',
  },
  'cart.paidVia': { en: 'Paid via {method}', hi: '{method} से भुगतान', te: '{method} ద్వారా చెల్లించారు' },
  'cart.removeItem': { en: 'Remove entirely', hi: 'पूरी तरह हटाएँ', te: 'పూర్తిగా తొలగించు' },

  // --- Search (SearchResultsView / SearchSuggestions) -------------------------
  'search.resultsFor': { en: 'Results for “{query}”', hi: '“{query}” के परिणाम', te: '“{query}” ఫలితాలు' },
  'search.itemCount': { en: '{count} Items', hi: '{count} वस्तुएँ', te: '{count} వస్తువులు' },
  'search.refine': { en: 'Refine your search', hi: 'खोज को सीमित करें', te: 'వెతుకులాటను మెరుగుపరచండి' },
  'search.showing': { en: 'Showing {count} products', hi: '{count} उत्पाद दिख रहे हैं', te: '{count} ఉత్పత్తులు చూపిస్తోంది' },
  'search.sort': { en: 'Sort results', hi: 'परिणाम क्रमबद्ध करें', te: 'ఫలితాలను క్రమబద్ధీకరించు' },
  'search.bestMatch': { en: 'Best Match', hi: 'सबसे मिलता-जुलता', te: 'ఉత్తమ సరిపోలిక' },
  'search.priceLowHigh': { en: 'Price: Low to High', hi: 'क़ीमत: कम से ज़्यादा', te: 'ధర: తక్కువ నుండి ఎక్కువ' },
  'search.priceHighLow': { en: 'Price: High to Low', hi: 'क़ीमत: ज़्यादा से कम', te: 'ధర: ఎక్కువ నుండి తక్కువ' },
  'search.topRated': { en: 'Top Rated', hi: 'सबसे बढ़िया रेटिंग', te: 'అత్యుత్తమ రేటింగ్' },
  'search.seeAll': { en: 'See all matches', hi: 'सभी परिणाम देखें', te: 'అన్ని ఫలితాలు చూడండి' },
  'search.searchFor': { en: 'Search for', hi: 'खोजें', te: 'వెతకండి' },
  'search.section': { en: 'Section · {count} items', hi: 'विभाग · {count} वस्तुएँ', te: 'విభాగం · {count} వస్తువులు' },
  'search.options': { en: '{count} options', hi: '{count} विकल्प', te: '{count} ఎంపికలు' },
  'search.wholeShop': {
    en: 'Search the whole shop...',
    hi: 'पूरी दुकान में खोजें...',
    te: 'షాప్ అంతటా వెతకండి...',
  },
  'search.organic': { en: 'Organic', hi: 'जैविक', te: 'సేంద్రియం' },
  'search.itemOne': { en: '1 Item', hi: '1 वस्तु', te: '1 వస్తువు' },
  'search.showingOne': { en: 'Showing 1 product', hi: '1 उत्पाद दिख रहा है', te: '1 ఉత్పత్తి చూపిస్తోంది' },
  'search.nothingMatching': {
    en: 'Nothing matching “{query}”',
    hi: '“{query}” से कुछ नहीं मिला',
    te: '“{query}”కి ఏమీ దొరకలేదు',
  },
  'search.tryWithoutOrganic': {
    en: 'Try turning off the Organic filter, or search for something else.',
    hi: 'जैविक फ़िल्टर हटाकर देखें, या कुछ और खोजें।',
    te: 'సేంద్రియ ఫిల్టర్ తీసేసి చూడండి, లేదా వేరే ఏదైనా వెతకండి.',
  },
  'search.checkSpelling': {
    en: 'Check the spelling, or try a shorter word.',
    hi: 'वर्तनी जाँचें, या छोटा शब्द आज़माएँ।',
    te: 'స్పెల్లింగ్ చూడండి, లేదా చిన్న పదం ప్రయత్నించండి.',
  },

  // --- Rewards & spin wheel ---------------------------------------------------
  'rewards.title': { en: 'Rewards', hi: 'इनाम', te: 'రివార్డులు' },
  'rewards.tokensEarned': { en: 'Reward Tokens Earned', hi: 'कमाए गए टोकन', te: 'సంపాదించిన టోకెన్లు' },
  'rewards.tokens': { en: 'tokens', hi: 'टोकन', te: 'టోకెన్లు' },
  'rewards.countedSpend': { en: 'Counted Spend', hi: 'गिना गया ख़र्च', te: 'లెక్కించిన ఖర్చు' },
  'rewards.earningOrders': { en: 'Earning Orders', hi: 'कमाई वाले ऑर्डर', te: 'సంపాదన ఆర్డర్లు' },
  'rewards.howYouEarn': { en: 'How you earn', hi: 'आप कैसे कमाते हैं', te: 'మీరు ఎలా సంపాదిస్తారు' },
  'rewards.tokenHistory': { en: 'Token History', hi: 'टोकन इतिहास', te: 'టోకెన్ చరిత్ర' },
  'rewards.noTokens': { en: 'No tokens yet', hi: 'अभी कोई टोकन नहीं', te: 'ఇంకా టోకెన్లు లేవు' },
  'rewards.tokenOne': { en: 'token', hi: 'टोकन', te: 'టోకెన్' },
  // One sentence rather than the English original's bolded fragments. The bold
  // could only be kept by splitting the sentence at fixed points, and the point
  // those numbers fall at is different in each language.
  'rewards.rule': {
    en: 'Every ₹{rupees} in a single order earns you {tokens} tokens. Tokens are counted per order, so a bigger basket earns more than the same total split up. Cancelled orders don’t earn.',
    hi: 'एक ही ऑर्डर में हर ₹{rupees} पर {tokens} टोकन मिलते हैं। टोकन हर ऑर्डर के हिसाब से गिने जाते हैं, इसलिए एक बड़ी टोकरी उतने ही कुल ख़र्च को बाँटने से ज़्यादा कमाती है। रद्द ऑर्डर पर कुछ नहीं मिलता।',
    te: 'ఒకే ఆర్డర్‌లో ప్రతి ₹{rupees}కి {tokens} టోకెన్లు వస్తాయి. టోకెన్లు ఆర్డర్ వారీగా లెక్కిస్తారు, కాబట్టి ఒకే మొత్తాన్ని విడగొట్టడం కంటే పెద్ద బుట్టకే ఎక్కువ వస్తాయి. రద్దైన ఆర్డర్లకు ఏమీ రావు.',
  },
  'rewards.shortfall': {
    en: 'Your last order was ₹{rupees} short of another {tokens} tokens. Worth topping up next time.',
    hi: 'आपका पिछला ऑर्डर {tokens} और टोकन से ₹{rupees} पीछे रह गया। अगली बार थोड़ा और जोड़ना फ़ायदे का है।',
    te: 'మీ చివరి ఆర్డర్ మరో {tokens} టోకెన్లకు ₹{rupees} తక్కువైంది. వచ్చేసారి కొంచెం ఎక్కువ చేస్తే మంచిది.',
  },
  'rewards.firstTokens': {
    en: 'Spend ₹{rupees} in one order to earn your first {tokens} tokens.',
    hi: 'अपने पहले {tokens} टोकन के लिए एक ऑर्डर में ₹{rupees} ख़र्च करें।',
    te: 'మీ మొదటి {tokens} టోకెన్ల కోసం ఒకే ఆర్డర్‌లో ₹{rupees} ఖర్చు చేయండి.',
  },
  'rewards.orderTotal': { en: 'Order total ₹{amount}', hi: 'ऑर्डर कुल ₹{amount}', te: 'ఆర్డర్ మొత్తం ₹{amount}' },
  'rewards.spendNote': {
    en: 'Tokens buy spins on the Lucky Spin above. There is no cash redemption yet — your balance keeps counting up from every order in the meantime.',
    hi: 'टोकन से ऊपर दिए लकी स्पिन घुमाए जा सकते हैं। नक़द में बदलने की सुविधा अभी नहीं है — तब तक हर ऑर्डर से आपका बैलेंस बढ़ता रहेगा।',
    te: 'పైన ఉన్న లక్కీ స్పిన్ తిప్పడానికి టోకెన్లు వాడొచ్చు. నగదుగా మార్చుకునే సదుపాయం ఇంకా లేదు — అప్పటివరకు ప్రతి ఆర్డర్‌తో మీ బ్యాలెన్స్ పెరుగుతూనే ఉంటుంది.',
  },
  'spin.title': { en: 'Lucky Spin', hi: 'लकी स्पिन', te: 'లక్కీ స్పిన్' },
  'spin.cost': {
    en: 'Costs {cost} tokens a go. You have {left} to spend.',
    hi: 'हर बार {cost} टोकन लगते हैं। आपके पास {left} हैं।',
    te: 'ఒక్కసారికి {cost} టోకెన్లు. మీ దగ్గర {left} ఉన్నాయి.',
  },
  'spin.spinning': { en: 'Spinning…', hi: 'घूम रहा है…', te: 'తిరుగుతోంది…' },
  'spin.spinFor': { en: 'Spin for {cost} tokens', hi: '{cost} टोकन में घुमाएँ', te: '{cost} టోకెన్లతో తిప్పండి' },
  'spin.needMore': { en: 'Need {count} more tokens', hi: '{count} और टोकन चाहिए', te: 'ఇంకా {count} టోకెన్లు కావాలి' },
  'spin.youWon': { en: 'You won the {prize}!', hi: 'आपने {prize} जीता!', te: 'మీరు {prize} గెలిచారు!' },
  'spin.recentSpins': { en: 'Recent spins', hi: 'हाल के स्पिन', te: 'ఇటీవలి స్పిన్‌లు' },
  'spin.prize.eggBasket': { en: 'Egg Basket', hi: 'अंडा टोकरी', te: 'గుడ్ల బుట్ట' },
  'spin.prize.knife': { en: 'Kitchen Knife', hi: 'रसोई चाकू', te: 'వంటగది కత్తి' },
  'spin.prize.juiceGlass': { en: 'Juice Glass', hi: 'जूस गिलास', te: 'జ్యూస్ గ్లాస్' },
  'spin.prize.slicer': { en: '2-in-1 Vegetable Slicer', hi: '2-इन-1 सब्ज़ी स्लाइसर', te: '2-ఇన్-1 కూరగాయల స్లైసర్' },
  'spin.prize.none': { en: 'Better Luck Next Time', hi: 'अगली बार शुभकामनाएँ', te: 'మళ్లీసారి అదృష్టం' },
  'spin.prize.short.eggBasket': { en: 'Egg Basket', hi: 'अंडा', te: 'గుడ్లు' },
  'spin.prize.short.knife': { en: 'Knife', hi: 'चाकू', te: 'కత్తి' },
  'spin.prize.short.juiceGlass': { en: 'Juice Glass', hi: 'गिलास', te: 'గ్లాస్' },
  'spin.prize.short.slicer': { en: 'Slicer', hi: 'स्लाइसर', te: 'స్లైసర్' },
  'spin.prize.short.none': { en: 'Try Again', hi: 'फिर से', te: 'మళ్లీ' },
  'spin.wheelAria': {
    en: 'Prize wheel with {count} segments',
    hi: '{count} हिस्सों वाला इनाम चक्र',
    te: '{count} భాగాల బహుమతి చక్రం',
  },
  'spin.unknownPrize': { en: 'Unknown prize', hi: 'अज्ञात इनाम', te: 'తెలియని బహుమతి' },
  'spin.disclaimer': {
    en: 'Spins and prizes are recorded on this device only and can’t be claimed yet — this is a preview of the rewards store. Nothing is dispatched for a win.',
    hi: 'स्पिन और इनाम सिर्फ़ इसी डिवाइस पर दर्ज होते हैं और अभी लिए नहीं जा सकते — यह इनाम स्टोर की एक झलक है। जीत पर कुछ भेजा नहीं जाता।',
    te: 'స్పిన్‌లు, బహుమతులు ఈ పరికరంలో మాత్రమే నమోదవుతాయి, ఇంకా తీసుకోలేరు — ఇది రివార్డ్ స్టోర్ ముందస్తు రూపం. గెలిచినా ఏమీ పంపబడదు.',
  },

  // --- Account menu -----------------------------------------------------------
  'account.purchaseHistory': { en: 'Purchase History', hi: 'ख़रीद इतिहास', te: 'కొనుగోలు చరిత్ర' },
  'account.purchaseHistorySub': {
    en: 'Track your past orders and total spending',
    hi: 'अपने पुराने ऑर्डर और कुल ख़र्च देखें',
    te: 'మీ గత ఆర్డర్లు మరియు మొత్తం ఖర్చు చూడండి',
  },
  'account.profileDetails': { en: 'Profile Details', hi: 'प्रोफ़ाइल विवरण', te: 'ప్రొఫైల్ వివరాలు' },
  'account.profileDetailsSub': {
    en: 'View and edit your personal information',
    hi: 'अपनी निजी जानकारी देखें और बदलें',
    te: 'మీ వ్యక్తిగత సమాచారాన్ని చూడండి, మార్చండి',
  },
  'account.editProfile': { en: 'Edit Profile Details', hi: 'प्रोफ़ाइल विवरण बदलें', te: 'ప్రొఫైల్ వివరాలు మార్చండి' },
  'account.signOutAllDevices': {
    en: 'Sign out on all devices',
    hi: 'सभी डिवाइस से लॉग आउट करें',
    te: 'అన్ని పరికరాల నుండి లాగ్ అవుట్ చేయండి',
  },

  'list.harvested': { en: '{count} Harvested', hi: '{count} उपज', te: '{count} పంటలు' },
  'list.onlyLeft': { en: 'Only {count} left', hi: 'सिर्फ़ {count} बचे', te: 'కేవలం {count} మిగిలాయి' },
  'list.seeAll': { en: 'See All', hi: 'सभी देखें', te: 'అన్నీ చూడండి' },
  'list.quickView': { en: 'Quick View', hi: 'झलक देखें', te: 'త్వరిత వీక్షణ' },
  'market.retry': { en: 'Retry', hi: 'फिर कोशिश करें', te: 'మళ్లీ ప్రయత్నించండి' },
  'market.needAddressTitle': {
    en: 'Set your delivery address',
    hi: 'अपना डिलीवरी पता डालें',
    te: 'మీ డెలివరీ చిరునామా పెట్టండి',
  },
  'market.needAddressHint': {
    en: 'We need it to show the markets that can reach you.',
    hi: 'आप तक पहुँचने वाले बाज़ार दिखाने के लिए यह ज़रूरी है।',
    te: 'మీకు చేరగల మార్కెట్లను చూపడానికి ఇది అవసరం.',
  },
  // The ETA line under the hero offer. Two whole sentences rather than one with
  // a "your door" fallback substituted in: Telugu marks the destination with a
  // case suffix on the place itself (`{place}కి`), so a fallback that already
  // carries one would come out doubled.
  'hero.etaTo': { en: '15m to {place}', hi: '{place} तक 15 मिनट', te: '{place}కి 15 నిమిషాలు' },
  'hero.etaDoor': {
    en: '15m to your door',
    hi: 'आपके दरवाज़े तक 15 मिनट',
    te: 'మీ ఇంటికి 15 నిమిషాలు',
  },

  'market.finding': {
    en: 'Finding markets near you…',
    hi: 'आपके पास के बाज़ार खोजे जा रहे हैं…',
    te: 'మీ దగ్గరి మార్కెట్లను వెతుకుతోంది…',
  },
  'market.noneTitle': {
    en: 'No markets deliver here yet',
    hi: 'यहाँ अभी कोई बाज़ार डिलीवरी नहीं करता',
    te: 'ఇక్కడికి ఇంకా ఏ మార్కెట్ డెలివరీ చేయదు',
  },
  'market.noneHint': {
    en: 'We are opening in new areas all the time.',
    hi: 'हम लगातार नए इलाक़ों में शुरू कर रहे हैं।',
    te: 'మేము ఎప్పటికప్పుడు కొత్త ప్రాంతాల్లో ప్రారంభిస్తున్నాం.',
  },
  'market.shoppingFrom': { en: 'Shopping from', hi: 'यहाँ से ख़रीदारी', te: 'ఇక్కడి నుండి కొనుగోలు' },
  'market.choose': { en: 'Choose a market', hi: 'बाज़ार चुनें', te: 'మార్కెట్ ఎంచుకోండి' },
  // Stall counts are split into a one/many pair rather than built by appending
  // an "s": Hindi and Telugu do not pluralise this the way English does, and a
  // string assembled from fragments in English order comes out wrong in both.
  'market.summaryOne': {
    en: '{km} km away · 1 stall open',
    hi: '{km} किमी दूर · 1 दुकान खुली',
    te: '{km} కి.మీ దూరం · 1 దుకాణం తెరిచి ఉంది',
  },
  'market.summaryMany': {
    en: '{km} km away · {stalls} stalls open',
    hi: '{km} किमी दूर · {stalls} दुकानें खुली',
    te: '{km} కి.మీ దూరం · {stalls} దుకాణాలు తెరిచి ఉన్నాయి',
  },
  'market.rowOne': {
    en: '{km} km · 1 stall open',
    hi: '{km} किमी · 1 दुकान खुली',
    te: '{km} కి.మీ · 1 దుకాణం తెరిచి ఉంది',
  },
  'market.rowMany': {
    en: '{km} km · {stalls} stalls open',
    hi: '{km} किमी · {stalls} दुकानें खुली',
    te: '{km} కి.మీ · {stalls} దుకాణాలు తెరిచి ఉన్నాయి',
  },
  'market.rowClosed': {
    en: '{km} km · closed right now',
    hi: '{km} किमी · अभी बंद है',
    te: '{km} కి.మీ · ప్రస్తుతం మూసివేసి ఉంది',
  },
  'market.rowTooFar': {
    en: '{km} km · too far to deliver',
    hi: '{km} किमी · डिलीवरी के लिए बहुत दूर',
    te: '{km} కి.మీ · డెలివరీకి చాలా దూరం',
  },

  // --- Checkout blockers (App.jsx) --------------------------------------------
  'checkout.needMarket': {
    en: 'We need your delivery address before we can pick a market to fill this order. Set it from the address bar at the top of the shop.',
    hi: 'इस ऑर्डर के लिए बाज़ार चुनने से पहले हमें आपका डिलीवरी पता चाहिए। दुकान के ऊपर पता बार से इसे डालें।',
    te: 'ఈ ఆర్డర్‌కు మార్కెట్ ఎంచుకోవడానికి ముందు మీ డెలివరీ చిరునామా కావాలి. షాప్ పైన ఉన్న చిరునామా బార్ నుండి పెట్టండి.',
  },
  'checkout.needStreetAddress': {
    en: 'Add the street address the rider should deliver to. Tap the address bar at the top of the shop.',
    hi: 'वह पता डालें जहाँ राइडर को डिलीवरी करनी है। दुकान के ऊपर पता बार पर टैप करें।',
    te: 'రైడర్ డెలివరీ చేయాల్సిన చిరునామా పెట్టండి. షాప్ పైన ఉన్న చిరునామా బార్‌ను తాకండి.',
  },

  'account.rewardsSub': {
    en: 'Earn {tokens} tokens for every ₹{rupees} you spend',
    hi: 'हर ₹{rupees} ख़र्च पर {tokens} टोकन कमाएँ',
    te: 'మీరు ఖర్చు చేసే ప్రతి ₹{rupees}కి {tokens} టోకెన్లు సంపాదించండి',
  },

  // --- Price Tracker (PriceHistory.jsx) ---------------------------------------
  'price.title': { en: 'Price Tracker', hi: 'क़ीमत ट्रैकर', te: 'ధరల ట్రాకర్' },
  'price.subtitleMarket': {
    en: 'Price changes at {market} over the last {days} days',
    hi: '{market} में पिछले {days} दिनों के क़ीमत बदलाव',
    te: 'గత {days} రోజుల్లో {market}లో ధరల మార్పులు',
  },
  'price.subtitleNoMarket': {
    en: 'Pick a market to see how its prices have moved',
    hi: 'क़ीमतें कैसे बदलीं यह देखने के लिए बाज़ार चुनें',
    te: 'ధరలు ఎలా మారాయో చూడటానికి ఒక మార్కెట్ ఎంచుకోండి',
  },
  'price.rising': { en: 'Rising', hi: 'बढ़ रही', te: 'పెరుగుతున్నవి' },
  'price.falling': { en: 'Falling', hi: 'घट रही', te: 'తగ్గుతున్నవి' },
  'price.steady': { en: 'Steady', hi: 'स्थिर', te: 'స్థిరం' },
  'price.needMarket': {
    en: 'Prices are set by each market, so a trend only means something once you have chosen one. Pick a market on the home screen and its price changes will show up here.',
    hi: 'क़ीमतें हर बाज़ार अपनी तय करता है, इसलिए बाज़ार चुनने पर ही रुझान का मतलब बनता है। होम स्क्रीन पर बाज़ार चुनें, उसके क़ीमत बदलाव यहाँ दिखेंगे।',
    te: 'ధరలను ప్రతి మార్కెట్ తనే నిర్ణయిస్తుంది, కాబట్టి మీరు ఒకటి ఎంచుకున్నాకే ధోరణికి అర్థం ఉంటుంది. హోమ్ స్క్రీన్‌లో ఒక మార్కెట్ ఎంచుకోండి, దాని ధరల మార్పులు ఇక్కడ కనిపిస్తాయి.',
  },
  'price.loadFailed': {
    en: 'Could not load price history just now. Pull down to try again.',
    hi: 'अभी क़ीमत इतिहास नहीं आ सका। फिर कोशिश करने के लिए नीचे खींचें।',
    te: 'ప్రస్తుతం ధరల చరిత్ర రాలేదు. మళ్లీ ప్రయత్నించడానికి కిందికి లాగండి.',
  },
  'price.noneRecorded': {
    en: 'No price changes recorded at {market} yet. This fills in as the market updates its sheet — it does not estimate what prices might have been.',
    hi: '{market} में अभी कोई क़ीमत बदलाव दर्ज नहीं हुआ। बाज़ार जैसे-जैसे अपनी सूची बदलेगा, यह भरता जाएगा — यह अंदाज़ा नहीं लगाता कि क़ीमतें क्या रही होंगी।',
    te: '{market}లో ఇంకా ఏ ధరల మార్పూ నమోదు కాలేదు. మార్కెట్ తన జాబితాను మార్చే కొద్దీ ఇది నిండుతుంది — ధరలు ఎలా ఉండేవో ఇది ఊహించదు.',
  },
  'price.searchItems': { en: 'Search items...', hi: 'वस्तुएँ खोजें...', te: 'వస్తువులను వెతకండి...' },
  'price.all': { en: 'All', hi: 'सभी', te: 'అన్నీ' },
  'price.loading': { en: 'Loading price history…', hi: 'क़ीमत इतिहास आ रहा है…', te: 'ధరల చరిత్ర వస్తోంది…' },
  'price.noChanges': { en: 'no changes', hi: 'कोई बदलाव नहीं', te: 'మార్పులు లేవు' },
  'price.today': { en: 'today', hi: 'आज', te: 'ఈరోజు' },
  'price.inForce': { en: 'in force', hi: 'अभी लागू', te: 'ప్రస్తుతం అమల్లో' },
  'price.oneOnRecord': {
    en: 'One price on record — it has not changed in this window.',
    hi: 'रिकॉर्ड में एक ही क़ीमत — इस अवधि में यह नहीं बदली।',
    te: 'రికార్డులో ఒకే ధర — ఈ వ్యవధిలో ఇది మారలేదు.',
  },
  'price.changesRecorded': {
    en: '{count} price changes recorded. The line holds flat between changes because that is what the price did.',
    hi: '{count} क़ीमत बदलाव दर्ज हैं। दो बदलावों के बीच लकीर सपाट रहती है क्योंकि क़ीमत ने वही किया।',
    te: '{count} ధరల మార్పులు నమోదయ్యాయి. మార్పుల మధ్య గీత సమాంతరంగా ఉంటుంది, ఎందుకంటే ధర అలాగే ఉంది.',
  },
};

/**
 * @param {string} key
 * @param {'en'|'hi'|'te'} language
 * @param {Record<string, string|number>} [vars] values for `{name}` placeholders
 * @returns {string} the translated string, or the English one if the key
 *   exists but this language is missing it, or the raw key as a last resort
 *   so a typo shows up as visibly wrong text rather than a blank label.
 *
 * Placeholders are named (`{count}`), never positional, because word order
 * differs between these three languages — Telugu and Hindi both put the verb
 * last, so a string built by concatenating fragments in English order comes out
 * wrong. Naming them lets a translation move them wherever its grammar needs.
 *
 * A placeholder with no matching value is left as-is rather than blanked, so a
 * missed variable reads as an obvious `{count}` on screen instead of a sentence
 * with a hole in it.
 */
export function translate(key, language, vars) {
  const entry = STRINGS[key];
  if (!entry) return key;

  const template = entry[language] || entry[DEFAULT_LANGUAGE] || key;
  if (!vars) return template;

  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  );
}
