const Y=40000;out=[];let X=0;
const FONT={ja:"Noto Sans JP",ko:"Noto Sans KR",zh:"Noto Sans SC",zt:"Noto Sans TC",ar:"Noto Sans Arabic",fa:"Noto Sans Arabic",ur:"Noto Sans Arabic",he:"Noto Sans Hebrew",hi:"Noto Sans Devanagari",mr:"Noto Sans Devanagari",ne:"Noto Sans Devanagari",bn:"Noto Sans Bengali",ta:"Noto Sans Tamil",te:"Noto Sans Telugu",th:"Noto Sans Thai",km:"Noto Sans Khmer",my:"Noto Sans Myanmar",am:"Noto Sans Ethiopic",ka:"Noto Sans Georgian",hy:"Noto Sans Armenian",si:"Noto Sans Sinhala",lo:"Noto Sans Lao",gu:"Noto Sans Gujarati",pa:"Noto Sans Gurmukhi",kn:"Noto Sans Kannada",ml:"Noto Sans Malayalam"};
// code, native name, [vault label, Send, Receive, Swap, Rotate, Activity, See all, keys left, Sent to, Received]
const LANGS=[
["en","English",["In this vault","Send","Receive","Swap","Rotate","Activity","See all","282 hash keys left","Sent to Maya","Received"]],
["id","Bahasa Indonesia",["Di brankas ini","Kirim","Terima","Tukar","Putar","Aktivitas","Lihat semua","Sisa 282 kunci hash","Dikirim ke Maya","Diterima"]],
["ja","日本語",["この金庫の残高","送金","受取","交換","更新","履歴","すべて表示","ハッシュ鍵 残り282","Mayaへ送金","受取済み"]],
["ko","한국어",["이 금고 잔액","보내기","받기","교환","교체","활동","모두 보기","해시 키 282개 남음","Maya에게 보냄","받음"]],
["zh","简体中文",["此金库余额","发送","接收","兑换","轮换","动态","查看全部","剩余 282 个哈希密钥","已发送给 Maya","已收到"]],
["zt","繁體中文",["此金庫餘額","傳送","接收","兌換","輪替","動態","查看全部","剩餘 282 把雜湊金鑰","已傳送給 Maya","已收到"]],
["ar","العربية",["في هذه الخزنة","إرسال","استلام","مبادلة","تدوير","النشاط","عرض الكل","تبقّى 282 مفتاح تجزئة","أُرسل إلى مايا","مُستلَم"],1],
["he","עברית",["בכספת הזו","שליחה","קבלה","המרה","החלפה","פעילות","הצג הכול","נותרו 282 מפתחות גיבוב","נשלח למאיה","התקבל"],1],
["fa","فارسی",["در این گاوصندوق","ارسال","دریافت","مبادله","چرخش","فعالیت","مشاهده همه","۲۸۲ کلید هش باقی مانده","ارسال به مایا","دریافت شد"],1],
["ur","اردو",["اس والٹ میں","بھیجیں","وصول کریں","تبادلہ","تبدیل","سرگرمی","سب دیکھیں","282 ہیش کیز باقی","مایا کو بھیجا","موصول"],1],
["hi","हिन्दी",["इस तिजोरी में","भेजें","प्राप्त करें","बदलें","रोटेट","गतिविधि","सब देखें","282 हैश कुंजियाँ बाकी","माया को भेजा","प्राप्त"]],
["bn","বাংলা",["এই ভল্টে","পাঠান","গ্রহণ","বিনিময়","ঘোরান","কার্যকলাপ","সব দেখুন","২৮২টি হ্যাশ কী বাকি","মায়াকে পাঠানো","প্রাপ্ত"]],
["ta","தமிழ்",["இந்த பெட்டகத்தில்","அனுப்பு","பெறு","மாற்று","சுழற்று","செயல்பாடு","அனைத்தும்","282 ஹாஷ் விசைகள் மீதம்","மாயாவுக்கு அனுப்பியது","பெறப்பட்டது"]],
["th","ไทย",["ในห้องนิรภัยนี้","ส่ง","รับ","แลก","หมุนเวียน","กิจกรรม","ดูทั้งหมด","เหลือแฮชคีย์ 282 ดอก","ส่งให้ Maya","ได้รับ"]],
["vi","Tiếng Việt",["Trong két này","Gửi","Nhận","Hoán đổi","Xoay vòng","Hoạt động","Xem tất cả","Còn 282 khóa băm","Đã gửi Maya","Đã nhận"]],
["ru","Русский",["В этом хранилище","Отправить","Получить","Обмен","Сменить","Активность","Все","Осталось 282 хеш-ключа","Отправлено Maya","Получено"]],
["uk","Українська",["У цьому сховищі","Надіслати","Отримати","Обмін","Змінити","Активність","Усі","Лишилось 282 хеш-ключі","Надіслано Maya","Отримано"]],
["de","Deutsch",["In diesem Tresor","Senden","Empfangen","Tauschen","Erneuern","Aktivität","Alle anzeigen","Noch 282 Hash-Schlüssel","An Maya gesendet","Empfangen"]],
["fr","Français",["Dans ce coffre","Envoyer","Recevoir","Échanger","Renouveler","Activité","Tout voir","Il reste 282 clés de hachage","Envoyé à Maya","Reçu"]],
["es","Español",["En esta bóveda","Enviar","Recibir","Cambiar","Rotar","Actividad","Ver todo","Quedan 282 claves hash","Enviado a Maya","Recibido"]],
["pt","Português",["Neste cofre","Enviar","Receber","Trocar","Renovar","Atividade","Ver tudo","Restam 282 chaves hash","Enviado para Maya","Recebido"]],
["tr","Türkçe",["Bu kasada","Gönder","Al","Takas","Yenile","Etkinlik","Tümü","282 hash anahtarı kaldı","Maya'ya gönderildi","Alındı"]],
["pl","Polski",["W tym sejfie","Wyślij","Odbierz","Wymień","Odnów","Aktywność","Wszystko","Zostało 282 kluczy haszujących","Wysłano do Maya","Odebrano"]],
["sw","Kiswahili",["Katika hazina hii","Tuma","Pokea","Badilisha","Zungusha","Shughuli","Ona zote","Funguo 282 za hash zimebaki","Imetumwa kwa Maya","Imepokelewa"]],
["jv","Basa Jawa",["Ing brankas iki","Kirim","Tampa","Ijol","Ganti","Kegiatan","Deleng kabeh","Kari 282 kunci hash","Dikirim menyang Maya","Ditampa"]],
["ms","Bahasa Melayu",["Dalam peti besi ini","Hantar","Terima","Tukar","Putar","Aktiviti","Lihat semua","Tinggal 282 kunci hash","Dihantar kepada Maya","Diterima"]],
["tl","Filipino",["Sa vault na ito","Ipadala","Tanggapin","Palitan","I-rotate","Aktibidad","Tingnan lahat","282 hash key ang natitira","Ipinadala kay Maya","Natanggap"]],
["am","አማርኛ",["በዚህ ካዝና","ላክ","ተቀበል","ቀይር","አዙር","እንቅስቃሴ","ሁሉንም እይ","282 የሃሽ ቁልፎች ቀርተዋል","ለማያ ተልኳል","ተቀብሏል"]],
["ka","ქართული",["ამ სეიფში","გაგზავნა","მიღება","გაცვლა","როტაცია","აქტივობა","ყველა","დარჩა 282 ჰეშ-გასაღები","გაეგზავნა მაიას","მიღებულია"]],
["my","မြန်မာ",["ဤမုတ်ဆိပ်တွင်","ပို့ရန်","လက်ခံ","လဲလှယ်","လှည့်","လုပ်ဆောင်ချက်","အားလုံး","hash key 282 ခု ကျန်","Maya ထံ ပို့ပြီး","လက်ခံပြီး"]],
];
const nx=w=>{const x=X;X+=w+60;return x};
LANGS.forEach(([code,name,t,rtl])=>{const fam=FONT[code]||"IBM Plex Sans";const tt=(p,c,o={})=>T(p,c,{...o,x:{...(o.x||{}),...(o.mono?{}:{fontFamily:fam}),...(rtl&&o.wrap?{textAlign:"right"}:{})}});
const s=Screen("Language · "+code+" · "+name,390,844,nx(390),Y);Status(s);
const h=H(s,"Header",{gap:10,padding:[12,20]});const hk=[()=>{const lg=Fr(h,"Logo",{width:28,height:28,cornerRadius:14,fill:"$accent"})},()=>tt(h,"Quantum Safe",{name:"Title",s:17,w:"600"}),()=>Sp(h),()=>{const pl=Fr(h,"Lang pill",{cornerRadius:4,stroke:"$accent",strokeWidth:1,padding:[3,8]});T(pl,code.toUpperCase()+(rtl?" · RTL":""),{name:"Code",mono:true,s:10,w:"600",f:"$accent"})}];(rtl?hk.reverse():hk).forEach(f=>f());
const b=V(s,"Body",{gap:16,padding:[8,20,0,20],height:"fill_container",alignItems:rtl?"end":"start"});
tt(b,t[0],{name:"Balance label",s:12,f:"$muted"});const ar=H(b,"Amount row",{gap:8,alignItems:"end",justifyContent:rtl?"end":"start"});T(ar,"1,284,000",{name:"Amount",mono:true,s:38,w:"600"});T(ar,"QC",{name:"Unit",mono:true,s:14,f:"$muted"});
const q=Fr(b,"Quick actions",{width:"fill_container",gap:8});const acts=[["arrow-up-right",t[1]],["arrow-down-left",t[2]],["repeat",t[3]],["refresh-cw",t[4]]];(rtl?acts.reverse():acts).forEach(([i,l])=>{const c=Fr(q,"Action · "+l,{layout:"vertical",width:"fill_container",gap:6,alignItems:"center",padding:[12,4],cornerRadius:12,fill:"$surface"});I(c,i,{s:18,f:"$accent"});tt(c,l,{name:"Label",s:12})});
const bn=H(b,"Banner",{gap:10,padding:12,cornerRadius:12,stroke:"$warn",strokeWidth:1,justifyContent:rtl?"end":"start"});const bk=[()=>I(bn,"key",{s:16,f:"$warn"}),()=>tt(bn,t[7],{name:"Text",s:13,f:"$warn"})];(rtl?bk.reverse():bk).forEach(f=>f());
const sh=H(b,"Section header",{gap:8});const sk=[()=>tt(sh,t[5],{name:"Title",s:15,w:"600"}),()=>Sp(sh),()=>tt(sh,t[6],{name:"Link",s:13,f:"$accent"})];(rtl?sk.reverse():sk).forEach(f=>f());
for(const[i,l,a,c]of[["arrow-up-right",t[8],"−40,000","$text"],["arrow-down-left",t[9],"+2,000","$ok"],["arrow-down-left",t[9],"+1,000,000","$ok"]]){const r=H(b,"Row",{gap:12,padding:[12,0],stroke:"$line",strokeWidth:{bottom:1}});const parts=[()=>I(r,i,{f:"$muted"}),()=>{const tv=V(r,"Text",{gap:2,alignItems:rtl?"end":"start"});tt(tv,l,{name:"Title"})},()=>T(r,a,{name:"Amount",mono:true,s:13,f:c})];(rtl?parts.reverse():parts).forEach(f=>f())}
const tb=H(s,"Tab bar",{stroke:"$line",strokeWidth:{top:1},padding:[10,0,28,0],justifyContent:"space_around"});const tabs=[["shield","QC"],["send",t[1]],["history",t[5]],["settings","⚙"]];(rtl?tabs.reverse():tabs).forEach(([i,l],k)=>{const c=Fr(tb,"Tab",{layout:"vertical",gap:4,alignItems:"center"});I(c,i,{s:20,f:k==(rtl?3:0)?"$accent":"$muted"});tt(c,l,{name:"Label",s:11,f:"$muted"})});
Update(s,{placeholder:false});out.push(s)});

