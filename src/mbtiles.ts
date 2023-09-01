/* eslint-disable no-case-declarations */
import fs from 'fs/promises'
import path from 'path'
import type { UrlWithParsedQuery } from 'url'
import url from 'url'
import qs from 'querystring'
import { Buffer } from 'buffer'
import type { Database } from 'sqlite3'
import sqlite3 from 'sqlite3'
import tiletype from '@mapbox/tiletype'
import { EventEmitter } from 'events'
import type { Stats } from 'fs'
import SphericalMercator from '@mapbox/sphericalmercator'

const sm = new SphericalMercator()

export class MBTiles extends EventEmitter {
  filename: string

  open = false

  private _sqlMode: number

  private _db?: Database

  private _stats?: Stats

  private _info?: any

  constructor(uri: string | UrlWithParsedQuery) {
    super()

    const _uri = url.parse(typeof uri === 'string' ? uri : uri.href, true)

    if (typeof uri === 'string') {
      _uri.pathname = qs.unescape(_uri.pathname ?? '')
    } else if (typeof _uri.query === 'string') {
      _uri.query = qs.parse(_uri.query)
    }

    if (!_uri.pathname) {
      throw new Error(`Invalid URI ${url.format(_uri)}`)
    }

    _uri.query = {
      batch: '100',
      mode: 'rwc',
      ..._uri.query,
    }

    const queryMode = _uri.query?.mode ?? 'rwc'

    const flagEnum = {
      ro: sqlite3.OPEN_READONLY,
      rw: sqlite3.OPEN_READWRITE,
      rwc: sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
    }

    if (typeof queryMode !== 'string' || !['ro', 'rw', 'rwc'].includes(queryMode)) {
      throw new Error('Only supports "ro", "rw", or "rwc" mode.')
    }
    this._sqlMode = flagEnum[queryMode as keyof typeof flagEnum]

    this.setMaxListeners(0)
    this.filename = _uri.pathname
  }

  private _connectDB() {
    return new Promise<Database>((resolve, reject) => {
      const db = new sqlite3.Database(this.filename, this._sqlMode, err => {
        if (err) {
          reject(err)
        }
        resolve(db)
      })
    })
  }

  async connect() {
    this._db = await this._connectDB()
    this._stats = await fs.stat(this.filename)
    this.open = true
    this.emit('open', null)
    return this
  }

  registerProtocols(tilelive: any) {
    tilelive.protocols['mbtiles:'] = MBTiles
  }

  async list(filepath: string) {
    const _filepath = path.resolve(filepath)
    const files = await fs.readdir(_filepath)
    const result: Record<string, string> = {}
    for (const file of files) {
      const name = file.match(/^([\w-]+)\.mbtiles$/)
      if (name) {
        result[name[1]] = `mbtiles://${path.join(_filepath, name[0])}`
      }
    }
    return result
  }

  async findID(filepath: string, id: string) {
    const _filepath = path.resolve(filepath)
    const file = path.join(_filepath, `${id}.mbtiles`)
    await fs.stat(file)
    return `mbtiles://${file}`
  }

