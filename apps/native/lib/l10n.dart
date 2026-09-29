/// UI strings. English and Indonesian are complete; the other 28 languages
/// translate the home-screen strings and fall back to English elsewhere.
const rtlLangs = {'ar', 'he', 'fa', 'ur'};

const langNames = <String, String>{
  'en': 'English', 'id': 'Bahasa Indonesia', 'ja': '日本語', 'ko': '한국어',
  'zh': '简体中文', 'zt': '繁體中文', 'ar': 'العربية', 'he': 'עברית', 'fa': 'فارسی',
  'ur': 'اردو', 'hi': 'हिन्दी', 'bn': 'বাংলা', 'ta': 'தமிழ்', 'th': 'ไทย',
  'vi': 'Tiếng Việt', 'ru': 'Русский', 'uk': 'Українська', 'de': 'Deutsch',
  'fr': 'Français', 'es': 'Español', 'pt': 'Português', 'tr': 'Türkçe',
  'pl': 'Polski', 'sw': 'Kiswahili', 'jv': 'Basa Jawa', 'ms': 'Bahasa Melayu',
  'tl': 'Filipino', 'am': 'አማርኛ', 'ka': 'ქართული', 'my': 'မြန်မာ',
};

const _homeKeys = ['vault', 'send', 'receive', 'swap', 'rotate', 'activity', 'seeAll', 'keysLeft', 'sentTo', 'received'];

