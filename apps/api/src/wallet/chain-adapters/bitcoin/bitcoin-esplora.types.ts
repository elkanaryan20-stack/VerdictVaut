/** Minimal Esplora (blockstream/mempool.space-compatible) REST API shapes — only the fields this adapter actually reads. */
export interface EsploraVout {
  scriptpubkey_address?: string;
  value: number;
}

export interface EsploraTxStatus {
  confirmed: boolean;
  block_height?: number;
}

export interface EsploraTx {
  txid: string;
  vout: EsploraVout[];
  status: EsploraTxStatus;
}
