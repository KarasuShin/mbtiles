const EARTH_RADIUS = 6371.0088

const degToRad = (degrees: number) => degrees * (Math.PI / 180)

const tileToLon = (tileX: number, zoom: number) => ((tileX / 2 ** zoom) * 360.0) - 180.0

const tileToLat = (tileY: number, zoom: number) => {
  const n = Math.PI - 2 * Math.PI * tileY / 2 ** zoom
  return (180.0 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}

export const calculateTileArea = (zoom: number, tileX: number, tileY: number) => {
  const left = degToRad(tileToLon(tileX, zoom))
  const top = degToRad(tileToLat(tileY, zoom))
  const right = degToRad(tileToLon(tileX + 1, zoom))
  const bottom = degToRad(tileToLat(tileY + 1, zoom))
  return (Math.PI / degToRad(180)) * EARTH_RADIUS ** 2 * Math.abs(Math.sin(top) - Math.sin(bottom)) * Math.abs(left - right)
}
