/**
 * Lexicons for Tier 2, mirrored from data/lexicons/*.json.
 *
 * Inlined as TS because core must not touch the filesystem (SPEC §1). The JSON
 * files stay the human-facing source of truth; keep the two in sync.
 */

// --- intent.json ---------------------------------------------------------

export const INTENT_CHANNEL = [
  "whatsapp", "whats app", "whatzapp", "watsapp", "wtsapp", "wsp", "wapp",
  "green app", "green tick app", "the green one",
  "telegram", "tele gram", "tg",
  "signal app", "imessage", "viber", "snapchat", "snap chat",
  "instagram", "insta", "insta gram", "ig", "igdm",
  "facebook", "fb", "messenger",
  "sms", "text message", "email me", "mail me", "gmail",
];

export const INTENT_ACTION = [
  "call me", "call karo", "call kar", "call kro", "phone me", "ring me",
  "give me a call", "gimme a call", "give a missed call", "missed call",
  "dm me", "dm karo", "text me", "message me", "msg me", "msg karna",
  "msg kar", "ping me", "buzz me", "reach me at", "reach out at",
  "contact me at", "hit me up", "hmu",
  "number de do", "number dedo", "number bhejo", "number send karo",
  "apna number", "mera number", "my number is", "number is",
  "send your number", "share your number", "no. de do",
  "contact number", "mobile number", "mob no", "cell number",
];

export const INTENT_OFFPLATFORM = [
  "book direct", "book directly", "direct booking", "directly book",
  "take this offline", "offline baat", "offline discuss",
  "outside the app", "outside app", "off the app", "off platform",
  "without the app", "app ke bahar", "app se bahar",
  "avoid the fee", "avoid commission", "save commission", "no commission",
  "cheaper direct", "better price direct", "direct me sasta",
  "cancel here and", "cancel the booking and", "cancel and book",
  "next time direct", "agli baar direct", "seedha book",
];

export const INTENT_PAYMENT = [
  "google pay", "gpay", "g pay", "phonepe", "phone pe", "paytm",
  "bhim", "upi id", "upi karo", "upi kar do", "scan the qr", "qr code",
  "bank transfer", "neft", "imps", "rtgs", "account number",
  "cash payment", "cash me do", "cash de dena", "pay cash",
  "advance de do", "advance bhejo", "token amount",
];

/**
 * Phrases that contain an intent term but are harmless (SPEC §10 hard
 * negatives: "call it a day" is called out explicitly as an FP trap).
 */
export const INTENT_NEGATIVE_CONTEXT = [
  "call it a day", "call it quits", "close call", "call the shots",
  "wake up call", "on call", "call ahead if", "courtesy call",
  "judgement call", "judgment call", "call center", "call centre",
  "roll call", "call to prayer", "last call",
  "text book", "textbook", "book direct flight",
];

// --- domains.json --------------------------------------------------------

export const MESSENGER_DOMAINS = [
  "wa.me", "api.whatsapp.com", "chat.whatsapp.com", "web.whatsapp.com", "whatsapp.com",
  "t.me", "telegram.me", "telegram.org", "telegram.dog",
  "ig.me", "instagram.com", "instagr.am",
  "m.me", "messenger.com", "facebook.com", "fb.com", "fb.me",
  "signal.me", "snapchat.com", "discord.gg", "discord.com",
  "join.skype.com", "skype.com", "hangouts.google.com", "meet.google.com",
  "zoom.us", "linkedin.com", "x.com", "twitter.com",
];

export const SHORTENERS = [
  "bit.ly", "bitly.com", "tinyurl.com", "goo.gl", "t.co", "ow.ly", "buff.ly",
  "is.gd", "cutt.ly", "rebrand.ly", "shorturl.at", "rb.gy", "linktr.ee",
  "s.id", "tiny.cc", "shorte.st", "adf.ly", "bl.ink", "clck.ru", "v.gd",
  "qr.ae", "u.to", "sh.st", "surl.li", "shrtco.de", "1link.in", "zi.gg",
];

export const PAYMENT_DOMAINS = [
  "paypal.me", "razorpay.com", "rzp.io", "pages.razorpay.com",
  "paytm.me", "phonepe.com", "gpay.app.goo.gl", "cash.app",
  "venmo.com", "wise.com", "revolut.me", "buymeacoffee.com", "stripe.com",
];

export const RISKY_TLDS = new Set([
  "tk", "ml", "ga", "cf", "gq", "top", "xyz", "buzz", "click", "link",
  "work", "loan", "download", "review", "country", "stream", "gdn",
  "mom", "party", "science", "date", "faith", "racing", "win", "bid",
  "trade", "webcam", "cricket", "accountant", "zip", "mov", "rest",
]);

/** First-party domains — never flagged (SPEC §4). */
export const ALLOWLIST_DOMAINS = new Set([
  "wayzyy.com", "www.wayzyy.com", "app.wayzyy.com", "help.wayzyy.com",
  "support.wayzyy.com", "blog.wayzyy.com", "wayzyy.in",
]);

