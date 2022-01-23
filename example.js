const { ArweaveClient } = require('./index')

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

  // see if content is cached locally
  // version 0 is no longer cached!
  console.log(`Is 'Test Document'@0 cached? ${client.isCached("Test Document", 0)}`)
  // but version 1 is
  console.log(`Is 'Test Document'@1 cached? ${client.isCached("Test Document", 1)}`)

  // fetch latest document content (if version is omitted, latest is fetched)
  console.log(await client.getDocumentByName("Test Document"))

  // fetch specific version
  // this is no longer in cache so will try to fetch from network
  // this might take a long while (>2min) because of block confirmation times
  // so will most likely timeout!!
  console.log(await client.getDocumentByName("Test Document", 0))

  // get specific document by transaction (that you know exists)
  console.log(await client.getDocumentByTxId("v-KCk3wHsrJdCShnXigOZaJzMpddqKvdHVgdYoxB_8w"))
}

main()