import { useCallback, useEffect, useMemo, useState } from "react";
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { PROGRAM_ID, QC_DECIMALS, QC_MINT, explorerAddr } from "@app/config";
import { VaultRecord, backupJson, createVault, getVault, importRecord, listVaults, openVault, parseBackup, putVault } from "@app/store";
import { FlowCtx, balanceOf, markSpent, sweepRent, withdraw } from "@app/flow";
import { formatAmount, parseAmount, rentCollector, tokenAccountOf } from "@app/vault";
import { OwnerRecord, createOwner, getOwner, importOwner, parseOwnerBackup, unsealOwner } from "./owner";
import { RPC_KEY, connect, pickRpc, sendSigned } from "./rpc";
import { flush, syncStorage } from "./storage";
import { qcBalance } from "./lookup";

const TRANSPARENCY = "https://quantcoin-pi.vercel.app/transparency/";
const group = (s: string) => { const [i, f] = s.split("."); return i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f ? "." + f : ""); };
const fmt = (v: bigint | null | undefined) => (v == null ? "-" : group(formatAmount(v, QC_DECIMALS)));

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function downloadBackup(r: VaultRecord) {
  download(`quantum-safe-vault-${r.id.slice(0, 8)}.json`, backupJson(r));
  putVault({ ...getVault(r.id)!, backedUp: true });
}

