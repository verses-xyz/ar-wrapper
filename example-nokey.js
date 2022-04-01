const { ArweaveClient } = require('ar-wrapper')

// Main driver logic (using a main function to allow use of async-await features)
async function main() {
  // Instantiate client without key
  const client = new ArweaveClient("some-address")
  const docs = await client.getDocumentsByName("some_name", undefined, undefined, {
    skipHydration: true,
  })
}

main()
