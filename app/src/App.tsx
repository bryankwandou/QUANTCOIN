import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { PROGRAM_ID, QC_DECIMALS, QC_MINT, explorerAddr } from "./lib/config";
import { VaultRecord, backupJson, createVault, getVault, importRecord, listVaults, openVault, parseBackup, putVault } from "./lib/store";
import { FlowCtx, balanceOf, markSpent, sweepRent, withdraw } from "./lib/flow";
import { depositIxs, formatAmount, parseAmount, rentCollector, tokenAccountOf } from "./lib/vault";

function downloadBackup(r: VaultRecord) {
  const url = URL.createObjectURL(new Blob([backupJson(r)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `quantum-safe-vault-${r.id.slice(0, 8)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  putVault({ ...getVault(r.id)!, backedUp: true });
}

const fmt = (v: bigint | null | undefined) => (v == null ? "-" : formatAmount(v, QC_DECIMALS));

export default function App() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const owner = wallet.publicKey;
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [vaults, setVaults] = useState<VaultRecord[]>([]);
  const [balances, setBalances] = useState<Record<string, bigint | null>>({});
  const [walletQc, setWalletQc] = useState<bigint | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const say = useCallback((m: string) => setLog((l) => [...l, `${new Date().toLocaleTimeString()}  ${m}`]), []);
  const reload = useCallback(() => setVaults(owner ? listVaults().filter((v) => v.owner === owner.toBase58()) : []), [owner]);

  const refresh = useCallback(async () => {
    reload();
    if (!owner) return;
    const mine = listVaults().filter((v) => v.owner === owner.toBase58());
    const out: Record<string, bigint | null> = {};
    await Promise.all(mine.map(async (v) => {
      out[v.id] = await balanceOf(connection, new PublicKey(v.ata)).catch(() => null);
      // A signed vault whose token account is gone has been spent on-chain.
      if (out[v.id] === null && v.signed && v.status !== "spent") markSpent(v.id);
    }));
    setBalances(out);
    setWalletQc(await balanceOf(connection, tokenAccountOf(QC_MINT, owner)).catch(() => null));
    reload();
  }, [connection, owner, reload]);

  useEffect(() => { refresh(); }, [refresh]);

  async function send(ixs: TransactionInstruction[], label: string) {
    if (!owner) throw new Error("connect a wallet");
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight }).add(...ixs);
    const sig = await wallet.sendTransaction(tx, connection, { skipPreflight: false });
    say(`${label}: sent ${sig}`);
    const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(`${label} failed: ${JSON.stringify(res.value.err)}`);
    return sig;
  }

  async function sendAs(ixs: TransactionInstruction[], signer: Keypair, label: string) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: signer.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
    tx.sign(signer);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    say(`${label}: ${sig}`);
    return sig;
  }

  const ctx = (): FlowCtx => ({
    conn: connection, program: PROGRAM_ID, mint: QC_MINT, owner: owner!, send, sendAs,
    backup: async (r) => { downloadBackup(r); say(`Backup of next vault ${r.id} downloaded. Keep it with the others.`); },
    log: say,
  });

  async function run(fn: () => Promise<void>) {
    setErr(""); setBusy(true);
    try { await fn(); } catch (e) { const m = (e as Error).message; setErr(m); say(`Error: ${m}`); }
    finally { setBusy(false); refresh(); }
  }

  const onCreate = () => run(async () => {
    if (password !== confirm) throw new Error("passwords do not match");
    say("Encrypting new vault (PBKDF2 600k iterations)...");
    const { record } = await createVault(PROGRAM_ID, QC_MINT, owner!, password);
    downloadBackup(record);
    say(`Vault ${record.id} created; encrypted backup downloaded.`);
  });

  const onDeposit = (r: VaultRecord, amt: string) => run(async () => {
    if (!r.backedUp || r.status !== "active") throw new Error("this vault cannot receive funds");
    const a = parseAmount(amt, QC_DECIMALS);
    if (a <= 0n) throw new Error("amount must be positive");
    const sig = await send(depositIxs(QC_MINT, QC_DECIMALS, owner!, new PublicKey(r.id), a), "deposit");
    say(`Deposited ${fmt(a)} QC: ${sig}`);
  });

  const onWithdraw = (r: VaultRecord, amt: string) => run(async () => {
    const a = r.pending ? BigInt(r.pending.amount) : parseAmount(amt, QC_DECIMALS);
    const res = await withdraw(ctx(), r, a, password);
    say(`Done. Remainder is in new vault ${res.next.id}.`);
  });

  const onSweep = (r: VaultRecord) => run(async () => {
    const { secret } = await openVault(r, password);
    await sweepRent(ctx(), rentCollector(secret));
  });

  const onImport = (file: File) => run(async () => {
    const r = parseBackup(await file.text());
    await openVault(r, password);            // proves the password and that secrets match the address
    if (owner && r.owner !== owner.toBase58()) say(`Note: this vault belongs to wallet ${r.owner}; connect it to see the vault.`);
    importRecord(r);
    say(`Imported vault ${r.id}.`);
  });

  const active = vaults.filter((v) => v.status === "active");
  const spent = vaults.filter((v) => v.status === "spent");

  return (
    <main>
      <header>
        <div className="brand"><img src="/logo.svg" alt="" /><h1>Quantum Safe</h1><span className="tag">DEVNET</span></div>
        <WalletMultiButton />
      </header>

      <section className="warn">
        <h2>Read this first</h2>
        <ul>
          <li><b>Losing your password or backup file means the QC in that vault is locked forever.</b> Nobody can recover it.</li>
          <li>Only QC held <b>inside a vault</b> is quantum-resistant. QC in a normal wallet account is not.</li>
          <li>Each vault key signs exactly one withdrawal. Every withdrawal empties the vault and moves the rest into a new vault; back up every new file.</li>
          <li>Spending also needs the connected wallet (the vault owner). Keep that wallet too.</li>
        </ul>
      </section>

      {!owner ? <section>Connect Phantom or Solflare (devnet) to start.</section> : <>
        <section>
          <h2>Wallet</h2>
          <div className="kv"><span className="muted">Owner</span><span className="mono">{owner.toBase58()}</span>
            <span className="muted">QC balance</span><span>{fmt(walletQc)} QC</span></div>
          <label>Vault password (used for create, withdraw and import; never stored)</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          <label>Repeat password (for new vaults)</label>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          <div className="row">
            <button disabled={busy || password.length < 10} onClick={onCreate}>Create vault</button>
            <label className="ghost-file">
              <input type="file" accept="application/json,.json" style={{ display: "none" }} disabled={busy || !password}
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onImport(f); }} />
              <span role="button" className="muted" style={{ textDecoration: "underline", cursor: "pointer" }}>Import backup file</span>
            </label>
            <button className="ghost" disabled={busy} onClick={() => refresh()}>Refresh</button>
          </div>
          {password && password.length < 10 && <p className="muted">Use at least 10 characters.</p>}
          {err && <p className="err">{err}</p>}
        </section>

        <h2>Vaults</h2>
        {active.length === 0 && <p className="muted">No active vaults for this wallet.</p>}
        {active.map((v) => <VaultCard key={v.id} v={v} bal={balances[v.id]} busy={busy} hasPw={password.length > 0}
          onDeposit={onDeposit} onWithdraw={onWithdraw} onBackup={() => { downloadBackup(v); reload(); }} />)}

        {spent.length > 0 && <details>
          <summary className="muted">Spent vaults ({spent.length}) - never send funds here</summary>
          {spent.map((v) => <div key={v.id} className="card spent">
            <div className="muted">SPENT - do not deposit</div>
            <div className="mono">vault {v.id.slice(0, 6)}...{v.id.slice(-6)}</div>
            <div className="row">
              <button className="ghost" disabled={busy || !password} onClick={() => onSweep(v)}>Return leftover rent</button>
            </div>
          </div>)}
        </details>}
      </>}

      {log.length > 0 && <section><h2>Activity</h2><pre className="log">{log.join("\n")}</pre></section>}
      <p className="muted">Program <a href={explorerAddr(PROGRAM_ID.toBase58())}>{PROGRAM_ID.toBase58()}</a> - mint <a href={explorerAddr(QC_MINT.toBase58())}>{QC_MINT.toBase58()}</a></p>
    </main>
  );
}

function VaultCard({ v, bal, busy, hasPw, onDeposit, onWithdraw, onBackup }: {
  v: VaultRecord; bal: bigint | null | undefined; busy: boolean; hasPw: boolean;
  onDeposit: (v: VaultRecord, a: string) => void; onWithdraw: (v: VaultRecord, a: string) => void; onBackup: () => void;
}) {
  const [dep, setDep] = useState("");
  const [wd, setWd] = useState("");
  return (
    <div className="card">
      <div className="bal">{bal == null ? "0" : fmt(bal)} QC</div>
      {!v.backedUp ? <>
        <p className="err">Backup not downloaded. This vault cannot receive funds until you save its backup file.</p>
        <button onClick={onBackup}>Download backup</button>
      </> : <>
        <div className="kv">
          <span className="muted">Vault (PDA)</span><a className="mono" href={explorerAddr(v.id)}>{v.id}</a>
          <span className="muted">Deposit address (QC token account)</span><span className="mono">{v.ata}</span>
        </div>
        {v.pending ? <>
          <p className="muted">This vault already signed a withdrawal of {fmt(BigInt(v.pending.amount))} QC. Only that exact withdrawal can be retried.</p>
          <div className="row"><button disabled={busy || !hasPw} onClick={() => onWithdraw(v, "")}>Retry signed withdrawal</button></div>
        </> : <>
          <div className="row">
            <input placeholder="Deposit amount (QC)" inputMode="decimal" value={dep} onChange={(e) => setDep(e.target.value)} />
            <button disabled={busy || !dep} onClick={() => onDeposit(v, dep)}>Deposit</button>
          </div>
          <div className="row">
            <input placeholder="Withdraw amount (QC)" inputMode="decimal" value={wd} onChange={(e) => setWd(e.target.value)} />
            <button className="ghost" disabled={busy || !wd || !hasPw || !bal} onClick={() => onWithdraw(v, wd)}>Withdraw</button>
          </div>
          <p className="muted">Withdraw sends the amount to your wallet and moves the rest into a new vault (a new backup file downloads first).</p>
        </>}
        <button className="ghost" onClick={onBackup}>Download backup again</button>
      </>}
      {v.signed && <p className="muted mono">signed digest {v.signed}</p>}
      <p className="muted"><a href={explorerAddr(v.ata)}>View token account on explorer</a></p>
    </div>
  );
}

