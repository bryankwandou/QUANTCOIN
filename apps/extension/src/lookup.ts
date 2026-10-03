import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { QC_MINT } from "@app/config";
import { tokenAccountOf } from "@app/vault";

/** Read-only QC balance. A QC token account is read directly; any other address
 *  (wallet, vault PDA) is mapped to its QC associated token account. */
export async function qcBalance(conn: Connection, address: string): Promise<{ tokenAccount: string; amount: bigint | null }> {
  const key = new PublicKey(address.trim());
  const info = await conn.getAccountInfo(key, "confirmed");
  let ta = key;
  if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID) && info.data.length >= 165) {
    if (!new PublicKey(info.data.subarray(0, 32)).equals(QC_MINT)) throw new Error("token account is not for the QC mint");
  } else ta = tokenAccountOf(QC_MINT, key);
  const tinfo = ta.equals(key) ? info : await conn.getAccountInfo(ta, "confirmed");
  if (!tinfo) return { tokenAccount: ta.toBase58(), amount: null };
  return { tokenAccount: ta.toBase58(), amount: BigInt((await conn.getTokenAccountBalance(ta, "confirmed")).value.amount) };
}
