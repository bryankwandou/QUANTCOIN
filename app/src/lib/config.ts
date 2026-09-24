import { PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey("CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms");
export const QC_MINT = new PublicKey("BUoNsFbNU5hxYK5rRoiHkFqonaoaNL836Wo5QgrukAK8");
export const QC_DECIMALS = 5;
const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
export const RPC_URL = env?.VITE_RPC_URL || "https://api.devnet.solana.com";
export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const explorerAddr = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;
