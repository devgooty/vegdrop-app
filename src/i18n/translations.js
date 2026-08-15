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

  // --- Rewards & spin wheel ---------------------------------------------------
  'rewards.title': { en: 'Rewards', hi: 'इनाम', te: 'రివార్డులు' },
  'rewards.tokensEarned': { en: 'Reward Tokens Earned', hi: 'कमाए गए टोकन', te: 'సంపాదించిన టోకెన్లు' },
  'rewards.tokens': { en: 'tokens', hi: 'टोकन', te: 'టోకెన్లు' },
  'rewards.countedSpend': { en: 'Counted Spend', hi: 'गिना गया ख़र्च', te: 'లెక్కించిన ఖర్చు' },
  'rewards.earningOrders': { en: 'Earning Orders', hi: 'कमाई वाले ऑर्डर', te: 'సంపాదన ఆర్డర్లు' },
  'rewards.howYouEarn': { en: 'How you earn', hi: 'आप कैसे कमाते हैं', te: 'మీరు ఎలా సంపాదిస్తారు' },
  'rewards.tokenHistory': { en: 'Token History', hi: 'टोकन इतिहास', te: 'టోకెన్ చరిత్ర' },
  'rewards.noTokens': { en: 'No tokens yet', hi: 'अभी कोई टोकन नहीं', te: 'ఇంకా టోకెన్లు లేవు' },
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

  // --- Account menu -----------------------------------------------------------
  'account.purchaseHistory': { en: 'Purchase History', hi: 'ख़रीद इतिहास', te: 'కొనుగోలు చరిత్ర' },
  'account.purchaseHistorySub': {
    en: 'Track your past orders and total spending',
    hi: 'अपने पुराने ऑर्डर और कुल ख़र्च देखें',
    te: 'మీ గత ఆర్డర్లు మరియు మొత్తం ఖర్చు చూడండి',
  },
  'account.rewardsSub': {
    en: 'Earn {tokens} tokens for every ₹{rupees} you spend',
    hi: 'हर ₹{rupees} ख़र्च पर {tokens} टोकन कमाएँ',
    te: 'మీరు ఖర్చు చేసే ప్రతి ₹{rupees}కి {tokens} టోకెన్లు సంపాదించండి',
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
