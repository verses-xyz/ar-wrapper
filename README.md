# 🎁 ar-wrapper
A thin wrapper around [`arweave-js`](https://github.com/ArweaveTeam/arweave-js) for versioned permaweb document management.
Helps to abstract away complexity for document storage for servers which front
transaction + gas costs for users. Includes local caching for optimistic transaction executions.

Usage of this library requires possession of a Arweave keyfile for a wallet which
has funds.

You can look at `example.js` for annotated usage of this library.
Type definitions can be found in `index.d.ts`.

### Installation
```bash
npm i ar-wrapper
```

```js
const { ArweaveClient } = require('ar-wrapper')
```