export default function App() {
  const [rpc, setRpc] = useState<string>("");
  const [rpcErr, setRpcErr] = useState("");
  const [customRpc, setCustomRpc] = useState(syncStorage.getItem(RPC_KEY) ?? "");
  const conn = useMemo<Connection | null>(() => (rpc ? connect(rpc) : null), [rpc]);
  const [owner, setOwner] = useState<OwnerRecord | null>(getOwner());
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [vaults, setVaults] = useState<VaultRecord[]>([]);
  const [balances, setBalances] = useState<Record<string, bigint | null>>({});
  const [ownerSol, setOwnerSol] = useState<number | null>(null);
  const [lookup, setLookup] = useState("");
  const [lookupRes, setLookupRes] = useState<{ tokenAccount: string; amount: bigint | null } | null>(null);
  const [paste, setPaste] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const say = useCallback((m: string) => setLog((l) => [...l, `${new Date().toLocaleTimeString()}  ${m}`]), []);
  const ownerPk = owner ? new PublicKey(owner.pubkey) : null;

  useEffect(() => {
    setRpcErr("");
    pickRpc(customRpc || null).then(setRpc, (e) => { setRpc(""); setRpcErr((e as Error).message); });
  }, [customRpc]);

  const reload = useCallback(() => setVaults(owner ? listVaults().filter((v) => v.owner === owner.pubkey) : []), [owner]);

  const refresh = useCallback(async () => {
    reload();
    if (!owner || !conn) return;
    const out: Record<string, bigint | null> = {};
    await Promise.all(listVaults().filter((v) => v.owner === owner.pubkey).map(async (v) => {
      out[v.id] = await balanceOf(conn, new PublicKey(v.ata)).catch(() => null);
      if (out[v.id] === null && v.signed && v.status !== "spent") markSpent(v.id);
    }));
    setBalances(out);
    setOwnerSol(await conn.getBalance(new PublicKey(owner.pubkey), "confirmed").catch(() => null));
    reload();
  }, [conn, owner, reload]);

  useEffect(() => { refresh(); }, [refresh]);

  async function run(fn: () => Promise<void>) {
    setErr(""); setBusy(true);
    try { await fn(); await flush(); } catch (e) { const m = (e as Error).message; setErr(m); say(`Error: ${m}`); }
    finally { setBusy(false); refresh(); }
  }

  const needPw = () => { if (password.length < 10) throw new Error("password must be at least 10 characters"); };
  const needNew = () => { needPw(); if (password !== confirm) throw new Error("passwords do not match"); };

  function ctx(kp: Keypair): FlowCtx {
    if (!conn) throw new Error("no RPC");
    // Persist (incl. the signed digest) before anything is broadcast.
    const send = async (ixs: TransactionInstruction[], label: string) => {
      await flush();
      const sig = await sendSigned(conn, ixs, kp, label);
      say(`${label}: ${sig}`);
      return sig;
    };
    const sendAs = async (ixs: TransactionInstruction[], signer: Keypair, label: string) => {
      await flush();
      const sig = await sendSigned(conn, ixs, signer, label);
      say(`${label}: ${sig}`);
      return sig;
    };
    return {
      conn, program: PROGRAM_ID, mint: QC_MINT, owner: kp.publicKey, send, sendAs,
      backup: async (r) => { downloadBackup(r); await flush(); say(`Backup of next vault ${r.id} downloaded.`); },
      log: say,
    };
  }

  const onLookup = () => run(async () => {
    if (!conn) throw new Error(rpcErr || "no RPC");
    setLookupRes(null);
    setLookupRes(await qcBalance(conn, lookup));
  });

  const onCreateOwner = () => run(async () => {
    needNew();
    say("Sealing new owner key (PBKDF2 600k)...");
    const r = await createOwner(password);
    setOwner(r);
    download(`quantum-safe-owner-${r.pubkey.slice(0, 8)}.json`, JSON.stringify(r, null, 1));
    say(`Owner ${r.pubkey} created; encrypted backup downloaded.`);
  });

  const onImportText = (text: string) => run(async () => {
    needPw();
    const j = JSON.parse(text);
    if (j?.format === "quantum-safe-owner/1") {
      const r = parseOwnerBackup(text);
      await importOwner(r, password);
      setOwner(r);
      say(`Imported owner ${r.pubkey}.`);
    } else {
      const r = parseBackup(text);
      await openVault(r, password);
      importRecord(r);
      if (owner && r.owner !== owner.pubkey) say(`Note: vault ${r.id} belongs to owner ${r.owner}.`);
      say(`Imported vault ${r.id}.`);
    }
    setPaste("");
  });

  const onCreateVault = () => run(async () => {
    needNew();
    if (!ownerPk) throw new Error("create or import an owner key first");
    say("Encrypting new vault (PBKDF2 600k)...");
    const { record } = await createVault(PROGRAM_ID, QC_MINT, ownerPk, password);
    downloadBackup(record);
    say(`Vault ${record.id} created; encrypted backup downloaded.`);
  });

  const onWithdraw = (r: VaultRecord, amt: string) => run(async () => {
    needPw();
    if (!owner) throw new Error("no owner key");
    const kp = await unsealOwner(owner, password);
    const a = r.pending ? BigInt(r.pending.amount) : parseAmount(amt, QC_DECIMALS);
    if (a <= 0n) throw new Error("amount must be positive");
    const res = await withdraw(ctx(kp), r, a, password);
    say(`Done. Remainder is in new vault ${res.next.id}.`);
  });

  const onSweep = (r: VaultRecord) => run(async () => {
    needPw();
    const kp = await unsealOwner(owner!, password);
    const { secret } = await openVault(r, password);
    await sweepRent(ctx(kp), rentCollector(secret));
  });

  const saveRpc = (v: string) => { syncStorage.setItem(RPC_KEY, v); setCustomRpc(v); };
  const active = vaults.filter((v) => v.status === "active");
  const spent = vaults.filter((v) => v.status === "spent");

  return (
    <main>
      <header>
        <div className="brand"><img src="logo.svg" alt="" /><h1>Quantum Safe</h1><span className="tag">MAINNET</span></div>
        <a className="muted" href="popup.html?tab=1" target="_blank">Open in tab</a>
      </header>
      <p className="muted" data-testid="rpc">RPC: {rpc || (rpcErr ? `unavailable - ${rpcErr}` : "connecting...")}</p>

      <section>
        <h2>Check a balance (read-only)</h2>
        <div className="row">
          <input data-testid="lookup" placeholder="Wallet, vault or QC token account" value={lookup} onChange={(e) => setLookup(e.target.value)} />
          <button data-testid="lookup-go" disabled={busy || !lookup || !conn} onClick={onLookup}>Check</button>
        </div>
        {lookupRes && <div className="kv">
          <span className="muted">QC</span><span className="bal" data-testid="lookup-amount">{lookupRes.amount == null ? "no QC account" : fmt(lookupRes.amount)}</span>
          <span className="muted">Token acct</span><a className="mono" href={explorerAddr(lookupRes.tokenAccount)} target="_blank">{lookupRes.tokenAccount}</a>
        </div>}
        <p className="muted"><a href={TRANSPARENCY} target="_blank">Supply transparency</a> - <a href={explorerAddr(QC_MINT.toBase58())} target="_blank">QC mint on explorer</a></p>
      </section>

      <section className="warn">
        <ul>
          <li><b>Lose the password or the backup files and the QC is locked forever.</b></li>
          <li>Each vault key signs exactly one withdrawal; the rest moves to a new vault. Back up every new file.</li>
          <li>Vaults are owned by this extension's own owner key (wallet extensions cannot sign inside a popup). It also pays fees: send it a little SOL.</li>
        </ul>
      </section>

      <section>
        <label>Password (never stored; min 10 chars)</label>
        <input data-testid="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        <label>Repeat (for new keys and vaults)</label>
        <input data-testid="pw2" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        {!owner ? <div className="row"><button data-testid="create-owner" disabled={busy} onClick={onCreateOwner}>Create owner key</button></div> : <>
          <div className="kv">
            <span className="muted">Owner</span><a className="mono" data-testid="owner" href={explorerAddr(owner.pubkey)} target="_blank">{owner.pubkey}</a>
            <span className="muted">SOL</span><span>{ownerSol == null ? "-" : (ownerSol / 1e9).toFixed(6)}</span>
          </div>
          <div className="row">
            <button data-testid="create-vault" disabled={busy} onClick={onCreateVault}>Create vault</button>
            <button className="ghost" disabled={busy} onClick={() => download(`quantum-safe-owner-${owner.pubkey.slice(0, 8)}.json`, JSON.stringify(owner, null, 1))}>Export owner backup</button>
            <button className="ghost" disabled={busy} onClick={() => refresh()}>Refresh</button>
          </div>
        </>}
        <label>Import a backup (owner or vault): paste JSON or pick a file</label>
        <textarea data-testid="paste" value={paste} onChange={(e) => setPaste(e.target.value)} />
        <div className="row">
          <button data-testid="import" className="ghost" disabled={busy || !paste} onClick={() => onImportText(paste)}>Import pasted</button>
          <input type="file" accept="application/json,.json" disabled={busy}
            onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onImportText(await f.text()); }} />
        </div>
        {err && <p className="err" data-testid="err">{err}</p>}
      </section>

      {owner && <>
        <h2>Vaults</h2>
        {active.length === 0 && <p className="muted">No active vaults.</p>}
        {active.map((v) => <VaultCard key={v.id} v={v} bal={balances[v.id]} busy={busy}
          onWithdraw={onWithdraw} onBackup={() => { downloadBackup(v); flush().then(reload); }} />)}
        {spent.length > 0 && <details>
          <summary className="muted">Spent vaults ({spent.length}) - never send funds here</summary>
          {spent.map((v) => <div key={v.id} className="card spent" data-testid="spent-vault">
            <div className="mono">vault {v.id.slice(0, 6)}...{v.id.slice(-6)}</div>
            <button className="ghost" disabled={busy} onClick={() => onSweep(v)}>Return leftover rent</button>
          </div>)}
        </details>}
      </>}

      <section>
        <label>Custom RPC (blank = public mainnet, then the site proxy)</label>
        <div className="row">
          <input data-testid="rpc-input" defaultValue={customRpc} id="rpcIn" placeholder="https://..." />
          <button data-testid="rpc-save" className="ghost" onClick={() => saveRpc((document.getElementById("rpcIn") as HTMLInputElement).value.trim())}>Save</button>
        </div>
      </section>

      {log.length > 0 && <section><pre className="log" data-testid="log">{log.join("\n")}</pre></section>}
      <p className="muted">Program <a href={explorerAddr(PROGRAM_ID.toBase58())} target="_blank">{PROGRAM_ID.toBase58().slice(0, 8)}...</a> - wallet QC ATA {owner ? tokenAccountOf(QC_MINT, new PublicKey(owner.pubkey)).toBase58().slice(0, 8) + "..." : "-"}</p>
    </main>
  );
}

