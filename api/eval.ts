// api/eval.ts
import type { VercelRequest, VercelResponse } from '@vercel/node'

// ==== CORS ====
const ALLOW_ORIGINS = [
  'capacitor://localhost',
  'http://localhost',
  'http://127.0.0.1',
  'https://radka-celiakia.vercel.app',
  'https://intolerancies.vercel.app',
]

function setCors(res: VercelResponse, origin: string | undefined) {
  const o = origin || ''
  const allow = ALLOW_ORIGINS.some(x => o.startsWith(x)) ? o : ALLOW_ORIGINS[3]
  res.setHeader('Access-Control-Allow-Origin', allow)
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

// ==== Body typ ====
type EvalBody = {
  code?: string
  name?: string
  ingredients?: string
  allergens?: string
  lang?: 'sk' | 'cs' | 'en'
}

// ==== Handler ====
export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res, req.headers.origin)

  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' })
    return
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    res.status(200).json({
      ok: true,
      status: 'maybe',
      notes: ['Chýba OPENAI_API_KEY na Verceli – AI sa preskočila.'],
    })
    return
  }

  let body: EvalBody
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body as EvalBody)
  } catch {
    res.status(400).json({ ok: false, error: 'Bad JSON body' })
    return
  }

  const lang = body.lang || 'sk'
  const name = body.name || ''
  const ingredients = body.ingredients || ''
  const allergens = body.allergens || ''
  const code = body.code || ''

  // Jednoduchý prompt – pozor, celé je v jedinom template stringu
  const prompt = `
Si potravinový poradca pre celiatikov a ľudí s intoleranciami.
Dostaneš základné údaje o produkte a máš rozhodnúť:
- status: "safe" (bezpečné), "avoid" (vyhnúť sa), alebo "maybe" (neisté).
- notes: krátke odôvodnenia v jazyku používateľa.

Kritériá:
- Ak text alebo alergény obsahujú mlieko (mliečna bielkovina, srvátka, whey, kazeín) → status "avoid".
- Ak obsahujú lepok (pšenica, jačmeň, raž, špalda, ovos bez deklarácie bezgluténový) → "avoid".
- Ak je jasne deklarované "bez lepku" a neuvádza sa mlieko → "safe".
- Inak "maybe".

Vráť presne JSON: {"status":"safe|avoid|maybe","notes":["...","..."]}

Jazyk odpovede: ${lang}
Názov: ${name}
Kód: ${code}
Ingrediencie: ${ingredients}
Alergény (z DB): ${allergens}
`.trim()

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini', // ak by to hádzalo 404 na účte, použi "gpt-3.5-turbo"
        temperature: 0.2,
        messages: [
          { role: 'system', content: 'You are a precise JSON generator. Always return strict JSON only.' },
          { role: 'user', content: prompt },
        ],
      }),
    })

    if (!resp.ok) {
      const txt = await resp.text()
      res.status(200).json({
        ok: true,
        status: 'maybe',
        notes: [`AI požiadavka zlyhala (HTTP ${resp.status}).`, txt.slice(0, 300)],
      })
      return
    }

    const data = await resp.json()
    const content: string = data.choices?.[0]?.message?.content ?? '{}'

    // Pokus o parse odpovede modelu
    let parsed: { status?: string; notes?: string[] } = {}
    try {
      parsed = JSON.parse(content)
    } catch {
      // fallback – niekedy model pridá text okolo JSONu, skús vytiahnuť blok medzi { }
      const m = content.match(/\{[\s\S]*\}/)
      if (m) {
        try {
          parsed = JSON.parse(m[0])
        } catch {}
      }
    }

    // Sanitizácia
    const st = parsed.status === 'safe' || parsed.status === 'avoid' ? parsed.status : 'maybe'
    const notes = Array.isArray(parsed.notes) && parsed.notes.length ? parsed.notes.slice(0, 5) : ['Nedostatočné údaje.']

    res.status(200).json({ ok: true, status: st, notes })
  } catch (e: any) {
    res.status(200).json({
      ok: true,
      status: 'maybe',
      notes: ['AI požiadavka zlyhala.', String(e?.message || e).slice(0, 300)],
    })
  }
}
