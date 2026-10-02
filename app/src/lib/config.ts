import { PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey("CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms");
export const QC_MINT = new PublicKey("AsEEaydVYMpghdNTrQoVZTAhJSewZT5xD9WE9hpA68W2"); // mainnet
export const QC_DECIMALS = 5;
const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
// Public mainnet RPCs refuse browser requests, so the site proxies them (web/api/rpc.mjs).
export const RPC_URL = env?.VITE_RPC_URL || (typeof location !== "undefined" ? `${location.origin}/api/rpc` : "https://api.mainnet-beta.solana.com");
export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}`;
export const explorerAddr = (a: string) => `https://explorer.solana.com/address/${a}`;
