const ArweaveLib = require('arweave')
const { LRUMap } = require('lru_map')

const DEFAULT_OPTIONS = {
  host: 'arweave.net',
  port: 443,
  protocol: 'https',
  timeout: 20000,
  logging: false,
}

// A single managed document
class Document {
  data
  txID
  client
  synced

  constructor(parentClient, content, version, name, meta) {
    this.client = parentClient
    this.data = {
      content,
      version,
      name,
      meta,
    }
    this.txID = undefined
    this.synced = false
  }

  update(partialDocument) {
    this.synced = false
    this.data = {
      ...this.data,
      version: this.data.version + 1,
      ...partialDocument,
    }
  }
}

// Constants
const VERSION = "DOC_VERSION"
const NAME = "DOC_NAME"

// Thin wrapper client around Arweave for versioned document/data management.
// Relies on an 'admin' wallet for fronting transaction + gas costs for users.
class ArweaveClient {
  #key
  adminAddr
  client
  cache

  // Construct a new client given the address of the admin account,
  // keys to the wallet, and a set of options for connecting to an Arweave network.
  // Options are identical to the ones supported by the official arweave-js library
  constructor(adminAddress, key, cache_size = 500, options = DEFAULT_OPTIONS) {
    this.#key = key
    this.adminAddr = adminAddress
    this.client = ArweaveLib.init(options)
    this.cache = new LRUMap(500)
  }

  // Function to add a new document
  async addDocument(content, version, name, meta) {
    // create document + transaction
    const doc = new Document(this, content, version, name, meta)
    const tx = await this.client.createTransaction({
      data: JSON.stringify(doc.data)
    }, this.#key)

    // tag with metadata (actual meta is stringified in body)
    tx.addTag(VERSION, doc.data.version)
    tx.addTag(NAME, doc.data.name)

    // sign + send tx
    await this.client.transactions.sign(tx, this.#key)
    const txResult = await this.client.transactions.post(tx)

    // success, update doc data, add to cache
    doc.txID = tx.id
    doc.synced = true
    this.cache.set(doc.data.name, doc)

    return {
      ...txResult,
      id: tx.id,
    }
  }

  async updateDocument(content, version, meta) {
  }

  async getDocumentByName(name) {
    // check if doc is in cache and entry is up to date
    if (this.cache.has(name) && this.cache.get(name).synced) {
      return this.cache.get(name)
    }

    // otherwise, fetch latest to cache

    // return
    return this.cache.get(name)
  }

  // get document by specific version and hash

}