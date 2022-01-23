declare module "ar-wrapper" {
  type Arweave = import("arweave")
  type LRUMap = import("lru_map").LRUMap<string, Document>

  interface BlockStatusI {
    status: number
    confirmed: {
      block_height: number
      block_indep_hash: string
      number_of_confirmations: number
    }
  }

  export interface BlockDocument {
    name: string
    content: string
    version: number
    tags: Record<string, string>
  }

  export interface OptionsI {
    host: string
    port: number
    protocol: string
    timeout: number
    logging: boolean
  }

  export const DEFAULT_OPTIONS: OptionsI

  export class Document {
    txID: string
    client: ArweaveClient
    posted: boolean
    timestamp: string

    name: string
    content: any
    version: number
    tags: Record<string, string>

    constructor(parentClient: ArweaveClient, name: string, content: any, tags: Record<string, string>, version?: number)
    data(): BlockDocument

    update(content: any): Promise<Document>
    bumpTimestamp(dateMs: number)
  }

  export class ArweaveClient {
    adminAddr: string
    client: Arweave
    cache: LRUMap

    constructor(adminAddress: string, keyFile: string, cacheSize?: number, options?: OptionsI)
    isCached(documentName: string, desiredVersion?: number): boolean
    addDocument(name: string, content: any, tags: Record<string, string>): Promise<Document>
    updateDocument(document: Document): Promise<Document>
    pollForConfirmation(txId: string, maxRetries?: number): Promise<BlockStatusI>
    getDocumentByName(name: string, version?: number, maxRetries?: number, verifiedOnly?: boolean): Promise<Document>
    getDocumentByTxId(txId: string, maxRetries?: number, verifiedOnly?: boolean): Promise<Document>
  }
}