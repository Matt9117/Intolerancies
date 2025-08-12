import React, { useEffect, useMemo, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";

type EvalStatus = "safe" | "avoid" | "maybe";
type AiReply = { ok: boolean; status?: EvalStatus; notes?: string[] };

type IntoleranceKey =
  | "gluten" | "milk_protein" | "lactose" | "nuts" | "peanut" | "soy" | "egg"
  | "sesame" | "fish" | "shellfish" | "celery" | "mustard" | "sulphites" | "lupin";

const INTOLERANCES: Record<IntoleranceKey, { sk: string; cs: string; terms: string[] }> = {
  gluten: { sk: "Lepok", cs: "Lepek", terms: ["lepok","pšenica","psenica","wheat","jačmeň","jacmen","barley","raž","raz","rye","špalda","spelta","spelt","ovos","gluten"] },
  milk_protein: { sk: "Mliečna bielkovina (APLV)", cs: "Mléčná bílkovina", terms: ["mlieko","mliecna bielkovina","mliečna bielkovina","srvátka","whey","casein","kazein","kazeín","maslo","smotana","syr","tvaroh","mliečny","mléko","syrovátka","kasein"] },
  lactose: { sk: "Laktóza", cs: "Laktóza", terms: ["laktóza","laktosa","lactose"] },
  nuts: { sk: "Orechy stromové", cs: "Stromové ořechy", terms: ["lieskové","mandle","vlašské","kešu","pekany","piniové","pistácie","brazilské","hazelnut","almond","walnut","cashew","pecan","pistachio"] },
  peanut: { sk: "Arašidy", cs: "Arašidy", terms: ["arašidy","arašídy","arašíd","peanut","arachis hypogaea"] },
  soy: { sk: "Sója", cs: "Sója", terms: ["sója","soja","soy","sojový","sójový","lecitín (sojový)","sojový lecitín","soya"] },
  egg: { sk: "Vajce", cs: "Vejce", terms: ["vajce","vajcia","vaječný","vaječné","albumín","egg","ovalbumin"] },
  sesame: { sk: "Sezam", cs: "Sezam", terms: ["sezam","sesame","sezamové"] },
  fish: { sk: "Ryby", cs: "Ryby", terms: ["ryba","ryby","fish","losos","tuniak","tuna","kapor","treska","cod","lososový"] },
  shellfish: { sk: "Kôrovce/mäkkýše", cs: "Korýši/Měkkýši", terms: ["kreveta","krab","homár","mušla","slávka","lastúra","krevet","krabí","morský plod","shrimp","crab","lobster","mussel","shellfish"] },
  celery: { sk: "Zeler", cs: "Celer", terms: ["zeler","celer","celery"] },
  mustard: { sk: "Horčica", cs: "Hořčice", terms: ["horčica","horčičné semeno","horčičný","mustard","hořčice"] },
  sulphites: { sk: "Oxidy siričité/siričitany", cs: "Oxidy siřičité/siřičitany", terms: ["oxid siričitý","siričitany","siričitan","oxid siřičitý","siřičitany","sulphites","sulfites","E220","E221","E222","E223","E224","E226","E227","E228"] },
  lupin: { sk: "Vlčí bôb (lupina)", cs: "Vlčí bob (lupina)", terms: ["vlčí bôb","lupina","lupin","lupine"] },
};

type Profile = {
  name: string;
  intolerances: IntoleranceKey[];
};

function loadProfile(): Profile | null {
  try { return JSON.parse(localStorage.getItem("radka_profile") || "null"); } catch { return null; }
}
function saveProfile(p: Profile | null) {
  if (!p) return localStorage.removeItem("radka_profile");
  localStorage.setItem("radka_profile", JSON.stringify(p));
}

export default function App() {
  // profile / onboarding
  const [profile, setProfile] = useState<Profile | null>(loadProfile());
  const [nameDraft, setNameDraft] = useState(profile?.name || "");

  // camera / scanning
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const gotOneRef = useRef(false);

  // search/product
  const [barcode, setBarcode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [product, setProduct] = useState<any>(null);
  const [status, setStatus] = useState<EvalStatus | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  // history
  const [history, setHistory] = useState<any[]>(() => {
    try { return JSON.parse(localStorage.getItem("radka_scan_history") || "[]"); } catch { return []; }
  });
  useEffect(() => {
    localStorage.setItem("radka_scan_history", JSON.stringify(history.slice(0, 100)));
  }, [history]);

  // ---------- camera ----------
  useEffect(() => {
    if (!scanning) return;
    (async () => {
      try {
        // ask once to get labels
        const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
        tmp.getTracks().forEach(t => t.stop());
        const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput");
        setDevices(cams);
        if (!deviceId) {
          const back = cams.find(c => /back|rear|environment/i.test(c.label));
          setDeviceId(back?.deviceId ?? cams[0]?.deviceId ?? null);
        }
      } catch (e) {
        setError("Kameru sa nepodarilo inicializovať. Skontroluj povolenia.");
        setScanning(false);
      }
    })();
  }, [scanning]);

  useEffect(() => {
    if (!scanning || !deviceId || !videoRef.current) return;
    gotOneRef.current = false;
    const reader = new BrowserMultiFormatReader();
    readerRef.current = reader;

    reader.decodeFromVideoDevice(deviceId, videoRef.current, (result) => {
      if (!result || gotOneRef.current) return;
      gotOneRef.current = true;
      const code = result.getText();
      setBarcode(code);
      setScanning(false);
      stopReader();
      fetchProduct(code);
    }).catch(() => {
      setError("Nepodarilo sa spustiť dekódovanie videa.");
      setScanning(false);
      stopReader();
    });

    return () => stopReader();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning, deviceId]);

  function stopReader() {
    try { readerRef.current?.reset(); } catch {}
    const v = videoRef.current;
    if (v?.srcObject) {
      (v.srcObject as MediaStream).getTracks().forEach(t => t.stop());
      v.srcObject = null;
    }
  }
  function switchCamera() {
    if (!devices.length) return;
    const idx = Math.max(0, devices.findIndex(d => d.deviceId === deviceId));
    const next = devices[(idx + 1) % devices.length];
    setDeviceId(next.deviceId);
  }

  // ---------- CZ/SK/OFF lookup chain ----------
  async function fetchOFFChain(code: string) {
    const endpoints = [
      `https://sk.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`,
      `https://cz.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`,
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`
    ];
    for (const url of endpoints) {
      try {
        const r = await fetch(url);
        if (r.ok) {
          const j = await r.json();
          if (j.status === 1 && j.product) return j;
        }
      } catch {}
    }
    throw new Error("Produkt sa nenašiel v SK/CZ/World databáze.");
  }

  // ---------- data ----------
  async function fetchProduct(code: string) {
    if (!code) return;
    setLoading(true);
    setError(null);
    setProduct(null);
    setStatus(null);
    setNotes([]);

    try {
      const off = await fetchOFFChain(code);
      const p = off.product;
      setProduct(p);

      const base = evaluateForProfile(p, profile);
      setStatus(base.status);
      setNotes(base.notes);

      // AI fallback pri 'maybe' alebo ak chýbajú ingrediencie
      if (base.status === "maybe" || !(p.ingredients_text || p.ingredients_text_sk || p.ingredients_text_cs || p.ingredients_text_en)) {
        const ai = await evaluateWithAI({
          code,
          name: p.product_name || p.generic_name || "",
          ingredients: p.ingredients_text_sk || p.ingredients_text_cs || p.ingredients_text_en || p.ingredients_text || "",
          allergens: (p.allergens_hierarchy || []).join(", "),
          lang: "sk",
          intolerances: profile?.intolerances || []
        });
        if (ai.status) setStatus(ai.status);
        if (ai.notes?.length) setNotes(n => [...n, ...ai.notes!]);
      }

      setHistory(h => [
        { code, brand: p.brands || "", name: p.product_name || p.generic_name || "Neznámy produkt", status: base.status, ts: Date.now() },
        ...h.filter((x: any) => x.code !== code)
      ]);
    } catch (e: any) {
      setError(e?.message || "Neznáma chyba");
    } finally {
      setLoading(false);
    }
  }

  function evaluateForProfile(p: any, prof: Profile | null): { status: EvalStatus; notes: string[] } {
    const notes: string[] = [];
    const tags: string[] = p.allergens_tags || [];
    const textRaw = (p.ingredients_text_sk || p.ingredients_text_cs || p.ingredients_text_en || p.ingredients_text || "");
    const txt = textRaw.toLowerCase();

    // If no profile, fall back to gluten + milk_protein
    const active = prof?.intolerances?.length ? prof.intolerances : (["gluten", "milk_protein"] as IntoleranceKey[]);

    let st: EvalStatus = "maybe";

    for (const key of active) {
      const spec = INTOLERANCES[key];
      const hitTag = tags.some(t => new RegExp(`(^|:)(${spec.sk}|${spec.cs}|${key})$`, "i").test(t));
      const hitTxt = spec.terms.some(t => txt.includes(t));

      if (hitTag || hitTxt) {
        st = "avoid";
        notes.push(`Obsahuje / môže obsahovať: ${spec.sk}.`);
      }
    }

    // Gluten-free claims for gluten
    const claims = `${p.labels || ""} ${p.traces || ""} ${(p.traces_tags || []).join(" ")}`.toLowerCase();
    const saysGF = /gluten[- ]?free|bez lepku|bezlepkov/i.test(claims);
    if (active.includes("gluten") && saysGF && st !== "avoid") {
      st = "safe";
      notes.push("Deklarované ako bezlepkové.");
    }

    if (st === "maybe") {
      notes.push("Nenašli sa jasné rizikové alergény podľa profilu. Skontroluj etiketu.");
    }

    // traces
    const traces = (p.traces || (p.traces_tags || []).join(", ") || "").toLowerCase();
    for (const key of active) {
      const spec = INTOLERANCES[key];
      if (spec.terms.some(t => traces.includes(t))) {
        notes.push(`Upozornenie: stopy ${spec.sk}.`);
        if (st === "safe") st = "maybe";
      }
    }

    return { status: st, notes };
  }

  async function evaluateWithAI(payload: { code: string; name: string; ingredients: string; allergens: string; lang: "sk" | "cs"; intolerances: IntoleranceKey[]; }): Promise<{ status?: EvalStatus; notes?: string[] }> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch("/api/eval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal
      });
      clearTimeout(t);

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        return { status: undefined, notes: [`AI doplnenie nie je dostupné (${res.status}).`, ...(txt ? [txt] : [])] };
      }
      const data: AiReply = await res.json().catch(() => ({ ok: false } as AiReply));
      if (!data.ok) return { status: undefined, notes: ["AI odpoveď nebola v poriadku. Použité boli len dáta z OFF."] };
      return { status: data.status, notes: data.notes };
    } catch {
      return { status: undefined, notes: ["AI nie je dostupná (sieť/kvóta). Rozhodnutie je len podľa OFF."] };
    }
  }

  // ---------- UI helpers ----------
  const card: React.CSSProperties = { background:"#FFFFFF", border:"1px solid rgba(0,0,0,0.06)", borderRadius:16, padding:12, boxShadow:"0 1px 3px rgba(0,0,0,0.06)" };
  const pill = (bg:string, color:string) => ({ display:"inline-block", padding:"4px 10px", borderRadius:999, fontSize:12, fontWeight:700 as const, background:bg, color, border:"1px solid rgba(0,0,0,0.06)" });
  const statusPill = (s:EvalStatus|null) =>
    s==="safe"  ? <span style={pill("#E8F8EE","#0A5A2A")}>Bezpečné</span> :
    s==="avoid" ? <span style={pill("#FDE7E7","#7E1111")}>Vyhnúť sa</span> :
    s==="maybe" ? <span style={pill("#FFF0C7","#7A5200")}>Neisté</span> :
                  <span style={pill("#F3F4F6","#374151")}>Zatiaľ nič</span>;

  function clearHistory(){ setHistory([]); localStorage.removeItem("radka_scan_history"); }

  function toggleIntol(key: IntoleranceKey) {
    setProfile(prev => {
      const cur: Profile = prev || { name: nameDraft || "", intolerances: [] };
      const exists = cur.intolerances.includes(key);
      const next = { ...cur, intolerances: exists ? cur.intolerances.filter(k => k !== key) : [...cur.intolerances, key] };
      saveProfile(next);
      return next;
    });
  }

  function completeProfile() {
    const name = (nameDraft || "").trim() || "Ja";
    const next: Profile = { name, intolerances: profile?.intolerances?.length ? profile.intolerances : ["gluten","milk_protein"] };
    setProfile(next);
    saveProfile(next);
  }

  // ---------- render ----------
  return (
    <div style={{ minHeight:"100vh", background:"#F6F7FB", color:"#111827", padding:16 }}>
      <div style={{ maxWidth:900, margin:"0 auto" }}>
        {/* header */}
        <div style={{ ...card, background:"linear-gradient(135deg, rgba(2,132,199,0.10), rgba(109,40,217,0.12))", borderRadius:20, marginBottom:16 }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, flexWrap:"wrap" }}>
            <div>
              <h1 style={{ margin:0, fontSize:28, fontWeight:800, color:"#1F2937" }}>Radka Scanner+</h1>
              <div style={{ fontSize:13, color:"#334155" }}>Profilové vyhodnocovanie pre SK/CZ + AI fallback</div>
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={() => setProfile(null)} style={{ padding:"10px 14px", borderRadius:12, border:"1px solid rgba(0,0,0,0.1)", background:"#fff", fontWeight:600 }}>
                Zmeniť profil
              </button>
              <button onClick={switchCamera} disabled={!devices.length}
                style={{ padding:"10px 14px", borderRadius:12, border:"1px solid rgba(0,0,0,0.1)", background:"#fff", fontWeight:600 }}>
                Prepnúť kameru
              </button>
              <label style={{ display:"flex", alignItems:"center", gap:8, padding:"10px 12px", borderRadius:12, border:"1px solid rgba(0,0,0,0.1)", background:"#fff", fontWeight:600 }}>
                <input type="checkbox" checked={scanning} onChange={e=>{ setError(null); setProduct(null); setStatus(null); setNotes([]); setScanning(e.target.checked); }} />
                Kamera
              </label>
            </div>
          </div>
        </div>

        {/* onboarding/profile */}
        {!profile && (
          <div style={{ ...card, marginBottom:16 }}>
            <div style={{ fontWeight:800, fontSize:18, marginBottom:10 }}>Tvoj profil</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr", gap:8, marginBottom:12 }}>
              <label style={{ fontSize:14 }}>
                Meno (voliteľné):
                <input value={nameDraft} onChange={e=>setNameDraft(e.target.value)} placeholder="napr. Radka"
                  style={{ display:"block", width:"100%", marginTop:6, padding:"10px 12px", borderRadius:12, border:"1px solid rgba(0,0,0,0.12)" }} />
              </label>
            </div>
            <div style={{ fontWeight:700, marginBottom:6 }}>Označ intolerancie/alergény</div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))", gap:8 }}>
              {Object.keys(INTOLERANCES).map((k) => {
                const key = k as IntoleranceKey;
                const spec = INTOLERANCES[key];
                const active = profile?.intolerances?.includes(key) || false;
                return (
                  <button key={key} onClick={()=>toggleIntol(key)}
                    style={{ textAlign:"left", padding:10, borderRadius:12, border:"1px solid rgba(0,0,0,0.12)", background: active ? "#E8F2FF" : "#fff", fontWeight:600 }}>
                    {spec.sk}
                  </button>
                );
              })}
            </div>
            <div style={{ marginTop:12, display:"flex", gap:8 }}>
              <button onClick={completeProfile} style={{ padding:"12px 16px", borderRadius:12, border:"1px solid rgba(109,40,217,0.25)", background:"linear-gradient(135deg,#7C3AED,#6D28D9)", color:"#fff", fontWeight:700 }}>Pokračovať</button>
              <button onClick={()=>{ setProfile({ name: (nameDraft||"Ja"), intolerances: ["gluten","milk_protein"] }); saveProfile({ name: (nameDraft||"Ja"), intolerances: ["gluten","milk_protein"] }); }} style={{ padding:"12px 16px", borderRadius:12, border:"1px solid rgba(0,0,0,0.12)", background:"#fff", fontWeight:700 }}>Len bezlepkové + bez mlieka</button>
            </div>
          </div>
        )}

        {/* scan */}
        {profile && (
          <div style={{ ...card, marginBottom:16 }}>
            <div style={{ fontWeight:700, fontSize:18, marginBottom:10 }}>Skenovanie čiarového kódu</div>

            {scanning && (
              <div style={{ borderRadius:12, overflow:"hidden", border:"1px solid rgba(0,0,0,0.1)", background:"#000", aspectRatio:"16/9", marginBottom:10 }}>
                <video ref={videoRef} style={{ width:"100%", height:"100%", objectFit:"cover" }} muted playsInline autoPlay />
              </div>
            )}

            {error && (
              <div style={{ padding:10, borderRadius:10, border:"1px solid #FCA5A5", background:"#FEE2E2", color:"#7F1D1D", marginBottom:10 }}>
                {error}
              </div>
            )}

            <div style={{ display:"grid", gridTemplateColumns:"1fr auto", gap:8 }}>
              <input
                placeholder="Zadaj EAN/UPC kód"
                value={barcode}
                onChange={e=>setBarcode(e.target.value)}
                onKeyDown={e=>{ if (e.key==="Enter" && barcode) fetchProduct(barcode); }}
                style={{ padding:"12px 12px", border:"1px solid rgba(0,0,0,0.12)", borderRadius:12, fontSize:16 }}
              />
              <button onClick={()=> barcode && fetchProduct(barcode)} disabled={!barcode || loading}
                style={{ padding:"12px 16px", borderRadius:12, border:"1px solid rgba(109,40,217,0.25)", background:loading ? "linear-gradient(135deg,#E5E7EB,#F3F4F6)" : "linear-gradient(135deg,#7C3AED,#6D28D9)", color:loading ? "#111827" : "#fff", fontWeight:700, boxShadow:"0 6px 20px rgba(109,40,217,0.25)" }}>
                {loading ? "Načítavam…" : "Vyhľadať"}
              </button>
            </div>

            <div style={{ fontSize:12, color:"#6B7280", marginTop:8 }}>
              Najprv SK/CZ databázy, potom svet. Pri nejasnostiach doplní AI podľa tvojho profilu.
            </div>
          </div>
        )}

        {/* product */}
        {product && (
          <div style={{ ...card, marginBottom:16 }}>
            <div style={{ display:"flex", justifyContent:"space-between", gap:10, alignItems:"center", flexWrap:"wrap" }}>
              <div style={{ fontWeight:800, fontSize:18 }}>{product.product_name || product.generic_name || "Neznámy produkt"}</div>
              <div>{statusPill(status)}</div>
            </div>
            <div style={{ fontSize:13, color:"#6B7280", marginTop:2 }}>Kód: {product.code}</div>

            {notes.length>0 && (
              <ul style={{ marginLeft:18, lineHeight:1.5, marginTop:8 }}>
                {notes.map((n,i)=>(<li key={i} style={{ fontSize:14 }}>{n}</li>))}
              </ul>
            )}

            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginTop:8 }}>
              <div>
                <div style={{ fontWeight:700, marginBottom:4 }}>Alergény (z databázy)</div>
                <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                  {(product.allergens_hierarchy || []).length
                    ? (product.allergens_hierarchy || []).map((t:string)=>(
                        <span key={t} style={{ fontSize:12, background:"#F3F4F6", padding:"4px 8px", borderRadius:999, border:"1px solid rgba(0,0,0,0.08)" }}>
                          {t.replace(/^.*:/,"")}
                        </span>
                      ))
                    : <span style={{ fontSize:13, color:"#6B7280" }}>Neuvádzané</span>}
                </div>
              </div>
              <div>
                <div style={{ fontWeight:700, marginBottom:4 }}>Ingrediencie (sk/cs/en)</div>
                <div style={{ fontSize:13, maxHeight:140, overflow:"auto", padding:8, borderRadius:10, background:"#F9FAFB", border:"1px solid rgba(0,0,0,0.08)" }}>
                  {product.ingredients_text_sk || product.ingredients_text_cs || product.ingredients_text_en || product.ingredients_text || "Neuvádzané"}
                </div>
              </div>
            </div>

            <div style={{ fontSize:12, color:"#6B7280", marginTop:8 }}>
              Zdroj: Open Food Facts (SK/CZ/World) • Posledná aktualizácia: {product.last_modified_t ? new Date(product.last_modified_t*1000).toLocaleDateString() : "neuvedené"}
            </div>
          </div>
        )}

        {/* history */}
        <div style={{ ...card, marginBottom:24 }}>
          <div style={{ fontWeight:800, fontSize:18 }}>Posledné skeny</div>
          {history.length===0 ? (
            <div style={{ fontSize:13, color:"#6B7280", marginTop:6 }}>Zatiaľ prázdne</div>
          ) : (
            <div style={{ display:"flex", flexDirection:"column", gap:8, marginTop:8 }}>
              {history.map((h:any)=>(
                <button key={h.code} onClick={()=>fetchProduct(h.code)}
                  style={{ textAlign:"left", border:"1px solid rgba(0,0,0,0.06)", borderRadius:12, padding:10, background:"#fff", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <div>
                    <div style={{ fontWeight:700 }}>{h.name}</div>
                    <div style={{ fontSize:12, color:"#6B7280" }}>{h.brand} • {h.code}</div>
                  </div>
                  <div style={{ fontSize:12, padding:"4px 8px", borderRadius:999, border:"1px solid rgba(0,0,0,0.06)",
                    background: h.status==="safe" ? "#E8F8EE" : h.status==="avoid" ? "#FDE7E7" : "#FFF0C7",
                    color:      h.status==="safe" ? "#0A5A2A" : h.status==="avoid" ? "#7E1111" : "#7A5200",
                    fontWeight:700 }}>
                    {h.status==="safe" ? "Bezpečné" : h.status==="avoid" ? "Vyhnúť sa" : "Neisté"}
                  </div>
                </button>
              ))}
            </div>
          )}
          <div style={{ marginTop:10, display:"flex", gap:8 }}>
            <button onClick={clearHistory} style={{ padding:"8px 12px", borderRadius:10, border:"1px solid rgba(0,0,0,0.12)", background:"#fff", fontWeight:600 }}>
              Vymazať históriu
            </button>
            <button onClick={()=>{ saveProfile(null); setProfile(null); }} style={{ padding:"8px 12px", borderRadius:10, border:"1px solid rgba(0,0,0,0.12)", background:"#fff", fontWeight:600 }}>
              Vymazať profil
            </button>
          </div>
        </div>

        <div style={{ textAlign:"center", fontSize:12, color:"#6B7280", paddingBottom:24 }}>
          Toto je pomocný nástroj. Pri nejasnostiach vždy skontroluj etiketu výrobku.
        </div>
      </div>
    </div>
  );
}