const _home = <String, List<String>>{
  'ja': ['この金庫の残高', '送金', '受取', '交換', '更新', '履歴', 'すべて表示', 'ハッシュ鍵 残り{n}', 'Mayaへ送金', '受取済み'],
  'ko': ['이 금고 잔액', '보내기', '받기', '교환', '교체', '활동', '모두 보기', '해시 키 {n}개 남음', 'Maya에게 보냄', '받음'],
  'zh': ['此金库余额', '发送', '接收', '兑换', '轮换', '动态', '查看全部', '剩余 {n} 个哈希密钥', '已发送给 Maya', '已收到'],
  'zt': ['此金庫餘額', '傳送', '接收', '兌換', '輪替', '動態', '查看全部', '剩餘 {n} 把雜湊金鑰', '已傳送給 Maya', '已收到'],
  'ar': ['في هذه الخزنة', 'إرسال', 'استلام', 'مبادلة', 'تدوير', 'النشاط', 'عرض الكل', 'تبقّى {n} مفتاح تجزئة', 'أُرسل إلى مايا', 'مُستلَم'],
  'he': ['בכספת הזו', 'שליחה', 'קבלה', 'המרה', 'החלפה', 'פעילות', 'הצג הכול', 'נותרו {n} מפתחות גיבוב', 'נשלח למאיה', 'התקבל'],
  'fa': ['در این گاوصندوق', 'ارسال', 'دریافت', 'مبادله', 'چرخش', 'فعالیت', 'مشاهده همه', '{n} کلید هش باقی مانده', 'ارسال به مایا', 'دریافت شد'],
  'ur': ['اس والٹ میں', 'بھیجیں', 'وصول کریں', 'تبادلہ', 'تبدیل', 'سرگرمی', 'سب دیکھیں', '{n} ہیش کیز باقی', 'مایا کو بھیجا', 'موصول'],
  'hi': ['इस तिजोरी में', 'भेजें', 'प्राप्त करें', 'बदलें', 'रोटेट', 'गतिविधि', 'सब देखें', '{n} हैश कुंजियाँ बाकी', 'माया को भेजा', 'प्राप्त'],
  'bn': ['এই ভল্টে', 'পাঠান', 'গ্রহণ', 'বিনিময়', 'ঘোরান', 'কার্যকলাপ', 'সব দেখুন', '{n}টি হ্যাশ কী বাকি', 'মায়াকে পাঠানো', 'প্রাপ্ত'],
  'ta': ['இந்த பெட்டகத்தில்', 'அனுப்பு', 'பெறு', 'மாற்று', 'சுழற்று', 'செயல்பாடு', 'அனைத்தும்', '{n} ஹாஷ் விசைகள் மீதம்', 'மாயாவுக்கு அனுப்பியது', 'பெறப்பட்டது'],
  'th': ['ในห้องนิรภัยนี้', 'ส่ง', 'รับ', 'แลก', 'หมุนเวียน', 'กิจกรรม', 'ดูทั้งหมด', 'เหลือแฮชคีย์ {n} ดอก', 'ส่งให้ Maya', 'ได้รับ'],
  'vi': ['Trong két này', 'Gửi', 'Nhận', 'Hoán đổi', 'Xoay vòng', 'Hoạt động', 'Xem tất cả', 'Còn {n} khóa băm', 'Đã gửi Maya', 'Đã nhận'],
  'ru': ['В этом хранилище', 'Отправить', 'Получить', 'Обмен', 'Сменить', 'Активность', 'Все', 'Осталось {n} хеш-ключей', 'Отправлено Maya', 'Получено'],
  'uk': ['У цьому сховищі', 'Надіслати', 'Отримати', 'Обмін', 'Змінити', 'Активність', 'Усі', 'Лишилось {n} хеш-ключів', 'Надіслано Maya', 'Отримано'],
  'de': ['In diesem Tresor', 'Senden', 'Empfangen', 'Tauschen', 'Erneuern', 'Aktivität', 'Alle anzeigen', 'Noch {n} Hash-Schlüssel', 'An Maya gesendet', 'Empfangen'],
  'fr': ['Dans ce coffre', 'Envoyer', 'Recevoir', 'Échanger', 'Renouveler', 'Activité', 'Tout voir', 'Il reste {n} clés de hachage', 'Envoyé à Maya', 'Reçu'],
  'es': ['En esta bóveda', 'Enviar', 'Recibir', 'Cambiar', 'Rotar', 'Actividad', 'Ver todo', 'Quedan {n} claves hash', 'Enviado a Maya', 'Recibido'],
  'pt': ['Neste cofre', 'Enviar', 'Receber', 'Trocar', 'Renovar', 'Atividade', 'Ver tudo', 'Restam {n} chaves hash', 'Enviado para Maya', 'Recebido'],
  'tr': ['Bu kasada', 'Gönder', 'Al', 'Takas', 'Yenile', 'Etkinlik', 'Tümü', '{n} hash anahtarı kaldı', "Maya'ya gönderildi", 'Alındı'],
  'pl': ['W tym sejfie', 'Wyślij', 'Odbierz', 'Wymień', 'Odnów', 'Aktywność', 'Wszystko', 'Zostało {n} kluczy haszujących', 'Wysłano do Maya', 'Odebrano'],
  'sw': ['Katika hazina hii', 'Tuma', 'Pokea', 'Badilisha', 'Zungusha', 'Shughuli', 'Ona zote', 'Funguo {n} za hash zimebaki', 'Imetumwa kwa Maya', 'Imepokelewa'],
  'jv': ['Ing brankas iki', 'Kirim', 'Tampa', 'Ijol', 'Ganti', 'Kegiatan', 'Deleng kabeh', 'Kari {n} kunci hash', 'Dikirim menyang Maya', 'Ditampa'],
  'ms': ['Dalam peti besi ini', 'Hantar', 'Terima', 'Tukar', 'Putar', 'Aktiviti', 'Lihat semua', 'Tinggal {n} kunci hash', 'Dihantar kepada Maya', 'Diterima'],
  'tl': ['Sa vault na ito', 'Ipadala', 'Tanggapin', 'Palitan', 'I-rotate', 'Aktibidad', 'Tingnan lahat', '{n} hash key ang natitira', 'Ipinadala kay Maya', 'Natanggap'],
  'am': ['በዚህ ካዝና', 'ላክ', 'ተቀበል', 'ቀይር', 'አዙር', 'እንቅስቃሴ', 'ሁሉንም እይ', '{n} የሃሽ ቁልፎች ቀርተዋል', 'ለማያ ተልኳል', 'ተቀብሏል'],
  'ka': ['ამ სეიფში', 'გაგზავნა', 'მიღება', 'გაცვლა', 'როტაცია', 'აქტივობა', 'ყველა', 'დარჩა {n} ჰეშ-გასაღები', 'გაეგზავნა მაიას', 'მიღებულია'],
  'my': ['ဤမုတ်ဆိပ်တွင်', 'ပို့ရန်', 'လက်ခံ', 'လဲလှယ်', 'လှည့်', 'လုပ်ဆောင်ချက်', 'အားလုံး', 'hash key {n} ခု ကျန်', 'Maya ထံ ပို့ပြီး', 'လက်ခံပြီး'],
};

