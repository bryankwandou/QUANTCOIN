const Y=5000;out=[];
{const s=Screen("Extension · side panel 400×800",400,800,0,Y);Head(s,"Quantum Safe");const b=V(s,"Body",{gap:20,padding:[8,20,0,20],height:"fill_container"});Bal(b,{s:36});Acts(b);Keys(b);Hist(b,3);const f=H(s,"Site",{gap:10,padding:[12,20],stroke:"$line",strokeWidth:{top:1}});Fr(f,"Dot",{width:8,height:8,cornerRadius:4,fill:"$ok"});T(f,"Connected to jup.ag",{s:12});Sp(f);T(f,"Disconnect",{s:12,f:"$accent"});Update(s,{placeholder:false});out.push(s)}
const desk=(name,w,x)=>{const s=Screen(name,w,1080,x,Y);Update(s,{layout:"horizontal"});Side(s,"full");
 const main=V(s,"Main",{height:"fill_container",gap:28,padding:[40,48],...(w>2000?{width:1360}:{})});
 const top=H(main,"Top",{gap:12});T(top,"Savings",{s:24,w:"600"});Sp(top);const sr=H(top,"Search",{gap:8,padding:[8,12],cornerRadius:8,stroke:"$line",strokeWidth:1,width:280});I(sr,"search",{s:16});T(sr,"Search address or tx",{s:13,f:"$muted"});
 const hero=Fr(main,"Hero",{width:"fill_container",gap:24,alignItems:"end"});Bal(hero,{s:60});const ac=Fr(hero,"Acts",{gap:10});Btn(ac,"Deposit",{ghost:true,icon:"arrow-down-to-line",wd:150,h:44});Btn(ac,"Send",{icon:"arrow-up-right",wd:150,h:44});
 const grid=Fr(main,"Stats",{width:"fill_container",gap:16});[["Hash keys left","1,023","of 1,024"],["Last send","−40,000","25 Sep · Maya"],["Vaults","3","1,650,000 QC total"],["Audit","12/12","internal checks pass"]].forEach(([a,b2,c])=>{const p=V(grid,a,{gap:6,padding:18,cornerRadius:12,fill:"$surface"});T(p,a,{s:12,f:"$muted"});T(p,b2,{mono:true,s:26,w:"600"});T(p,c,{s:12,f:"$muted"})});
 Hist(main,5);
 const act=V(s,"Activity column",{width:360,height:"fill_container",gap:16,padding:[40,24],stroke:"$line",strokeWidth:{left:1}});
 const k=Panel(act,"KEYS");Row(k,"wallet","Wallet key","Ed25519 · Phantom","OK",{ic:"$accent",rf:"$accent"});Row(k,"key-round","Hash key","Winternitz · 1,023 left","UNUSED",{ic:"$blue",rf:"$blue"});
 const n=Panel(act,"LIVE");[["Incoming 2,000 QC","from 3Fq…9aZ · pending"],["Vault #3 created","2 min ago"],["RPC switched","Helius devnet"]].forEach(([a,b2])=>Row(n,"dot",a,b2,null));
 const t=Panel(act,"TIP");T(t,"Losing either key alone loses nothing. Losing both does. Keep the hash-key backup somewhere other than this computer.",{s:13,f:"$muted",wrap:true});
 Update(s,{placeholder:false});out.push(s)};
desk("Desktop · 1920×1080",1920,480);
desk("Ultrawide · 2560×1080",2560,2480);
Print("IDS",out.join(","));