// FULL LANGUAGE PICKER: every supported language in native script
const ALL=["Afrikaans","Shqip","አማርኛ","العربية","Հայերեն","অসমীয়া","Aymar aru","Azərbaycan","Bamanankan","Euskara","Беларуская","বাংলা","भोजपुरी","Bosanski","Български","Català","Cebuano","chiCheŵa","简体中文","繁體中文","Corsu","Hrvatski","Čeština","Dansk","ދިވެހި","डोगरी","Nederlands","English","Esperanto","Eesti","Eʋegbe","Filipino","Suomi","Français","Frysk","Galego","ქართული","Deutsch","Ελληνικά","Avañe'ẽ","ગુજરાતી","Kreyòl ayisyen","Hausa","ʻŌlelo Hawaiʻi","עברית","हिन्दी","Hmoob","Magyar","Íslenska","Igbo","Ilokano","Bahasa Indonesia","Gaeilge","Italiano","日本語","Basa Jawa","ಕನ್ನಡ","Қазақ","ខ្មែរ","Kinyarwanda","कोंकणी","한국어","Krio","Kurdî","کوردی","Кыргызча","ລາວ","Latina","Latviešu","Lingála","Lietuvių","Luganda","Lëtzebuergesch","Македонски","मैथिली","Malagasy","Bahasa Melayu","മലയാളം","Malti","Māori","मराठी","ꯃꯤꯇꯩꯂꯣꯟ","Mizo ṭawng","Монгол","မြန်မာ","नेपाली","Norsk","ଓଡ଼ିଆ","Afaan Oromoo","پښتو","فارسی","Polski","Português (Brasil)","Português (Portugal)","ਪੰਜਾਬੀ","Runa Simi","Română","Русский","Gagana Samoa","संस्कृतम्","Gàidhlig","Sepedi","Српски","Sesotho","chiShona","سنڌي","සිංහල","Slovenčina","Slovenščina","Soomaali","Español","Español (Latinoamérica)","Basa Sunda","Kiswahili","Svenska","Тоҷикӣ","தமிழ்","Татар","తెలుగు","ไทย","ትግርኛ","Xitsonga","Türkçe","Türkmen","Twi","Українська","اردو","ئۇيغۇرچە","Oʻzbek","Tiếng Việt","Cymraeg","isiXhosa","ייִדיש","Yorùbá","isiZulu","Basa Bali","Basa Bugis","Basa Minang","Bahasa Makassar","Basa Batak Toba","Acèh","Sasak","Madhurâ"];
const pk=Screen("Settings · language · all "+ALL.length,390,844,nx(390),Y);Status(pk);Head(pk,"Language",{back:true});
const pb=V(pk,"Body",{gap:0,padding:[0,20,20,20]});const se=H(pb,"Search",{height:44,padding:[0,12],cornerRadius:10,fill:"$surface",gap:8});I(se,"search",{s:16});T(se,"Search "+ALL.length+" languages",{name:"Placeholder",f:"$muted"});
T(pb,"SUGGESTED",{name:"Group",s:11,w:"600",f:"$muted",x:{letterSpacing:1}});
["English","Bahasa Indonesia","Basa Jawa"].forEach((l,i)=>{const r=H(pb,"Lang · "+l,{gap:10,padding:[12,0],stroke:"$line",strokeWidth:{bottom:1}});T(r,l,{name:"Native"});Sp(r);if(i==0)I(r,"check",{f:"$accent"})});
let last="";ALL.slice().sort((a,b)=>a.localeCompare(b)).forEach(l=>{const L=l[0].toUpperCase();if(/[A-Z]/.test(L)&&L!==last){last=L;T(pb,L,{name:"Letter "+L,s:11,w:"600",f:"$accent",mono:true})}const r=H(pb,"Lang · "+l,{gap:10,padding:[10,0],stroke:"$line",strokeWidth:{bottom:1}});T(r,l,{name:"Native",s:14});Sp(r)});
Update(pk,{placeholder:false,height:"fit_content"});out.push(pk);
Print("IDS",out.join(","));Print("N",ALL.length);