const _en = <String, String>{
  'vault': 'In this vault', 'send': 'Send', 'receive': 'Receive', 'swap': 'Swap', 'rotate': 'Rotate',
  'activity': 'Activity', 'seeAll': 'See all', 'keysLeft': '{n} hash keys left', 'sentTo': 'Sent to Maya',
  'received': 'Received', 'settings': 'Settings', 'unlock': 'Enter passcode', 'useBio': 'Use fingerprint or face',
  'wrong': 'Wrong passcode', 'recipient': 'Recipient address', 'scan': 'Scan QR', 'amount': 'Amount',
  'review': 'Review', 'confirm': 'Confirm send', 'hold': 'Hold to sign with both keys', 'sending': 'Sending',
  'sentOk': 'Sent', 'copy': 'Copy', 'copied': 'Address copied', 'share': 'Share', 'theme': 'Theme',
  'language': 'Language', 'system': 'System', 'dark': 'Dark', 'light': 'Light',
  'setCode': 'Choose a 6-digit passcode', 'confirmCode': 'Enter it again', 'mismatch': "Passcodes didn't match",
  'noVault': 'No vault added yet', 'addVault': 'Add vault address', 'vaultAddr': 'Vault address',
  'noActivity': 'No transactions yet', 'retry': 'Try again', 'network': 'Network', 'save': 'Save',
  'noKeys': 'This device has no signing keys yet. Create new vault keys, or import a vault file from the QC command-line client.',
  'createKeys': 'Create vault keys', 'importKey': 'Import vault file', 'cancel': 'Cancel',
  'feeKey': 'Fee key', 'needSol': 'Send a little SOL to the fee key to pay network fees.',
  'unfinished': 'Unfinished transfer', 'resume': 'Finish transfer', 'tooMuch': 'More than this vault holds',
  'step_preparing': 'signing', 'step_accounts': 'preparing accounts', 'step_signing': 'signing',
  'step_sending': 'broadcasting', 'step_done': 'done',
  'removeVault': 'Remove vault', 'openExplorer': 'Open in explorer',
  'badAddr': 'Not a Solana address', 'ethAddr': "That's an Ethereum address. QC only lives on Solana.",
  'lookalike': 'This looks like a copy of a saved address', 'notEnough': 'More than this vault holds',
  'walletKey': 'Wallet key', 'hashKey': 'Hash key', 'fee': 'Network fee', 'to': 'To', 'done': 'Done',
  'lock': 'Lock now', 'sound': 'Sound', 'haptics': 'Haptics', 'noCamera': 'Camera not available here',
};

const _id = <String, String>{
  'vault': 'Di brankas ini', 'send': 'Kirim', 'receive': 'Terima', 'swap': 'Tukar', 'rotate': 'Putar',
  'activity': 'Aktivitas', 'seeAll': 'Lihat semua', 'keysLeft': 'Sisa {n} kunci hash', 'sentTo': 'Dikirim ke Maya',
  'received': 'Diterima', 'settings': 'Pengaturan', 'unlock': 'Masukkan kode sandi', 'useBio': 'Pakai sidik jari atau wajah',
  'wrong': 'Kode sandi salah', 'recipient': 'Alamat penerima', 'scan': 'Pindai QR', 'amount': 'Jumlah',
  'review': 'Tinjau', 'confirm': 'Konfirmasi kirim', 'hold': 'Tahan untuk tanda tangan dua kunci', 'sending': 'Mengirim',
  'sentOk': 'Terkirim', 'copy': 'Salin', 'copied': 'Alamat disalin', 'share': 'Bagikan', 'theme': 'Tema',
  'language': 'Bahasa', 'system': 'Sistem', 'dark': 'Gelap', 'light': 'Terang',
  'setCode': 'Buat kode sandi 6 angka', 'confirmCode': 'Masukkan sekali lagi', 'mismatch': 'Kode sandi tidak sama',
  'noVault': 'Belum ada brankas', 'addVault': 'Tambah alamat brankas', 'vaultAddr': 'Alamat brankas',
  'noActivity': 'Belum ada transaksi', 'retry': 'Coba lagi', 'network': 'Jaringan', 'save': 'Simpan',
  'noKeys': 'Perangkat ini belum punya kunci tanda tangan. Buat kunci brankas baru, atau impor file brankas dari klien baris perintah QC.',
  'createKeys': 'Buat kunci brankas', 'importKey': 'Impor file brankas', 'cancel': 'Batal',
  'feeKey': 'Kunci biaya', 'needSol': 'Kirim sedikit SOL ke kunci biaya untuk membayar biaya jaringan.',
  'unfinished': 'Transfer belum selesai', 'resume': 'Selesaikan transfer', 'tooMuch': 'Melebihi isi brankas',
  'step_preparing': 'menandatangani', 'step_accounts': 'menyiapkan akun', 'step_signing': 'menandatangani',
  'step_sending': 'menyiarkan', 'step_done': 'selesai',
  'removeVault': 'Hapus brankas', 'openExplorer': 'Buka di explorer',
  'badAddr': 'Bukan alamat Solana', 'ethAddr': 'Itu alamat Ethereum. QC hanya ada di Solana.',
  'lookalike': 'Alamat ini mirip salinan alamat yang tersimpan', 'notEnough': 'Melebihi isi brankas',
  'walletKey': 'Kunci dompet', 'hashKey': 'Kunci hash', 'fee': 'Biaya jaringan', 'to': 'Ke', 'done': 'Selesai',
  'lock': 'Kunci sekarang', 'sound': 'Suara', 'haptics': 'Getar', 'noCamera': 'Kamera tidak tersedia di sini',
};

String tr(String lang, String key, {int? n}) {
  String? s;
  if (lang == 'id') {
    s = _id[key];
  } else if (_home.containsKey(lang)) {
    final i = _homeKeys.indexOf(key);
    if (i >= 0) s = _home[lang]![i];
  }
  s ??= _en[key] ?? key;
  return n == null ? s : s.replaceAll('{n}', '$n');
}
