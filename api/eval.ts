// api/eval.ts

// Povolené originy (CORS)
const ALLOW_ORIGINS = [
  'capacitor://localhost',
  'http://localhost',
  'http://127.0.0.1',
  'https://radka-celiakia.vercel.app',
  'https://intolerancies.vercel.app',
];

function setCors(res: any, origin?: string) {
  const o = origin || '';
  const allow = ALLOW_ORIGINS.some(x => o.startsWith(x)) ? o : ALLOW_ORIGINS[3];
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

type EvalBody = {
  code?: string;
  name?: string;
  ingredients?: string;
  allergens?: string;
  lang?: 'sk'|'cs'|'en';
};

// Vercel edge/function handler bez @vercel/node
export default async function handler(req: any, res: any) {
  setCors(res, req.headers?.origin);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok:false, error:'Method not allowed' }));
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY as string | undefined;
  if (!apiKey) {
    res.statusCode = 200;
    res.end(JSON.stringify({
      ok:true, status:'maybe',
      notes:['Na Verceli chýba OPENAI_API_KEY – AI sa preskočila.'],
    }));
    return;
  }

  let body: EvalBody;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body as EvalBody);
  } catch {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok:false, error:'Bad JSON body' }));
    return;
  }

  const lang = body.lang || 'sk';
  const prompt = `
Si potravinový poradca pre celiatikov a ľudí s intoleranciami.
Vráť JSON {"status":"safe|avoid|maybe","notes":["..."]}.
Kritériá: mlieko/srvátka/whey/kazeín → avoid; lepok/pšenica/jačmeň/raž/špalda/ovos (bez jasného gluten-free) → avoid; ak jasné gluten-free a bez mlieka → safe; inak maybe.

Jazyk: ${lang}
Názov: ${body.name || ''}
Kód: ${body.code || ''}
Ingrediencie: ${body.ingredients || ''}
Alergény (DB): ${body.allergens || ''}
`.trim();

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':'application/json',
        'Authorization':`Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role:'system', content:'Return strict JSON only.' },
          { role:'user', content: prompt }
        ],
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      res.statusCode = 200;
      res.end(JSON.stringify({
        ok:true, status:'maybe',
        notes:[`AI zlyhala (HTTP ${resp.status})`, text.slice(0,300)],
      }));
      return;
    }

    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content ?? '{}';

    let parsed: any = {};
    try { parsed = JSON.parse(raw); }
    catch {
      const m = String(raw).match(/\{[\s\S]*\}/);
      if (m) try { parsed = JSON.parse(m[0]); } catch {}
    }

    const status = (parsed.status === 'safe' || parsed.status === 'avoid') ? parsed.status : 'maybe';
    const notes = Array.isArray(parsed.notes) && parsed.notes.length ? parsed.notes.slice(0,5) : ['Nedostatočné údaje.'];

    res.statusCode = 200;
    res.end(JSON.stringify({ ok:true, status, notes }));
  } catch (e:any) {
    res.statusCode = 200;
    res.end(JSON.stringify({
      ok:true, status:'maybe',
      notes:['AI požiadavka zlyhala.', String(e?.message || e).slice(0,300)],
    }));
  }
}
