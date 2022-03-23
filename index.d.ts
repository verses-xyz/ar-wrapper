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

  interface FetchSettingsI {
    maxRetries: number
    verifiedOnly: boolean
    maxResults: number
    compatabilityMode: boolean
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

  interface Serializable {
    toString: (any) => string
  }

  // A single managed document containing arbitrary content.
  // Should not be constructed manually, do this through the `ArweaveClient`
  export class Document<T = string> {
    // Transaction ID of Document
    txID: string
    // Parent Arweave Client
    client: ArweaveClient
    // Whether the document has been posted to chain to be mined
    posted: boolean
    // Timestamp of block being published
    timestamp: string

    // Name of document. Assumed to be a unique identifier.
    // To avoid collisions, you can namespace this by prefixing it with a string of your choice.
    name: string
    // Arbitrary content. Can be JSON.
    content: T
    // Document version. Uses an integer system, usually initialized to 0.
    version: number
    // Object containing arbitrary user-defined metadata tags
    tags: Record<string, string>

    // Initialize a new document. Not synced by default!
    constructor(parentClient: ArweaveClient, name: string, content: any, tags: Record<string, string>, version?: number)

    // Return an object representation of data in this document that is stored on chain.
    data(): BlockDocument

    // Update document content. If you want to update any other fields, make a new
    // document.
    update(content: any): Promise<Document>

    // Helper function to bump timestamp of document
    bumpTimestamp(dateMs: number)
  }

  // Thin wrapper client around Arweave for versioned document/data management.
  // Relies on an 'admin' wallet for fronting transaction + gas costs for users.
  export class ArweaveClient {
    // Public address for admin wallet
    adminAddr: string
    // Underlying arweave-js client
    client: Arweave
    // Simple cache of Document for optimistic block confirmations
    cache: LRUMap

    // Construct a new client given the address of the admin account,
    // keys to the wallet, and a set of options for connecting to an Arweave network.
    // `cacheSize` can be set to 0 to disable caching (not recommended).
    // Options are identical to the ones supported by the official `arweave-js` library.
    constructor(adminAddress: string, keyFile?: string, cacheSize?: number, options?: OptionsI)

    // See if given document is cached.
    // Optionally define desired version to match against.
    isCached(documentName: string, desiredVersion?: number): boolean

    // Add a new document 
    addDocument(name: string, content: any, tags: Record<string, string>): Promise<Document>
    
    // Update existing document object and send to chain
    updateDocument(document: Document): Promise<Document>
  
    // Wait until block is confirmed as mined using exponential retry-backoff
    pollForConfirmation(txId: string, maxRetries?: number): Promise<BlockStatusI>

    // Returns list of matching documents to query
    executeQuery(names: string[], versions: number[], userTags: Record<string, string>, userOptions?: Partial<FetchSettingsI>): Promise<Document[]>

    // Return a list of document objects via lookup by their name
    getDocumentsByName(name: string, version?: number, tags?: Record<string, string>, options?: Partial<FetchSettingsI>): Promise<Document[]>

    // Return a list of document objects by their tags
    getDocumentsByTags(tags: Record<string, string>, options?: Partial<FetchSettingsI>): Promise<Document[]>
  
    // Return a single document object via lookup by transaction ID
    getDocumentByTxId(txId: string, userOptions?: Partial<FetchSettingsI>): Promise<Document>
  }
}
