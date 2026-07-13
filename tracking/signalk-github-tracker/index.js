/*
 * signalk-github-tracker  v1.2
 * ----------------------------
 * Signal K-plugin voor de Cerbo GX (Venus OS Large) aan boord van de Pieternel (Vindö 65 S).
 *
 * Bestanden in de GitHub-repo:
 *  - data/track.json          : archief-index + trackpunten van de lopende maand
 *  - data/track-YYYY-MM.json  : afgesloten maanden (immutable archief)
 *  - data/data.json           : dashboard, laatste 48 u op 5-min-resolutie
 *  - data/hourly.json         : uurgemiddelden hele reis (klassement), 1x/uur gepusht
 *
 * Zuinig met data (Starlink!):
 *  - sha-cache: geen GET vóór elke PUT; alleen bij conflict wordt opnieuw opgehaald
 *  - track gesplitst per maand: upload blijft klein, archief wordt nooit opnieuw verstuurd
 *  - intern wordt per minuut gemeten (vlagen!), gepubliceerd op 5-min-resolutie
 *
 * - Offline-buffer: alles staat lokaal in /data en gaat mee bij de volgende poging.
 * - Ankermodus: geen beweging = alleen elk uur een "heartbeat"-trackpunt.
 */

const fs = require('fs')
const path = require('path')

const KNOTS_PER_MS = 1.94384
const DEG_PER_RAD = 180 / Math.PI
const SAMPLE_MS = 10000        // 10 s — vlagen vang je alleen met snel samplen
const SAVE_EVERY_MIN = 5       // state elke 5 min naar schijf (flash sparen)

