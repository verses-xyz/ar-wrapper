const { ArweaveClient } = require('ar-wrapper')

// Address of your admin wallet with funds
const address = "..."
// Contents of your wallet JSON keyfile. Ideally do NOT hardcode this! Use environment variables or DI.
const keyfile = `{...}`

// Main driver logic (using a main function to allow use of async-await features)
async function main() {
  // Instantiate client
  const client = new ArweaveClient(address, keyfile)

  // create a new document
  const doc = await client.addDocument("Test Document", "Lorem Ipsum", {
    "hasTag": true
  })

  // update document content (note the version bump!)
  await doc.update("Woah, new content!")

  // fetch latest document content (if version is omitted, latest is fetched)
  const docs = await client.getDocumentsByName("Test Document")
  console.log(docs.length, docs[0])

  // fetch by tags
  const docsWithTags = await client.getDocumentsByTags({
    "hasTag": true
  })
  console.log(docsWithTags.length, docsWithTags[0])

  // fetch specific version
  // this is no longer in cache so will try to fetch from network
  // this might take a long while (>2min) because of block confirmation times
  // so will most likely timeout!!
  console.log(await client.getDocumentsByName("Test Document", 0))

  // get specific document by transaction (that you know exists)
  console.log(await client.getDocumentByTxId("v-KCk3wHsrJdCShnXigOZaJzMpddqKvdHVgdYoxB_8w"))
}

main()
