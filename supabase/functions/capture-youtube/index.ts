import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPADATA_API_KEY = Deno.env.get('SUPADATA_API_KEY') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function decodeEntities(text: string): string {
  const entities: Record<string, string> = {
    '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
    '&nbsp;': ' ', '&rsquo;': '\u2019', '&lsquo;': '\u2018',
    '&rdquo;': '\u201d', '&ldquo;': '\u201c', '&mdash;': '\u2014',
    '&ndash;': '\u2013', '&hellip;': '\u2026',
    '&aacute;': '\u00e1', '&eacute;': '\u00e9', '&iacute;': '\u00ed',
    '&oacute;': '\u00f3', '&uacute;': '\u00fa', '&ntilde;': '\u00f1',
    '&iexcl;': '\u00a1', '&iquest;': '\u00bf',
    '&Aacute;': '\u00c1', '&Eacute;': '\u00c9', '&Iacute;': '\u00cd',
    '&Oacute;': '\u00d3', '&Uacute;': '\u00da', '&Ntilde;': '\u00d1',
  }
  let out = text
  for (const [entity, char] of Object.entries(entities)) {
    out = out.split(entity).join(char)
  }
  return out.split('&amp;').join('&')
}

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  ]
  for (const p of patterns) {
    const m = url.match(p)
    if (m) return m[1]
  }
  return null
}

async function getOEmbedTitle(videoId: string): Promise<string> {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`)
    if (!res.ok) return 'Untitled video'
    const data = await res.json()
    return decodeEntities(data.title ?? 'Untitled video')
  } catch {
    return 'Untitled video'
  }
}

// Route 1: Supadata — fetches from a real residential connection, so YouTube
// does not treat it as a datacenter request.
async function trySupadata(videoId: string): Promise<string | null> {
  if (!SUPADATA_API_KEY) return null
  try {
    const res = await fetch(`https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}`, {
      headers: { 'x-api-key': SUPADATA_API_KEY },
    })
    if (!res.ok) return null
    const data = await res.json()
    if (Array.isArray(data?.content)) {
      return data.content.map((seg: any) => seg.text).join(' ')
    }
    if (typeof data?.content === 'string') return data.content
    return null
  } catch {
    return null
  }
}

// Route 2: YouTube's internal "innertube" API, posing as an iPhone client.
// This sometimes gets served captions that the public web page would not.
async function tryInnertube(videoId: string): Promise<string | null> {
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: 'IOS',
            clientVersion: '19.29.1',
            deviceModel: 'iPhone14,3',
          },
        },
      }),
    })
    if (!res.ok) return null
    const data = await res.json()
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks
    if (!tracks || tracks.length === 0) return null

    const track = tracks.find((t: any) => t.languageCode?.startsWith('en')) ?? tracks[0]
    const captionRes = await fetch(track.baseUrl)
    if (!captionRes.ok) return null
    const xml = await captionRes.text()
    const text = xml
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return decodeEntities(text) || null
  } catch {
    return null
  }
}

// Route 3: fall back to the video description — better than nothing, but the
// caller should know this is NOT the actual spoken transcript.
async function getDescriptionFallback(videoId: string): Promise<{ text: string | null }> {
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId,
        context: { client: { clientName: 'ANDROID', clientVersion: '19.29.37' } },
      }),
    })
    if (!res.ok) return { text: null }
    const data = await res.json()
    const desc = data?.videoDetails?.shortDescription
    return { text: desc ? decodeEntities(desc) : null }
  } catch {
    return { text: null }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing auth' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const anon = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: userError } = await anon.auth.getUser()
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { url } = await req.json()
    const videoId = url ? extractVideoId(url) : null
    if (!videoId) {
      return new Response(JSON.stringify({ error: 'Could not extract video ID from URL' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const title = await getOEmbedTitle(videoId)

    let text: string | null = null
    let fetchedVia = ''
    let hasTranscript = true

    text = await trySupadata(videoId)
    if (text) fetchedVia = 'supadata'

    if (!text) {
      text = await tryInnertube(videoId)
      if (text) fetchedVia = 'innertube'
    }

    if (!text) {
      const fallback = await getDescriptionFallback(videoId)
      text = fallback.text
      fetchedVia = 'description'
      hasTranscript = false
    }

    if (!text) {
      return new Response(JSON.stringify({ error: 'Could not retrieve any content for this video' }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    const label = hasTranscript ? '📹 YouTube' : '📹 YouTube (description only)'
    const { data: thought, error: insertError } = await admin.from('thoughts').insert({
      user_id: user.id,
      content: `${label}: ${title}\n\n${text.slice(0, 2000)}`,
      metadata: { video_id: videoId, video_url: url, title, has_transcript: hasTranscript, fetched_via: fetchedVia },
    }).select('id').single()

    if (insertError) {
      console.error('insert error', insertError)
      return new Response(JSON.stringify({ error: 'Failed to save' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    try {
      await admin.from('thought_sources').insert({
        thought_id: thought.id,
        user_id: user.id,
        source_text: text,
        source_kind: hasTranscript ? 'youtube_transcript' : 'youtube_description',
        char_count: text.length,
        truncated: false,
      })
    } catch (sourceErr) {
      console.warn('thought_source insert failed (non-fatal)', sourceErr)
    }

    return new Response(JSON.stringify({
      success: true, title, thought_id: thought.id, has_transcript: hasTranscript, fetched_via: fetchedVia,
    }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error('unhandled error', err)
    return new Response(JSON.stringify({ error: 'Unexpected error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})