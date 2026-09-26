const th=(d,l)=>({type:"color",value:[{value:d,theme:{mode:"dark"}},{value:l,theme:{mode:"light"}}]});

Delete("FIpzS");const r={x:0,y:1860};

s=Screen("Mobile · settings",390,1400,r.x,r.y);
Status(s);Head(s,"Settings");
const b=V(s,"Body",{gap:22,padding:[8,20,24,20]});
const acc=H(b,"Account",{gap:12,padding:14,cornerRadius:12,fill:"$surface"});
Fr(acc,"Avatar",{width:44,height:44,cornerRadius:22,fill:{type:"gradient",gradientType:"linear",rotation:135,colors:[{color:"$blue",position:0},{color:"$accent",position:1}]}});
const at=V(acc,"t",{gap:2});T(at,"Bryan",{s:16,w:"600"});T(at,"7x8zcyKj…4vjLLh6 · 2 vaults",{mono:true,s:11,f:"$muted"});I(acc,"chevron-right",{s:16});
const sec=(title,rows)=>{const g=V(b,title,{gap:0});T(g,title.toUpperCase(),{s:11,w:"600",f:"$muted",x:{letterSpacing:1}});for(const x of rows)Row(g,...x);return g};
sec("Security",[["scan-face","Face ID / fingerprint","Unlock and approve sends","toggle"],["timer","Auto-lock","After 5 minutes",">"],["key-round","Hash key","1,023 one-time signatures left",">",{ic:"$accent"}],["file-key","Recovery phrase","Last viewed 12 Sep",">"],["plug","Connected sites","3 sites",">"]]);
sec("Network",[["globe","Network","Devnet",">"],["server","RPC endpoint","api.devnet.solana.com",">"],["gauge","Priority fee","Normal",">"]]);
sec("Display",[["sun-moon","Theme","System",">"],["languages","Language","English",">"],["badge-dollar-sign","Currency","USD",">"],["eye-off","Hide balances",null,"toggle-off"]]);
sec("Sound & haptics",[["volume-2","Sound effects","Key clicks, send chime","toggle"],["vibrate","Haptics","Tap, signed, confirmed","toggle"]]);
sec("Notifications",[["arrow-down-left","Incoming transfers",null,"toggle"],["shield-alert","Vault changes",null,"toggle"]]);
sec("About",[["file-check","Audit report","Internal · 12/12 pass",">"],["info","Version","0.4.0 · devnet",null]]);
const dz=V(b,"Danger zone",{gap:8,padding:14,cornerRadius:12,stroke:"$danger",strokeWidth:1});
T(dz,"Reset this device",{w:"600",f:"$danger"});T(dz,"Removes keys from this phone. Funds stay in the vault; you need the recovery phrase and hash-key backup to get back in.",{s:12,f:"$muted",wrap:true});
Tabs(s,"Settings");
Update(s,{placeholder:false,height:"fit_content(844)"});
Print("ID",s);
