// ==UserScript==
// @name         Max Subtitle Downloader
// @namespace    https://subtiltee.com
// @version      2.5.1
// @description  Download Max (HBO Max) subtitles for the current video - Simple & Free. For batch download (all languages/seasons) and better UX, get the full extension!
// @author       Subtiltee
// @match        https://*.hbomax.com/*
// @match        https://play.max.com/*
// @icon         https://www.hbomax.com/favicon.ico
// @license      Proprietary
// @grant        none
// @inject-into  page
// @run-at       document-start
// @homepageURL  https://subtiltee.com/subtitle-downloader
// @supportURL   https://subtiltee.com/subtitle-downloader
// ==/UserScript==

;(function () {
  'use strict'

  // ============================================================
  // CONFIGURATION
  // ============================================================

  const CONFIG = {
    platform: 'hbomax',
    platformName: 'Max',
    colors: {
      primary: '#002be7',
      secondary: '#001eb3',
      background: '#0d0d0d',
      surface: '#1a1a1a',
      text: '#ffffff',
      textMuted: '#888888',
      border: '#333333',
    },
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    stores: {
      chrome:
        'https://chromewebstore.google.com/detail/subtitle-downloader-for-y/flnhbocnpgofdjnmhogoanlilfmeneph',
      firefox: 'https://addons.mozilla.org/en-US/firefox/addon/subtitles-streaming-dl',
      edge: 'https://microsoftedge.microsoft.com/addons/detail/subtitle-downloader-for-y/pgcpmjnfaedbodloldemfgdoccfgaecp',
    },
    websiteUrl: 'https://subtiltee.com/subtitle-downloader',
  }

  const UTM_SOURCE = 'github';
  const UTM_MEDIUM = 'userscript';

  // ============================================================
  // UTILITIES
  // ============================================================

  function log(...args) {
    console.log(`[Max Subtitle DL]`, ...args)
  }

  function logError(...args) {
    console.error(`[Max Subtitle DL]`, ...args)
  }

  function downloadFile(content, filename) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  function detectBrowser() {
    const ua = navigator.userAgent
    if (ua.includes('Edg/')) return 'edge'
    if (ua.includes('Firefox/')) return 'firefox'
    return 'chrome'
  }

  function getStoreUrl(browser = null) {
    const b = browser || detectBrowser()
    const base = CONFIG.stores[b] || CONFIG.stores.chrome
    return `${base}?utm_source=${UTM_SOURCE}&utm_medium=${UTM_MEDIUM}&utm_campaign=hbomax`
  }

  function getWebsiteUrl() {
    return `${CONFIG.websiteUrl}?ref=${UTM_SOURCE}&utm_source=${UTM_SOURCE}&utm_medium=${UTM_MEDIUM}&utm_campaign=hbomax`
  }

  // Extract { contentId, episodeId, videoId } from a page URL or a CMS API URL.
  // Supported: /video/watch/{contentId}[/{episodeId}] and /cms/routes/video/watch/{contentId}[/{episodeId}]
  // Episodes of a show can share the same contentId, so the cache key must include episodeId.
  function extractVideoIds(url) {
    if (!url || typeof url !== 'string') return null
    const match = url.match(/\/(?:cms\/routes\/)?video\/watch\/([a-f0-9-]{36})(?:\/([a-f0-9-]{36}))?/)
    if (!match) return null
    const contentId = match[1]
    const episodeId = match[2] || null
    return { contentId, episodeId, videoId: episodeId ? `${contentId}+${episodeId}` : contentId }
  }

  function getVideoId() {
    return extractVideoIds(window.location.href)?.videoId || null
  }

  // Short ID used in the downloaded filename (episodeId when present, contentId otherwise)
  function getFileId() {
    const ids = extractVideoIds(window.location.href)
    return ids ? ids.episodeId || ids.contentId : 'video'
  }

  function sanitizeFilename(name) {
    return name.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim()
  }

  function getLocalizedLanguageName(isoCode) {
    try {
      const userLocale = navigator.language || 'en'
      const languageNames = new Intl.DisplayNames([userLocale], { type: 'language' })
      return languageNames.of(isoCode) || isoCode
    } catch (e) {
      return isoCode
    }
  }

  // ============================================================
  // HBO MAX SUBTITLE LOGIC
  // ============================================================

  const HBOState = {
    videoId: null,
    tracks: {},
    lastMpdUrl: null,
    // Every MPD URL already handled (hooked or recovered), so the late-injection rescue
    // never re-reads a manifest that was already processed (e.g. the previous episode's).
    seenMpdUrls: new Set(),
    // performance.now() of the last navigation to a watch page: the rescue only trusts
    // MPD requests started after it.
    watchStartedAt: 0,
    // Set as soon as the player asks for a manifest, to tell "waiting for the player"
    // apart from "reading subtitles" in the status line.
    manifestRequested: false,
    videoInfo: {
      title: null,
      season: null,
      episode: null,
      isSerie: false,
    },
  }

  // The default Resource Timing buffer (~250 entries) fills up within seconds on HBO Max;
  // once full the browser stops recording, which would blind the late-injection rescue.
  try {
    performance.setResourceTimingBufferSize(5000)
  } catch (e) {}

  function clearState(newVideoId = null) {
    HBOState.videoId = newVideoId
    HBOState.videoInfo = { title: null, season: null, episode: null, isSerie: false }
    HBOState.watchStartedAt = performance.now()
    HBOState.manifestRequested = false

    const titleEl = document.getElementById('subtiltee-video-title')
    if (titleEl) {
      titleEl.textContent = ''
      titleEl.style.display = 'none'
    }

    refreshSubtitleUI(true)
  }

  function updateTitleDisplay() {
    const titleEl = document.getElementById('subtiltee-video-title')
    if (titleEl && HBOState.videoInfo.title) {
      let displayTitle = HBOState.videoInfo.title
      if (HBOState.videoInfo.isSerie && HBOState.videoInfo.season) {
        displayTitle += ` (S${HBOState.videoInfo.season}E${HBOState.videoInfo.episode})`
      }
      titleEl.textContent = displayTitle
      titleEl.style.display = 'block'
    }
  }

  function getAvailableSubtitles() {
    const videoId = getVideoId()
    return videoId ? HBOState.tracks[videoId] || [] : []
  }

  function parseDurationToSeconds(duration) {
    const match = duration.match(/^PT(?:(\d+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?$/)
    if (!match) return 0
    const hours = match[1] ? parseInt(match[1], 10) : 0
    const minutes = match[2] ? parseFloat(match[2]) : 0
    const seconds = match[3] ? parseFloat(match[3]) : 0
    return hours * 3600 + minutes * 60 + seconds
  }

  // Keep only the main-content Periods of a multi-Period MPD (drops ads, recap pre-roll, post-roll).
  // Each Period gets an (audio_count, text_count) signature; the signature carrying the most
  // TOTAL seconds is the content. The old rule (most frequent signature among Periods >= 60s)
  // broke ties by document order and could keep an 86s "previously on" pre-roll over a
  // 57min episode, truncating the subtitles to the first ~86s.
  function filterContentPeriods(allPeriods) {
    if (allPeriods.length === 0) return []
    if (allPeriods.length === 1) {
      const period = allPeriods[0]
      const durationAttr = period.getAttribute('duration')
      const duration = durationAttr ? parseDurationToSeconds(durationAttr) : 0
      return [{ period, duration }]
    }
    const periodsData = []
    const signatureDurations = new Map()
    for (const period of allPeriods) {
      const durationAttr = period.getAttribute('duration')
      const duration = durationAttr ? parseDurationToSeconds(durationAttr) : 0
      const langsOf = (type) =>
        new Set(
          Array.from(period.querySelectorAll(`AdaptationSet[contentType="${type}"]`))
            .map((as) => as.getAttribute('lang'))
            .filter(Boolean)
        )
      const signature = `${langsOf('audio').size}a_${langsOf('text').size}t`
      periodsData.push({ period, duration, signature })
      signatureDurations.set(signature, (signatureDurations.get(signature) || 0) + duration)
    }
    let mainContentSignature = null,
      maxDuration = 0
    for (const [sig, total] of signatureDurations.entries()) {
      if (total > maxDuration) {
        maxDuration = total
        mainContentSignature = sig
      }
    }
    if (!mainContentSignature)
      return periodsData.map((p) => ({ period: p.period, duration: p.duration }))
    // No duration gate: it would drop legitimately short content Periods (NO_ADS layout)
    const kept = periodsData.filter((p) => p.signature === mainContentSignature)
    log(`Kept ${kept.length}/${periodsData.length} Period(s), content signature ${mainContentSignature}`)
    return kept.map((p) => ({ period: p.period, duration: p.duration }))
  }

  function parseMpdContent(mpdContent, mpdUrl) {
    try {
      const parser = new DOMParser()
      const doc = parser.parseFromString(mpdContent, 'text/xml')
      const tracksByKey = new Map()
      const urlSetsByKey = new Map() // key -> Set<string>, dedupes segments shared across Periods
      const fallbackBaseUrl = mpdUrl
        .split('?')[0]
        .substring(0, mpdUrl.split('?')[0].lastIndexOf('/') + 1)
      if (doc.querySelector('parsererror')) return []
      const contentPeriods = filterContentPeriods(doc.querySelectorAll('Period'))

      for (const { period } of contentPeriods) {
        let periodBaseUrl =
          Array.from(period.children)
            .find((c) => c.tagName === 'BaseURL')
            ?.textContent?.trim() || fallbackBaseUrl
        if (!periodBaseUrl.endsWith('/')) periodBaseUrl += '/'

        for (const adaptationSet of period.querySelectorAll('AdaptationSet[contentType="text"]')) {
          const rawLang = adaptationSet.getAttribute('lang') || 'unknown'
          const lang = rawLang.toLowerCase()
          const role = adaptationSet.querySelector('Role')?.getAttribute('value') || ''
          const source = role.includes('caption') ? 'CC' : role.includes('forced') ? 'FORCED' : ''
          const segmentTemplate = adaptationSet.querySelector('SegmentTemplate')
          if (!segmentTemplate) continue
          const media = segmentTemplate.getAttribute('media')
          const startNumber = parseInt(segmentTemplate.getAttribute('startNumber') || '0', 10)
          const segments =
            segmentTemplate.querySelector('SegmentTimeline')?.querySelectorAll('S') || []

          let currentNumber = startNumber,
            urls = []
          for (const s of segments) {
            const repeat = parseInt(s.getAttribute('r') || '0', 10)
            for (let i = 0; i <= repeat; i++) {
              urls.push(
                media.replace('$Number$', currentNumber).startsWith('http')
                  ? media.replace('$Number$', currentNumber)
                  : periodBaseUrl + media.replace('$Number$', currentNumber)
              )
              currentNumber++
            }
          }
          if (urls.length > 0) {
            const key = `${lang}::${source}`
            let track = tracksByKey.get(key)
            if (!track) {
              track = {
                language: lang,
                label: getLocalizedLanguageName(rawLang) + (source ? ` [${source}]` : ''),
                segments: [],
                source,
              }
              tracksByKey.set(key, track)
              urlSetsByKey.set(key, new Set())
            }
            const urlSet = urlSetsByKey.get(key)
            for (const u of urls) {
              if (!urlSet.has(u)) {
                urlSet.add(u)
                track.segments.push({ url: u })
              }
            }
          }
        }
      }
      return Array.from(tracksByKey.values())
    } catch (e) {
      logError('MPD parse failed', e)
      return []
    }
  }

  function processPlaybackData(data, url) {
    if (!data) return
    if (url.includes('/cms/routes/video/watch/')) {
      const contentId = extractVideoIds(url)?.contentId
      const videoObj = data.included?.find((item) => item.type === 'video' && item.id === contentId)
      if (videoObj) {
        const attrs = videoObj.attributes,
          isSerie = (attrs.materialType || attrs.videoType) === 'EPISODE'
        let showTitle = attrs.name || attrs.originalName || ''
        if (isSerie && videoObj.relationships?.show?.data?.id) {
          const showObj = data.included.find(
            (item) => item.type === 'show' && item.id === videoObj.relationships.show.data.id
          )
          if (showObj) showTitle = showObj.attributes.name || showObj.attributes.originalName || showTitle
        }
        HBOState.videoInfo = {
          title: showTitle,
          season: isSerie ? attrs.seasonNumber : null,
          episode: isSerie ? attrs.episodeNumber : null,
          isSerie,
        }
        updateTitleDisplay()
      }
    }
  }

  function isMpdUrl(url) {
    return url.includes('.mpd') && !url.includes('fallback.mpd')
  }

  function isWatchedUrl(url) {
    return typeof url === 'string' && (isMpdUrl(url) || url.includes('/cms/routes/video/watch/'))
  }

  // Shared handler for fetch + XHR responses
  function handleResponse(url, text) {
    if (!text) return
    if (isMpdUrl(url)) {
      HBOState.seenMpdUrls.add(url)
      if (!text.includes('<MPD') || url === HBOState.lastMpdUrl) return
      const videoId = getVideoId()
      if (!videoId) return
      const tracks = parseMpdContent(text, url)
      // Never let an empty parse (ad / unrelated manifest) erase tracks already found
      if (tracks.length === 0) return
      HBOState.lastMpdUrl = url
      HBOState.tracks[videoId] = tracks
      log(`${tracks.length} subtitle track(s) found for ${videoId}`)
      // Show the tracks right away instead of waiting for the next poll tick
      refreshSubtitleUI()
    } else {
      try {
        processPlaybackData(JSON.parse(text), url)
      } catch (e) {}
    }
  }

  // Called on every outgoing request: flags that the player started asking for its manifest,
  // and records MPD URLs seen by the hooks so the rescue below never re-reads them.
  function noteManifestRequest(url) {
    if (typeof url !== 'string') return
    const isMpd = isMpdUrl(url)
    if (isMpd) HBOState.seenMpdUrls.add(url)
    if ((isMpd || url.includes('/playback/v1/playbackInfo')) && !HBOState.manifestRequested) {
      HBOState.manifestRequested = true
      refreshSubtitleUI()
    }
  }

  // Late-injection rescue: if the userscript manager injected the script after the player had
  // already downloaded its manifest, the hooks never saw it and the widget would wait forever.
  // The request is still listed in the Resource Timing buffer, and the manifest CDN answers
  // `Access-Control-Allow-Origin: *`, so it can be re-read from the page without cookies.
  async function rescueMissedManifest() {
    if (!location.pathname.includes('/video/watch/') || getAvailableSubtitles().length > 0) return
    let entries
    try {
      entries = performance
        .getEntriesByType('resource')
        .filter(
          (e) =>
            isMpdUrl(e.name) &&
            e.startTime >= HBOState.watchStartedAt &&
            !HBOState.seenMpdUrls.has(e.name)
        )
    } catch (e) {
      return
    }
    if (entries.length === 0) return
    const url = entries[entries.length - 1].name
    HBOState.seenMpdUrls.add(url)
    HBOState.manifestRequested = true
    log('Manifest request missed (script injected late), re-reading it')
    try {
      const response = await originalFetch(url, { credentials: 'omit' })
      if (response.ok) handleResponse(url, await response.text())
    } catch (e) {
      logError('Manifest rescue failed', e)
    }
  }

  const originalFetch = window.fetch
  window.fetch = async function (...args) {
    const input = args[0]
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
    noteManifestRequest(url)
    const response = await originalFetch.apply(this, args)
    if (isWatchedUrl(url)) {
      response
        .clone()
        .text()
        .then((text) => handleResponse(url, text))
        .catch(() => {})
    }
    return response
  }

  const originalXHROpen = XMLHttpRequest.prototype.open
  const originalXHRSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (method, url) {
    this._hboUrl = url instanceof URL ? url.href : url
    return originalXHROpen.apply(this, arguments)
  }
  XMLHttpRequest.prototype.send = function () {
    const url = this._hboUrl
    noteManifestRequest(url)
    if (isWatchedUrl(url)) {
      this.addEventListener('load', function () {
        try {
          // responseText throws for non-text responseType
          handleResponse(url, this.responseText)
        } catch (e) {}
      })
    }
    return originalXHRSend.apply(this, arguments)
  }

  async function downloadSubtitle(track) {
    if (!track.segments || track.segments.length === 0) throw new Error('No segments found.')
    let mergedVtt = 'WEBVTT\n\n'
    let okCount = 0
    for (const segment of track.segments) {
      try {
        // The VTT segments are served by a CDN answering `Access-Control-Allow-Origin: *`,
        // which rejects credentialed requests: always fetch them without cookies.
        const response = await originalFetch(segment.url, { credentials: 'omit' })
        if (response.ok) {
          okCount++
          let content = await response.text()
          mergedVtt +=
            content
              .replace(/^WEBVTT[^\n]*\n+/g, '')
              .replace(/^X-TIMESTAMP-MAP[^\n]*\n+/gm, '')
              .replace(/^NOTE[^\n]*\n/gm, '')
              .trim() + '\n\n'
        }
      } catch (e) {
        logError('Segment failed', segment.url, e)
      }
    }
    if (okCount === 0) throw new Error('No subtitle segment could be downloaded. Reload the page and try again.')
    mergedVtt = mergedVtt.replace(/\n{3,}/g, '\n\n').trim() + '\n'
    const info = HBOState.videoInfo
    let baseName = `Max_${getFileId()}`
    if (info.title) {
      baseName = info.isSerie && info.season
        ? `${info.title} S${String(info.season).padStart(2, '0')}E${String(info.episode).padStart(2, '0')}`
        : info.title
    }
    const suffix = track.source ? `.${track.source.toLowerCase()}` : ''
    downloadFile(mergedVtt, `${sanitizeFilename(baseName)}.${track.language}${suffix}.vtt`)
  }

  // ============================================================
  // USER INTERFACE
  // ============================================================

  function createUI() {
    if (document.getElementById('subtiltee-widget')) return
    if (!location.pathname.includes('/video/watch/')) return

    const container = document.createElement('div')
    container.id = 'subtiltee-widget'
    container.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 720px;
            background: #0f0f0f;
            border: 1px solid #222;
            border-radius: 24px;
            padding: 32px;
            box-shadow: 0 40px 100px rgba(0,0,0,0.9), 0 0 0 1px rgba(255,255,255,0.05);
            font-family: ${CONFIG.fontFamily};
            color: #fff;
            z-index: 2147483647;
            box-sizing: border-box;
            transition: transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
            display: flex;
            gap: 32px;
        `

    container.innerHTML = `
            <button id="subtiltee-close" style="position:absolute;right:16px;top:16px;background:rgba(255,255,255,0.05);border:none;color:#888;font-size:18px;cursor:pointer;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;transition:all 0.2s;z-index:10;">✕</button>
            <div style="flex: 1.2; display: flex; flex-direction: column; border-right: 1px solid #222; padding-right: 32px;">
                <div id="subtiltee-header" style="cursor:move;user-select:none;margin-bottom:24px;">
                    <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
                        <span style="font-size:32px;">📥</span>
                        <div style="font-size:22px;font-weight:800;letter-spacing:-0.5px;color:#fff;">Subtitle Downloader</div>
                    </div>
                    <div id="subtiltee-status" style="display:inline-block;font-size:12px;font-weight:700;padding:6px 14px;background:rgba(255,255,255,0.05);border-radius:20px;color:#888;border:1px solid rgba(255,255,255,0.1);">Waiting for the player...</div>
                </div>
                <div style="margin-bottom:24px; flex-grow: 1;">
                    <div id="subtiltee-video-title" style="font-size:14px;font-weight:700;color:${CONFIG.colors.primary};margin-bottom:16px;display:none;padding:12px;background:rgba(0,43,231,0.1);border-radius:10px;border:1px solid rgba(0,43,231,0.2);text-align:center;"></div>
                    <div style="margin-bottom:10px;font-size:11px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:1px;text-align:center;">Select Language</div>
                    <div style="position:relative;">
                        <select id="subtiltee-select" style="width:100%;padding:16px;border:1px solid #333;border-radius:14px;background:#161616;color:#fff;font-size:15px;cursor:pointer;outline:none;appearance:none;transition:all 0.2s;text-align-last:center;">
                            <option disabled selected>Scanning...</option>
                        </select>
                        <div style="position:absolute;right:16px;top:50%;transform:translateY(-50%);pointer-events:none;color:#666;">↓</div>
                    </div>
                    <div id="subtiltee-hbo-bypass" style="margin-top:12px;padding:12px;background:rgba(255,255,255,0.03);border:1px dashed rgba(255,255,255,0.1);border-radius:12px;font-size:11px;color:#888;cursor:pointer;line-height:1.4;transition:all 0.2s;text-align:center;">
                        <span style="color:#fff;font-weight:800;display:block;margin-bottom:2px;">🌍 Bypass Regional Limits</span>
                        Max may hide some subtitles based on your location. Use the extension to unlock <b>EVERY</b> language available for this video!
                    </div>
                </div>
                <button id="subtiltee-download" style="width:100%;padding:18px;background:${CONFIG.colors.primary};border:none;border-radius:16px;color:white;font-size:16px;font-weight:800;cursor:pointer;box-shadow:0 10px 25px rgba(0,43,231,0.3);transition:all 0.2s;display:flex;align-items:center;justify-content:center;gap:10px;"><span>⬇️</span><span>Download Subtitle</span></button>
                
                <div style="margin-top:24px;padding:16px;background:rgba(255,255,255,0.03);border-radius:14px;border:1px dashed rgba(255,255,255,0.1);font-size:11px;color:#888;line-height:1.5;">
                    <div style="font-weight:800;color:#fff;margin-bottom:6px;display:flex;align-items:center;gap:6px;">
                        <span>💡</span><span>Why this Lite script?</span>
                    </div>
                    This tool is meant to be simple & lightweight. If you don't want to waste your time and <b>Download ALL subtitle languages</b> or <b>Full Seasons</b> in 1-click, the extension is for you!
                </div>
            </div>
            <div style="flex: 1; display: flex; flex-direction: column;">
                <div id="subtiltee-extension-card" style="background:linear-gradient(165deg, #1a1a1a 0%, #111 100%);border:1px solid #333;border-radius:20px;padding:24px;cursor:pointer;transition:all 0.2s;position:relative;overflow:hidden;flex-grow:1;display:flex;flex-direction:column;">
                    <div style="margin-bottom:16px;">
                        <div style="font-size:14px;color:#4ade80;font-weight:800;margin-bottom:4px;display:flex;align-items:center;gap:6px;"><span>⭐⭐⭐⭐⭐</span><span>Used by 3,000+ users</span></div>
                        <div style="font-size:20px;font-weight:800;color:#fff;margin-bottom:8px;">Official Extension <span style="font-size:12px;background:${CONFIG.colors.primary};padding:2px 8px;border-radius:6px;vertical-align:middle;margin-left:4px;">ALL-IN-ONE</span></div>
                        <div style="font-size:13px;line-height:1.5;color:#aaa;">Stop managing 5+ separate scripts! This Lite version is extracted from my official extension that works on <b>Netflix, YouTube, Disney+, Prime, Max</b> & 10+ more.</div>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px;">
                        <div style="background:rgba(255,255,255,0.03);padding:10px;border-radius:12px;border:1px solid rgba(74,222,128,0.3);display:flex;align-items:center;gap:8px;grid-column: span 2;"><span style="font-size:16px;">📁</span><span style="font-size:11px;font-weight:700;color:#4ade80;">Batch Download (All Langs & Seasons)</span></div>
                        <div style="background:rgba(255,255,255,0.03);padding:10px;border-radius:12px;border:1px solid rgba(255,255,255,0.05);display:flex;align-items:center;gap:8px;"><span style="font-size:16px;">📄</span><span style="font-size:11px;font-weight:700;color:#ccc;">SRT, VTT, ASS...</span></div>
                        <div style="background:rgba(255,255,255,0.03);padding:10px;border-radius:12px;border:1px solid rgba(255,255,255,0.05);display:flex;align-items:center;gap:8px;"><span style="font-size:16px;">🌐</span><span style="font-size:11px;font-weight:700;color:#ccc;">Dual & Translate</span></div>
                    </div>
                    <div class="subtiltee-extension-btn" style="margin-top:auto;width:100%;padding:14px;background:#fff;border-radius:12px;color:#000;font-size:14px;font-weight:800;text-align:center;transition:all 0.2s;">Discover Full Experience (Free) →</div>
                </div>
                <div style="margin-top:20px;">
                    <div style="text-align:center;margin-bottom:10px;font-size:10px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:1px;">Direct Store Install</div>
                    <div style="display:flex;gap:8px;">
                        <button class="subtiltee-store" data-browser="chrome" style="flex:1;padding:10px;background:#161616;border:1px solid #333;border-radius:10px;color:#fff;font-size:10px;font-weight:700;cursor:pointer;transition:all 0.2s;display:flex;align-items:center;justify-content:center;gap:4px;">🌐 Chrome</button>
                        <button class="subtiltee-store" data-browser="firefox" style="flex:1;padding:10px;background:#161616;border:1px solid #333;border-radius:10px;color:#fff;font-size:10px;font-weight:700;cursor:pointer;transition:all 0.2s;display:flex;align-items:center;justify-content:center;gap:4px;">🦊 Firefox</button>
                        <button class="subtiltee-store" data-browser="edge" style="flex:1;padding:10px;background:#161616;border:1px solid #333;border-radius:10px;color:#fff;font-size:10px;font-weight:700;cursor:pointer;transition:all 0.2s;display:flex;align-items:center;justify-content:center;gap:4px;">🟦 Edge</button>
                    </div>
                </div>
            </div>
        `
    document.body.appendChild(container)
    setupEventListeners(container)
    startSubtitlePolling()
    setupDragging(container)
    updateTitleDisplay()
  }

  function setupEventListeners(container) {
    const downloadBtn = container.querySelector('#subtiltee-download'),
      extensionCard = container.querySelector('#subtiltee-extension-card'),
      extensionBtn = container.querySelector('.subtiltee-extension-btn'),
      closeBtn = container.querySelector('#subtiltee-close'),
      storeBtns = container.querySelectorAll('.subtiltee-store'),
      select = container.querySelector('#subtiltee-select'),
      bypassBtn = container.querySelector('#subtiltee-hbo-bypass')

    downloadBtn.onmouseover = () => {
      downloadBtn.style.background = CONFIG.colors.secondary
      downloadBtn.style.transform = 'translateY(-2px)'
    }
    downloadBtn.onmouseout = () => {
      downloadBtn.style.background = CONFIG.colors.primary
      downloadBtn.style.transform = 'translateY(0)'
    }
    extensionCard.onmouseover = () => {
      extensionCard.style.borderColor = CONFIG.colors.primary
      extensionCard.style.background = 'linear-gradient(165deg, #222 0%, #161616 100%)'
      if (extensionBtn) extensionBtn.style.transform = 'scale(1.02)'
    }
    extensionCard.onmouseout = () => {
      extensionCard.style.borderColor = '#333'
      extensionCard.style.background = 'linear-gradient(165deg, #1a1a1a 0%, #111 100%)'
      if (extensionBtn) extensionBtn.style.transform = 'scale(1)'
    }

    bypassBtn.onclick = () => window.open(getWebsiteUrl(), '_blank')
    bypassBtn.onmouseover = () => {
      bypassBtn.style.background = 'rgba(255,255,255,0.05)'
      bypassBtn.style.borderColor = 'rgba(255,255,255,0.2)'
      bypassBtn.style.color = '#fff'
    }
    bypassBtn.onmouseout = () => {
      bypassBtn.style.background = 'rgba(255,255,255,0.03)'
      bypassBtn.style.borderColor = 'rgba(255,255,255,0.1)'
      bypassBtn.style.color = '#888'
    }

    closeBtn.onclick = () => (container.style.display = 'none')
    extensionCard.onclick = () => window.open(getWebsiteUrl(), '_blank')
    downloadBtn.onclick = async () => {
      const subs = getAvailableSubtitles()
      if (select.selectedIndex < 0) return alert('Select a subtitle.')
      downloadBtn.disabled = true
      downloadBtn.textContent = '⏳ Downloading...'
      try {
        await downloadSubtitle(subs[select.selectedIndex])
      } catch (e) {
        alert(e.message)
      } finally {
        downloadBtn.disabled = false
        downloadBtn.innerHTML = '<span>⬇️</span><span>Download Subtitle</span>'
      }
    }
    storeBtns.forEach(
      (btn) =>
        (btn.onclick = (e) => {
          e.stopPropagation()
          window.open(getStoreUrl(btn.dataset.browser), '_blank')
        })
    )
  }

  function setupDragging(container) {
    const header = container.querySelector('#subtiltee-header')
    let isDragging = false,
      offsetX = 0,
      offsetY = 0
    header.onmousedown = (e) => {
      isDragging = true
      offsetX = e.clientX - container.getBoundingClientRect().left
      offsetY = e.clientY - container.getBoundingClientRect().top
      container.style.transition = 'none'
    }
    document.onmousemove = (e) => {
      if (!isDragging) return
      container.style.left = `${e.clientX - offsetX}px`
      container.style.top = `${e.clientY - offsetY}px`
      container.style.transform = 'none'
      container.style.right = 'auto'
    }
    document.onmouseup = () => {
      if (isDragging) {
        isDragging = false
        container.style.transition = 'transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1)'
      }
    }
  }

  // Last rendered state of the widget. Keyed on video + phase + track count: keying on the
  // count alone left the status stuck on "Scanning" whenever clearState() reset the text but
  // the new video had the same number of tracks (same video after a URL tweak, cached video).
  let lastRenderKey = null

  function refreshSubtitleUI(force = false) {
    const select = document.getElementById('subtiltee-select')
    const status = document.getElementById('subtiltee-status')
    if (!select || !status) return
    const subs = getAvailableSubtitles()
    const phase = subs.length > 0 ? 'ready' : HBOState.manifestRequested ? 'reading' : 'waiting'
    const key = `${getVideoId()}|${phase}|${subs.length}`
    if (!force && key === lastRenderKey) return
    lastRenderKey = key
    status.style.background = 'rgba(255,255,255,0.05)'
    if (phase === 'ready') {
      status.textContent = `✓ ${subs.length} subtitles detected`
      status.style.color = '#4ade80'
      select.innerHTML = subs.map((s, i) => `<option value="${i}">${s.label}</option>`).join('')
    } else {
      // The player only requests its manifest once it starts, which can take a while on HBO Max
      status.textContent = phase === 'reading' ? 'Reading subtitles...' : 'Waiting for the player...'
      status.style.color = '#888'
      select.innerHTML = '<option disabled selected>Scanning...</option>'
    }
  }

  let pollingStarted = false
  function startSubtitlePolling() {
    refreshSubtitleUI(true)
    // A single interval for the whole page life: the widget can be removed and re-created on
    // SPA navigation, and refreshSubtitleUI() always looks the current elements up by id.
    if (pollingStarted) return
    pollingStarted = true
    setInterval(() => {
      refreshSubtitleUI()
      rescueMissedManifest()
    }, 1000)
  }

  function init() {
    if (document.body && location.pathname.includes('/video/watch/')) createUI()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else setTimeout(init, 500)
  let lastUrl = location.href
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href
      if (location.pathname.includes('/video/watch/')) {
        clearState()
        if (document.getElementById('subtiltee-widget'))
          document.getElementById('subtiltee-widget').style.display = 'flex'
        else setTimeout(createUI, 500)
      } else if (document.getElementById('subtiltee-widget'))
        document.getElementById('subtiltee-widget').remove()
    }
  // `document` itself when <html> does not exist yet (possible at document-start)
  }).observe(document.documentElement || document, { childList: true, subtree: true })
})()
