export const CHAIN_ID = 4663;
export const EXPLORER_URL = "https://robinhoodchain.blockscout.com";
export const CONFIRMATIONS = 12;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";
export const chain = {
  id: CHAIN_ID, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: EXPLORER_URL } },
} as const;
