import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

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

function htmlToText(html: string): string {
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return decodeEntities(text)
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i)
  return match ? decodeEntities(match[1].trim()) : 'Untitled'
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
    if (!url) {
      return new Response(JSON.stringify({ error: 'Missing url' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const pageRes = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OpenBrainBot/1.0)' },
    })
    if (!pageRes.ok) {
      return new Response(JSON.stringify({ error: `Failed to fetch page: ${pageRes.status}` }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const html = await pageRes.text()
    const title = extractTitle(html)
    const text = htmlToText(html)

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    const { data: thought, error: insertError } = await admin.from('thoughts').insert({
      user_id: user.id,
      content: `🔗 ${title}\n\n${text.slice(0, 2000)}`,
      metadata: { url, title },
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
        source_kind: 'web',
        char_count: text.length,
        truncated: false,
      })
    } catch (sourceErr) {
      console.warn('thought_source insert failed (non-fatal)', sourceErr)
    }

    return new Response(JSON.stringify({ success: true, title, thought_id: thought.id }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error('unhandled error', err)
    return new Response(JSON.stringify({ error: 'Unexpected error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})