module.exports = function (app) {
  const plugin = {}
  plugin.id = 'signalk-github-tracker'
  plugin.name = 'GitHub Tracker (Route du Soleil)'
  plugin.description =
    'Pusht periodiek track en dashboard-data naar een GitHub-repo (data-zuinig voor Starlink)'

  let logTimer = null
  let pushTimer = null
  let sampleTimer = null
  let minuteTimer = null

  let stateFile = null
  let lastLogged = null
  let pushing = false
  let minutesSinceSave = 0

  // ---- persistente state ----
  let trackPoints = []      // trackpunten lopende maand
  let trackMonth = null     // 'YYYY-MM' van trackPoints
  let archivedMonths = []   // afgesloten maanden die al op GitHub staan
  let archivePending = null // { month, points } — nog te archiveren maand
  let unpushed = 0          // trackpunten sinds laatste geslaagde push
  let monthsChanged = false
  let recent = []           // minuutrecords (intern, 1-min resolutie), laatste N uur
  let hourly = []           // uurrecords, hele reis
  let shas = {}             // repo-pad -> laatst bekende sha (scheelt een GET per push)
  let dataDirty = false
  let hourlyDirty = false

  let minAcc = null
  let hourAcc = null

  plugin.schema = {
    type: 'object',
    required: ['githubToken', 'githubOwner', 'githubRepo'],
    properties: {
      githubToken: {
        type: 'string',
        title: 'GitHub-token',
        description:
          'Fine-grained personal access token met alléén Contents: read & write op de website-repo'
      },
      githubOwner: { type: 'string', title: 'GitHub-gebruikersnaam (owner)' },
      githubRepo: { type: 'string', title: 'Repository-naam' },
      branch: { type: 'string', title: 'Branch', default: 'main' },
      filePath: {
        type: 'string',
        title: 'Pad van het trackbestand in de repo',
        default: 'data/track.json'
      },
      logIntervalMinutes: {
        type: 'number',
        title: 'Log-interval (minuten)',
        description: 'Hoe vaak een trackpunt wordt vastgelegd tijdens het varen',
        default: 10
      },
      pushIntervalMinutes: {
        type: 'number',
        title: 'Push-interval (minuten)',
        description: 'Hoe vaak naar GitHub wordt gepusht (op zee: 30-60 zet nog minder data om)',
        default: 15
      },
      minMoveMeters: {
        type: 'number',
        title: 'Minimale verplaatsing (meter)',
        description: 'Minder verplaatsing dan dit = voor anker/in de haven, dan alleen heartbeat',
        default: 75
      },
      heartbeatMinutes: {
        type: 'number',
        title: 'Heartbeat-interval (minuten)',
        description: 'Punt loggen ook zonder beweging, zodat "laatst gezien" actueel blijft',
        default: 60
      },
      dashboardEnabled: {
        type: 'boolean',
        title: 'Dashboard-data loggen (wind/SOG/diepte → data.json)',
        default: true
      },
      dataFilePath: {
        type: 'string',
        title: 'Pad van het dashboard-bestand in de repo',
        default: 'data/data.json'
      },
      hourlyFilePath: {
        type: 'string',
        title: 'Pad van het uurgemiddelden-bestand in de repo',
        default: 'data/hourly.json'
      },
      recentHours: {
        type: 'number',
        title: 'Uren dashboard-data bewaren',
        default: 48
      }
    }
  }

  // ---------- helpers ----------

  function haversineMeters (lat1, lon1, lat2, lon2) {
    const R = 6371000
    const dLat = ((lat2 - lat1) * Math.PI) / 180
    const dLon = ((lon2 - lon1) * Math.PI) / 180
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(a))
  }

  function getValue (skPath) {
    const v = app.getSelfPath(skPath)
    return v && v.value !== undefined && v.value !== null ? v.value : null
  }

  const r1 = v => (v === null ? null : Math.round(v * 10) / 10)
  const monthOf = iso => iso.slice(0, 7)

  function circMeanDeg (sinSum, cosSum, n) {
    if (n === 0) return null
    let deg = Math.atan2(sinSum / n, cosSum / n) * DEG_PER_RAD
    if (deg < 0) deg += 360
    return Math.round(deg)
  }

  // ---------- state op schijf ----------

  function saveState () {
    try {
      fs.writeFileSync(stateFile, JSON.stringify({
        trackPoints, trackMonth, archivedMonths, archivePending, unpushed,
        recent, hourly, shas
      }))
    } catch (e) {
      app.error('Kon state niet opslaan: ' + e.message)
    }
  }

  function loadState () {
    try {
      if (fs.existsSync(stateFile)) {
        const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
        trackPoints = s.trackPoints || []
        trackMonth = s.trackMonth || null
        archivedMonths = s.archivedMonths || []
        archivePending = s.archivePending || null
        unpushed = s.unpushed || 0
        recent = s.recent || []
        hourly = s.hourly || []
        shas = s.shas || {}
        return true
      }
    } catch (e) {
      app.error('Kon state niet lezen, start leeg: ' + e.message)
    }
    return false
  }

  // migratie vanaf v1.1 (aparte buffer- en dashboardbestanden)
  function migrateOldState (dataDir) {
    const oldPending = path.join(dataDir, 'pending-points.json')
    const oldDash = path.join(dataDir, 'dashboard-state.json')
    try {
      if (fs.existsSync(oldPending)) {
        const pts = JSON.parse(fs.readFileSync(oldPending, 'utf8'))
        if (Array.isArray(pts) && pts.length) {
          trackPoints = trackPoints.concat(pts)
          trackMonth = trackMonth || monthOf(pts[pts.length - 1][2])
          unpushed += pts.length
        }
        fs.unlinkSync(oldPending)
        app.debug('Oude buffer gemigreerd')
      }
      if (fs.existsSync(oldDash)) {
        const s = JSON.parse(fs.readFileSync(oldDash, 'utf8'))
        if (Array.isArray(s.recent) && !recent.length) recent = s.recent
        if (Array.isArray(s.hourly) && !hourly.length) hourly = s.hourly
        fs.unlinkSync(oldDash)
        app.debug('Oude dashboard-state gemigreerd')
      }
    } catch (e) {
      app.error('Migratie oude state mislukt (ga door): ' + e.message)
    }
  }

  // ---------- track loggen ----------

  function logPoint (options) {
    const pos = getValue('navigation.position')
    if (!pos || typeof pos.latitude !== 'number') {
      app.debug('Geen positie beschikbaar, sla over')
      return
    }

    const now = Date.now()
    if (lastLogged) {
      const moved = haversineMeters(
        lastLogged.lat, lastLogged.lon, pos.latitude, pos.longitude
      )
      const sinceMin = (now - lastLogged.t) / 60000
      if (moved < options.minMoveMeters && sinceMin < options.heartbeatMinutes) {
        app.debug(`Voor anker (${Math.round(moved)} m), geen nieuw punt`)
        return
      }
    }

    const sogMs = getValue('navigation.speedOverGround')
    const cogRad = getValue('navigation.courseOverGroundTrue')
    const nowIso = new Date(now).toISOString()

    const point = [
      Math.round(pos.latitude * 1e5) / 1e5,
      Math.round(pos.longitude * 1e5) / 1e5,
      nowIso,
      sogMs === null ? null : r1(sogMs * KNOTS_PER_MS),
      cogRad === null ? null : Math.round(cogRad * DEG_PER_RAD)
    ]

    // maandwissel: lopende maand klaarzetten als archief
    const m = monthOf(nowIso)
    if (trackMonth && m !== trackMonth) {
      if (archivePending) {
        // vorige archivering is nog niet gelukt — voeg samen zodat niets verloren gaat
        archivePending.points = archivePending.points.concat(trackPoints)
      } else {
        archivePending = { month: trackMonth, points: trackPoints }
      }
      trackPoints = []
      app.debug(`Maandwissel: ${trackMonth} klaargezet voor archief`)
    }
    trackMonth = m

    trackPoints.push(point)
    unpushed++
    lastLogged = { lat: point[0], lon: point[1], t: now }
    saveState()
    app.debug(`Punt gelogd: ${point[0]}, ${point[1]} (${unpushed} niet gepusht)`)
  }

  // ---------- dashboard: 10s-samples -> minuutrecord -> uurrecord ----------

  function takeSample () {
    let windMs = getValue('environment.wind.speedTrue')
    if (windMs === null) windMs = getValue('environment.wind.speedApparent')
    const dirRad = getValue('environment.wind.directionTrue')
    const sogMs = getValue('navigation.speedOverGround')

    if (!minAcc) {
      minAcc = {
        twsSum: 0, twsN: 0, twsMax: null,
        sogSum: 0, sogN: 0,
        dirSin: 0, dirCos: 0, dirN: 0
      }
    }
    if (windMs !== null) {
      const kn = windMs * KNOTS_PER_MS
      minAcc.twsSum += kn
      minAcc.twsN++
      if (minAcc.twsMax === null || kn > minAcc.twsMax) minAcc.twsMax = kn
    }
    if (sogMs !== null) {
      minAcc.sogSum += sogMs * KNOTS_PER_MS
      minAcc.sogN++
    }
    if (dirRad !== null) {
      minAcc.dirSin += Math.sin(dirRad)
      minAcc.dirCos += Math.cos(dirRad)
      minAcc.dirN++
    }
  }

  function closeMinute (options) {
    const now = new Date()
    const a = minAcc
    minAcc = null

    let depth = getValue('environment.depth.belowTransducer')
    if (depth === null) depth = getValue('environment.depth.belowSurface')
    const cogRad = getValue('navigation.courseOverGroundTrue')

    const rec = [
      now.toISOString(),
      a && a.sogN ? r1(a.sogSum / a.sogN) : null,          // SOG kn
      a && a.twsN ? r1(a.twsSum / a.twsN) : null,          // wind kn (gemiddeld)
      a && a.twsMax !== null ? r1(a.twsMax) : null,        // vlaag kn (max 10s-sample)
      a ? circMeanDeg(a.dirSin, a.dirCos, a.dirN) : null,  // windrichting °
      depth === null ? null : r1(depth),                   // diepte m
      cogRad === null ? null : Math.round(cogRad * DEG_PER_RAD) // COG °
    ]

    // niets gemeten (instrumenten uit in de haven)? geen record
    if (rec.slice(1).every(v => v === null)) return

    recent.push(rec)
    const cutoff = Date.now() - (options.recentHours || 48) * 3600000
    while (recent.length && new Date(recent[0][0]).getTime() < cutoff) recent.shift()

    // uur-accumulator
    const hourKey = rec[0].slice(0, 13)
    if (hourAcc && hourAcc.key !== hourKey) closeHour()
    if (!hourAcc) {
      hourAcc = {
        key: hourKey,
        sogSum: 0, sogN: 0, sogMax: null,
        twsSum: 0, twsN: 0, gustMax: null,
        dirSin: 0, dirCos: 0, dirN: 0
      }
    }
    if (rec[1] !== null) {
      hourAcc.sogSum += rec[1]; hourAcc.sogN++
      if (hourAcc.sogMax === null || rec[1] > hourAcc.sogMax) hourAcc.sogMax = rec[1]
    }
    if (rec[2] !== null) { hourAcc.twsSum += rec[2]; hourAcc.twsN++ }
    if (rec[3] !== null && (hourAcc.gustMax === null || rec[3] > hourAcc.gustMax)) {
      hourAcc.gustMax = rec[3]
    }
    if (rec[4] !== null) {
      const rad = rec[4] / DEG_PER_RAD
      hourAcc.dirSin += Math.sin(rad); hourAcc.dirCos += Math.cos(rad); hourAcc.dirN++
    }

    dataDirty = true
    if (++minutesSinceSave >= SAVE_EVERY_MIN) {
      minutesSinceSave = 0
      saveState()
    }
  }

  function closeHour () {
    const a = hourAcc
    hourAcc = null
    if (!a || (a.sogN === 0 && a.twsN === 0)) return
    hourly.push([
      a.key + ':00:00Z',
      a.sogN ? r1(a.sogSum / a.sogN) : null,
      a.sogMax,
      a.twsN ? r1(a.twsSum / a.twsN) : null,
      a.gustMax,
      circMeanDeg(a.dirSin, a.dirCos, a.dirN)
    ])
    hourlyDirty = true
  }

  // publicatie: 1-min records samenvatten naar 5-min buckets (~5x kleiner bestand)
  function downsample5min (records) {
    const buckets = new Map()
    for (const r of records) {
      const key = Math.floor(new Date(r[0]).getTime() / 300000)
      let b = buckets.get(key)
      if (!b) {
        b = { t: r[0], sogSum: 0, sogN: 0, twsSum: 0, twsN: 0, gust: null, dirSin: 0, dirCos: 0, dirN: 0, depSum: 0, depN: 0, cog: null }
        buckets.set(key, b)
      }
      if (r[1] !== null) { b.sogSum += r[1]; b.sogN++ }
      if (r[2] !== null) { b.twsSum += r[2]; b.twsN++ }
      if (r[3] !== null && (b.gust === null || r[3] > b.gust)) b.gust = r[3]
      if (r[4] !== null) {
        const rad = r[4] / DEG_PER_RAD
        b.dirSin += Math.sin(rad); b.dirCos += Math.cos(rad); b.dirN++
      }
      if (r[5] !== null) { b.depSum += r[5]; b.depN++ }
      if (r[6] !== null) b.cog = r[6]
    }
    return [...buckets.keys()].sort((x, y) => x - y).map(k => {
      const b = buckets.get(k)
      return [
        b.t,
        b.sogN ? r1(b.sogSum / b.sogN) : null,
        b.twsN ? r1(b.twsSum / b.twsN) : null,
        b.gust,
        circMeanDeg(b.dirSin, b.dirCos, b.dirN),
        b.depN ? r1(b.depSum / b.depN) : null,
        b.cog
      ]
    })
  }

  // ---------- GitHub ----------

  function ghHeaders (options) {
    return {
      Authorization: `Bearer ${options.githubToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'signalk-github-tracker',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  }

  function apiUrl (options, filePath) {
    return (
      `https://api.github.com/repos/${options.githubOwner}/${options.githubRepo}` +
      `/contents/${filePath}`
    )
  }

  async function ghGetSha (options, filePath) {
    const res = await fetch(
      `${apiUrl(options, filePath)}?ref=${options.branch || 'main'}`,
      { headers: ghHeaders(options) }
    )
    if (res.status === 404) return undefined
    if (!res.ok) throw new Error(`GET ${filePath} ${res.status} ${await res.text()}`)
    return (await res.json()).sha
  }

  async function ghGetJson (options, filePath) {
    const res = await fetch(
      `${apiUrl(options, filePath)}?ref=${options.branch || 'main'}`,
      { headers: ghHeaders(options) }
    )
    if (!res.ok) return null
    const body = await res.json()
    shas[filePath] = body.sha
    try {
      return JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'))
    } catch (e) {
      return null
    }
  }

  // PUT met sha-cache; bij conflict (409/422) éénmalig sha ophalen en opnieuw proberen
  async function ghPut (options, filePath, obj, message, retried) {
    const res = await fetch(apiUrl(options, filePath), {
      method: 'PUT',
      headers: ghHeaders(options),
      body: JSON.stringify({
        message,
        content: Buffer.from(JSON.stringify(obj)).toString('base64'),
        branch: options.branch || 'main',
        ...(shas[filePath] ? { sha: shas[filePath] } : {})
      })
    })
    if (res.ok) {
      const body = await res.json()
      shas[filePath] = body.content && body.content.sha
      return
    }
    if ((res.status === 409 || res.status === 422) && !retried) {
      app.debug(`sha-conflict op ${filePath}, haal opnieuw op`)
      shas[filePath] = await ghGetSha(options, filePath)
      return ghPut(options, filePath, obj, message, true)
    }
    throw new Error(`PUT ${filePath} ${res.status} ${await res.text()}`)
  }

  async function pushToGithub (options) {
    if (pushing) return
    pushing = true
    app.debug(
      `Push-poging: ${unpushed} trackpunten, archief ${archivePending ? archivePending.month : '-'}, ` +
      `dashboard ${dataDirty ? 'ja' : 'nee'}, uur ${hourlyDirty ? 'ja' : 'nee'}`
    )
    try {
      const nowIso = new Date().toISOString()

      // 1. afgesloten maand archiveren (eenmalig per maand)
      if (archivePending) {
        const p = `data/track-${archivePending.month}.json`
        await ghPut(options, p,
          { updated: nowIso, points: archivePending.points },
          `track: archief ${archivePending.month} (${archivePending.points.length} punten)`)
        archivedMonths.push(archivePending.month)
        archivePending = null
        monthsChanged = true
      }

      // 2. lopende track (index + punten van deze maand)
      if (unpushed > 0 || monthsChanged) {
        await ghPut(options, options.filePath,
          { updated: nowIso, months: archivedMonths, points: trackPoints },
          `track: ${trackPoints.length} punt(en) in ${trackMonth || '-'} t/m ${nowIso}`)
        unpushed = 0
        monthsChanged = false
      }

      // 3. dashboard (5-min resolutie)
      if (options.dashboardEnabled !== false && dataDirty) {
        await ghPut(options, options.dataFilePath || 'data/data.json',
          { updated: nowIso, recent: downsample5min(recent) },
          `data: dashboard t/m ${nowIso}`)
        dataDirty = false
      }

      // 4. uurgemiddelden (alleen als er een nieuw uur bij is)
      if (options.dashboardEnabled !== false && hourlyDirty) {
        await ghPut(options, options.hourlyFilePath || 'data/hourly.json',
          { updated: nowIso, hourly },
          `data: uurgemiddelden t/m ${nowIso}`)
        hourlyDirty = false
      }

      saveState()
      const total = archivedMonths.length
        ? `${trackPoints.length} punten deze maand (+${archivedMonths.length} maand(en) archief)`
        : `${trackPoints.length} trackpunten`
      app.setPluginStatus(`${total} online, laatste push ${new Date().toLocaleTimeString()}`)
      app.debug('Push geslaagd')
    } catch (e) {
      app.error(`Push mislukt (${unpushed} trackpunten in buffer): ${e.message}`)
      app.setPluginError(`Push mislukt (${unpushed} trackpunten in buffer): ${e.message}`)
    } finally {
      pushing = false
    }
  }

  // verse install: state terughalen uit GitHub zodat er niets kwijt is
  async function recoverFromGithub (options) {
    try {
      const track = await ghGetJson(options, options.filePath)
      if (track) {
        if (Array.isArray(track.points) && track.points.length) {
          trackPoints = track.points.concat(trackPoints)
          trackMonth = trackMonth || monthOf(track.points[track.points.length - 1][2])
        }
        if (Array.isArray(track.months)) archivedMonths = track.months
        app.debug(`Track hersteld uit GitHub (${trackPoints.length} punten, ${archivedMonths.length} maanden archief)`)
      }
      const h = await ghGetJson(options, options.hourlyFilePath || 'data/hourly.json')
      if (h && Array.isArray(h.hourly) && !hourly.length) hourly = h.hourly
      // data.json bewust niet hersteld: 5-min resolutie, dashboard vult zich vanzelf weer
      saveState()
    } catch (e) {
      app.debug('Herstel uit GitHub niet gelukt (start leeg): ' + e.message)
    }
  }

  // ---------- lifecycle ----------

  plugin.start = function (options) {
    const dataDir = app.getDataDirPath()
    stateFile = path.join(dataDir, 'tracker-state.json')

    const hadState = loadState()
    migrateOldState(dataDir)
    if (!hadState) recoverFromGithub(options)

    const logMs = Math.max(1, options.logIntervalMinutes || 10) * 60000
    const pushMs = Math.max(1, options.pushIntervalMinutes || 15) * 60000

    setTimeout(() => logPoint(options), 30000)
    logTimer = setInterval(() => logPoint(options), logMs)
    pushTimer = setInterval(() => pushToGithub(options), pushMs)

    if (options.dashboardEnabled !== false) {
      sampleTimer = setInterval(takeSample, SAMPLE_MS)
      minuteTimer = setInterval(() => closeMinute(options), 60000)
    }

    app.setPluginStatus(
      `Actief — track elke ${options.logIntervalMinutes || 10} min` +
      (options.dashboardEnabled !== false ? ', dashboard elke minuut' : '') +
      `, push elke ${options.pushIntervalMinutes || 15} min`
    )
  }

  plugin.stop = function () {
    ;[logTimer, pushTimer, sampleTimer, minuteTimer].forEach(t => t && clearInterval(t))
    logTimer = pushTimer = sampleTimer = minuteTimer = null
    if (stateFile) saveState()
  }

  return plugin
}
