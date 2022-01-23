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

// A single managed document containing arbitrary content.
// Should not be constructed manually, do this through the `ArweaveClient`
class Document {
  // Transaction ID of Document
  txID
  // Parent Arweave Client
  client
  // Whether the document has been posted to chain to be mined
  posted
  // Timestamp of block being published
  timestamp

  // Name of document. Assumed to be a unique identifier.
  // To avoid collisions, you can namespace this by prefixing it with a string of your choice.
  name
  // Arbitrary content. Can be JSON.
  content
  // Document version. Uses an integer system, usually initialized to 0.
  version
  // Object containing arbitrary user-defined metadata tags
  tags

  // Initialize a new document. Not synced by default!
  constructor(parentClient, name, content, tags, version = 0) {
    this.client = parentClient
    this.txID = undefined
    this.posted = false
    this.timestamp = undefined

    this.name = name
    this.content = content
    this.version = version
    this.tags = tags
  }

  // Return an object representation of data in this document that is stored on chain.
  data() {
    return {
      name: this.name,
      content: this.content,
      version: this.version,
      tags: this.tags,
    }
  }

  // Update document content. If you want to update any other fields, make a new
  // document.
  async update(content) {
    this.content = content
    this.version += 1
    this.posted = false
    await this.client.updateDocument(this)
  }

  // Helper function to bump timestamp of document
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
  // Key object for associated admin wallet
  #key
  // Public address for admin wallet
  adminAddr
  // Underlying arweave-js client
  client
  // Simple cache of Documents for optimistic block confirmations
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

  // Internal function for adding single document to permaweb
  async #insert(doc) {
    const tx = await this.client.createTransaction({
      data: JSON.stringify(doc.data())
    }, this.#key)

    // tag with metadata (actual meta is stringified in body)
    tx.addTag(VERSION, doc.version)
    tx.addTag(NAME, doc.name)

    // sign + send tx
    await this.client.transactions.sign(tx, this.#key)
    const txResult = await this.client.transactions.post(tx)

    // success, update doc data, add to cache
    doc.txID = tx.id
    this.cache.set(doc.name, doc)
    return doc
  }

  // Add a new document
  async addDocument(name, content, tags) {
    // create document + transaction
    const doc = new Document(this, name, content, tags)
    return this.#insert(doc)
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

  // Update existing document object and send to chain
  async updateDocument(document) {
    // check if cache has latest version of document
    if (this.isCached(document.name, document.version)) {
      return document
    }

    // otherwise, update latest
    await this.#insert(document)
    this.cache.set(document.name, document)
    return document
  }

  // Wait until block is confirmed as mined using exponential retry-backoff
  async pollForConfirmation(txId, maxRetries = 10) {
    if (!txId) {
      return Promise.reject("Document has not been posted! Use .update() first")
    }

    return await backOff(async () => {
      const txStatus = await this.client.transactions.getStatus(txId)
      if (txStatus.status === 200) {
        return txStatus
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
    if (versions.length > 0) {
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

  async getDocumentByName(name, version, maxRetries = 10, verifiedOnly = true) {
    // check if doc is in cache and entry is up to date (and correct version)
    if (this.isCached(name, version)) {
      return this.cache.get(name)
    }

    // otherwise, fetch latest to cache
    // build query to lookup by name (and optionally version) and send request to arweave graphql server
    const query = this.#queryBuilder([name], version ? [version] : [], verifiedOnly)
    const req = await fetch('https://arweave.net/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(query),
    })
    const json = await req.json()

    // safe to get first item as we specify specific tags in the query building stage
    const txId = json.data.transactions.edges[0]?.node.id
    if (!txId) {
      return Promise.reject(`No transaction with name ${name} found`)
    }

    // fetch document, update cache
    const doc = await this.getDocumentByTxId(txId)
    this.cache.set(doc.name, doc)
    return doc
  }

  async getDocumentByTxId(txId, maxRetries = 10, verifiedOnly = true) {
    // ensure block with tx is confirmed (do not assume it is in cache)
    const txStatus = await this.pollForConfirmation(txId, maxRetries)

    // fetch tx metadata
    const transactionMetadata = await this.client.transactions.get(txId)
    if (verifiedOnly && transactionMetadata.owner !== this.adminAddr) {
      return Promise.reject(`Document is not verified. Owner address mismatched! Got: ${transactionMetadata.owner}`)
    }

    // tag parsing
    const tags = transactionMetadata.get('tags').reduce((accum, tag) => {
      let key = tag.get('name', {decode: true, string: true})
      accum[key] = tag.get('value', {decode: true, string: true})
      return accum
    }, {})

    // assert that these are actually documents
    if (!(tags.hasOwnProperty(NAME) && tags.hasOwnProperty(VERSION))) {
      return Promise.reject(`Transaction ${txId} is not a document. Make sure your transaction ID is correct`)
    }

    // concurrently fetch associated block + block metadata + data
    const blockId = txStatus.confirmed.block_indep_hash
    const [blockMeta, dataString] = await Promise.all([
      this.client.blocks.get(blockId),
      this.client.transactions.getData(txId, {
        decode: true,
        string: true,
      }),
    ])
    const docData = JSON.parse(dataString)

    // transform into document and return
    const doc = new Document(this, docData, tags)
    doc.bumpTimestamp(blockMeta.timestamp)
    this.cache.set(doc.name, doc)
    return doc
  }
}