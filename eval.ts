// api/eval.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

const ALLOW_ORIGINS = [
  "capacitor://localhost",
  "http://localhost",
  "http://127.0.0.1",
  "http://localhost:5173",
  "https://radka-celiakia.vercel.app"
];

function setCors(res: VercelResponse, origin?: string) {
  const allowed = origin && ALLOW_ORIGINS.some(o => origin.startsWith(o));
  res.setHeader("Access-Control-Allow-Origin", allowed ? origin! : "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res, req.headers.origin);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  try {
    const { code, name, ingredients, allergens, lang, intolerances } = req.body ?? {};
    if (!code) return res.status(400).json({ ok: false, error: "Missing code" });

    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      return res.status(200).json({
        ok: true,
        status: "maybe",
        notes: ["AI kľúč nie je nastavený na serveri. Použité boli iba dáta z OFF."]
      });
    }

    const sys = (l: "sk" | "cs") =>
      l === "cs"
        ? "Jsi asistent pro hodnocení potravin pro uživatele s intolerancemi (celiakie, mléčná bílkovina atd.). Vrať JSON: {"status":"safe|avoid|maybe","notes":[...]}."
        : "Si asistent na hodnotenie potravín pre používateľov s intoleranciami (celiakia, mliečna bielkovina atď.). Vráť JSON: {"status":"safe|avoid|maybe","notes":[...]}.";

    const user = `
EAN: ${code}
Názov: ${name}
Ingrediencie: ${ingredients || "-"}
Alergény (OFF): ${allergens || "-"}
Intolerancie používateľa: ${(Array.isArray(intolerances)?intolerances:[]).join(", ") || "-"}
Úloha: Vyhodnoť, či je potravina bezpečná pre tohto konkrétneho používateľa. 
Ak je jasný dôvod NEVHODNOSTI (napr. obsahuje mliečnu bielkovinu pre APLV, obsahuje lepok pre celiakiu), daj status "avoid". 
Ak deklarácia jasne potvrdzuje bezpečnosť (napr. bezlepkové a bez mlieka), daj "safe". Inak "maybe". 
`;

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: sys((lang as "sk"|"cs") || "sk") },
          { role: "user", content: user }
        ],
        temperature: 0.2
      })
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return res.status(200).json({
        ok: true,
        status: "maybe",
        notes: ["AI požiadavka zlyhala.", `${resp.status} ${txt}`.trim()]
      });
    }

    const data = await resp.json();
    const content: string = data.choices?.[0]?.message?.content || "";
    let parsed: any = null;
    try { parsed = JSON.parse(content); } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }

    const st = (parsed?.status === "safe" || parsed?.status === "avoid" || parsed?.status === "maybe") ? parsed.status : "maybe";
    const nts: string[] = Array.isArray(parsed?.notes) ? parsed.notes : [content || ""];

    return res.status(200).json({ ok: true, status: st, notes: nts });
  } catch (e: any) {
    return res.status(200).json({
      ok: true,
      status: "maybe",
      notes: ["AI výnimka na serveri.", e?.message || "Unknown error"]
    });
  }
}
