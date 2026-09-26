import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

async function sendMessage(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const body = await req.json()
    const message = body?.message

    if (!message || !message.text) {
      // Nothing to do (e.g. non-text message) — still ack so Telegram is happy
      return new Response('ok', { status: 200, headers: corsHeaders })
    }

    const chatId = message.chat.id
    const text: string = message.text.trim()

    // ── /search or ?query ──────────────────────────────
    if (text.startsWith('/search') || text.startsWith('?')) {
      const query = text.startsWith('/search')
        ? text.replace('/search', '').trim()
        : text.slice(1).trim()

      if (!query) {
        await sendMessage(chatId, 'Send /search followed by a word to look for, e.g. /search coffee')
        return new Response('ok', { status: 200, headers: corsHeaders })
      }

      const { data, error } = await admin
        .from('thoughts')
        .select('content, created_at')
        .eq('user_id', OWNER_USER_ID)
        .ilike('content', `%${query}%`)
        .order('created_at', { ascending: false })
        .limit(5)

      if (error) {
        console.error('search error', error)
        await sendMessage(chatId, 'Something went wrong searching your brain.')
        return new Response('ok', { status: 200, headers: corsHeaders })
      }

      if (!data || data.length === 0) {
        await sendMessage(chatId, `No thoughts found matching "${query}".`)
      } else {
        const results = data
          .map((t, i) => `${i + 1}. ${t.content.slice(0, 200)}`)
          .join('\n\n')
        await sendMessage(chatId, `Found ${data.length} result(s):\n\n${results}`)
      }

      return new Response('ok', { status: 200, headers: corsHeaders })
    }

    // ── /recent ─────────────────────────────────────────
    if (text.startsWith('/recent')) {
      const { data, error } = await admin
        .from('thoughts')
        .select('content, created_at')
        .eq('user_id', OWNER_USER_ID)
        .order('created_at', { ascending: false })
        .limit(5)

      if (error) {
        console.error('recent error', error)
        await sendMessage(chatId, 'Something went wrong fetching recent thoughts.')
        return new Response('ok', { status: 200, headers: corsHeaders })
      }

      if (!data || data.length === 0) {
        await sendMessage(chatId, 'Your brain is empty so far.')
      } else {
        const results = data
          .map((t, i) => `${i + 1}. ${t.content.slice(0, 200)}`)
          .join('\n\n')
        await sendMessage(chatId, `Your last ${data.length} thought(s):\n\n${results}`)
      }

      return new Response('ok', { status: 200, headers: corsHeaders })
    }

    // ── default: save as a new thought ─────────────────
    const { error: insertError } = await admin.from('thoughts').insert({
      user_id: OWNER_USER_ID,
      content: `💬 ${text}`,
    })

    if (insertError) {
      console.error('insert error', insertError)
      await sendMessage(chatId, 'Something went wrong saving that.')
      return new Response('ok', { status: 200, headers: corsHeaders })
    }

    await sendMessage(chatId, 'Saved to your brain ✅')
    return new Response('ok', { status: 200, headers: corsHeaders })

  } catch (err) {
    console.error('unhandled error', err)
    // Always return 200 so Telegram doesn't retry forever
    return new Response('ok', { status: 200, headers: corsHeaders })
  }
})