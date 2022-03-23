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


class Document {
  txID
  client
  posted
  timestamp


  name
  content
  version
  tags

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

  data() {
    return {
      name: this.name,
      content: this.content,
      version: this.version,
      tags: this.tags,
    }
  }

  async update(content) {
    this.content = content
    this.version += 1
    this.posted = false
    return await this.client.updateDocument(this)
  }

  bumpTimestamp(dateMs) {
    const time = new Date(dateMs * 1000)
    this.timestamp = time.toString()
  }
}

// Constants
const VERSION = "DOC_VERSION"
const NAME = "DOC_NAME"
const META = "DOC_META"


class ArweaveClient {
  // Key object for associated admin wallet
  #key
  adminAddr
  client
  cache

  constructor(adminAddress, keyFile, cacheSize = 500, options = DEFAULT_ARWEAVE_OPTIONS) {
    if (keyFile === undefined) {
      console.log("WARN: keyFile is undefined. Client is now in READ-ONLY mode. If this isn't intentional, make sure you are passing in a key")
    } else {
      this.#key = JSON.parse(keyFile)
    }
    this.adminAddr = adminAddress
    this.client = ArweaveLib.init(options)
    this.cache = new LRUMap(cacheSize)
  }

  // Internal function for adding single document to permaweb
  async #insert(doc) {
    if (!this.#key) {
      throw "Can't call .insert() in READ-ONLY mode!"
    }

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

  isCached(txId, desiredVersion) {
    const inCache = this.cache.has(txId)
    if (!inCache) {
      return false
    }

    const cached = this.cache.get(txId)
    const versionMatch = desiredVersion !== undefined ? cached.version === desiredVersion : true
    return cached.posted && versionMatch
  }

  async addDocument(name, content, tags) {
    // create document + transaction
    const doc = new Document(this, name, content, tags)
    return this.#insert(doc)
  }

  async updateDocument(document) {
    // check if cache has latest version of document
    if (this.isCached(document.txID, document.version)) {
      return document
    }

    // otherwise, update latest
    return await this.#insert(document)
  }

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
    const txIds = resultEdges.sort((a, b) => {
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

  async getDocumentsByTags(tags, options = DEFAULT_FETCH_OPTIONS) {
    return this.executeQuery([], [], tags, options)
  }

  async getDocumentsByName(name, version, tags = [], options = DEFAULT_FETCH_OPTIONS) {
    return this.executeQuery([name], version === undefined ? [] : [version], tags, options)
  }

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
    const readOnlyMode = !this.#key
    if ((options.verifiedOnly && !readOnlyMode) && transactionMetadata.owner !== this.#key.n) {
      return Promise.reject(`Document is not verified. Owner address mismatched! Got: ${transactionMetadata.owner}`)
    }

    // tag parsing
    const metaTags = transactionMetadata.get('tags').reduce((accum, tag) => {
      let key = tag.get('name', { decode: true, string: true })
      accum[key] = tag.get('value', { decode: true, string: true })
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
