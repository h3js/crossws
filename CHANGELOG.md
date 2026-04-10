# Changelog

## v0.4.4

[compare changes](https://github.com/h3js/crossws/compare/v0.4.3...v0.4.4)

### 🩹 Fixes

- Use `AbortController` for `StubRequest.signal` ([#175](https://github.com/h3js/crossws/pull/175))

### 🏡 Chore

- Update deps ([9f32424](https://github.com/h3js/crossws/commit/9f32424))

### ❤️ Contributors

- Alessandro De Blasis ([@deblasis](https://github.com/deblasis))
- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.4.3

[compare changes](https://github.com/h3js/crossws/compare/v0.4.2...v0.4.3)

### 📦 Build

- Migrate to obuild (rolldown) ([efdd087](https://github.com/h3js/crossws/commit/efdd087))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.4.2

[compare changes](https://github.com/h3js/crossws/compare/v0.4.0...v0.4.2)

### 🩹 Fixes

- **node server:** Properly pass request to `NodeRequest` ([28e5d64](https://github.com/h3js/crossws/commit/28e5d64))
- **cloudflare:** Send close frame ([#177](https://github.com/h3js/crossws/pull/177))

### 📖 Documentation

- Add new logo with cube style ([#171](https://github.com/h3js/crossws/pull/171))
- Mention publish not broadcasting to sender ([#173](https://github.com/h3js/crossws/pull/173))

### 🏡 Chore

- **playground:** Add `start` command ([7ab898c](https://github.com/h3js/crossws/commit/7ab898c))
- **release:** V0.4.1 ([3a537a0](https://github.com/h3js/crossws/commit/3a537a0))
- Update undocs ([4f1e94b](https://github.com/h3js/crossws/commit/4f1e94b))
- Update undocs ([8646f89](https://github.com/h3js/crossws/commit/8646f89))
- **docs:** Add missing backtick ([#169](https://github.com/h3js/crossws/pull/169))
- Update undocs ([440a088](https://github.com/h3js/crossws/commit/440a088))
- Update srvx version & usage ([#178](https://github.com/h3js/crossws/pull/178))
- Update dependencies ([8761d2e](https://github.com/h3js/crossws/commit/8761d2e))
- Lint ([df7062b](https://github.com/h3js/crossws/commit/df7062b))
- Fix type issues ([68841e6](https://github.com/h3js/crossws/commit/68841e6))
- Update uWebSockets.js ([9ce4ce5](https://github.com/h3js/crossws/commit/9ce4ce5))
- Fix lint issues ([4b1b779](https://github.com/h3js/crossws/commit/4b1b779))

### ❤️ Contributors

- Joseph Lee ([@jclab-joseph](https://github.com/jclab-joseph))
- Pooya Parsa ([@pi0](https://github.com/pi0))
- Nick Perez ([@nperez0111](https://github.com/nperez0111))
- Rijk Van Zanten ([@rijkvanzanten](https://github.com/rijkvanzanten))
- Sébastien Chopin <seb@nuxt.com>
- Abeer0 ([@iiio2](https://github.com/iiio2))

## v0.4.1

[compare changes](https://github.com/h3js/crossws/compare/v0.4.0...v0.4.1)

### 🩹 Fixes

- **node server:** Properly pass request to `NodeRequest` ([28e5d64](https://github.com/h3js/crossws/commit/28e5d64))

### 🏡 Chore

- **playground:** Add `start` command ([7ab898c](https://github.com/h3js/crossws/commit/7ab898c))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.4.0

[compare changes](https://github.com/h3js/crossws/compare/v0.3.5...v0.4.0)

### 🚀 Enhancements

- Stub full request interface ([#156](https://github.com/h3js/crossws/pull/156))
- Universal server for deno, node and bun using srvx (experimental) ([#158](https://github.com/h3js/crossws/pull/158))
- Create `PeerContext` interface for type augmentation ([#159](https://github.com/h3js/crossws/pull/159))
- ⚠️ Namespaced pub/sub peers ([#162](https://github.com/h3js/crossws/pull/162))
- ⚠️ Support returning context from `upgrade` hook ([#163](https://github.com/h3js/crossws/pull/163))
- **cloudflare:** Support global publish via rpc ([#166](https://github.com/h3js/crossws/pull/166))
- Add cloudflare and default (sse) server entries ([#167](https://github.com/h3js/crossws/pull/167))

### 🩹 Fixes

- ⚠️ Do not automatically accept first `sec-webSocket-protocol` ([#142](https://github.com/h3js/crossws/pull/142))

### 💅 Refactors

- Remove `uncrypto` dependency ([#153](https://github.com/h3js/crossws/pull/153))
- ⚠️ Always pass `Request` as first param to `resolve` ([#160](https://github.com/h3js/crossws/pull/160))
- Simplify inspect values ([aa49668](https://github.com/h3js/crossws/commit/aa49668))
- Throw error when running deno, bun and node adapters in an incompatible environment ([b5fcf2a](https://github.com/h3js/crossws/commit/b5fcf2a))
- Narrow down `upgrade` return type ([d843cd0](https://github.com/h3js/crossws/commit/d843cd0))
- ⚠️ Always terminate `upgrade` if `Response` is returned ([#164](https://github.com/h3js/crossws/pull/164))
- ⚠️ Merge `cloudflare` and `cloudflare-durable` adapters ([#165](https://github.com/h3js/crossws/pull/165))
- **cloudflare:** Show warning when pub/sub is not supported ([#144](https://github.com/h3js/crossws/pull/144))

### 📖 Documentation

- Change to `h3js` from `unjs` ([#155](https://github.com/h3js/crossws/pull/155))
- Add docs for augmenting `PeerContext` type ([#161](https://github.com/h3js/crossws/pull/161))
- Prepare for v0.4 ([#168](https://github.com/h3js/crossws/pull/168))

### 📦 Build

- Simplify and fix exports ([0d2ceb0](https://github.com/h3js/crossws/commit/0d2ceb0))
- Remove extra `.d.ts` files ([1f389d6](https://github.com/h3js/crossws/commit/1f389d6))

### 🏡 Chore

- Update deps ([37889b0](https://github.com/h3js/crossws/commit/37889b0))
- Update deps ([c6f6bd8](https://github.com/h3js/crossws/commit/c6f6bd8))

#### ⚠️ Breaking Changes

- ⚠️ Namespaced pub/sub peers ([#162](https://github.com/h3js/crossws/pull/162))
- ⚠️ Support returning context from `upgrade` hook ([#163](https://github.com/h3js/crossws/pull/163))
- ⚠️ Do not automatically accept first `sec-webSocket-protocol` ([#142](https://github.com/h3js/crossws/pull/142))
- ⚠️ Always pass `Request` as first param to `resolve` ([#160](https://github.com/h3js/crossws/pull/160))
- ⚠️ Always terminate `upgrade` if `Response` is returned ([#164](https://github.com/h3js/crossws/pull/164))
- ⚠️ Merge `cloudflare` and `cloudflare-durable` adapters ([#165](https://github.com/h3js/crossws/pull/165))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Tee Ming ([@eltigerchino](https://github.com/eltigerchino))
- Luke Nelson <luke@nelson.zone>
- @beer ([@iiio2](https://github.com/iiio2))

## v0.3.5

[compare changes](https://github.com/h3js/crossws/compare/v0.3.4...v0.3.5)

### 🚀 Enhancements

- **node:** Support `closeAll` with `force` flag ([#147](https://github.com/h3js/crossws/pull/147))

### 🩹 Fixes

- **node:** Destroy socket on upgrade abort ([#140](https://github.com/h3js/crossws/pull/140))

### 📦 Build

- Export `AdapterInternal` type ([#149](https://github.com/h3js/crossws/pull/149))

### 🌊 Types

- Mark `NodeAdapter.handleUpgrade` as async ([#136](https://github.com/h3js/crossws/pull/136))

### 🏡 Chore

- Unused import ([39485dc](https://github.com/h3js/crossws/commit/39485dc))
- Update deps ([c0b6db5](https://github.com/h3js/crossws/commit/c0b6db5))
- Use pnpm for docs ([e631333](https://github.com/h3js/crossws/commit/e631333))
- Move to h3js org ([3747c75](https://github.com/h3js/crossws/commit/3747c75))
- Update cloudflare test ([12fef5f](https://github.com/h3js/crossws/commit/12fef5f))
- Update deps ([3e27973](https://github.com/h3js/crossws/commit/3e27973))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- M1212e ([@m1212e](https://github.com/m1212e))
- Tee Ming ([@eltigerchino](https://github.com/eltigerchino))
- James Garbutt ([@43081j](https://github.com/43081j))

## v0.3.4

[compare changes](https://github.com/h3js/crossws/compare/v0.3.3...v0.3.4)

### 🚀 Enhancements

- **cloudflare:** Support `resolveDurableStub` ([#130](https://github.com/h3js/crossws/pull/130))

### 🩹 Fixes

- Specify an explicit return type for `uint8Array()` ([#128](https://github.com/h3js/crossws/pull/128))
- **node, uws:** Send data as blob only if it is not string ([#124](https://github.com/h3js/crossws/pull/124))
- Global publish via first subscribed peer ([#103](https://github.com/h3js/crossws/pull/103))
- **bun:** Pass `code` and `reason` to `close` hook ([#132](https://github.com/h3js/crossws/pull/132))
- Define `request.context` as read only ([#133](https://github.com/h3js/crossws/pull/133))

### 💅 Refactors

- Stricter type declarations ([#129](https://github.com/h3js/crossws/pull/129))

### 📖 Documentation

- **node:** Check `upgrade === "websocket"` in example ([#131](https://github.com/h3js/crossws/pull/131))
- Add dynamic example for changeable resolve ([e5daf22](https://github.com/h3js/crossws/commit/e5daf22))

### 🏡 Chore

- **release:** V0.3.3 ([d917f3a](https://github.com/h3js/crossws/commit/d917f3a))
- Update deps ([d904557](https://github.com/h3js/crossws/commit/d904557))
- Update deps ([43ec0c0](https://github.com/h3js/crossws/commit/43ec0c0))
- Update ci ([9ef29ad](https://github.com/h3js/crossws/commit/9ef29ad))

### ❤️ Contributors

- Pooya Parsa ([@pi0](http://github.com/pi0))
- Sandro Circi ([@sandros94](http://github.com/sandros94))
- Flo <TecToast@gmail.com>
- Tee Ming <chewteeming01@gmail.com>

## v0.3.3

[compare changes](https://github.com/h3js/crossws/compare/v0.3.2...v0.3.3)

### 🚀 Enhancements

- Allow throwing error with `.response` prop in `upgrade` ([#113](https://github.com/h3js/crossws/pull/113))

### ❤️ Contributors

- Luke Hagar ([@LukeHagar](http://github.com/LukeHagar))

## v0.3.2

[compare changes](https://github.com/h3js/crossws/compare/v0.3.1...v0.3.2)

### 🚀 Enhancements

- Support throwing responses in `upgrade` hook ([#91](https://github.com/h3js/crossws/pull/91))
- **peer:** Support `context` ([#110](https://github.com/h3js/crossws/pull/110))
- Shared context between `upgrade` hook and `peer` ([#111](https://github.com/h3js/crossws/pull/111))

### 🩹 Fixes

- **types:** `peer.request` always has `.headers` if defined ([e915f8d](https://github.com/h3js/crossws/commit/e915f8d))
- **types:** Mark `peer.request` as always defined ([8fbb59b](https://github.com/h3js/crossws/commit/8fbb59b))

### 📖 Documentation

- Fix typo ([#85](https://github.com/h3js/crossws/pull/85))
- Fix typo ([#84](https://github.com/h3js/crossws/pull/84))
- Add `destr` tip for JSON parsing ([#109](https://github.com/h3js/crossws/pull/109))

### 🏡 Chore

- **release:** V0.3.1 ([c6d888f](https://github.com/h3js/crossws/commit/c6d888f))
- **example:** Handle binary/blob messages ([38c6baa](https://github.com/h3js/crossws/commit/38c6baa))
- Update eslint config ([d3ab5f8](https://github.com/h3js/crossws/commit/d3ab5f8))
- Update deps ([590a4a7](https://github.com/h3js/crossws/commit/590a4a7))
- Update deno typos ([095c538](https://github.com/h3js/crossws/commit/095c538))
- Update deps ([bef0f4f](https://github.com/h3js/crossws/commit/bef0f4f))
- **examples:** Fix typo ([#107](https://github.com/h3js/crossws/pull/107))
- Remote unused type ([e3c2cf5](https://github.com/h3js/crossws/commit/e3c2cf5))
- Update build config ([3f5a5dc](https://github.com/h3js/crossws/commit/3f5a5dc))
- Fix upgrade hook type ([ee7b282](https://github.com/h3js/crossws/commit/ee7b282))

### ❤️ Contributors

- Pooya Parsa ([@pi0](http://github.com/pi0))
- Luke Hagar ([@LukeHagar](http://github.com/LukeHagar))
- 39sho ([@39sho](http://github.com/39sho))
- Sandro Circi ([@sandros94](http://github.com/sandros94))
- Jamaluddin Rumi <jamal.rumi@icloud.com>

## v0.3.1

[compare changes](https://github.com/h3js/crossws/compare/v0.3.0...v0.3.1)

### 🩹 Fixes

- **types:** `AdapterOptions` type ([#80](https://github.com/h3js/crossws/pull/80))

### 🏡 Chore

- **release:** V0.3.0 ([4a5e168](https://github.com/h3js/crossws/commit/4a5e168))
- Update deps ([567c9fe](https://github.com/h3js/crossws/commit/567c9fe))
- Update changelog ([1f5411a](https://github.com/h3js/crossws/commit/1f5411a))

### ❤️ Contributors

- Pooya Parsa ([@pi0](http://github.com/pi0))
- Hayatosc ([@hayatosc](http://github.com/hayatosc))

## v0.3.0

[compare changes](https://github.com/h3js/crossws/compare/v0.2.4...v0.3.0)

## 🌟 What is new?

### Better stability

Crossws 0.3.x includes an overhaul of refactors, stability improvements, and new features. A new codebase and testing matrix had been implemented ([#55](https://github.com/h3js/crossws/pull/55)) to make sure all supported adapters and runtimes work as expected and are consistent with each other.

### Refined Peer API

The peer object allows easy interaction with connected WebSocket clients from server route hooks ([peer docs](https://crossws.h3.dev/guide/peer)).

To improve Web standards compatibility, accessing upgrade URL and headers is now possible with `peer.request.url` and `peer.request.headers` (**breaking change**), and `peer.addr` is also renamed to `peer.remoteAddress` to improve readability (**breaking change**) and support is increased across providers. You can also use new lazy-generated and secure `peer.id` (UUID v4) for various purposes including temporary sessions or persistent state.

Two new methods are now supported to close connected peers using `peer.close(code, reason)` and `peer.terminate()`. With this new version, you can access a standard [`WebSocket`](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket) interface using `peer.websocket`.

> [!NOTE]
> Today many of the server runtimes don't provide a spec-compliant `WebSocket` API. Crossws uses an internal proxy to polyfill consistent access to `extensions`, `protocol`, and `readyState`. See [compatibility table](https://crossws.h3.dev/guide/peer#compatibility) for more details.

### Refined Message API

On `message` [hook](https://crossws.h3.dev/guide/hooks), you receive a message object containing data from the client ([message docs](https://crossws.h3.dev/guide/message)).

Parsing incoming messages can be tricky across runtimes. Message object now has stable methods `.text()`, `.json()`, `.uint8Array()`, `.arrayBuffer()`, `.blob()` to safely read message as desired format. If you need, you can also access `.rawData`, `.peer`, `.event` (if available), and lazy generated secure UUID v4 `.id`

### Authentication via `upgrade` hook

When you need to authenticate and validate WebSocket clients before they can upgrade, you can now easily use the `upgrade` hook to check incoming URLs and headers/cookies and return a Web Standard [Response](https://developer.mozilla.org/en-US/docs/Web/API/Response) in case you need to abort the upgrade.

### Pubsub with Deno and Cloudflare Durable Objects

One of the common use cases of WebSockets is pubsub. This release adds pub-sub support to [Deno provider](https://crossws.h3.dev/adapters/deno) and also you can globally broadcast messages using `ws.publish` for advanced use cases.

Normally with cloudflare workers, it is not possible to connect multiple peers with each other. Cloudflare [Durable Objects](https://developers.cloudflare.com/durable-objects/) (available on paid plans) allows building collaborative editing tools, interactive chat, multiplayer games, and applications that need coordination among multiple clients.

Crossws provides a new composable method to easily integrate WebSocket handlers with Durable Objects. Hibernation is supported out of the box to reduce billing costs when connected clients are inactive. ([durable object peer docs](https://crossws.h3.dev/adapters/cloudflare#durable-objects))

## Changelog

### 🚀 Enhancements

- ⚠️ Overhaul internal implementation ([#55](https://github.com/h3js/crossws/pull/55))
- ⚠️ Overhaul peer and message interface ([#70](https://github.com/h3js/crossws/pull/70))
- **node, uws:** Automatically detect binary message type ([#53](https://github.com/h3js/crossws/pull/53))
- **peer:** Add `peer.close()` and `peer.terminate()` support ([#36](https://github.com/h3js/crossws/pull/36))
- Cloudflare durable objects support ([#54](https://github.com/h3js/crossws/pull/54)) ([docs](https://crossws.h3.dev/adapters/cloudflare#durable-objects))
- **deno:** Support pub/sub ([#58](https://github.com/h3js/crossws/pull/58))
- Universal access to all peers ([#60](https://github.com/h3js/crossws/pull/60))
- Global publish using `ws.publish` ([#61](https://github.com/h3js/crossws/pull/61))
- Experimental SSE-based adapter to support websocket in limited runtimes ([#62](https://github.com/h3js/crossws/pull/62), [#66](https://github.com/h3js/crossws/pull/66), [#68](https://github.com/h3js/crossws/pull/68)) ([docs](https://crossws.h3.dev/adapters/sse)
- **peer:** Use secure lazy random UUID v4 ([#64](https://github.com/h3js/crossws/pull/64))

### 🩹 Fixes

- Should not serailize binary messages ([#39](https://github.com/h3js/crossws/pull/39))
- **cloudflare-durable:** Restore peer url and id after hibernation ([#71](https://github.com/h3js/crossws/pull/71))

### 💅 Refactors

- ⚠️ Move `peer.ctx` to `peer._internal` ([#59](https://github.com/h3js/crossws/pull/59))
- ⚠️ Remove adapter hooks ([#72](https://github.com/h3js/crossws/pull/72))
- Rename internal crossws to hooks ([bb4c917](https://github.com/h3js/crossws/commit/bb4c917))
- Better internal organization ([2744f21](https://github.com/h3js/crossws/commit/2744f21))

### 📖 Documentation

[#22](https://github.com/h3js/crossws/pull/22), [76fc105](https://github.com/h3js/crossws/commit/76fc105), [7dacb00](https://github.com/h3js/crossws/commit/7dacb00), [#46](https://github.com/h3js/crossws/pull/46), [#45](https://github.com/h3js/crossws/pull/45), [#44](https://github.com/h3js/crossws/pull/44), [a96dca3](https://github.com/h3js/crossws/commit/a96dca3), [898ab49](https://github.com/h3js/crossws/commit/898ab49), [2e49cc3](https://github.com/h3js/crossws/commit/2e49cc3)

### 📦 Build

- Remove optional `uWebSockets.js` dependency ([#52](https://github.com/h3js/crossws/pull/52), [b23b76d](https://github.com/h3js/crossws/commit/b23b76d))
- ⚠️ Esm-only build ([#63](https://github.com/h3js/crossws/pull/63))

### ✅ Tests

- Add adapter tests ([#56](https://github.com/h3js/crossws/pull/56))
- **cloudflare:** Use random port for wrangler inspector ([a46265c](https://github.com/h3js/crossws/commit/a46265c))
- Run tests with web standard `WebSocket` and `EventSource` ([#67](https://github.com/h3js/crossws/pull/67))

### ❤️ Contributors

- Pooya Parsa ([@pi0](http://github.com/pi0))
- Eduardo San Martin Morote ([@posva](http://github.com/posva))
- Alex ([@alexzhang1030](http://github.com/alexzhang1030))
- 39sho ([@39sho](http://github.com/39sho))
- @beer ([@iiio2](http://github.com/iiio2))
- Sébastien Chopin ([@atinux](http://github.com/atinux))
- Pierre Golfier <pro@pedraal.fr>

## v0.2.4

[compare changes](https://github.com/h3js/crossws/compare/v0.2.3...v0.2.4)

### 🚀 Enhancements

- Auto generated peer id ([a3b61f5](https://github.com/h3js/crossws/commit/a3b61f5))
- Basic pubsub support for node ([4bd61ca](https://github.com/h3js/crossws/commit/4bd61ca))

### 💅 Refactors

- Improve peer inspect message ([9f7e1f0](https://github.com/h3js/crossws/commit/9f7e1f0))

### 📖 Documentation

- Update content ([6d78e12](https://github.com/h3js/crossws/commit/6d78e12))

### 🏡 Chore

- Use seperate playground index ([889b37b](https://github.com/h3js/crossws/commit/889b37b))
- Update lockfile ([c119028](https://github.com/h3js/crossws/commit/c119028))
- Update docs ([54e0dca](https://github.com/h3js/crossws/commit/54e0dca))
- Update playground ([a6879bd](https://github.com/h3js/crossws/commit/a6879bd))
- Update example ([0ce11c5](https://github.com/h3js/crossws/commit/0ce11c5))
- Update playground ([cbeb472](https://github.com/h3js/crossws/commit/cbeb472))

### ❤️ Contributors

- Pooya Parsa ([@pi0](http://github.com/pi0))

## v0.2.3

[compare changes](https://github.com/h3js/crossws/compare/v0.2.2...v0.2.3)

### 🩹 Fixes

- **node:** Respect `x-forwarded` for client id ([3f8bd0c](https://github.com/h3js/crossws/commit/3f8bd0c))

### ❤️ Contributors

- Pooya Parsa ([@pi0](http://github.com/pi0))

## v0.2.2

[compare changes](https://github.com/h3js/crossws/compare/v0.2.1...v0.2.2)

### 🩹 Fixes

- **deno:** Pass info ([2c63b37](https://github.com/h3js/crossws/commit/2c63b37))

### 🏡 Chore

- **example:** Handle secure origins ([7f8639f](https://github.com/h3js/crossws/commit/7f8639f))

### ❤️ Contributors

- Pooya Parsa ([@pi0](http://github.com/pi0))

## v0.2.1

[compare changes](https://github.com/h3js/crossws/compare/v0.2.0...v0.2.1)

### 🩹 Fixes

- `$callHook` should check hook existence ([40082ba](https://github.com/h3js/crossws/commit/40082ba))

### 📖 Documentation

- Update usage to 0.2x ([db99a91](https://github.com/h3js/crossws/commit/db99a91))

### ❤️ Contributors

- Pooya Parsa ([@pi0](http://github.com/pi0))

## v0.2.0

[compare changes](https://github.com/h3js/crossws/compare/v0.1.3...v0.2.0)

### 💅 Refactors

- ⚠️ Improve types and api ([2ebacd3](https://github.com/h3js/crossws/commit/2ebacd3))

### 🏡 Chore

- Add new playground ([4e82c55](https://github.com/h3js/crossws/commit/4e82c55))
- Update playground ([ced76fa](https://github.com/h3js/crossws/commit/ced76fa))

#### ⚠️ Breaking Changes

- ⚠️ Improve types and api ([2ebacd3](https://github.com/h3js/crossws/commit/2ebacd3))

### ❤️ Contributors

- Pooya Parsa ([@pi0](http://github.com/pi0))

## v0.1.3

[compare changes](https://github.com/h3js/crossws/compare/v0.1.2...v0.1.3)

### 🏡 Chore

- Add build script to release ([6681afa](https://github.com/h3js/crossws/commit/6681afa))

### ❤️ Contributors

- Pooya Parsa ([@pi0](http://github.com/pi0))

## v0.1.2

[compare changes](https://github.com/h3js/crossws/compare/v0.1.1...v0.1.2)

### 🚀 Enhancements

- Support `uWebSockets.js ([b1de991](https://github.com/h3js/crossws/commit/b1de991))
- Allow access to peer url and headers ([b67bef0](https://github.com/h3js/crossws/commit/b67bef0))
- Dynamic resolver ([cb6721c](https://github.com/h3js/crossws/commit/cb6721c))
- Support upgrade hook to set headers ([91edb54](https://github.com/h3js/crossws/commit/91edb54))
- Pub/sub support for `bun` and `uws` ([a486f45](https://github.com/h3js/crossws/commit/a486f45))

### 💅 Refactors

- Use `@deno/types` ([0026087](https://github.com/h3js/crossws/commit/0026087))
- Use `crossws` interface to call hooks ([7e36eba](https://github.com/h3js/crossws/commit/7e36eba))
- Add `/adapters/uws` ([b51b01c](https://github.com/h3js/crossws/commit/b51b01c))

### 📖 Documentation

- Add link to play online ([ed41540](https://github.com/h3js/crossws/commit/ed41540))
- Migrate to unjs-docs structure v2 ([#13](https://github.com/h3js/crossws/pull/13))
- Update bun ([0c717d8](https://github.com/h3js/crossws/commit/0c717d8))

### 🏡 Chore

- Update examples ([a347e80](https://github.com/h3js/crossws/commit/a347e80))
- Initial docs ([2f3e983](https://github.com/h3js/crossws/commit/2f3e983))
- Add h3 example ([894792a](https://github.com/h3js/crossws/commit/894792a))
- Fix docs workspace root ([a607b89](https://github.com/h3js/crossws/commit/a607b89))
- Update docs ([5f72d42](https://github.com/h3js/crossws/commit/5f72d42))
- Update docs ([52c0e4f](https://github.com/h3js/crossws/commit/52c0e4f))
- Specify `uWebSockets.js` peer dep ([1ef0585](https://github.com/h3js/crossws/commit/1ef0585))

### ❤️ Contributors

- Pooya Parsa ([@pi0](http://github.com/pi0))

## v0.1.1

[compare changes](https://github.com/h3js/crossws/compare/v0.1.0...v0.1.1)

### 💅 Refactors

- Import bun types from @types/bun ([ba40b53](https://github.com/h3js/crossws/commit/ba40b53))

### 📦 Build

- Expose default export for compatibility types ([9934fb5](https://github.com/h3js/crossws/commit/9934fb5))

### 🏡 Chore

- Update lockfile ([53162bd](https://github.com/h3js/crossws/commit/53162bd))
- Update badges ([6e2b296](https://github.com/h3js/crossws/commit/6e2b296))

### ❤️ Contributors

- Pooya Parsa ([@pi0](http://github.com/pi0))

## v0.0.1

### 🏡 Chore

- Update readme ([af705a6](https://github.com/h3js/crossws/commit/af705a6))
- Don't gitignore manual `types` ([ec9330b](https://github.com/h3js/crossws/commit/ec9330b))

### ❤️ Contributors

- Pooya Parsa ([@pi0](http://github.com/pi0))
