import { useState, useEffect, useRef, useCallback } from "react";
import { auth, leagueApi, draftApi } from "./lib/api";
import { useDraftSocket } from "./hooks/useDraftSocket";
import { useLeague } from "./hooks/useLeague";

// ─── Design tokens ────────────────────────────────────────────────────────────

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400;1,700&family=JetBrains+Mono:wght@300;400;500;700&family=Cormorant+Garamond:ital,wght@0,300;0,400;1,300;1,400&display=swap');
  *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
  :root {
    --black:#0a0906; --near-black:#111009; --charcoal:#1c1a16; --warm-grey:#2e2b24;
    --mid-grey:#4a453b; --muted:#7a7060; --light:#b8ad9e; --cream:#e8dfc8; --white:#f5f0e8;
    --amber:#d4831a; --amber-bright:#f0a030; --amber-dim:#7a4a0e; --gold:#c8a030;
    --red:#c03830; --green:#3a7a50;
    --font-display:'Playfair Display',Georgia,serif;
    --font-body:'Cormorant Garamond',Georgia,serif;
    --font-mono:'JetBrains Mono',monospace;
  }
  html,body,#root { height:100%; background:var(--black); color:var(--cream); font-family:var(--font-body); font-size:16px; line-height:1.5; -webkit-font-smoothing:antialiased; }
  body::after { content:''; position:fixed; inset:0; background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E"); background-size:256px 256px; pointer-events:none; z-index:9999; opacity:0.35; }
  button { cursor:pointer; font-family:var(--font-mono); }
  input,select { font-family:var(--font-mono); }
  ::-webkit-scrollbar { width:4px; }
  ::-webkit-scrollbar-track { background:var(--charcoal); }
  ::-webkit-scrollbar-thumb { background:var(--amber-dim); border-radius:2px; }
  @keyframes fadeUp { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
  @keyframes pulse-amber { 0%,100%{opacity:1} 50%{opacity:0.5} }
  @keyframes slide-in-right { from{opacity:0;transform:translateX(20px)} to{opacity:1;transform:translateX(0)} }
  @keyframes spin { to{transform:rotate(360deg)} }
  @keyframes name-cycle { 0%,100%{opacity:1;transform:translateY(0)} 50%{opacity:0.4;transform:translateY(-6px)} }
  .fade-up { animation:fadeUp 0.4s ease both; }
`;

// ─── Shared components ────────────────────────────────────────────────────────

const GrainCard = ({ children, style, onClick }) => (
  <div onClick={onClick} style={{ background:"var(--charcoal)", border:"1px solid var(--warm-grey)", borderRadius:2, position:"relative", overflow:"hidden", ...style }}>{children}</div>
);

const Mono = ({ children, size=10, color="var(--muted)", style={}, spacing="0.12em" }) => (
  <span style={{ fontFamily:"var(--font-mono)", fontSize:size, color, letterSpacing:spacing, ...style }}>{children}</span>
);

const Label = ({ children }) => <Mono size={9} color="var(--muted)" spacing="0.2em">{children}</Mono>;

const BudgetBar = ({ remaining, total=1000 }) => {
  const pct = (remaining/total)*100;
  const color = pct>50?"var(--amber)":pct>20?"var(--gold)":"var(--red)";
  return (
    <div style={{ width:"100%", height:3, background:"var(--warm-grey)", borderRadius:2, overflow:"hidden" }}>
      <div style={{ width:`${pct}%`, height:"100%", background:color, transition:"width 0.6s ease", borderRadius:2 }} />
    </div>
  );
};

const MoviePoster = ({ poster, title, size=60 }) => (
  <div style={{ width:size, height:size*1.5, background:poster?`url(${poster}) center/cover`:"var(--warm-grey)", borderRadius:2, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", overflow:"hidden", border:"1px solid var(--mid-grey)" }}>
    {!poster && <span style={{ fontFamily:"var(--font-display)", fontSize:size*0.22, color:"var(--muted)", textAlign:"center", padding:4, lineHeight:1.2 }}>{title?.slice(0,2)}</span>}
  </div>
);

const ScorePill = ({ points, category }) => {
  const colors = { box_office:{bg:"#1a2e1a",color:"#5a9a5a"}, metacritic:{bg:"#2e1a2e",color:"#9a5a9a"}, oscar_nom:{bg:"#2e2510",color:"#c8a030"}, oscar_win:{bg:"#3a2a08",color:"#f0c040"}, oscar_best_picture:{bg:"#3a2a08",color:"#f0c040"}, festival_award:{bg:"#1a2a2e",color:"#4a9ab0"}, cinema_score:{bg:"#2e1a1a",color:"#c05050"}, profitability:{bg:"#1a2e1a",color:"#5a9a5a"} };
  const c = colors[category]||{bg:"var(--warm-grey)",color:"var(--light)"};
  return <span style={{ background:c.bg, color:c.color, fontFamily:"var(--font-mono)", fontSize:10, fontWeight:700, padding:"2px 6px", borderRadius:2 }}>+{points}</span>;
};

const Spinner = () => <div style={{ width:24, height:24, border:"2px solid var(--warm-grey)", borderTopColor:"var(--amber)", borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />;

function getSnakeNominator(nominationOrder, turn) {
  const n = nominationOrder.length;
  if (n === 0) return null;
  const round = Math.floor(turn / n);
  const pos   = turn % n;
  const idx   = round % 2 === 0 ? pos : (n - 1 - pos);
  return nominationOrder[idx];
}

const ErrorBanner = ({ message, onDismiss }) => !message ? null : (
  <div style={{ position:"fixed", top:72, left:"50%", transform:"translateX(-50%)", zIndex:200, background:"#3a0e0e", border:"1px solid var(--red)", borderRadius:2, padding:"10px 20px", display:"flex", gap:12, alignItems:"center" }}>
    <Mono size={12} color="#e06060">⚠ {message}</Mono>
    <button onClick={onDismiss} style={{ background:"none", border:"none", color:"var(--muted)", fontSize:14, padding:0 }}>✕</button>
  </div>
);

const Nav = ({ page, setPage, playerName, leagueName, onSignOut }) => (
  <nav style={{ position:"fixed", top:0, left:0, right:0, zIndex:100, background:"rgba(10,9,6,0.95)", backdropFilter:"blur(12px)", borderBottom:"1px solid var(--warm-grey)", display:"flex", alignItems:"center", padding:"0 24px", height:56 }}>
    <div style={{ marginRight:"auto", display:"flex", alignItems:"baseline", gap:8 }}>
      <span style={{ fontFamily:"var(--font-display)", fontSize:18, fontWeight:900, color:"var(--amber)", letterSpacing:"-0.02em" }}>RINGER</span>
      <Mono size={9} color="var(--muted)" spacing="0.15em">FILM DRAFT</Mono>
    </div>
    {[{id:"draft",label:"DRAFT ROOM"},{id:"dashboard",label:"LEAGUE"},{id:"roster",label:"MY ROSTER"}].map(tab => (
      <button key={tab.id} onClick={()=>setPage(tab.id)} style={{ background:"none", border:"none", borderBottom:page===tab.id?"2px solid var(--amber)":"2px solid transparent", color:page===tab.id?"var(--amber-bright)":"var(--muted)", fontFamily:"var(--font-mono)", fontSize:10, fontWeight:700, letterSpacing:"0.12em", padding:"0 20px", height:56, transition:"all 0.2s" }}>{tab.label}</button>
    ))}
    <div style={{ marginLeft:"auto", display:"flex", gap:12, alignItems:"center" }}>
      {playerName && <Mono size={10} color="var(--light)">{playerName}</Mono>}
      {leagueName && <div style={{ fontFamily:"var(--font-mono)", fontSize:10, color:"var(--muted)", border:"1px solid var(--warm-grey)", padding:"4px 10px", borderRadius:2 }}>{leagueName}</div>}
      <button onClick={onSignOut} style={{ background:"none", border:"1px solid var(--warm-grey)", borderRadius:2, color:"var(--muted)", fontFamily:"var(--font-mono)", fontSize:9, fontWeight:700, letterSpacing:"0.12em", padding:"4px 10px", cursor:"pointer", transition:"all 0.2s" }} onMouseEnter={e=>e.target.style.color="var(--light)"} onMouseLeave={e=>e.target.style.color="var(--muted)"}>SIGN OUT</button>
    </div>
  </nav>
);

// ─── AUTH SCREEN ──────────────────────────────────────────────────────────────

function AuthScreen({ onAuth }) {
  const [mode, setMode]           = useState("join");
  const [inviteCode, setInviteCode] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [signinCode, setSigninCode] = useState("");
  const [signinName, setSigninName] = useState("");
  const [leagueName, setLeagueName] = useState("");
  const [budget, setBudget]       = useState(1000);
  const [minRoster, setMinRoster] = useState(6);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const [createdCode, setCreatedCode] = useState(null);
  const [copied, setCopied]       = useState(false);

  const inp = { width:"100%", background:"var(--near-black)", border:"1px solid var(--mid-grey)", borderRadius:2, color:"var(--white)", fontFamily:"var(--font-mono)", fontSize:14, padding:"12px 14px", outline:"none", marginTop:6 };

  const handleJoin = async () => {
    if (!inviteCode.trim()||!playerName.trim()) { setError("Both fields required."); return; }
    setLoading(true); setError(null);
    try {
      const res = await leagueApi.join(inviteCode.trim().toUpperCase(), playerName.trim());
      auth.setToken(res.authToken);
      auth.setLeague({ id:res.leagueId, name:res.leagueName });
      auth.setPlayer({ id:res.playerId, name:playerName.trim() });
      onAuth();
    } catch(e) { setError(e.message); } finally { setLoading(false); }
  };

  const handleCreate = async () => {
    if (!leagueName.trim()||!playerName.trim()) { setError("Both fields required."); return; }
    setLoading(true); setError(null);
    try {
      const res = await leagueApi.create({ name:leagueName.trim(), seasonYear:new Date().getFullYear(), commissionerName:playerName.trim(), budgetPerPlayer:budget, minRoster, maxRoster:10 });
      auth.setToken(res.authToken);
      auth.setLeague({ id:res.leagueId, name:leagueName.trim() });
      auth.setPlayer({ id:res.commissionerId, name:playerName.trim(), is_commissioner:true });
      setCreatedCode(res.inviteCode);
    } catch(e) { setError(e.message); } finally { setLoading(false); }
  };

  const handleSignIn = async () => {
    if (!signinCode.trim()||!signinName.trim()) { setError("Both fields required."); return; }
    setLoading(true); setError(null);
    try {
      const res = await leagueApi.signIn(signinCode.trim().toUpperCase(), signinName.trim());
      auth.setToken(res.authToken);
      auth.setLeague({ id:res.leagueId, name:res.leagueName });
      auth.setPlayer({ id:res.playerId, name:signinName.trim(), is_commissioner:res.isCommissioner });
      onAuth();
    } catch(e) { setError(e.message); } finally { setLoading(false); }
  };

  if (createdCode) return (
    <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", padding:24 }}>
      <div style={{ width:"100%", maxWidth:400, textAlign:"center" }}>
        <div style={{ fontFamily:"var(--font-display)", fontSize:52, fontWeight:900, color:"var(--amber)", letterSpacing:"-0.02em", lineHeight:1, marginBottom:8 }}>RINGER</div>
        <Mono size={10} color="var(--muted)" spacing="0.3em">FILM DRAFT LEAGUE</Mono>
        <GrainCard style={{ padding:32, marginTop:32 }}>
          <div style={{ fontFamily:"var(--font-display)", fontSize:22, fontWeight:700, color:"var(--white)", marginBottom:8 }}>League Created!</div>
          <Mono size={11} color="var(--muted)" style={{display:"block",marginBottom:24}}>Share this invite code with your league members</Mono>
          <div style={{ fontFamily:"var(--font-mono)", fontSize:48, fontWeight:700, color:"var(--amber-bright)", letterSpacing:"0.3em", padding:"20px 0", border:"1px solid var(--amber-dim)", borderRadius:2, background:"var(--near-black)", marginBottom:16 }}>{createdCode}</div>
          <button onClick={()=>{ navigator.clipboard.writeText(createdCode); setCopied(true); setTimeout(()=>setCopied(false),2000); }}
            style={{ width:"100%", background:copied?"var(--green)":"var(--warm-grey)", color:"var(--light)", border:"none", borderRadius:2, padding:"12px 0", fontFamily:"var(--font-mono)", fontSize:10, fontWeight:700, letterSpacing:"0.12em", marginBottom:12, transition:"background 0.2s" }}>
            {copied ? "COPIED ✓" : "COPY CODE"}
          </button>
          <button onClick={onAuth} style={{ width:"100%", background:"var(--amber)", color:"var(--black)", border:"none", borderRadius:2, padding:"14px 0", fontFamily:"var(--font-mono)", fontSize:11, fontWeight:700, letterSpacing:"0.12em" }}>
            ENTER DRAFT ROOM →
          </button>
        </GrainCard>
      </div>
    </div>
  );

  return (
    <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", padding:24 }}>
      <div style={{ width:"100%", maxWidth:400 }}>
        <div style={{ textAlign:"center", marginBottom:40 }}>
          <div style={{ fontFamily:"var(--font-display)", fontSize:52, fontWeight:900, color:"var(--amber)", letterSpacing:"-0.02em", lineHeight:1 }}>RINGER</div>
          <Mono size={10} color="var(--muted)" spacing="0.3em">FILM DRAFT LEAGUE</Mono>
        </div>
        <div style={{ display:"flex", border:"1px solid var(--warm-grey)", borderRadius:2, marginBottom:28, overflow:"hidden" }}>
          {[["join","JOIN LEAGUE"],["signin","SIGN IN"],["create","CREATE LEAGUE"]].map(([m,label]) => (
            <button key={m} onClick={()=>setMode(m)} style={{ flex:1, padding:"10px 0", background:mode===m?"var(--amber)":"transparent", color:mode===m?"var(--black)":"var(--muted)", border:"none", fontFamily:"var(--font-mono)", fontSize:9, fontWeight:700, letterSpacing:"0.1em" }}>
              {label}
            </button>
          ))}
        </div>
        <GrainCard style={{ padding:24 }}>
          {error && <div style={{ background:"#2e0e0e", border:"1px solid var(--red)", borderRadius:2, padding:"10px 14px", marginBottom:16 }}><Mono size={11} color="#e06060">{error}</Mono></div>}
          {mode==="join" ? (
            <>
              <div style={{ marginBottom:16 }}>
                <Label>INVITE CODE</Label>
                <input value={inviteCode} onChange={e=>setInviteCode(e.target.value.toUpperCase())} placeholder="ABC123" maxLength={6} style={{...inp,letterSpacing:"0.3em",fontSize:20,textAlign:"center"}} />
              </div>
              <div style={{ marginBottom:20 }}>
                <Label>YOUR NAME</Label>
                <input value={playerName} onChange={e=>setPlayerName(e.target.value)} placeholder="e.g. Alex Chen" style={inp} />
              </div>
              <button onClick={handleJoin} disabled={loading} style={{ width:"100%", background:"var(--amber)", color:"var(--black)", border:"none", borderRadius:2, padding:"14px 0", fontFamily:"var(--font-mono)", fontSize:11, fontWeight:700, letterSpacing:"0.12em", display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
                {loading?<Spinner />:"JOIN LEAGUE →"}
              </button>
            </>
          ) : mode==="signin" ? (
            <>
              <div style={{ marginBottom:16 }}>
                <Label>INVITE CODE</Label>
                <input value={signinCode} onChange={e=>setSigninCode(e.target.value.toUpperCase())} placeholder="ABC123" maxLength={6} style={{...inp,letterSpacing:"0.3em",fontSize:20,textAlign:"center"}} />
              </div>
              <div style={{ marginBottom:20 }}>
                <Label>YOUR NAME (EXACT)</Label>
                <input value={signinName} onChange={e=>setSigninName(e.target.value)} placeholder="The name you joined with" style={inp} />
              </div>
              <button onClick={handleSignIn} disabled={loading} style={{ width:"100%", background:"var(--amber)", color:"var(--black)", border:"none", borderRadius:2, padding:"14px 0", fontFamily:"var(--font-mono)", fontSize:11, fontWeight:700, letterSpacing:"0.12em", display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
                {loading?<Spinner />:"SIGN IN →"}
              </button>
            </>
          ) : (
            <>
              <div style={{ marginBottom:14 }}><Label>LEAGUE NAME</Label><input value={leagueName} onChange={e=>setLeagueName(e.target.value)} placeholder="e.g. The Ringer Film Draft" style={inp} /></div>
              <div style={{ marginBottom:14 }}><Label>YOUR NAME (COMMISSIONER)</Label><input value={playerName} onChange={e=>setPlayerName(e.target.value)} placeholder="Your name" style={inp} /></div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:20 }}>
                <div><Label>BUDGET ($)</Label><input type="number" value={budget} onChange={e=>setBudget(parseInt(e.target.value)||1000)} style={inp} /></div>
                <div><Label>MIN ROSTER</Label><input type="number" value={minRoster} onChange={e=>setMinRoster(parseInt(e.target.value)||6)} min={1} max={20} style={inp} /></div>
              </div>
              <button onClick={handleCreate} disabled={loading} style={{ width:"100%", background:"var(--amber)", color:"var(--black)", border:"none", borderRadius:2, padding:"14px 0", fontFamily:"var(--font-mono)", fontSize:11, fontWeight:700, letterSpacing:"0.12em", display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
                {loading?<Spinner />:"CREATE LEAGUE →"}
              </button>
            </>
          )}
        </GrainCard>
        <div style={{ textAlign:"center", marginTop:20 }}>
          <Mono size={9} color="var(--mid-grey)">Returning player? Use SIGN IN with your invite code + name.</Mono>
        </div>
      </div>
    </div>
  );
}

// ─── CHAT PANEL ───────────────────────────────────────────────────────────────

function ChatPanel({ messages, onSend, playerName }) {
  const [input, setInput] = useState("");
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior:'smooth' }); }, [messages.length]);
  const send = () => { const t = input.trim(); if (!t) return; onSend(t); setInput(""); };
  return (
    <GrainCard style={{ display:"flex", flexDirection:"column", flex:1, minHeight:0, overflow:"hidden" }}>
      <div style={{ flex:1, overflowY:"auto", padding:12, display:"flex", flexDirection:"column", gap:4 }}>
        {messages.length===0 && <Mono size={10} color="var(--mid-grey)" style={{padding:"20px 0",textAlign:"center"}}>No messages yet</Mono>}
        {messages.map((m,i) => (
          <div key={m.id ?? i} style={{ padding:"6px 8px", borderRadius:2, background:m.playerName===playerName?"rgba(212,131,26,0.08)":"transparent" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:2 }}>
              <Mono size={10} color={m.playerName===playerName?"var(--amber-bright)":"var(--light)"} style={{fontWeight:700}}>{m.playerName}</Mono>
              <Mono size={8} color="var(--mid-grey)">{new Date(m.sentAt||m.sent_at).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</Mono>
            </div>
            <div style={{ fontFamily:"var(--font-body)", fontSize:13, color:"var(--cream)", lineHeight:1.45, wordBreak:"break-word" }}>{m.message}</div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div style={{ borderTop:"1px solid var(--warm-grey)", padding:"10px 12px", display:"flex", gap:8, flexShrink:0 }}>
        <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&send()} maxLength={200} placeholder="Say something…" style={{ flex:1, background:"var(--near-black)", border:"1px solid var(--mid-grey)", borderRadius:2, color:"var(--white)", fontFamily:"var(--font-mono)", fontSize:12, padding:"8px 12px", outline:"none" }} />
        <button onClick={send} style={{ background:"transparent", color:"var(--amber)", border:"1px solid var(--amber-dim)", borderRadius:2, fontFamily:"var(--font-mono)", fontSize:10, fontWeight:700, letterSpacing:"0.12em", padding:"0 14px", flexShrink:0 }}>SEND</button>
      </div>
    </GrainCard>
  );
}

// ─── PLAYER BUDGETS (compact) ─────────────────────────────────────────────────

function PlayerBudgetsMini({ players, you }) {
  if (!players.length) return null;
  return (
    <div>
      <Label>PLAYER BUDGETS</Label>
      <div style={{ display:"flex", flexDirection:"column", gap:6, marginTop:8 }}>
        {players.map(p => (
          <GrainCard key={p.id} style={{ padding:"10px 14px", borderColor:p.id===you?.id?"var(--amber-dim)":"var(--warm-grey)", background:p.id===you?.id?"rgba(212,131,26,0.06)":"var(--charcoal)" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
              <div style={{ fontFamily:"var(--font-body)", fontSize:13, color:p.id===you?.id?"var(--amber-bright)":"var(--cream)", fontStyle:"italic" }}>{p.name}{p.id===you?.id?" ★":""}</div>
              <Mono size={14} color="var(--cream)" style={{fontWeight:700}}>${p.budget_remaining}</Mono>
            </div>
            <BudgetBar remaining={p.budget_remaining} />
            <Mono size={9} color="var(--muted)" style={{marginTop:3}}>max bid: <span style={{color:"var(--light)"}}>${p.effective_max_bid}</span></Mono>
          </GrainCard>
        ))}
      </div>
    </div>
  );
}

// ─── NOMINATION ORDER PANEL ───────────────────────────────────────────────────

function NominationOrderPanel({ nominationOrder, nominationTurn, players, you, isCommissioner, onShuffle, onNominate }) {
  const [spinning, setSpinning] = useState(false);
  const [spinIdx,  setSpinIdx]  = useState(0);

  const handleShuffle = () => {
    setSpinning(true);
    let i = 0;
    const interval = setInterval(() => {
      setSpinIdx(Math.floor(Math.random() * Math.max(1, players.length)));
      if (++i > 30) { clearInterval(interval); setSpinning(false); }
    }, 80);
    onShuffle();
  };

  const currentNominatorId = getSnakeNominator(nominationOrder, nominationTurn);
  const isMyTurn = currentNominatorId === you?.id;

  if (nominationOrder.length === 0) {
    return (
      <GrainCard style={{ padding:"28px 24px", textAlign:"center" }}>
        {spinning ? (
          <div style={{ fontFamily:"var(--font-display)", fontSize:32, fontWeight:900, color:"var(--amber)", animation:"name-cycle 0.16s infinite", minHeight:48 }}>
            {players[spinIdx]?.name || '…'}
          </div>
        ) : isCommissioner ? (
          <>
            <div style={{ fontFamily:"var(--font-body)", fontSize:15, color:"var(--muted)", marginBottom:20, fontStyle:"italic" }}>Randomize nomination order before the draft begins.</div>
            <button onClick={handleShuffle} style={{ background:"var(--amber)", color:"var(--black)", border:"none", borderRadius:2, padding:"12px 28px", fontFamily:"var(--font-mono)", fontSize:11, fontWeight:700, letterSpacing:"0.12em" }}>🎲 RANDOMIZE ORDER</button>
          </>
        ) : (
          <Mono size={11} color="var(--muted)">Waiting for commissioner to set nomination order…</Mono>
        )}
      </GrainCard>
    );
  }

  return (
    <GrainCard style={{ padding:"16px 20px" }}>
      <Label>NOMINATION ORDER</Label>
      <div style={{ display:"flex", flexDirection:"column", gap:4, marginTop:10, marginBottom:14 }}>
        {nominationOrder.map((pid, i) => {
          const n = nominationOrder.length;
          const round = Math.floor(nominationTurn / n);
          const pos = nominationTurn % n;
          const currentIdx = round % 2 === 0 ? pos : (n - 1 - pos);
          const isCurrent = i === currentIdx;
          const player = players.find(p => p.id === pid);
          return (
            <div key={pid} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 10px", borderRadius:2, background:isCurrent?"rgba(212,131,26,0.12)":"transparent", border:isCurrent?"1px solid var(--amber-dim)":"1px solid transparent", transition:"all 0.3s" }}>
              <Mono size={10} color="var(--muted)" style={{width:16,textAlign:"center",fontWeight:700}}>{i+1}</Mono>
              <div style={{ fontFamily:"var(--font-body)", fontSize:14, color:isCurrent?"var(--amber-bright)":pid===you?.id?"var(--light)":"var(--muted)", fontStyle:"italic", flex:1 }}>{player?.name || pid}</div>
              {isCurrent && <Mono size={9} color="var(--amber)" spacing="0.15em">▶ UP</Mono>}
            </div>
          );
        })}
      </div>
      {isMyTurn
        ? <button onClick={onNominate} style={{ width:"100%", background:"var(--amber)", color:"var(--black)", border:"none", borderRadius:2, padding:"10px 0", fontFamily:"var(--font-mono)", fontSize:10, fontWeight:700, letterSpacing:"0.12em" }}>YOUR TURN — NOMINATE A FILM</button>
        : <Mono size={10} color="var(--muted)" style={{display:"block",textAlign:"center",padding:"8px 0"}}>Waiting for {players.find(p=>p.id===currentNominatorId)?.name||'…'} to nominate</Mono>
      }
    </GrainCard>
  );
}

// ─── DRAFT ROOM ───────────────────────────────────────────────────────────────

function DraftRoom({ leagueId, you }) {
  const [sessionId, setSessionId]   = useState(()=>localStorage.getItem('rdr_session'));
  const [bidInput, setBidInput]     = useState("");
  const [showPool, setShowPool]     = useState(false);
  const [poolMovies, setPoolMovies] = useState([]);
  const [poolSearch, setPoolSearch] = useState("");
  const [creating, setCreating]     = useState(false);
  const bidListRef = useRef(null);

  const { connected, draftState, secondsLeft, chatMessages, error, clearError, actions } = useDraftSocket(sessionId);

  useEffect(()=>{ if(bidListRef.current) bidListRef.current.scrollTop=bidListRef.current.scrollHeight; },[draftState?.bids?.length]);

  const loadPool = useCallback(async(search="")=>{ try{ const r=await leagueApi.pool(leagueId,{search,status:"upcoming"}); setPoolMovies(r.movies||[]); }catch{} },[leagueId]);
  useEffect(()=>{ if(showPool) loadPool(poolSearch); },[showPool,poolSearch,loadPool]);

  const handleCreateSession = async()=>{ setCreating(true); try{ const r=await draftApi.createSession(); localStorage.setItem('rdr_session',r.sessionId); setSessionId(r.sessionId); }catch(e){alert(e.message);}finally{setCreating(false);} };
  const handleBid=()=>{ const amt=parseInt(bidInput); if(!amt)return; actions.placeBid(amt); setBidInput(""); };

  const phase=draftState?.phase, currentMovie=draftState?.currentMovie, bids=draftState?.bids||[], topBid=draftState?.topBid;
  const players=draftState?.players||[], queue=draftState?.queue||[], recentSales=draftState?.recentSales||[];
  const nominationOrder=draftState?.nominationOrder||[], nominationTurn=draftState?.nominationTurn??0;
  const myPlayer=players.find(p=>p.id===you?.id), myMaxBid=myPlayer?.effective_max_bid??0;
  const timerColor=secondsLeft>15?"var(--amber)":secondsLeft>5?"#c87010":"var(--red)";

  if(!sessionId) return (
    <div style={{ padding:"88px 24px 24px", maxWidth:600, margin:"0 auto", textAlign:"center" }}>
      <div style={{ fontFamily:"var(--font-display)", fontSize:36, fontWeight:900, color:"var(--white)", marginBottom:12 }}>Draft Room</div>
      <Mono size={12} color="var(--muted)">No active draft session.</Mono>
      {you?.is_commissioner&&<button onClick={handleCreateSession} disabled={creating} style={{ marginTop:24, background:"var(--amber)", color:"var(--black)", border:"none", borderRadius:2, padding:"14px 32px", fontFamily:"var(--font-mono)", fontSize:11, fontWeight:700, letterSpacing:"0.12em" }}>{creating?"CREATING...":"CREATE DRAFT SESSION"}</button>}
      {!you?.is_commissioner&&<Mono size={11} color="var(--mid-grey)" style={{display:"block",marginTop:16}}>Ask your commissioner to create a session.</Mono>}
    </div>
  );

  return (
    <div style={{ display:"grid", gridTemplateColumns:"1fr 360px 320px", gap:16, padding:"88px 24px 24px", minHeight:"100vh", maxWidth:1400, margin:"0 auto" }}>
      <ErrorBanner message={error} onDismiss={clearError} />

      {/* CENTER */}
      <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <div style={{ width:8, height:8, borderRadius:"50%", background:connected?"var(--amber)":"var(--mid-grey)", animation:connected&&phase==="bidding"?"pulse-amber 1.2s infinite":"none" }} />
          <Mono size={10} color={connected?"var(--amber)":"var(--muted)"} spacing="0.2em" style={{fontWeight:700}}>
            {!connected?"CONNECTING...":phase==="idle"?"WAITING FOR COMMISSIONER":phase==="nominating"?"NOMINATING":phase==="bidding"?"LIVE AUCTION":phase==="complete"?"DRAFT COMPLETE":"LIVE"}
          </Mono>
          {you?.is_commissioner&&phase==="idle"&&<button onClick={actions.startDraft} style={{ marginLeft:12, background:"var(--amber)", color:"var(--black)", border:"none", borderRadius:2, padding:"6px 14px", fontFamily:"var(--font-mono)", fontSize:10, fontWeight:700 }}>START DRAFT</button>}
        </div>

        {currentMovie ? (
          <GrainCard style={{ padding:0, overflow:"hidden" }}>
            <div style={{ position:"relative", background:"linear-gradient(135deg,#1a1208 0%,#0e0c08 100%)", padding:32, display:"flex", gap:28, alignItems:"flex-start" }}>
              <div style={{ position:"absolute", left:0, top:0, bottom:0, width:16, display:"flex", flexDirection:"column", justifyContent:"space-around", padding:"8px 0" }}>
                {Array.from({length:12}).map((_,i)=><div key={i} style={{ width:8,height:8,borderRadius:2,background:"var(--black)",border:"1px solid var(--warm-grey)",marginLeft:4 }} />)}
              </div>
              <div style={{ marginLeft:24 }}><MoviePoster poster={currentMovie.poster} title={currentMovie.title} size={120} /></div>
              <div style={{ flex:1 }}>
                <Label>NOW ON THE BLOCK</Label>
                <h1 style={{ fontFamily:"var(--font-display)", fontSize:38, fontWeight:900, lineHeight:1, color:"var(--white)", margin:"8px 0 6px", letterSpacing:"-0.02em" }}>{currentMovie.title}</h1>
                <div style={{ fontFamily:"var(--font-body)", fontSize:15, color:"var(--amber)", fontStyle:"italic", marginBottom:10 }}>dir. {currentMovie.tmdb_director||currentMovie.director}</div>
                <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:12 }}>
                  {(currentMovie.genres||[]).map(g=><span key={typeof g==="string"?g:g.name} style={{ fontFamily:"var(--font-mono)", fontSize:9, color:"var(--light)", border:"1px solid var(--mid-grey)", padding:"3px 8px", borderRadius:1, letterSpacing:"0.1em" }}>{typeof g==="string"?g:g.name}</span>)}
                </div>
                <p style={{ fontFamily:"var(--font-body)", fontSize:13, color:"var(--light)", lineHeight:1.6, maxWidth:420 }}>{currentMovie.tmdb_overview||currentMovie.overview}</p>
                {currentMovie.metacritic_score&&<div style={{ marginTop:12, display:"inline-flex", alignItems:"center", gap:8, background:"var(--black)", padding:"6px 12px", borderRadius:2 }}>
                  <Mono size={9} color="var(--muted)" spacing="0.1em">METACRITIC</Mono>
                  <span style={{ fontFamily:"var(--font-mono)", fontSize:20, fontWeight:700, color:currentMovie.metacritic_score>=80?"#6abf69":"var(--amber)" }}>{currentMovie.metacritic_score}</span>
                </div>}
              </div>
            </div>
          </GrainCard>
        ) : phase==="nominating" ? (
          <NominationOrderPanel
            nominationOrder={nominationOrder}
            nominationTurn={nominationTurn}
            players={players}
            you={you}
            isCommissioner={!!you?.is_commissioner}
            onShuffle={actions.shuffleNominationOrder}
            onNominate={()=>setShowPool(true)}
          />
        ) : (
          <GrainCard style={{ padding:40, textAlign:"center" }}>
            {phase==="complete"?<div style={{ fontFamily:"var(--font-display)", fontSize:32, color:"var(--amber)", fontStyle:"italic" }}>Draft complete.</div>
            :<div style={{ fontFamily:"var(--font-display)", fontSize:24, color:"var(--muted)" }}>Waiting to start...</div>}
          </GrainCard>
        )}

        {phase==="bidding"&&<GrainCard style={{ padding:"20px 24px" }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
            <div>
              <Label>CURRENT HIGH BID</Label>
              <div style={{ display:"flex", alignItems:"baseline", gap:8, marginTop:4 }}>
                {topBid
                  ? <><span style={{ fontFamily:"var(--font-display)", fontSize:48, fontWeight:900, color:"var(--amber-bright)", lineHeight:1 }}>${topBid.amount}</span>
                       <span style={{ fontFamily:"var(--font-body)", fontSize:16, color:"var(--light)", fontStyle:"italic" }}>{topBid.playerName}</span></>
                  : <span style={{ fontFamily:"var(--font-display)", fontSize:32, fontWeight:700, color:"var(--mid-grey)", lineHeight:1 }}>NO BIDS YET</span>
                }
              </div>
            </div>
            <div style={{ textAlign:"center" }}>
              <Label>CLOSES IN</Label>
              <div style={{ fontFamily:"var(--font-mono)", fontSize:52, fontWeight:700, color:timerColor, lineHeight:1, transition:"color 0.3s", animation:secondsLeft<=10?"pulse-amber 0.6s infinite":"none" }}>{String(secondsLeft).padStart(2,"0")}</div>
            </div>
          </div>
          <div style={{ height:3, background:"var(--warm-grey)", borderRadius:2, overflow:"hidden", marginBottom:20 }}>
            <div style={{ height:"100%", background:`linear-gradient(90deg,${timerColor},${timerColor}cc)`, borderRadius:2, width:`${(secondsLeft/30)*100}%`, transition:"width 1s linear,background 0.3s" }} />
          </div>
          <div style={{ display:"flex", gap:10 }}>
            <div style={{ position:"relative", flex:1 }}>
              <span style={{ position:"absolute", left:14, top:"50%", transform:"translateY(-50%)", fontFamily:"var(--font-mono)", fontSize:18, color:"var(--muted)", fontWeight:700 }}>$</span>
              <input type="number" value={bidInput} onChange={e=>setBidInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleBid()} placeholder={(topBid?.amount??0)+1} min={(topBid?.amount??0)+1}
                style={{ width:"100%", height:52, background:"var(--near-black)", border:"1px solid var(--mid-grey)", borderRadius:2, color:"var(--white)", fontFamily:"var(--font-mono)", fontSize:20, fontWeight:700, padding:"0 16px 0 32px", outline:"none" }} />
            </div>
            <button onClick={handleBid} style={{ background:"var(--amber)", color:"var(--black)", border:"none", borderRadius:2, fontFamily:"var(--font-mono)", fontSize:11, fontWeight:700, letterSpacing:"0.12em", padding:"0 28px", height:52 }}>PLACE BID</button>
            {[(topBid?.amount??0)+25,(topBid?.amount??0)+50,(topBid?.amount??0)+100].map(amt=>amt<=myMaxBid&&<button key={amt} onClick={()=>{ actions.placeBid(amt); setBidInput(""); }} style={{ background:"var(--warm-grey)", color:"var(--light)", border:"none", borderRadius:2, fontFamily:"var(--font-mono)", fontSize:11, padding:"0 14px", height:52 }}>+{amt-(topBid?.amount??0)}</button>)}
            {you?.is_commissioner&&<button onClick={actions.pass} style={{ background:"transparent", color:"var(--muted)", border:"1px solid var(--warm-grey)", borderRadius:2, fontFamily:"var(--font-mono)", fontSize:10, padding:"0 14px", height:52 }}>PASS</button>}
          </div>
          <Mono size={10} color="var(--muted)" style={{marginTop:8}}>Your effective max: <span style={{color:"var(--light)"}}>${myMaxBid}</span><span style={{marginLeft:12,color:"var(--mid-grey)"}}>· ${myPlayer?.budget_remaining} remaining</span></Mono>
        </GrainCard>}

        {recentSales.length>0&&<div>
          <Label>RECENTLY SOLD</Label>
          <div style={{ display:"flex", gap:10, marginTop:10 }}>
            {recentSales.slice(0,3).map((sale,i)=><GrainCard key={i} style={{ flex:1, padding:"12px 14px" }}><div style={{ fontFamily:"var(--font-body)", fontSize:13, color:"var(--cream)", fontStyle:"italic", marginBottom:2 }}>{sale.movie?.title}</div><Mono size={10} color="var(--muted)">{sale.winner}</Mono><div style={{ fontFamily:"var(--font-mono)", fontSize:16, fontWeight:700, color:"var(--amber)", marginTop:4 }}>${sale.amount}</div></GrainCard>)}
          </div>
        </div>}
        {players.length>0&&<PlayerBudgetsMini players={players} you={you} />}
      </div>

      {/* BID HISTORY */}
      <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
        <Label>BID HISTORY</Label>
        <GrainCard style={{ flex:1, display:"flex", flexDirection:"column", maxHeight:"calc(100vh - 280px)" }}>
          <div ref={bidListRef} style={{ flex:1, overflowY:"auto", padding:16, display:"flex", flexDirection:"column", gap:6 }}>
            {bids.length===0&&<Mono size={11} color="var(--mid-grey)" style={{padding:"20px 0",textAlign:"center"}}>No bids yet</Mono>}
            {bids.map((bid,i)=>{ const isLatest=i===bids.length-1; return (
              <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 12px", background:isLatest?"rgba(212,131,26,0.12)":"transparent", borderLeft:isLatest?"2px solid var(--amber)":"2px solid transparent", borderRadius:1, animation:isLatest?"slide-in-right 0.3s ease":"none" }}>
                <div><div style={{ fontFamily:"var(--font-body)", fontSize:13, color:isLatest?"var(--cream)":"var(--light)", fontStyle:"italic" }}>{bid.playerName}</div><Mono size={9} color="var(--muted)">{new Date(bid.placedAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"})}</Mono></div>
                <div style={{ fontFamily:"var(--font-mono)", fontSize:isLatest?22:16, fontWeight:700, color:isLatest?"var(--amber-bright)":"var(--light)" }}>${bid.amount}</div>
              </div>
            );})}
          </div>
        </GrainCard>
        <Label>UP NEXT</Label>
        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
          {queue.length===0&&<Mono size={10} color="var(--mid-grey)">Queue is empty</Mono>}
          {queue.slice(0,4).map((item,i)=><GrainCard key={item.id} style={{ padding:"10px 14px", display:"flex", alignItems:"center", gap:10, opacity:1-i*0.15 }}><Mono size={10} color="var(--muted)" style={{width:16,textAlign:"center"}}>{i+1}</Mono><div style={{flex:1}}><div style={{ fontFamily:"var(--font-body)", fontSize:13, color:"var(--cream)", fontStyle:"italic" }}>{item.title}</div><Mono size={9} color="var(--muted)">nom. {item.nominated_by_name}</Mono></div></GrainCard>)}
          {(phase==="bidding"||(phase==="nominating"&&(nominationOrder.length===0||getSnakeNominator(nominationOrder,nominationTurn)===you?.id)))&&<button onClick={()=>setShowPool(true)} style={{ marginTop:4, background:"transparent", color:"var(--amber)", border:"1px solid var(--amber-dim)", borderRadius:2, padding:"8px 0", fontFamily:"var(--font-mono)", fontSize:10, fontWeight:700, letterSpacing:"0.12em" }}>+ NOMINATE</button>}
        </div>
      </div>

      {/* CHAT */}
      <div style={{ display:"flex", flexDirection:"column", gap:12, minHeight:0 }}>
        <Label>LEAGUE CHAT</Label>
        <ChatPanel messages={chatMessages} onSend={actions.sendChatMessage} playerName={you?.name} />
      </div>

      {/* POOL MODAL */}
      {showPool&&<div style={{ position:"fixed", inset:0, background:"rgba(10,9,6,0.85)", zIndex:300, display:"flex", alignItems:"center", justifyContent:"center", backdropFilter:"blur(4px)" }} onClick={()=>setShowPool(false)}>
        <GrainCard style={{ width:560, maxHeight:"75vh", display:"flex", flexDirection:"column" }} onClick={e=>e.stopPropagation()}>
          <div style={{ padding:"20px 20px 12px", borderBottom:"1px solid var(--warm-grey)" }}>
            <div style={{ fontFamily:"var(--font-display)", fontSize:22, fontWeight:700, color:"var(--white)", marginBottom:10 }}>Nominate a Film</div>
            <input value={poolSearch} onChange={e=>setPoolSearch(e.target.value)} placeholder="Search pool..." style={{ width:"100%", background:"var(--near-black)", border:"1px solid var(--mid-grey)", borderRadius:2, color:"var(--white)", fontFamily:"var(--font-mono)", fontSize:13, padding:"10px 14px", outline:"none" }} />
          </div>
          <div style={{ flex:1, overflowY:"auto", padding:12, display:"flex", flexDirection:"column", gap:6 }}>
            {poolMovies.filter(m=>!m.owned_by).map(m=><div key={m.id} onClick={()=>{ actions.nominate(m.id); setShowPool(false); }} style={{ padding:"12px 14px", display:"flex", gap:12, alignItems:"center", cursor:"pointer", borderRadius:2, border:"1px solid transparent", transition:"all 0.15s" }}
              onMouseEnter={e=>{e.currentTarget.style.background="rgba(212,131,26,0.08)";e.currentTarget.style.borderColor="var(--amber-dim)"}}
              onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.borderColor="transparent"}}>
              <MoviePoster poster={m.poster} title={m.title} size={36} />
              <div style={{flex:1}}><div style={{ fontFamily:"var(--font-body)", fontSize:15, color:"var(--white)", fontStyle:"italic" }}>{m.title}</div><Mono size={9} color="var(--muted)">{m.tmdb_director} · {m.release_date?.slice(0,4)}</Mono></div>
              {m.in_queue&&<Mono size={9} color="var(--amber)">QUEUED</Mono>}
            </div>)}
          </div>
        </GrainCard>
      </div>}
    </div>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

function Dashboard({ you }) {
  const { league, standings, feed, loading } = useLeague();
  const catLabel = { box_office:"Box Office", metacritic:"Metacritic", oscar_nom:"Oscar Nom", oscar_win:"Oscar Win", oscar_best_picture:"Best Picture", festival_award:"Festival", cinema_score:"CinemaScore", profitability:"Profitability" };

  if(loading) return <div style={{ padding:"88px 24px", display:"flex", justifyContent:"center" }}><Spinner /></div>;

  return (
    <div style={{ padding:"88px 24px 24px", maxWidth:1200, margin:"0 auto" }}>
      <div style={{ marginBottom:32 }}>
        <Mono size={9} color="var(--amber)" spacing="0.25em">THE RINGER FILM DRAFT · SEASON {league?.season_year||new Date().getFullYear()}</Mono>
        <h1 style={{ fontFamily:"var(--font-display)", fontSize:52, fontWeight:900, color:"var(--white)", lineHeight:1, letterSpacing:"-0.02em", marginTop:8 }}>League<br /><em style={{color:"var(--amber)"}}>Standings</em></h1>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 340px", gap:24 }}>
        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
          {standings.map((p,rank)=><GrainCard key={p.id} className="fade-up" style={{ padding:"18px 20px", display:"flex", alignItems:"center", gap:16, animationDelay:`${rank*0.06}s`, borderColor:rank===0?"var(--amber-dim)":"var(--warm-grey)" }}>
            <div style={{ fontFamily:"var(--font-display)", fontSize:rank===0?36:24, fontWeight:900, color:rank===0?"var(--amber)":"var(--mid-grey)", width:40, flexShrink:0, textAlign:"center", lineHeight:1 }}>{rank+1}</div>
            <div style={{flex:1}}>
              <div style={{ fontFamily:"var(--font-body)", fontSize:20, fontStyle:"italic", color:p.id===you?.id?"var(--amber-bright)":rank===0?"var(--white)":"var(--cream)", marginBottom:4 }}>{p.name}{p.id===you?.id?" ★":""}</div>
              <Mono size={10} color="var(--muted)">{p.movies_owned} films · ${p.budget_remaining} remaining</Mono>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{ fontFamily:"var(--font-mono)", fontSize:32, fontWeight:700, color:rank===0?"var(--amber-bright)":"var(--light)", lineHeight:1 }}>{p.total_points}</div>
              <Mono size={9} color="var(--muted)" spacing="0.1em">PTS</Mono>
            </div>
            <div style={{width:80}}><BudgetBar remaining={p.budget_remaining} /></div>
          </GrainCard>)}
          {standings.length===0&&<Mono size={12} color="var(--mid-grey)" style={{padding:"40px 0",textAlign:"center"}}>No standings yet — draft some films!</Mono>}
        </div>
        <div>
          <Label>SCORING FEED</Label>
          <div style={{ display:"flex", flexDirection:"column", gap:8, marginTop:12 }}>
            {feed.length===0&&<Mono size={11} color="var(--mid-grey)">No scoring events yet.</Mono>}
            {feed.map((ev,i)=><GrainCard key={i} className="fade-up" style={{ padding:"14px 16px", animationDelay:`${i*0.07}s` }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:6 }}>
                <div style={{ fontFamily:"var(--font-body)", fontSize:14, color:"var(--cream)", fontStyle:"italic", flex:1 }}>{ev.movie_title}</div>
                <ScorePill points={ev.points} category={ev.category} />
              </div>
              <Mono size={9} color="var(--muted)">{ev.player_name} · {catLabel[ev.category]||ev.category}</Mono>
              <Mono size={9} color="var(--mid-grey)" style={{display:"block",marginTop:2}}>{ev.description}</Mono>
            </GrainCard>)}
          </div>
          <div style={{marginTop:24}}>
            <Label>SCORING KEY</Label>
            <GrainCard style={{padding:16,marginTop:12}}>
              {[["Box Office","$25M+/100M+/250M+/500M+","3/7/12/20"],["Profitability",">1x/2x/3x+","3/6/10"],["Metacritic","40+/60+/80+","1/3/6"],["Oscar Nom","per nom","2"],["Oscar Win","per win (+BP bonus)","5(+10)"],["CinemaScore","A-/A/A+","3/6"],["Festival","Palme/Lion/Bear","2–4"]].map(([cat,desc,pts])=>(
                <div key={cat} style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", padding:"5px 0", borderBottom:"1px solid var(--warm-grey)" }}>
                  <div><Mono size={10} color="var(--light)" style={{fontWeight:600}}>{cat}</Mono><Mono size={9} color="var(--muted)" style={{marginLeft:8}}>{desc}</Mono></div>
                  <Mono size={10} color="var(--amber)" style={{fontWeight:700}}>{pts}</Mono>
                </div>
              ))}
            </GrainCard>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── MY ROSTER ────────────────────────────────────────────────────────────────

function RosterPage({ leagueId, you }) {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(()=>{ if(!leagueId||!you?.id)return; (async()=>{ try{ const r=await leagueApi.roster(leagueId,you.id); setData(r); }catch{}finally{setLoading(false);} })(); },[leagueId,you?.id]);

  const shareUrl = `${window.location.origin}/api/leagues/${leagueId}/roster/${you?.id}`;
  const handleCopy=()=>{ navigator.clipboard.writeText(shareUrl); setCopied(true); setTimeout(()=>setCopied(false),2000); };

  if(loading) return <div style={{ padding:"88px 24px", display:"flex", justifyContent:"center" }}><Spinner /></div>;

  const roster=data?.roster||[], released=roster.filter(m=>m.status==="released"), upcoming=roster.filter(m=>m.status!=="released");

  return (
    <div style={{ padding:"88px 0 60px", maxWidth:900, margin:"0 auto" }}>
      <div style={{ padding:"40px 40px 32px", background:"linear-gradient(160deg,#1a1408 0%,var(--black) 60%)", borderBottom:"1px solid var(--warm-grey)", position:"relative", overflow:"hidden", marginBottom:32 }}>
        <div style={{ position:"absolute", right:40, top:"50%", transform:"translateY(-50%)", fontFamily:"var(--font-display)", fontSize:200, fontWeight:900, color:"rgba(212,131,26,0.04)", lineHeight:1, userSelect:"none" }}>{data?.rank}</div>
        <Mono size={9} color="var(--amber)" spacing="0.25em">{data?.league?.name} · {data?.league?.season_year}</Mono>
        <h1 style={{ fontFamily:"var(--font-display)", fontSize:52, fontWeight:900, lineHeight:1, letterSpacing:"-0.02em", color:"var(--white)", margin:"10px 0 12px" }}>{you?.name}</h1>
        <div style={{ display:"flex", gap:24, alignItems:"center" }}>
          {[["RANK",`${data?.rank}/${data?.totalPlayers}`],["TOTAL POINTS",data?.totalPoints||0],["FILMS DRAFTED",roster.length]].map(([lbl,val],i)=>[
            i>0&&<div key={`d${i}`} style={{ width:1, height:40, background:"var(--warm-grey)" }} />,
            <div key={lbl}><Label>{lbl}</Label><div style={{ fontFamily:"var(--font-display)", fontSize:40, fontWeight:900, color:i===0?"var(--amber)":"var(--cream)", lineHeight:1 }}>{val}</div></div>
          ])}
        </div>
      </div>

      <div style={{padding:"0 24px"}}>
        {released.length>0&&<>
          <Mono size={9} color="var(--amber)" spacing="0.25em">RELEASED · {released.length} FILMS</Mono>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))", gap:2, margin:"16px 0 32px" }}>
            {released.map((m,i)=><div key={m.id} className="fade-up" style={{ background:"var(--charcoal)", border:"1px solid var(--warm-grey)", padding:"18px 18px 16px", display:"flex", gap:14, animationDelay:`${i*0.05}s`, transition:"border-color 0.2s,background 0.2s" }}
              onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--amber-dim)";e.currentTarget.style.background="rgba(212,131,26,0.04)"}}
              onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--warm-grey)";e.currentTarget.style.background="var(--charcoal)"}}>
              <MoviePoster poster={m.poster} title={m.title} size={54} />
              <div style={{flex:1,minWidth:0}}>
                <div style={{ fontFamily:"var(--font-body)", fontSize:15, color:"var(--white)", fontStyle:"italic", fontWeight:600, lineHeight:1.2, marginBottom:3 }}>{m.title}</div>
                <Mono size={9} color="var(--muted)" style={{marginBottom:8}}>{m.director}</Mono>
                <div style={{display:"flex",gap:10,alignItems:"center"}}>
                  {m.metacritic_score&&<Mono size={10} color={m.metacritic_score>=80?"#6abf69":"var(--light)"} style={{fontWeight:700}}>MC {m.metacritic_score}</Mono>}
                  {m.domestic_gross&&<Mono size={10} color="var(--muted)">${(m.domestic_gross/1_000_000).toFixed(0)}M</Mono>}
                </div>
              </div>
              <div style={{textAlign:"right",flexShrink:0}}>
                <div style={{ fontFamily:"var(--font-mono)", fontSize:22, fontWeight:700, color:(m.total_pts||0)>0?"var(--amber-bright)":"var(--mid-grey)", lineHeight:1 }}>{m.total_pts||0}</div>
                <Mono size={8} color="var(--muted)" spacing="0.1em">PTS</Mono>
                <Mono size={10} color="var(--mid-grey)" style={{display:"block",marginTop:6}}>${m.draft_bid}</Mono>
              </div>
            </div>)}
          </div>
        </>}

        {upcoming.length>0&&<>
          <Mono size={9} color="var(--muted)" spacing="0.25em">UPCOMING · {upcoming.length} FILMS</Mono>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))", gap:2, margin:"16px 0 32px" }}>
            {upcoming.map((m,i)=><div key={m.id} className="fade-up" style={{ background:"var(--near-black)", border:"1px solid var(--warm-grey)", padding:"18px 18px 16px", display:"flex", gap:14, opacity:0.75, animationDelay:`${(released.length+i)*0.05}s` }}>
              <MoviePoster poster={m.poster} title={m.title} size={54} />
              <div style={{flex:1,minWidth:0}}>
                <div style={{ fontFamily:"var(--font-body)", fontSize:15, color:"var(--light)", fontStyle:"italic", lineHeight:1.2, marginBottom:3 }}>{m.title}</div>
                <Mono size={9} color="var(--muted)" style={{marginBottom:6}}>{m.director}</Mono>
                <Mono size={9} color="var(--muted)">{m.release_date&&new Date(m.release_date).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}</Mono>
              </div>
              <div style={{textAlign:"right",flexShrink:0}}>
                <Mono size={10} color="var(--mid-grey)">${m.draft_bid}</Mono>
                <Mono size={9} color="var(--mid-grey)" spacing="0.1em" style={{display:"block",marginTop:2}}>PAID</Mono>
              </div>
            </div>)}
          </div>
        </>}

        {roster.length===0&&<Mono size={14} color="var(--mid-grey)" style={{display:"block",padding:"60px 0",textAlign:"center"}}>No films drafted yet.</Mono>}

        <div style={{ marginTop:16, padding:"20px 24px", border:"1px solid var(--warm-grey)", display:"flex", alignItems:"center", justifyContent:"space-between", background:"var(--charcoal)" }}>
          <div><Label>SHARE YOUR ROSTER</Label><Mono size={12} color="var(--light)" style={{display:"block",marginTop:4}}>{shareUrl}</Mono></div>
          <button onClick={handleCopy} style={{ background:copied?"var(--green)":"var(--amber)", color:"var(--black)", border:"none", borderRadius:2, fontFamily:"var(--font-mono)", fontSize:10, fontWeight:700, letterSpacing:"0.12em", padding:"12px 24px", transition:"background 0.2s" }}>{copied?"COPIED ✓":"COPY LINK"}</button>
        </div>
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [page, setPage]         = useState("draft");
  const [loggedIn, setLoggedIn] = useState(auth.isLoggedIn());
  const player = auth.getPlayer();
  const league = auth.getLeague();

  const handleSignOut = () => { auth.clear(); setLoggedIn(false); };

  if(!loggedIn) return (<><style dangerouslySetInnerHTML={{__html:CSS}} /><AuthScreen onAuth={()=>setLoggedIn(true)} /></>);

  return (
    <>
      <style dangerouslySetInnerHTML={{__html:CSS}} />
      <Nav page={page} setPage={setPage} playerName={player?.name} leagueName={league?.name} onSignOut={handleSignOut} />
      {page==="draft"     && <DraftRoom  leagueId={league?.id} you={player} />}
      {page==="dashboard" && <Dashboard  leagueId={league?.id} you={player} />}
      {page==="roster"    && <RosterPage leagueId={league?.id} you={player} />}
    </>
  );
}