  async getInfo() {
    const ensureZooms = async (info: any) => new Promise<any>((resolve, reject) => {
      if ('minzoom' in info && 'maxzoom' in info) {
        resolve(info)
      }
      let remaining = 30
      const zooms: any[] = []
      const query = this._db!.prepare('SELECT zoom_level FROM tiles WHERE zoom_level = ? LIMIT 1', (err: any) => {
        if (err) {
          if (err.errno === 1) {
            return info
          }
          reject(err)
        }

        function done(err: any, info?: any) {
          if (done.sent) {
            return
          }
          if (err) {
            return reject(err)
          }
          resolve(info)
          done.sent = true
        }

        done.sent = false

        for (let i = 0; i < remaining; i++) {
          query.get<any>(i, (err, row) => {
            if (err) { return done(err) }
            if (row) {
              zooms.push(row.zoom_level)
            }
            if (--remaining === 0) {
              if (!zooms.length) {
                return resolve(info)
              }
              zooms.sort((a, b) => a < b ? -1 : 1)
              info.minzoom = zooms[0]
              info.maxzoom = zooms.pop()
              return done(null, info)
            }
          })
        }

        query.finalize()
      })
    })

    const ensureBounds = async (info: any) => new Promise<any>((resolve, reject) => {
      if ('bounds' in info) {
        resolve(info)
      }
      if (!('minzoom' in info)) {
        resolve(info)
      }
      this._db!.get<any>(
        'SELECT MAX(tile_column) AS maxx, '
              + 'MIN(tile_column) AS minx, MAX(tile_row) AS maxy, '
              + 'MIN(tile_row) AS miny FROM tiles '
              + 'WHERE zoom_level = ?',
        info.minzoom,
        (err, row) => {
          if (err) {
            return reject(err)
          }
          if (!row) {
            resolve(info)
          }

          // @TODO this breaks a little at zoom level zero
          const urTile = sm.bbox(row.maxx, row.maxy, info.minzoom, true)
          const llTile = sm.bbox(row.minx, row.miny, info.minzoom, true)
          // @TODO bounds are limited to "sensible" values here
          // as sometimes tilesets are rendered with "negative"
          // and/or other extremity tiles. Revisit this if there
          // are actual use cases for out-of-bounds bounds.
          info.bounds = [
            llTile[0] > -180 ? llTile[0] : -180,
            llTile[1] > -90 ? llTile[1] : -90,
            urTile[2] < 180 ? urTile[2] : 180,
            urTile[3] < 90 ? urTile[3] : 90,
          ]
          resolve(info)
        })
    })

    const ensureCenter = (info: any) => {
      if ('center' in info) {
        return info
      }
      if (
        !('bounds' in info)
        || !('minzoom' in info)
        || !('maxzoom' in info)
      ) {
        return info
      }
      const range = info.maxzoom - info.minzoom
      info.center = [
        (info.bounds[2] - info.bounds[0]) / 2 + info.bounds[0],
        (info.bounds[3] - info.bounds[1]) / 2 + info.bounds[1],
        range <= 1 ? info.maxzoom : Math.floor(range * 0.5) + info.minzoom,
      ]
      return info
    }

    return new Promise((resolve, reject) => {
      if (!this._db) {
        return reject(new Error('MBTiles not yet loaded'))
      }

      if (this._info) {
        resolve(this._info)
      }

      const basename = path.basename(this.filename)
      const id = path.basename(this.filename, path.extname(this.filename))
      const filesize = this._stats!.size
      let info: any = {
        basename,
        filesize,
        id,
      }
      this._db.all<any>('SELECT name, value FROM metadata', async (err, rows) => {
        if (err) {
          return reject(err)
        }
        if (rows) {
          for (const row of rows) {
            switch (row.name) {
            // The special "json" key/value pair allows JSON to be serialized
            // and merged into the metadata of an MBTiles based source. This
            // enables nested properties and non-string datatypes to be
            // captured by the MBTiles metadata table.
              case 'json':
                const jsondata = JSON.parse(row.value)
                Object.keys(jsondata).reduce((memo, key) => {
                  memo[key] = memo[key] || jsondata[key]
                  return memo
                }, info)
                break
              case 'minzoom':
              case 'maxzoom':
                info[row.name] = parseInt(row.value, 10)
                break
              case 'center':
              case 'bounds':
                info[row.name] = row.value.split(',').map(parseFloat)
                break
              default:
                info[row.name] = row.value
                break
            }
          }
        }

        // Guarantee that we always return proper schema type, even if 'tms' is specified in metadata
        info.scheme = 'xyz'

        info = await ensureZooms(info)
        info = await ensureBounds(info)
        info = await ensureCenter(info)
        this._info = info
        resolve(info)
      })
    })
  }

  async getTile(x: number, y: number, z: number) {
    if (!this.open) {
      throw new Error('MBTiles not yet loaded')
    }
    y = (1 << z) - 1 - y
    const sql = 'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?'
    return new Promise<{
      grid: Buffer
      headers: Record<string, string>
    }>((resolve, reject) => {
      this._db?.get(sql, z, x, y, (err: any, row: any) => {
        if ((!err && !row) || (err && err.errno === 1)) {
          reject(new Error('Tile does not exist'))
        } else if (err) {
          reject(err)
        } else if (!row.tile_data || !Buffer.isBuffer(row.tile_data)) {
          const err = new Error('Tile is invalid')
          Object.defineProperty(err, 'code', {
            value: 'EINVALIDTILE',
          })
          reject(err)
        } else {
          const headers = tiletype.headers(row.tile_data) as Record<string, string>
          headers['Last-Modified'] = new Date(this._stats!.mtime).toUTCString()
          headers.ETag = `${this._stats!.size}-${Number(this._stats!.mtime)}`
          resolve({
            grid: row.tile_data,
            headers,
          })
        }
      })
    })
  }

  close() {
    this._db?.close()
  }
}
