import { clusterApiUrl, Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export interface Context {
  keypair: Keypair,
  connection: Connection
}

export function makeContext(): Context {
  return {
    keypair: Keypair.fromSecretKey(bs58.decode(process.env.SECRET_KEY as string)),
    connection: new Connection(
      process.env['RPC_URL'] ?? clusterApiUrl("mainnet-beta"), {
        httpHeaders: process.env['RPC_ORIGIN'] ? {
          "Origin": process.env.RPC_ORIGIN
        } : undefined
      }
    )
  }
}
