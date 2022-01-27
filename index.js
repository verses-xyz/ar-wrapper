const ArweaveLib = require('arweave')
const { LRUMap } = require('lru_map')
const { backOff } = require('exponential-backoff')
const fetch = require('cross-fetch')

const DEFAULT_ARWEAVE_OPTIONS = {
  host: 'arweave.net',
  port: 443,
  protocol: 'https',
  timeout: 20000,
  logging: false,
}

const DEFAULT_FETCH_OPTIONS = {
  maxRetries: 10,
  verifiedOnly: true,
  maxResults: 25,
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
    const time = new Date(dateMs * 1000)
    this.timestamp = time.toString()
  }
}

// Constants
const VERSION = "DOC_VERSION"
const NAME = "DOC_NAME"
const META = "DOC_META"

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
  // `cacheSize` can be set to 0 to disable caching (not recommended).
  // Options are identical to the ones supported by the official `arweave-js` library.
  constructor(adminAddress, keyFile, cacheSize = 500, options = DEFAULT_ARWEAVE_OPTIONS) {
    this.#key = JSON.parse(keyFile)
    this.adminAddr = adminAddress
    this.client = ArweaveLib.init(options)
    this.cache = new LRUMap(cacheSize)
  }

  // Internal function for adding single document to permaweb
  async #insert(doc) {
    const tx = await this.client.createTransaction({
      data: JSON.stringify(doc.data())
    }, this.#key)

    // tag with metadata (actual meta is stringified in body)
    tx.addTag(VERSION, doc.version)
    tx.addTag(NAME, doc.name)

    // add user defined metadata
    Object.entries(doc.tags).forEach(([tag, content]) => {
      tx.addTag(`${META}_${tag}`, content)
    })

    // sign + send tx
    await this.client.transactions.sign(tx, this.#key)
    const txResult = await this.client.transactions.post(tx)

    // check if something went wrong
    if (txResult.status !== 200) {
      return Promise.reject(txResult)
    }

    // success, update doc data, add to cache
    doc.txID = tx.id
    doc.posted = true
    this.cache.set(doc.txID, doc)
    return doc
  }

  // Internal function to see if given document is cached.
  // Optionally define desired version to match against.
  isCached(txId, desiredVersion) {
    const inCache = this.cache.has(txId)
    if (!inCache) {
      return false
    }

    const cached = this.cache.get(txId)
    const versionMatch = desiredVersion !== undefined ? cached.version === desiredVersion : true
    return cached.posted && versionMatch
  }

  // Add a new document
  async addDocument(name, content, tags) {
    // create document + transaction
    const doc = new Document(this, name, content, tags)
    return this.#insert(doc)
  }

  // Update existing document object and send to chain
  async updateDocument(document) {
    // check if cache has latest version of document
    if (this.isCached(document.txID, document.version)) {
      return document
    }

    // otherwise, update latest
    await this.#insert(document)
    return document
  }

  // Wait until block is confirmed as mined using exponential retry-backoff
  async pollForConfirmation(txId, maxRetries = 10) {
    if (!txId) {
      return Promise.reject("Document has not been posted! Use .update() first")
    }

    if (this.cache.has(txId)) {
      return true
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
  #queryBuilder(names, versions, userTags, verifiedOnly = true, cursor = undefined) {
    // parse use defined tags
    const tags = Object.entries(userTags).map(([k, v]) => `{
      name: "${META}_${k}",
      values: ["${v}"]
    }`)

    // add name tag
    if (names.length > 0) {
      tags.push(`{
        name: "${NAME}",
        values: ${JSON.stringify(names)},
      }`)
    }

    // versions is an optional field
    if (versions.length > 0) {
      tags.push(`{
        name: "${VERSION}",
        values: ${JSON.stringify(versions.map(n => n.toString()))},
      }`)
    }

    return {
      query: `
      query {
        transactions(
          tags: [${tags.join(",")}],
          ${verifiedOnly ? `owners: ["${this.adminAddr}"],` : ""}
          ${cursor ? `after: "${cursor}",` : ""}
        ) {
          edges {
            cursor
            node {
              id
              owner {
                address
              }
              tags {
                name
                value
              }
            }
          }
        }
      }
      `
    }
  }

  async executeQuery(names, versions, userTags, userOptions = DEFAULT_FETCH_OPTIONS) {
    const options = {
      ...DEFAULT_FETCH_OPTIONS,
      ...userOptions,
    }

    const fetchQuery = async (cursor) => {
      // fetch latest to cache
      // build query to lookup by name (and optionally version) and send request to arweave graphql server
      const query = this.#queryBuilder(names, versions, userTags, options.verifiedOnly, cursor)
      const req = await fetch('https://arweave.net/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(query),
      })
      const json = await req.json()
      return json.data.transactions
    }
    const resultEdges = []

    let nResults = 1
    let cursor = undefined
    while (nResults > 0 && resultEdges.length < options.maxResults) {
      const newEdges = await fetchQuery(cursor)
      nResults = newEdges.edges.length
      resultEdges.push(...newEdges.edges)
      cursor = newEdges.cursor
    }

    // safe to get first item as we specify specific tags in the query building stage
    const txIds = versions.length === 0 ?
      resultEdges.map(e => e.node.id) :
      resultEdges.sort((a, b) => {
        // we reverse sort edges if version is not defined to get latest version
        const getVersion = (edge) => edge.node.tags.find(tag => tag.name === VERSION).value || 0
        return getVersion(b) - getVersion(a)
      }).map(e => e.node.id)

    // fetch document, update cache
    const promises = txIds.map(txId => this.getDocumentByTxId(txId, options))
    const docs = (await Promise.allSettled(promises))
      .filter(p => p.status === "fulfilled")
      .map(p => p.value)
      .slice(0, userOptions.maxResults)
    docs.forEach(doc => this.cache.set(doc.name, doc))
    return docs
  }

  // Return a list of document objects by their tags
  async getDocumentsByTags(tags, options = DEFAULT_FETCH_OPTIONS) {
    return this.executeQuery([] ,[], tags, options)
  }

  // Return a document object via lookup by name
  async getDocumentsByName(name, version, tags = [], options = DEFAULT_FETCH_OPTIONS) {
    return this.executeQuery([name], version === undefined ? [] : [version], tags, options)
  }

  // Return a document object via lookup by transaction ID
  async getDocumentByTxId(txId, userOptions = DEFAULT_FETCH_OPTIONS) {
    const options = {
      ...DEFAULT_FETCH_OPTIONS,
      ...userOptions
    }

    if (this.cache.has(txId)) {
      return this.cache.get(txId)
    }

    // ensure block with tx is confirmed (do not assume it is in cache)
    const txStatus = await this.pollForConfirmation(txId, options.maxRetries)

    // fetch tx metadata
    const transactionMetadata = await this.client.transactions.get(txId)
    if (options.verifiedOnly && transactionMetadata.owner !== this.#key.n) {
      return Promise.reject(`Document is not verified. Owner address mismatched! Got: ${transactionMetadata.owner}`)
    }

    // tag parsing
    const metaTags = transactionMetadata.get('tags').reduce((accum, tag) => {
      let key = tag.get('name', {decode: true, string: true})
      accum[key] = tag.get('value', {decode: true, string: true})
      return accum
    }, {})

    // assert that these are actually documents
    if (!(metaTags.hasOwnProperty(NAME) && metaTags.hasOwnProperty(VERSION))) {
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
    const {
      name,
      content,
      version,
      tags
    } = JSON.parse(dataString)

    // transform into document and return
    const doc = new Document(this, name, content, tags, version)
    doc.posted = true
    doc.txID = txId
    doc.bumpTimestamp(blockMeta.timestamp)
    this.cache.set(doc.name, doc)
    return doc
  }
}

module.exports = {
  ArweaveClient,
  Document
}