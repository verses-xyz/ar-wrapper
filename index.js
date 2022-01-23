const ArweaveLib = require('arweave')
const { LRUMap } = require('lru_map')
const { backOff } = require('exponential-backoff')
const fetch = require('cross-fetch')

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
  posted
  tags
  timestamp

  // Creates a new document. Not synced by default!
  constructor(parentClient, data, tags) {
    this.client = parentClient
    this.data = data
    this.txID = undefined
    this.posted = false
    this.tags = tags
    this.timestamp = undefined
  }

  // Update document with a partial version of its fields.
  // Automatically bumps version field unless explicitly defined.
  async update(partialDocument) {
    this.posted = false
    this.data = {
      ...this.data,
      version: this.data.version + 1,
      ...partialDocument,
    }
    await this.client.updateDocument(this).then(() => this.posted = true)
  }

  bumpTimestamp(dateMs) {
    const options = { year: 'numeric', month: 'long', day: 'numeric' }
    const time = new Date(dateMs * 1000)
    this.timestamp = time.toLocaleDateString('en-US', options)
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
  // Options are identical to the ones supported by the official `arweave-js` library
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
    this.cache.set(doc.data.name, doc)

    return {
      ...txResult,
      id: tx.id,
    }
  }

  // Internal function to see if given document is cached.
  // Optionally define desired version to match against.
  isCached(documentName, desiredVersion) {
    const inCache = this.cache.has(documentName)
    if (!inCache) {
      return false
    }

    const cached = this.cache.get(documentName)
    const versionMatch = desiredVersion ? cached.version === desiredVersion : true
    return cached.synced && versionMatch
  }

  // take document with changes and update
  async updateDocument(document) {
    // check if doc is in cache and not dirty
    if (this.isCached(name)) {
      return Promise.resolve()
    }

    // fetch latest

  }

  // Wait until block is confirmed as mined using exponential retry-backoff
  async pollForConfirmation(txId, maxRetries = 10) {
    if (!txId) {
      return Promise.reject("Document has not been posted! Use .update() first")
    }

    return await backOff(async () => {
      const txStatus = await this.client.transactions.getStatus(txId)
      if (txStatus.status === 200) {
        return Promise.resolve(txStatus)
      } else {
        return Promise.reject(txStatus.status)
      }
    }, {
      numOfAttempts: maxRetries
    })
  }

  // Internal fn for building GraphQL queries for fetching data.
  // Both names and versions are arrays. Use `verifiedOnly = false` to include
  // all submitted TXs (including ones from non-admin wallet accounts)
  #queryBuilder(names, versions, verifiedOnly = true) {
    const tags = [{
      name: NAME,
      values: names,
    }]

    // versions is an optional field
    if (versions && versions.length > 0) {
      tags.push({
        name: VERSION,
        values: versions,
      })
    }

    return {
      query: `
      query {
        transactions(
          tags: ${JSON.stringify(tags)},
          ${verifiedOnly ? `owners: ["${this.adminAddr}"]` : ""}
        ) {
          edges {
            node {
              id
              owner {
                address
              }
            }
          }
        }
      }
      `
    }
  }

  async getDocumentByName(name, version) {
    // check if doc is in cache and entry is up to date (and correct version)
    if (this.isCached(name, version)) {
      return this.cache.get(name)
    }

    // otherwise, fetch latest to cache and overwrite

    // return
    return this.cache.get(name)
  }

  async getDocumentByTxId(txId, maxRetries = 10) {
    const txStatus = await this.pollForConfirmation(txId, maxRetries)

    // fetch tx metadata
    const transactionMetadata = await this.client.transactions.get(txId)
    const tags = transactionMetadata.get('tags').reduce((accum, tag) => {
      let key = tag.get('name', {decode: true, string: true})
      accum[key] = tag.get('value', {decode: true, string: true})
      return accum
    }, {})

    // assert that these are actually documents
    if (!(tags.hasOwnProperty(NAME) && tags.hasOwnProperty(VERSION))) {
      return Promise.reject("TX is not a document. Make sure your transaction ID is correct")
    }

    // fetch associated block + block metadata + data
    const blockId = txStatus.confirmed.block_indep_hash
    const [blockMeta, dataString] = await Promise.all([this.client.blocks.get(blockId), this.client.transactions.getData(txId, {
      decode: true,
      string: true,
    })])
    const docData = JSON.parse(dataString)

    // transform into document
    const doc = new Document(this, docData, tags)
    doc.bumpTimestamp(blockMeta.timestamp)
    return doc
  }
}