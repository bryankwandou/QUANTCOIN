const steps=[["1 · Review","Review",0],["2 · Wallet key signed","Signing…",1],["3 · Hash key signed","Signing…",2],["4 · Sending","Sending…",3],["5 · Confirmed","Done",4]];
ids=[];
steps.forEach(([label,cta,st],i)=>{
 const s=Screen("Send · "+label,390,844,480+i*430,1860);ids.push(s);
 Status(s);Head(s,"Send",{back:true});
 const b=V(s,"Body",{gap:20,padding:[8,20,0,20],height:"fill_container"});
 if(st<4){
  const hero=V(b,"Amount",{gap:6,alignItems:"center",padding:[20,0]});
  const coin=Fr(hero,"Coin",{width:st===3?72:64,height:st===3?72:64,cornerRadius:40,fill:"$accent",justifyContent:"center",alignItems:"center",...(st===3?{effect:{type:"shadow",offset:{x:0,y:0},blur:28,color:"#2EE6D688"}}:{})});
  T(coin,"QC",{mono:true,s:20,w:"600",f:"$ink"});
  const ar=Fr(hero,"Row",{gap:6,alignItems:"end"});T(ar,"40,000",{mono:true,s:40,w:"600"});T(ar,"QC",{mono:true,s:16,f:"$muted"});
  T(hero,"≈ $1,240.00",{s:12,f:"$muted"});
  const to=H(b,"To",{gap:12,padding:14,cornerRadius:12,fill:"$surface"});
  Fr(to,"Avatar",{width:32,height:32,cornerRadius:16,fill:{type:"gradient",gradientType:"linear",rotation:135,colors:[{color:"$blue",position:0},{color:"$accent",position:1}]}});
  const tt=V(to,"t",{gap:2});T(tt,"Maya",{w:"500"});T(tt,"5XQw…7wqG",{mono:true,s:11,f:"$muted"});T(to,"fee 0.000005",{mono:true,s:11,f:"$muted"});
  const kr=Fr(b,"Keys",{width:"fill_container",gap:10});
  [["wallet","Wallet key","Ed25519","$accent",1],["key-round","Hash key","Winternitz","$blue",2]].forEach(([ic,n,alg,c,k])=>{
   const on=st>=k;const kc=V(kr,n,{gap:8,padding:14,cornerRadius:12,fill:"$surface",stroke:on?c:"$line",strokeWidth:on?2:1,...(on&&st===k?{effect:{type:"shadow",offset:{x:0,y:0},blur:18,color:(k==1?"#2EE6D6":"#5B8CFF")+"66"}}:{})});
   const top=H(kc,"top",{gap:8});I(top,ic,{f:on?c:"$muted"});Sp(top);if(on)I(top,"check",{s:16,f:c});
   T(kc,n,{w:"600"});T(kc,alg+" · "+(on?"signed":"waiting"),{s:11,f:on?c:"$muted"});});
  if(st===3){const w=V(b,"Progress",{gap:8});const tr=Fr(w,"Track",{width:"fill_container",height:4,cornerRadius:2,fill:"$line"});Fr(tr,"Fill",{width:210,height:4,cornerRadius:2,fill:"$accent"});T(w,"Broadcasting · slot 318,442,907",{mono:true,s:11,f:"$muted"});}
 } else {
  const d=V(b,"Done",{gap:14,alignItems:"center",padding:[60,0,0,0]});
  const ring=Fr(d,"Ring",{width:128,height:128,cornerRadius:64,stroke:"#3DD68C44",strokeWidth:2,justifyContent:"center",alignItems:"center"});
  const chk=Fr(ring,"Check",{width:88,height:88,cornerRadius:44,fill:"$ok",justifyContent:"center",alignItems:"center"});I(chk,"check",{s:44,f:"$ink"});
  T(d,"Sent to Maya",{s:22,w:"600"});T(d,"40,000 QC left the vault. Both keys signed; the hash key you used is now spent and 1,022 remain.",{s:13,f:"$muted",wrap:true,x:{textAlign:"center"}});
  const rc=V(b,"Receipt",{gap:0,padding:[6,16],cornerRadius:12,fill:"$surface"});
  for(const[k,v]of[["Amount","40,000 QC"],["Fee","0.000005 SOL"],["Slot","318,442,907"],["Time","25 Sep 2026 · 14:02"]]){const r=H(rc,k,{padding:[10,0],stroke:"$line",strokeWidth:{bottom:1}});T(r,k,{s:12,f:"$muted"});Sp(r);T(r,v,{mono:true,s:12});}
 }
 const f=V(s,"Footer",{gap:10,padding:[12,20,34,20]});
 if(st===4){Btn(f,"View on explorer",{ghost:true,icon:"external-link"});Btn(f,"Done")}
 else Btn(f,cta==="Review"?"Sign with both keys":cta,{icon:st===0?"pen-line":undefined,bg:st===0?"$accent":"$surface",fg:st===0?"$ink":"$text"});
 const cap=H(s,"Caption",{padding:[0,20,14,20]});T(cap,label,{mono:true,s:10,f:"$muted"});
 Update(s,{placeholder:false});
});
Print("IDS",ids.join(","));