export const COMMON_TLDS = new Set([
  "com", "net", "org", "in", "co", "io", "me", "app", "dev", "info", "biz",
  "us", "uk", "ca", "au", "de", "fr", "it", "es", "nl", "ru", "cn", "jp",
  "br", "mx", "ae", "sg", "ch", "se", "no", "dk", "fi", "pl", "gov", "edu",
  "ac", "tv", "cc", "ly", "gg", "to", "sh", "st", "am", "fm", "pe", "ai",
]);

export const EMAIL_DOMAINS = [
  "gmail", "googlemail", "yahoo", "ymail", "rediffmail", "rediff",
  "hotmail", "outlook", "live", "msn", "icloud", "me", "aol",
  "protonmail", "proton", "zoho", "gmx", "mail", "yandex", "inbox",
];

// --- upi.json ------------------------------------------------------------

export const UPI_PSP_HANDLES = [
  "ybl", "ibl", "axl", "apl", "abfspay",
  "okhdfcbank", "okicici", "oksbi", "okaxis", "okbizaxis",
  "paytm", "ptaxis", "ptsbi", "ptyes", "pthdfc",
  "upi", "hdfcbank", "icici", "sbi", "axisbank", "kotak", "yesbank",
  "indus", "idfcbank", "idfcfirst", "federal", "fbl", "rbl", "unionbank",
  "uboi", "barodampay", "bandhan", "cnrb", "cboi", "dbs", "dlb", "jkb",
  "kbl", "kvb", "lvb", "pnb", "psb", "purz", "sib", "tjsb", "utbi", "yapl",
  "airtel", "freecharge", "jupiteraxis", "naviaxis", "slc", "timecosmos",
  "waaxis", "wahdfcbank", "waicici", "wasbi", "amazonpay", "aubank",
  "goaxb", "jio", "mahb", "myicici", "niyoicici", "omni", "rapl", "sliceaxis",
  "superyes", "yesg", "zoicici", "fam", "fkaxis", "seyes", "trans",
];

// --- safety.json ---------------------------------------------------------

export const HOSTILITY_SEV1 = [
  "shut up", "shutup", "stupid", "idiot", "nonsense", "rubbish", "pathetic",
  "worst", "useless", "trash", "garbage", "clown", "joker", "fool",
  "bakwas", "bakwaas", "faltu", "ghatiya", "bewakoof",
  "pagal", "paagal", "nalayak", "chup kar", "chup ho ja",
];

export const HOSTILITY_SEV2 = [
  "bastard", "asshole", "arsehole", "dickhead", "scumbag", "moron",
  "retard", "shithead", "prick", "wanker", "cunt", "bitch", "whore",
  "kutta", "kutte", "kamina", "kamine", "harami", "haramkhor",
  "gandu", "chutiya", "chutiye", "bhosdi", "bhosdike", "madarchod",
  "behenchod", "bhenchod", "bkl", "saala", "saale", "randi",
];

export const HOSTILITY_SEV3 = [
  "kill you", "kill u", "murder you", "stab you", "shoot you",
  "beat you up", "beat the shit", "break your legs", "break your face",
  "smash your face", "burn your house", "come to your house",
  "find you and", "you are dead", "ur dead", "watch your back",
  "jaan se maar", "maar dunga", "maar dungi", "dekh lunga", "dekh lenge",
  "zinda nahi", "ghar aake", "haath pair tod",
];

export const EXTORTION_DEMAND = [
  "refund", "full refund", "money back", "paisa wapas", "paise wapas",
  "discount", "free stay", "free night", "compensation", "waive",
  "cancel my booking", "cancel the charge", "chargeback",
  "extra night", "upgrade", "cashback", "adjust the amount",
  "paisa", "paise", "money", "pay me", "de do", "wapas karo",
];

export const EXTORTION_CONDITIONAL = [
  "or i will", "or i'll", "or ill", "or else", "otherwise", "or we will",
  "if not", "if you don't", "if you dont", "unless you",
  "warna", "nahi to", "nahin to", "varna", "nahito", "vrna",
  "ya phir", "or main", "or mai",
];

export const EXTORTION_LEVERAGE = [
  "review", "reviews", "bad review", "negative review", "worst review",
  "rating", "bad rating", "low rating", "1 star", "one star", "1-star",
  "2 star", "two star", "zero star", "0 star",
  "complaint", "complain", "report you", "report this",
  "social media", "twitter", "instagram post", "viral", "expose you",
  "consumer court", "legal action", "police complaint", "fir",
  "review kar dunga", "review likh dunga", "rating gira dunga",
  "bura review", "galat review",
];

export const SCAM_URGENCY = [
  "right now", "immediately", "urgent", "urgently", "hurry", "quick",
  "last chance", "expires", "expiring", "only today", "today only",
  "limited time", "act fast", "within 10 minutes", "within 5 minutes",
  "jaldi", "abhi", "turant", "aaj hi", "jald se jald",
];

export const SCAM_PAYMENT = [
  "pay", "payment", "deposit", "advance", "booking amount", "token amount",
  "transfer", "send money", "upi", "gpay", "phonepe", "paytm", "bank details",
  "card details", "cvv", "otp", "pin", "netbanking", "wallet",
];

export const SCAM_TOO_GOOD = [
  "50% off", "60% off", "70% off", "80% off", "90% off", "half price",
  "free upgrade", "guaranteed", "no questions asked", "special price for you",
  "only for you", "secret deal", "insider rate", "below market",
];
