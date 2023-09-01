# @karasushin/mbtiles

[![npm package](https://img.shields.io/npm/v/@karasushin/mbtiles.svg)](https://www.npmjs.com/package/@karasushin/mbtiles)

`@karasushin/mbtiles` is a refactored version of [node-mbtiles](https://github.com/mapbox/node-mbtiles) with TypeScript and adds promise support.

# Installation

```
pnpm add @karasushin/mbtiles
```

# Usage
```typescript
import { Mbtiles } from '@karasushin/mbtiles'

const mbtiles = new Mbtiles('mbtiles://...')

await mbtiles.connect()
await mbtiles.getInfo()
await mbtiles.getTile(x, y, z)
await mbtiles.close()
```