function VaultCard({ v, bal, busy, onWithdraw, onBackup }: {
  v: VaultRecord; bal: bigint | null | undefined; busy: boolean;
  onWithdraw: (v: VaultRecord, a: string) => void; onBackup: () => void;
}) {
  const [wd, setWd] = useState("");
  return (
    <div className="card" data-testid="vault">
      <div className="bal" data-testid="vault-bal">{bal == null ? "0" : fmt(bal)} QC</div>
      {!v.backedUp ? <>
        <p className="err">Backup not saved. Do not deposit until you save it.</p>
        <button onClick={onBackup}>Download backup</button>
      </> : <>
        <div className="kv">
          <span className="muted">Vault</span><a className="mono" data-testid="vault-id" href={explorerAddr(v.id)} target="_blank">{v.id}</a>
          <span className="muted">Deposit to</span><span className="mono" data-testid="vault-ata">{v.ata}</span>
        </div>
        {v.pending ? <>
          <p className="muted">Already signed a withdrawal of {fmt(BigInt(v.pending.amount))} QC; only that exact one can be retried.</p>
          <button disabled={busy} onClick={() => onWithdraw(v, "")}>Retry signed withdrawal</button>
        </> : <div className="row">
          <input data-testid="wd-amount" placeholder="Withdraw amount (QC)" inputMode="decimal" value={wd} onChange={(e) => setWd(e.target.value)} />
          <button data-testid="wd-go" className="ghost" disabled={busy || !wd || !bal} onClick={() => onWithdraw(v, wd)}>Withdraw</button>
        </div>}
        <button className="ghost" onClick={onBackup}>Download backup again</button>
      </>}
      {v.signed && <p className="muted mono">signed digest {v.signed}</p>}
    </div>
  );
}
