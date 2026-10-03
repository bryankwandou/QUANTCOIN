import { Connection, Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";

export const DIRECT_RPC = "https://api.mainnet-beta.solana.com";
// The site proxy (web/api/rpc.mjs) accepts this extension's origin once redeployed.
export const PROXY_RPC = "https://quantcoin-pi.vercel.app/api/rpc/";
export const RPC_KEY = "quantum-safe/rpc/v1";

/** Public mainnet answers 403 to requests carrying a browser Origin; probe, then fall back. */
export async function pickRpc(custom?: string | null): Promise<string> {
  const candidates = custom ? [custom] : [DIRECT_RPC, PROXY_RPC];
  const errs: string[] = [];
  for (const url of candidates) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getVersion" }) });
      if (r.ok && (await r.json()).result) return url;
      errs.push(`${url}: HTTP ${r.status}`);
    } catch (e) { errs.push(`${url}: ${(e as Error).message}`); }
  }
  throw new Error(`no RPC reachable (${errs.join("; ")})`);
}

export const connect = (url: string) => new Connection(url, { commitment: "confirmed", disableRetryOnRateLimit: true });

// Same as app/src/App.tsx confirmByPolling: HTTP only, no websocket.
export async function confirmByPolling(connection: Connection, sig: string, lastValidBlockHeight: number, label: string) {
  for (;;) {
    const st = (await connection.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`${label} failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return;
    if ((await connection.getBlockHeight("confirmed")) > lastValidBlockHeight) throw new Error(`${label}: blockhash expired before confirmation`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

export async function sendSigned(connection: Connection, ixs: TransactionInstruction[], payer: Keypair, label: string) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  tx.sign(payer);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await confirmByPolling(connection, sig, lastValidBlockHeight, label);
  return sig;
}
