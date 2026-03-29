"use client";
import { useState, useMemo, useCallback, useEffect } from "react";

function parseQASM(qasm) {
  const gates = []; let nQubits = 0, t = 0; const shifts = new Set();
  for (const line of qasm.split("\n")) {
    const trimmed = line.trim().replace(";", "");
    const qr = trimmed.match(/qreg\s+\w+\[(\d+)\]/);
    if (qr) { nQubits = Math.max(nQubits, parseInt(qr[1])); continue; }
    const cx = trimmed.match(/cx\s+\w+\[(\d+)\]\s*,\s*\w+\[(\d+)\]/);
    if (cx) { gates.push({ ctrl: parseInt(cx[1]), targ: parseInt(cx[2]), t: t++ }); continue; }
    const h = trimmed.match(/h\s+\w+\[(\d+)\]/);
    if (h) { shifts.add(parseInt(h[1])); }
  }
  if (nQubits === 0 && gates.length > 0) { const a = new Set(); gates.forEach(g=>{a.add(g.ctrl);a.add(g.targ)}); nQubits = Math.max(...a)+1; }
  return { gates, nQubits, shifts };
}

function parseGateList(text) {
  const gates = []; const shifts = new Set(); let t = 0;
  for (const token of text.split(/[,;\n]+/)) {
    const s = token.trim(); if (!s) continue;
    const hm = s.match(/^[hH]\s*(\d+)$/);
    if (hm) { shifts.add(parseInt(hm[1])); continue; }
    const gm = s.match(/(\d+)\s*[->:→]+\s*(\d+)/);
    if (gm) gates.push({ ctrl: parseInt(gm[1]), targ: parseInt(gm[2]), t: t++ });
  }
  const a = new Set(); gates.forEach(g=>{a.add(g.ctrl);a.add(g.targ)});
  return { gates, nQubits: a.size > 0 ? Math.max(...a)+1 : 0, shifts };
}

function classifyNodes(gates, nQubits) {
  const tt = {}, ct = {}, aT = new Set(), aC = new Set();
  gates.forEach((g, i) => {
    const time = g.t ?? i;
    aC.add(g.ctrl); aT.add(g.targ);
    if (!tt[g.targ]) tt[g.targ] = []; if (!ct[g.ctrl]) ct[g.ctrl] = [];
    tt[g.targ].push(time); ct[g.ctrl].push(time);
  });
  const nodes = []; let nR = 0;
  for (let q = 0; q < nQubits; q++) {
    const isT = aT.has(q), isC = aC.has(q);
    let type, relay;
    if (!isT && !isC) { type="virgin"; relay=0; }
    else if (isT && !isC) { type="spoke"; relay=0; }
    else if (isC && !isT) { type="hub"; relay=0; }
    else {
      const hasCA = (tt[q]||[]).some(t1 => (ct[q]||[]).some(t2 => t2 > t1));
      type = hasCA ? "relay" : "hub"; relay = hasCA ? 1 : 0; if (relay) nR++;
    }
    nodes.push({ index: q, type, relay, isolated: relay === 0 });
  }
  return { nodes, nRelays: nR, fullyIsolated: nR === 0 };
}

function estimateLoads(gates, nQubits, shifts) {
  const X = (s) => [s[1], s[0]];
  const H = (s) => [(s[0]+s[1])/Math.SQRT2, (s[0]-s[1])/Math.SQRT2];
  const st = {}; for (let q=0;q<nQubits;q++) st[q]=[1,0];
  for (const q of shifts) st[q] = H(st[q]);
  [...gates].sort((a,b)=>(a.t??0)-(b.t??0)).forEach(g => {
    const p1 = st[g.ctrl][1]**2;
    if (p1 > 1e-10) {
      const [a,b] = st[g.targ];
      const nA = Math.sqrt(1-p1)*a + Math.sqrt(p1)*b;
      const nB = Math.sqrt(1-p1)*b + Math.sqrt(p1)*a;
      const nm = Math.sqrt(nA**2+nB**2);
      st[g.targ] = nm>1e-10 ? [nA/nm,nB/nm] : [1,0];
    }
  });
  const loads = {};
  for (let q=0;q<nQubits;q++) {
    const ov = st[q][0]**2;
    const alpha = Math.acos(Math.sqrt(Math.min(1,Math.max(0,ov))));
    const f = Math.pow(Math.cos(alpha),4);
    loads[q] = { alpha, fidelity: f, free: f > 0.99 };
  }
  return loads;
}

function findChains(gates, analysis) {
  const rs = new Set(analysis.nodes.filter(n=>n.type==="relay").map(n=>n.index));
  if (!rs.size) return [];
  const adj = {}; gates.forEach(g => { if(!adj[g.ctrl])adj[g.ctrl]=[]; adj[g.ctrl].push(g.targ); });
  const chains = [], vis = new Set();
  for (const n of analysis.nodes) {
    if (n.type !== "hub") continue;
    const path = [n.index]; let cur = n.index;
    while (adj[cur]) {
      const rn = adj[cur].find(x => rs.has(x)&&!vis.has(x));
      if (rn !== undefined) { path.push(rn); vis.add(rn); cur = rn; }
      else { const sn = adj[cur]?.find(x=>analysis.nodes[x]?.type==="spoke"); if(sn!==undefined)path.push(sn); break; }
    }
    if (path.length > 2) chains.push(path);
  }
  return chains;
}

function findAlts(gates, analysis, loads) {
  const alts = [];
  for (let i = 0; i < gates.length-1; i++) {
    const g1=gates[i], g2=gates[i+1];
    if (g1.targ===g2.ctrl && analysis.nodes[g1.targ]?.type==="relay") {
      const rq=g1.targ, ld=loads[rq];
      const free = ld?.free;
      alts.push({
        relay:rq, free,
        desc: free
          ? `q${rq}: FREE REWRITE (α=${ld?.alpha?.toFixed(3)??0}). Replace q${g1.ctrl}→q${rq}→q${g2.targ} with star from q${g1.ctrl}.`
          : `q${rq}: cost F=${ld?.fidelity?.toFixed(4)??'?'} (α=${ld?.alpha?.toFixed(3)??'?'}). ${(ld?.fidelity??0)>0.5?"Consider":"Expensive"}: star from q${g1.ctrl}.`
      });
    }
  }
  return alts;
}

// ─── Benchmark Circuits ───────────────────────────────────────
// Real quantum algorithm CNOT structures for relay analysis

const BENCHMARKS = [
  {
    name: "QFT-4", category: "Transform", qubits: 4,
    desc: "Quantum Fourier Transform",
    gates: "0→1\n0→2\n0→3\n1→2\n1→3\n2→3",
  },
  {
    name: "QFT-8", category: "Transform", qubits: 8,
    desc: "8-qubit QFT",
    gates: "0→1\n0→2\n0→3\n0→4\n0→5\n0→6\n0→7\n1→2\n1→3\n1→4\n1→5\n1→6\n1→7\n2→3\n2→4\n2→5\n2→6\n2→7\n3→4\n3→5\n3→6\n3→7\n4→5\n4→6\n4→7\n5→6\n5→7\n6→7",
  },
  {
    name: "GHZ-5 (chain)", category: "Entanglement", qubits: 5,
    desc: "Standard GHZ via chain",
    gates: "h 0\n0→1\n1→2\n2→3\n3→4",
  },
  {
    name: "GHZ-5 (star)", category: "Entanglement", qubits: 5,
    desc: "GHZ via star — relay-free",
    gates: "h 0\n0→1\n0→2\n0→3\n0→4",
  },
  {
    name: "Grover-3", category: "Search", qubits: 4,
    desc: "Grover oracle + diffusion (3-qubit)",
    gates: "h 0\nh 1\nh 2\n0→3\n1→3\n2→3\n0→1\n1→2\n0→2",
  },
  {
    name: "VQE ansatz", category: "Variational", qubits: 4,
    desc: "Hardware-efficient VQE layer",
    gates: "0→1\n1→2\n2→3\n3→0",
  },
  {
    name: "QAOA-4", category: "Variational", qubits: 4,
    desc: "QAOA mixing layer (ring)",
    gates: "0→1\n1→0\n1→2\n2→1\n2→3\n3→2\n3→0\n0→3",
  },
  {
    name: "Bernstein-Vazirani", category: "Oracle", qubits: 5,
    desc: "BV for secret s=1011",
    gates: "h 0\nh 1\nh 2\nh 3\n0→4\n1→4\n3→4",
  },
  {
    name: "Teleportation", category: "Protocol", qubits: 3,
    desc: "Quantum teleportation",
    gates: "h 1\n1→2\n0→1\n1→2",
  },
  {
    name: "Surface code", category: "QEC", qubits: 9,
    desc: "Distance-3 surface code stabilizers",
    gates: "0→3\n1→3\n1→4\n2→4\n3→6\n4→6\n4→7\n5→7\n6→8\n7→8",
  },
  {
    name: "Steane [[7,1,3]]", category: "QEC", qubits: 7,
    desc: "Steane code encoding circuit",
    gates: "h 0\nh 1\nh 2\n0→3\n0→4\n0→6\n1→3\n1→5\n1→6\n2→4\n2→5\n2→6",
  },
  {
    name: "Toffoli decomp", category: "Gate", qubits: 3,
    desc: "CNOT decomposition of Toffoli",
    gates: "1→2\n0→2\n1→2\n0→2\n0→1",
  },
];

function analyzeBenchmark(b) {
  const parsed = b.gates.includes("OPENQASM") ? parseQASM(b.gates) : parseGateList(b.gates);
  const analysis = classifyNodes(parsed.gates, parsed.nQubits);
  const loads = estimateLoads(parsed.gates, parsed.nQubits, parsed.shifts);
  return { ...b, parsed, analysis, loads, nQubits: parsed.nQubits, nCNOTs: parsed.gates.length };
}

// ─── Presets ──────────────────────────────────────────────────

const PRESETS = {
  "Steane Code":    "7→0\n7→2\n7→4\n7→6\n8→1\n8→2\n8→5\n8→6\n9→3\n9→4\n9→5\n9→6\n0→10\n2→10\n4→10\n6→10\n1→11\n2→11\n5→11\n6→11\n3→12\n4→12\n5→12\n6→12",
  "Surface Code":   "9→0\n9→1\n9→3\n9→4\n10→1\n10→2\n10→4\n10→5\n11→3\n11→4\n11→6\n11→7\n12→4\n12→5\n12→7\n12→8\n0→13\n1→13\n3→13\n4→13\n1→14\n2→14\n4→14\n5→14\n3→15\n4→15\n6→15\n7→15\n4→16\n5→16\n7→16\n8→16",
  "QFT-5":          "h 0\n0→1\n0→2\n0→3\n0→4\n1→2\n1→3\n1→4\n2→3\n2→4\n3→4",
  "Trotter-8":      "0→1\n2→3\n4→5\n6→7\n1→2\n3→4\n5→6\n0→1\n2→3\n4→5\n6→7\n1→2\n3→4\n5→6",
  "Grover-4":       "0→3\n1→3\n2→3\n0→1\n1→2\n2→3\n0→3\n1→3\n2→3\n0→1\n1→2\n2→3",
  "Star":           "h 0\n0→1\n0→2\n0→3",
  "Chain":          "h 0\n0→1\n1→2\n2→3",
  "Dual Hub":       "h 0\nh 4\n0→1\n0→2\n0→3\n4→1\n4→2\n4→3",
  "Konami":         "h 0\nh 1\n0→2\n0→3\n1→2\n1→3\n0→4\n1→5",
  "Syndrome":       "0→4\n1→4\n2→5\n3→5\n4→6\n5→6",
  "QASM":           'OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[5];\nh q[0];\ncx q[0], q[1];\ncx q[1], q[2];\ncx q[0], q[3];\ncx q[3], q[4];',
};

// ─── Colors ───────────────────────────────────────────────────

const C = {
  bg:"#0a0e17",sf:"#111827",sfh:"#1a2236",bd:"#1e293b",bda:"#3b82f6",
  hub:"#f59e0b",hubG:"rgba(245,158,11,0.3)",spoke:"#10b981",spokeG:"rgba(16,185,129,0.3)",
  relay:"#ef4444",relayG:"rgba(239,68,68,0.4)",virgin:"#475569",
  tx:"#e2e8f0",txm:"#64748b",txd:"#334155",link:"#3b82f6",safe:"#10b981",danger:"#ef4444",accent:"#818cf8",
};
const NC = {hub:C.hub,spoke:C.spoke,relay:C.relay,virgin:C.virgin};

// ─── Graph Component ──────────────────────────────────────────

function Graph({gates,analysis,nQubits,chains}) {
  const large = nQubits > 10;
  const W=large?700:520,H=large?500:340,cx=W/2,cy=H/2,r=Math.min(W,H)*0.38;
  const nr=large?14:18,glowR=large?22:30,fs=large?9:11,fsL=large?8:9,offN=large?18:22,offT=large?24:32,offR=large?20:26;
  const pos = useMemo(()=>{
    const p=[]; for(let i=0;i<nQubits;i++){
      const a=-Math.PI/2+(2*Math.PI*i)/nQubits;
      p.push({x:cx+r*Math.cos(a),y:cy+r*Math.sin(a)});
    } return p;
  },[nQubits,cx,cy,r]);
  const chainEdges = useMemo(()=>{
    const s=new Set(); (chains||[]).forEach(ch=>{for(let i=0;i<ch.length-1;i++)s.add(`${ch[i]}-${ch[i+1]}`);}); return s;
  },[chains]);

  return(
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"auto",display:"block"}}>
      <defs>
        <marker id="a1" viewBox="0 0 10 7" refX="10" refY="3.5" markerWidth="8" markerHeight="6" orient="auto-start-reverse"><polygon points="0 0,10 3.5,0 7" fill={C.link}/></marker>
        <marker id="a2" viewBox="0 0 10 7" refX="10" refY="3.5" markerWidth="8" markerHeight="6" orient="auto-start-reverse"><polygon points="0 0,10 3.5,0 7" fill={C.danger}/></marker>
        {["hub","spoke","relay","virgin"].map(t=><radialGradient key={t} id={`g${t}`}><stop offset="0%" stopColor={{hub:C.hubG,spoke:C.spokeG,relay:C.relayG,virgin:"transparent"}[t]}/><stop offset="100%" stopColor="transparent"/></radialGradient>)}
      </defs>
      {gates.map((g,i)=>{
        const p1=pos[g.ctrl],p2=pos[g.targ]; if(!p1||!p2)return null;
        const dx=p2.x-p1.x,dy=p2.y-p1.y,len=Math.sqrt(dx*dx+dy*dy)||1;
        const nx=dx/len,ny=dy/len;
        const isChain=chainEdges.has(`${g.ctrl}-${g.targ}`);
        const isDanger=analysis.nodes[g.ctrl]?.type==="relay"||analysis.nodes[g.targ]?.type==="relay";
        return <line key={i} x1={p1.x+nx*offN} y1={p1.y+ny*offN} x2={p2.x-nx*offN} y2={p2.y-ny*offN}
          stroke={isChain?C.danger:isDanger?"rgba(239,68,68,0.5)":C.link}
          strokeWidth={isChain?3:isDanger?2:1.8} opacity={isChain?1:isDanger?0.7:0.5}
          markerEnd={isChain||isDanger?"url(#a2)":"url(#a1)"} strokeDasharray={isDanger&&!isChain?"6 3":"none"}/>;
      })}
      {analysis.nodes.map((n,i)=>{
        const p=pos[i]; if(!p)return null; const color=NC[n.type]||C.virgin;
        return(<g key={i}>
          <circle cx={p.x} cy={p.y} r={glowR} fill={`url(#g${n.type})`}/>
          <circle cx={p.x} cy={p.y} r={nr} fill={C.sf} stroke={color} strokeWidth={2.5} style={{filter:n.type==="relay"?"drop-shadow(0 0 8px rgba(239,68,68,0.7))":"none"}}/>
          <text x={p.x} y={p.y+1} textAnchor="middle" dominantBaseline="central" fill={color} fontSize={fs} fontWeight="700" fontFamily="'JetBrains Mono',monospace">q{i}</text>
          <text x={p.x} y={p.y+offT} textAnchor="middle" fill={C.txm} fontSize={fsL} fontFamily="'JetBrains Mono',monospace">{n.type}</text>
          {n.relay===1&&<text x={p.x} y={p.y-offR} textAnchor="middle" fill={C.danger} fontSize="10" fontWeight="700">r=1</text>}
        </g>);
      })}
    </svg>
  );
}

// ─── Benchmark Bar Chart ──────────────────────────────────────

function BenchmarkChart({ benchmarks }) {
  const W = 520, barH = 22, gap = 4, pad = 120;
  const H = benchmarks.length * (barH + gap) + 20;
  const maxCNOTs = Math.max(...benchmarks.map(b => b.nCNOTs));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"auto",display:"block"}}>
      {benchmarks.map((b, i) => {
        const y = i * (barH + gap) + 10;
        const barW = ((W - pad - 40) * b.nCNOTs) / maxCNOTs;
        const relayW = b.analysis.nRelays > 0 ? (barW * b.analysis.nRelays) / b.nCNOTs : 0;
        const safeW = barW - relayW;
        return (
          <g key={i}>
            <text x={pad - 6} y={y + barH / 2 + 1} textAnchor="end" fill={C.txm} fontSize="10" fontFamily="'JetBrains Mono',monospace">{b.name}</text>
            <rect x={pad} y={y} width={safeW} height={barH} rx={3} fill={C.safe} opacity={0.7} />
            {relayW > 0 && <rect x={pad + safeW} y={y} width={relayW} height={barH} rx={3} fill={C.danger} opacity={0.8} />}
            <text x={pad + barW + 6} y={y + barH / 2 + 1} fill={b.analysis.nRelays > 0 ? C.danger : C.safe} fontSize="10" fontFamily="'JetBrains Mono',monospace" fontWeight="600">
              {b.analysis.nRelays > 0 ? `${b.analysis.nRelays}R` : "0R"}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ─── Tab Button ───────────────────────────────────────────────

function Tab({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      background: active ? C.sfh : "transparent",
      border: `1px solid ${active ? C.bda : C.bd}`,
      borderRadius: 6, padding: "6px 14px", cursor: "pointer",
      fontSize: 11, fontWeight: active ? 600 : 400,
      color: active ? C.tx : C.txm,
      fontFamily: "'JetBrains Mono',monospace",
      transition: "all 0.15s ease",
    }}>
      {children}
    </button>
  );
}

// ─── N-Relay Calculator ──────────────────────────────────────

function innerRec(alphas, beta) {
  if (alphas.length === 0) return 1;
  const a = alphas[0], rest = alphas.slice(1);
  const A = innerRec(rest, beta);
  const B = bRec(rest, beta);
  return Math.cos(a)**2 * A + Math.sin(a)**2 * B;
}
function bRec(alphas, beta) {
  if (alphas.length === 0) return Math.sin(2*beta);
  const a = alphas[0], rest = alphas.slice(1);
  return Math.sin(2*a)/2 * (innerRec(rest, beta) + bRec(rest, beta));
}

function NRelayCalculator() {
  const [N, setN] = useState(3);
  const [beta, setBeta] = useState(0);
  const [sigma, setSigma] = useState(0.1);
  const [alphas, setAlphas] = useState([0.785, 0.785, 0.785]);

  const updateN = useCallback((newN) => {
    setN(newN);
    setAlphas(prev => {
      if (newN > prev.length) return [...prev, ...Array(newN - prev.length).fill(Math.PI/4)];
      return prev.slice(0, newN);
    });
  }, []);

  const updateAlpha = useCallback((idx, val) => {
    setAlphas(prev => { const next = [...prev]; next[idx] = val; return next; });
  }, []);

  const sc = innerRec(alphas, beta);
  const F = sc * sc;
  const A = alphas.length > 0 ? innerRec(alphas.slice(1), beta) : 1;
  const B = alphas.length > 0 ? bRec(alphas.slice(1), beta) : Math.sin(2*beta);
  const popFrac = alphas.length > 0 ? Math.cos(alphas[0])**2 * A : 1;
  const intFrac = alphas.length > 0 ? Math.sin(alphas[0])**2 * B : 0;

  // Transfer matrix eigenvalues for first relay
  const a0 = alphas.length > 0 ? alphas[0] : 0;
  const tr = Math.cos(a0) * (Math.cos(a0) + Math.sin(a0));
  const det = Math.sin(4 * a0) / 4;
  const disc = tr*tr - 4*det;
  const lp = disc >= 0 ? (tr + Math.sqrt(disc))/2 : tr/2;
  const lm = disc >= 0 ? (tr - Math.sqrt(disc))/2 : tr/2;

  // Disorder
  const Nstar = sigma > 0.001 ? Math.round(1 / (2 * sigma * sigma)) : Infinity;
  const Fdisorder = 0.25 * Math.exp(-2 * sigma * sigma * N);

  // Curve: F vs N for uniform alpha
  const curveW = 460, curveH = 180, pad = 40;
  const uniformAlpha = alphas.length > 0 ? alphas[0] : Math.PI/4;
  const curvePoints = [];
  for (let nn = 0; nn <= 20; nn++) {
    const f = innerRec(Array(nn).fill(uniformAlpha), beta) ** 2;
    const x = pad + (nn / 20) * (curveW - 2*pad);
    const y = pad + (1 - f) * (curveH - 2*pad);
    curvePoints.push(`${x},${y}`);
  }

  const font = "'JetBrains Mono','Fira Code',monospace";
  const s = (label, value, color) => (
    <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:12,fontFamily:font}}>
      <span style={{color:C.txm}}>{label}</span>
      <span style={{color:color||C.accent,fontWeight:700}}>{typeof value==="number"?value.toFixed(6):value}</span>
    </div>
  );

  return (
    <div style={{padding:20,maxWidth:900,margin:"0 auto"}}>
      <div style={{display:"flex",flexWrap:"wrap",gap:16}}>
        {/* Left: controls */}
        <div style={{flex:"1 1 320px",minWidth:280}}>
          <div style={{background:C.sf,borderRadius:10,border:`1px solid ${C.bd}`,padding:16,marginBottom:12}}>
            <div style={{fontSize:9,color:C.txm,textTransform:"uppercase",letterSpacing:1.5,marginBottom:10}}>Relay Chain</div>
            <div style={{fontSize:10,color:C.txm,marginBottom:4}}>N relays</div>
            <input type="range" min={1} max={8} value={N} onChange={e=>updateN(+e.target.value)} style={{width:"100%",accentColor:C.accent}}/>
            <div style={{textAlign:"center",fontSize:20,fontWeight:700,color:C.accent}}>{N}</div>

            {alphas.map((a, i) => (
              <div key={i} style={{marginTop:8}}>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:C.txm}}>
                  <span>α{i+1}</span><span style={{color:C.accent}}>{a.toFixed(3)}</span>
                </div>
                <input type="range" min={0} max={157} value={Math.round(a*100)} onChange={e=>updateAlpha(i,+e.target.value/100)} style={{width:"100%",accentColor:C.accent}}/>
              </div>
            ))}

            <div style={{marginTop:12}}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:C.txm}}>
                <span>β (endpoint)</span><span style={{color:C.accent}}>{beta.toFixed(3)}</span>
              </div>
              <input type="range" min={0} max={157} value={Math.round(beta*100)} onChange={e=>setBeta(+e.target.value/100)} style={{width:"100%",accentColor:C.accent}}/>
            </div>
          </div>

          {/* Disorder */}
          <div style={{background:C.sf,borderRadius:10,border:`1px solid ${C.bd}`,padding:16}}>
            <div style={{fontSize:9,color:C.txm,textTransform:"uppercase",letterSpacing:1.5,marginBottom:10}}>Theorem 12: Disorder</div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:C.txm}}>
              <span>σ (disorder)</span><span style={{color:C.warn}}>{sigma.toFixed(3)}</span>
            </div>
            <input type="range" min={0} max={100} value={Math.round(sigma*200)} onChange={e=>setSigma(+e.target.value/200)} style={{width:"100%",accentColor:C.warn}}/>
            {s("F(N) = ¼·exp(−2σ²N)", Fdisorder, Fdisorder>0.1?C.safe:C.danger)}
            {s("N* (characteristic length)", Nstar===Infinity?"∞":Nstar, C.warn)}
            <div style={{fontSize:10,color:C.txd,marginTop:8,lineHeight:1.5}}>
              Balanced relays (π/4) are protected by a first-order perturbative gap: PM₁P = 0. Decay rate is σ², not σ.
            </div>
          </div>
        </div>

        {/* Right: results */}
        <div style={{flex:"1 1 400px",minWidth:320}}>
          <div style={{background:C.sf,borderRadius:10,border:`1px solid ${C.bd}`,padding:16,marginBottom:12}}>
            <div style={{fontSize:9,color:C.txm,textTransform:"uppercase",letterSpacing:1.5,marginBottom:10}}>Theorem 7: N-Relay Recursion</div>
            {s("⟨S|C⟩", sc)}
            {s("F = ⟨S|C⟩²", F, F>0.9?C.safe:F>0.2?C.warn:C.danger)}
            <div style={{borderTop:`1px solid ${C.bd}`,margin:"8px 0",paddingTop:8}}>
              <div style={{fontSize:9,color:C.txm,marginBottom:4}}>DUAL CHANNELS</div>
              {s("Population (cos²α·A)", popFrac, C.spoke)}
              {s("Interference (sin²α·B)", intFrac, C.relay)}
              {s("Pop / Total", sc!==0?(popFrac/sc*100).toFixed(1)+"%":"—", C.spoke)}
              {s("Int / Total", sc!==0?(intFrac/sc*100).toFixed(1)+"%":"—", C.relay)}
            </div>
          </div>

          {/* Transfer matrix */}
          <div style={{background:C.sf,borderRadius:10,border:`1px solid ${C.bd}`,padding:16,marginBottom:12}}>
            <div style={{fontSize:9,color:C.txm,textTransform:"uppercase",letterSpacing:1.5,marginBottom:10}}>Theorem 9: Transfer Matrix M(α₁)</div>
            <div style={{fontFamily:font,fontSize:11,color:C.tx,lineHeight:1.8,padding:"4px 8px",background:"rgba(129,140,248,0.05)",borderRadius:6}}>
              <div>┌ {(Math.cos(a0)**2).toFixed(4)}  {(Math.sin(a0)**2).toFixed(4)} ┐</div>
              <div>└ {(Math.sin(2*a0)/2).toFixed(4)}  {(Math.sin(2*a0)/2).toFixed(4)} ┘</div>
            </div>
            <div style={{marginTop:8}}>
              {s("tr(M)", tr)}
              {s("det(M)", det)}
              {s("λ₊", lp, lp>0.99?C.safe:C.warn)}
              {s("λ₋", lm, C.txm)}
              {a0 > 0.78 && a0 < 0.79 && <div style={{fontSize:10,color:C.safe,marginTop:4}}>✓ Projector: M²=M, eigenvalues {"{"} 1, 0 {"}"}</div>}
            </div>
          </div>

          {/* F vs N curve */}
          <div style={{background:C.sf,borderRadius:10,border:`1px solid ${C.bd}`,padding:16}}>
            <div style={{fontSize:9,color:C.txm,textTransform:"uppercase",letterSpacing:1.5,marginBottom:8}}>F vs N (uniform α₁={uniformAlpha.toFixed(2)}, β={beta.toFixed(2)})</div>
            <svg viewBox={`0 0 ${curveW} ${curveH}`} style={{width:"100%",height:"auto"}}>
              {[0,.25,.5,.75,1].map(f=>{
                const y=pad+(1-f)*(curveH-2*pad);
                return <line key={f} x1={pad} x2={curveW-pad} y1={y} y2={y} stroke={C.bd} strokeWidth={0.5}/>;
              })}
              <polyline points={curvePoints.join(" ")} fill="none" stroke={C.accent} strokeWidth={2.5}/>
              {/* Mark current N */}
              {N<=20 && (() => {
                const fN = innerRec(Array(N).fill(uniformAlpha), beta)**2;
                const x = pad + (N/20)*(curveW-2*pad);
                const y = pad + (1-fN)*(curveH-2*pad);
                return <circle cx={x} cy={y} r={5} fill={C.accent} stroke={C.bg} strokeWidth={2}/>;
              })()}
              <text x={curveW/2} y={curveH-4} textAnchor="middle" fill={C.txd} fontSize="9" fontFamily={font}>N (relays)</text>
              <text x={8} y={curveH/2} textAnchor="middle" fill={C.txd} fontSize="9" fontFamily={font} transform={`rotate(-90,8,${curveH/2})`}>F</text>
            </svg>
          </div>
        </div>
      </div>

      {/* Formulas reference */}
      <div style={{marginTop:16,padding:16,borderRadius:10,background:"linear-gradient(135deg,rgba(129,140,248,0.06),rgba(16,185,129,0.06))",border:`1px solid ${C.bd}`}}>
        <div style={{fontSize:11,fontWeight:600,color:C.accent,marginBottom:8}}>SIXTEEN THEOREMS</div>
        <div style={{fontSize:11,color:C.txm,lineHeight:2,fontFamily:font}}>
          <div><span style={{color:C.tx}}>T2:</span> F = (cos²α + sin²α·sin2β·cosφ₃)²</div>
          <div><span style={{color:C.tx}}>T7:</span> ⟨S|C⟩ = cos²α₁·⟨S|C⟩(rest) + sin²α₁·B(rest) — recursive</div>
          <div><span style={{color:C.tx}}>T9:</span> ⟨S|C⟩ = e₁ᵀ · ∏M(αₖ) · v(β) — transfer matrix product</div>
          <div><span style={{color:C.tx}}>T10:</span> M(π/4) = ½|1,1⟩⟨1,1| — projector, F=0.25 ∀N</div>
          <div><span style={{color:C.tx}}>T11:</span> tr(M) = cosα(cosα+sinα), det(M) = sin(4α)/4</div>
          <div><span style={{color:C.tx}}>T12:</span> F(N) = ¼·exp(−2σ²N), c=1 exactly, PM₁P=0</div>
          <div style={{borderTop:`1px solid ${C.bd}`,paddingTop:8,marginTop:4}}><span style={{color:"#f59e0b"}}>T13 (CZ):</span> ⟨S|C⟩ = ½·Σ(-1)^Δ·∏p(rₖ,αₖ) — Fourier polynomial in cos(2α)</div>
          <div><span style={{color:"#f59e0b"}}>T15:</span> Z = ½(O₀+O₁), O₀ uses ξ=⟨ψ|U|ψ⟩, O₁ uses ξ*=⟨ψ|U†|ψ⟩</div>
          <div style={{borderTop:`1px solid ${C.bd}`,paddingTop:8,marginTop:4}}><span style={{color:"#10b981"}}>T16:</span> Universal 4×4 block-diagonal transfer matrix for ALL C-U gates</div>
          <div style={{color:C.txd,fontSize:10}}>D=4 universal. Hub=0→r₀ (forward). Hub=1→r₀* (backward). Bond dimension constant ∀N.</div>
        </div>
      </div>
    </div>
  );
}

// ─── General C-U Calculator (Theorem 16) ──────────────────────

function GeneralCUCalculator() {
  const font="'JetBrains Mono','Fira Code',monospace";
  const [gateKey, setGateKey] = useState("H");
  const [nRelays, setNRelays] = useState(3);
  const [beta, setBeta] = useState(45);
  const [uniform, setUniform] = useState(true);
  const [uniformAlpha, setUniformAlpha] = useState(45);
  const [angles, setAngles] = useState([45,45,45]);

  const GATES = {
    "X (CNOT)": [[0,1],[1,0]],
    "Z (CZ)": [[1,0],[0,-1]],
    "Y": [[0,{r:0,i:-1}],[{r:0,i:1},0]],
    "H": [[1/Math.sqrt(2),1/Math.sqrt(2)],[1/Math.sqrt(2),-1/Math.sqrt(2)]],
    "Ry(π/4)": [[Math.cos(Math.PI/8),-Math.sin(Math.PI/8)],[Math.sin(Math.PI/8),Math.cos(Math.PI/8)]],
    "Ry(π/2)": [[Math.cos(Math.PI/4),-Math.sin(Math.PI/4)],[Math.sin(Math.PI/4),Math.cos(Math.PI/4)]],
    "S": [[1,0],[0,{r:0,i:1}]],
    "T": [[1,0],[0,{r:Math.cos(Math.PI/4),i:Math.sin(Math.PI/4)}]],
  };

  const cx = (v) => typeof v === 'number' ? {r:v,i:0} : v;
  const cmul = (a,b) => ({r:a.r*b.r-a.i*b.i, i:a.r*b.i+a.i*b.r});
  const cadd = (a,b) => ({r:a.r+b.r, i:a.i+b.i});
  const cconj = (a) => ({r:a.r, i:-a.i});
  const cabs2 = (a) => a.r*a.r+a.i*a.i;
  const cscale = (s,a) => ({r:s*a.r, i:s*a.i});

  const getU = () => {
    const raw = GATES[gateKey];
    return raw.map(row => row.map(cx));
  };

  const computeZ = () => {
    const U = getU();
    const [a,b,c,d] = [U[0][0],U[0][1],U[1][0],U[1][1]];
    const bRad = beta*Math.PI/180;
    const cb=Math.cos(bRad), sb=Math.sin(bRad);
    const xi = cadd(cadd(cscale(cb*cb,a), cscale(cb*sb,cadd(b,c))), cscale(sb*sb,d));
    let state = [{r:1,i:0}, xi, cconj(xi), {r:1,i:0}];

    const relayAngles = uniform ? Array(nRelays).fill(uniformAlpha) : angles.slice(0,nRelays);
    for(let k=nRelays-1; k>=1; k--) {
      const aRad = relayAngles[k]*Math.PI/180;
      const ca=Math.cos(aRad), sa=Math.sin(aRad);
      const r0 = cadd(cscale(ca,a), cscale(sa,b));
      const r1 = cadd(cscale(ca,c), cscale(sa,d));
      const newA = cadd(cscale(ca*ca,state[0]), cscale(sa*sa,state[1]));
      const newB = cadd(cmul({r:ca,i:0},cmul(r0,state[0])), cmul({r:sa,i:0},cmul(r1,state[1])));
      const newC = cadd(cmul({r:ca,i:0},cmul(cconj(r0),state[2])), cmul({r:sa,i:0},cmul(cconj(r1),state[3])));
      const newD = cadd(cscale(cabs2(r0),state[2]), cscale(cabs2(r1),state[3]));
      state = [newA, newB, newC, newD];
    }
    const a1Rad = relayAngles[0]*Math.PI/180;
    const ca1=Math.cos(a1Rad), sa1=Math.sin(a1Rad);
    const r0_1 = cadd(cscale(ca1,a), cscale(sa1,b));
    const r1_1 = cadd(cscale(ca1,c), cscale(sa1,d));
    const Z = cscale(0.5, cadd(cadd(cscale(ca1*ca1,state[0]), cscale(sa1*sa1,state[1])),
                                cadd(cscale(cabs2(r0_1),state[2]), cscale(cabs2(r1_1),state[3]))));
    return Z;
  };

  const computeSweep = () => {
    const pts = [];
    for(let deg=0; deg<=90; deg+=1) {
      const U = getU();
      const [a,b,c,d] = [U[0][0],U[0][1],U[1][0],U[1][1]];
      const bRad = beta*Math.PI/180;
      const cb=Math.cos(bRad), sb=Math.sin(bRad);
      const xi = cadd(cadd(cscale(cb*cb,a), cscale(cb*sb,cadd(b,c))), cscale(sb*sb,d));
      let state = [{r:1,i:0}, xi, cconj(xi), {r:1,i:0}];
      const aRad = deg*Math.PI/180;
      for(let k=nRelays-1; k>=1; k--) {
        const ca=Math.cos(aRad), sa=Math.sin(aRad);
        const r0 = cadd(cscale(ca,a), cscale(sa,b));
        const r1 = cadd(cscale(ca,c), cscale(sa,d));
        const nA = cadd(cscale(ca*ca,state[0]), cscale(sa*sa,state[1]));
        const nB = cadd(cmul({r:ca,i:0},cmul(r0,state[0])), cmul({r:sa,i:0},cmul(r1,state[1])));
        const nC = cadd(cmul({r:ca,i:0},cmul(cconj(r0),state[2])), cmul({r:sa,i:0},cmul(cconj(r1),state[3])));
        const nD = cadd(cscale(cabs2(r0),state[2]), cscale(cabs2(r1),state[3]));
        state = [nA, nB, nC, nD];
      }
      const ca1=Math.cos(aRad), sa1=Math.sin(aRad);
      const r0_1 = cadd(cscale(ca1,a), cscale(sa1,b));
      const r1_1 = cadd(cscale(ca1,c), cscale(sa1,d));
      const Z = cscale(0.5, cadd(cadd(cscale(ca1*ca1,state[0]), cscale(sa1*sa1,state[1])),
                                  cadd(cscale(cabs2(r0_1),state[2]), cscale(cabs2(r1_1),state[3]))));
      pts.push({deg, re:Z.r, im:Z.i, f:Z.r*Z.r+Z.i*Z.i});
    }
    return pts;
  };

  const Z = computeZ();
  const sc = Z.r;
  const F = Z.r*Z.r + Z.i*Z.i;
  const sweep = useMemo(computeSweep, [gateKey, nRelays, beta]);

  const W=500, H=250, pad=40;
  const xScale = (deg) => pad + (deg/90)*(W-2*pad);
  const yScale = (v) => pad + (1-v)*(H-2*pad);

  useEffect(() => {
    if(!uniform) {
      const a = Array(nRelays).fill(uniformAlpha);
      setAngles(a);
    }
  }, [nRelays]);

  return (
    <div style={{padding:16,maxWidth:900}}>
      <div style={{fontSize:15,fontWeight:700,color:C.accent,marginBottom:12}}>General C-U Relay Calculator</div>
      <div style={{fontSize:11,color:C.txm,marginBottom:16}}>Theorem 16: Universal 4×4 Transfer Matrix — works for ANY controlled-unitary gate</div>

      <div style={{display:"flex",gap:20,flexWrap:"wrap",marginBottom:16}}>
        <div>
          <div style={{fontSize:10,color:C.txd,marginBottom:4}}>GATE U</div>
          <select value={gateKey} onChange={e=>setGateKey(e.target.value)} style={{background:C.sf,color:C.tx,border:`1px solid ${C.bd}`,borderRadius:4,padding:"4px 8px",fontSize:12,fontFamily:font}}>
            {Object.keys(GATES).map(k => <option key={k} value={k}>C-{k}</option>)}
          </select>
        </div>
        <div>
          <div style={{fontSize:10,color:C.txd,marginBottom:4}}>RELAYS N={nRelays}</div>
          <input type="range" min={1} max={20} value={nRelays} onChange={e=>setNRelays(+e.target.value)} style={{width:120}} />
        </div>
        <div>
          <div style={{fontSize:10,color:C.txd,marginBottom:4}}>RELAY α={uniformAlpha}°</div>
          <input type="range" min={0} max={90} value={uniformAlpha} onChange={e=>setUniformAlpha(+e.target.value)} style={{width:120}} />
        </div>
        <div>
          <div style={{fontSize:10,color:C.txd,marginBottom:4}}>ENDPOINT β={beta}°</div>
          <input type="range" min={0} max={90} value={beta} onChange={e=>setBeta(+e.target.value)} style={{width:120}} />
        </div>
      </div>

      <div style={{display:"flex",gap:16,flexWrap:"wrap",marginBottom:16}}>
        <div style={{padding:12,borderRadius:8,background:C.sf,border:`1px solid ${C.bd}`,minWidth:140}}>
          <div style={{fontSize:10,color:C.txd}}>⟨S|C⟩ = Re(Z)</div>
          <div style={{fontSize:22,fontWeight:700,color:sc>0.9?C.safe:sc>0.5?C.warn:C.danger}}>{sc.toFixed(6)}</div>
        </div>
        <div style={{padding:12,borderRadius:8,background:C.sf,border:`1px solid ${C.bd}`,minWidth:140}}>
          <div style={{fontSize:10,color:C.txd}}>F = |Z|²</div>
          <div style={{fontSize:22,fontWeight:700,color:F>0.9?C.safe:F>0.5?C.warn:C.danger}}>{F.toFixed(6)}</div>
        </div>
        {Math.abs(Z.i) > 1e-6 && (
          <div style={{padding:12,borderRadius:8,background:C.sf,border:`1px solid ${C.bd}`,minWidth:140}}>
            <div style={{fontSize:10,color:C.txd}}>Im(Z)</div>
            <div style={{fontSize:22,fontWeight:700,color:C.txm}}>{Z.i.toFixed(6)}</div>
          </div>
        )}
      </div>

      <div style={{marginBottom:16}}>
        <div style={{fontSize:10,color:C.txd,marginBottom:4}}>F(α) SWEEP — uniform chain, N={nRelays}, β={beta}°</div>
        <svg width={W} height={H} style={{background:C.sf,borderRadius:8,border:`1px solid ${C.bd}`}}>
          <line x1={pad} y1={yScale(0)} x2={W-pad} y2={yScale(0)} stroke={C.bd} strokeWidth={0.5}/>
          <line x1={pad} y1={yScale(0.5)} x2={W-pad} y2={yScale(0.5)} stroke={C.bd} strokeWidth={0.5} strokeDasharray="4,4"/>
          <line x1={pad} y1={yScale(1)} x2={W-pad} y2={yScale(1)} stroke={C.bd} strokeWidth={0.5}/>
          {[0,15,30,45,60,75,90].map(d => <text key={d} x={xScale(d)} y={H-4} textAnchor="middle" fill={C.txd} fontSize="8" fontFamily={font}>{d}°</text>)}
          {[0,0.25,0.5,0.75,1].map(v => <text key={v} x={pad-4} y={yScale(v)+3} textAnchor="end" fill={C.txd} fontSize="8" fontFamily={font}>{v}</text>)}
          <path d={sweep.map((p,i)=>`${i===0?'M':'L'}${xScale(p.deg)},${yScale(Math.max(-0.1,Math.min(1.1,p.re)))}`).join(' ')} fill="none" stroke={C.accent} strokeWidth={2}/>
          {Math.abs(sweep[45]?.im||0) > 0.01 && (
            <path d={sweep.map((p,i)=>`${i===0?'M':'L'}${xScale(p.deg)},${yScale(Math.max(-0.1,Math.min(1.1,p.f)))}`).join(' ')} fill="none" stroke={C.safe} strokeWidth={1.5} strokeDasharray="4,2"/>
          )}
          <circle cx={xScale(uniformAlpha)} cy={yScale(Math.max(-0.1,Math.min(1.1,sc)))} r={5} fill={C.accent} stroke={C.bg} strokeWidth={2}/>
          <text x={W/2} y={H-18} textAnchor="middle" fill={C.txd} fontSize="9" fontFamily={font}>uniform relay angle α</text>
          <text x={pad+4} y={pad-8} fill={C.accent} fontSize="9" fontFamily={font}>Re(Z)</text>
          {Math.abs(sweep[45]?.im||0) > 0.01 && <text x={pad+50} y={pad-8} fill={C.safe} fontSize="9" fontFamily={font}>|Z|²</text>}
        </svg>
      </div>

      <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
        <div style={{padding:12,borderRadius:8,background:"linear-gradient(135deg,rgba(129,140,248,0.06),rgba(16,185,129,0.06))",border:`1px solid ${C.bd}`,flex:1,minWidth:280}}>
          <div style={{fontSize:10,fontWeight:600,color:C.accent,marginBottom:6}}>TRANSFER MATRIX M(α)</div>
          <div style={{fontSize:10,color:C.txm,lineHeight:1.8,fontFamily:font}}>
            <div>⎡ cos²α    sin²α    0        0     ⎤</div>
            <div>⎢ cα·r₀    sα·r₁    0        0     ⎥</div>
            <div>⎢ 0        0        cα·r₀*   sα·r₁*⎥</div>
            <div>⎣ 0        0        |r₀|²    |r₁|² ⎦</div>
          </div>
          <div style={{fontSize:9,color:C.txd,marginTop:6}}>r₀ = a·cosα + b·sinα, r₁ = c·cosα + d·sinα</div>
          <div style={{fontSize:9,color:C.txd}}>Upper: hub=0 (U forward). Lower: hub=1 (U† backward).</div>
        </div>
        <div style={{padding:12,borderRadius:8,background:C.sf,border:`1px solid ${C.bd}`,flex:1,minWidth:200}}>
          <div style={{fontSize:10,fontWeight:600,color:C.accent,marginBottom:6}}>GATE PROPERTIES</div>
          {(() => {
            const U = getU();
            const xi0 = (() => { const cb=Math.cos(beta*Math.PI/180),sb=Math.sin(beta*Math.PI/180); const [a,b,c,d]=U.flat(); return cadd(cadd(cscale(cb*cb,a),cscale(cb*sb,cadd(b,c))),cscale(sb*sb,d)); })();
            const blocksIdentical = U.flat().every(v => Math.abs(v.i) < 1e-10);
            return (
              <div style={{fontSize:10,color:C.txm,lineHeight:1.8}}>
                <div>ξ(β) = {xi0.r.toFixed(4)}{Math.abs(xi0.i)>1e-4 ? ` + ${xi0.i.toFixed(4)}i` : ""}</div>
                <div>Blocks identical: {blocksIdentical ? "✓ (real U → D_eff=2)" : "✗ (complex U → D_eff=4)"}</div>
                <div>Bond dimension: D=4 (universal, constant)</div>
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

// ─── Main IDE ─────────────────────────────────────────────────

export default function Nativ3IDE() {
  const [input, setInput] = useState(PRESETS["Steane Code"]);
  const [activePreset, setActivePreset] = useState("Steane Code");
  const [tab, setTab] = useState("scanner"); // scanner | benchmarks

  const parsed = useMemo(()=> input.includes("OPENQASM")||input.includes("qreg") ? parseQASM(input) : parseGateList(input), [input]);
  const analysis = useMemo(()=> parsed.nQubits>0 ? classifyNodes(parsed.gates,parsed.nQubits) : {nodes:[],nRelays:0,fullyIsolated:true}, [parsed]);
  const loads = useMemo(()=> parsed.nQubits>0 ? estimateLoads(parsed.gates,parsed.nQubits,parsed.shifts) : {}, [parsed]);
  const chains = useMemo(()=> parsed.gates.length>0 ? findChains(parsed.gates,analysis) : [], [parsed,analysis]);
  const alts = useMemo(()=> parsed.gates.length>0 ? findAlts(parsed.gates,analysis,loads) : [], [parsed,analysis,loads]);

  const benchmarkResults = useMemo(() => BENCHMARKS.map(analyzeBenchmark), []);
  const totalRelays = benchmarkResults.reduce((s, b) => s + b.analysis.nRelays, 0);
  const totalCNOTs = benchmarkResults.reduce((s, b) => s + b.nCNOTs, 0);
  const relayFreeCount = benchmarkResults.filter(b => b.analysis.fullyIsolated).length;

  const font="'JetBrains Mono','Fira Code',monospace";
  const iso = analysis.fullyIsolated;

  return(
    <div style={{background:C.bg,color:C.tx,minHeight:"100vh",fontFamily:font}}>
      {/* ─── Header ─── */}
      <div style={{borderBottom:`1px solid ${C.bd}`,padding:"14px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
        <div>
          <div style={{fontSize:20,fontWeight:700}}>
            <span style={{color:C.accent}}>nativ3</span>
            <span style={{color:C.txd,fontWeight:400,fontSize:13,marginLeft:8}}>topology-aware quantum compiler</span>
          </div>
          <div style={{fontSize:9,color:C.txd,marginTop:2,letterSpacing:1}}>RELAY-BIT FAULT ISOLATION</div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          {tab === "scanner" && (
            <div style={{padding:"4px 12px",borderRadius:20,fontSize:11,fontWeight:600,background:iso?"rgba(16,185,129,0.12)":"rgba(239,68,68,0.12)",color:iso?C.safe:C.danger,border:`1px solid ${iso?"rgba(16,185,129,0.3)":"rgba(239,68,68,0.3)"}`}}>
              {iso?"ISOLATED":`${analysis.nRelays} RELAY${analysis.nRelays!==1?"S":""}`}
            </div>
          )}
          <a href="https://pypi.org/project/nativ3/" target="_blank" rel="noopener" style={{fontSize:9,color:C.accent,textDecoration:"none",padding:"3px 8px",border:`1px solid rgba(129,140,248,0.3)`,borderRadius:4,background:"rgba(129,140,248,0.08)"}}>PyPI</a>
          <a href="https://github.com/DisruptionEngineer/nativ3" target="_blank" rel="noopener" style={{fontSize:9,color:C.txm,textDecoration:"none",padding:"3px 8px",border:`1px solid ${C.bd}`,borderRadius:4}}>GitHub</a>
          <a href="https://doi.org/10.5281/zenodo.19319040" target="_blank" rel="noopener" style={{fontSize:9,color:C.txm,textDecoration:"none",padding:"3px 8px",border:`1px solid ${C.bd}`,borderRadius:4}}>Paper</a>
        </div>
      </div>

      {/* ─── Install Banner ─── */}
      <div style={{background:"linear-gradient(90deg,rgba(129,140,248,0.08),rgba(16,185,129,0.05))",borderBottom:`1px solid ${C.bd}`,padding:"8px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
        <div style={{display:"flex",gap:16,alignItems:"center"}}>
          <code style={{fontSize:11,color:C.accent,background:"rgba(129,140,248,0.1)",padding:"3px 10px",borderRadius:4,border:"1px solid rgba(129,140,248,0.2)"}}>pip install nativ3</code>
          <span style={{fontSize:10,color:C.txd}}>|</span>
          <code style={{fontSize:11,color:C.txm,background:C.sf,padding:"3px 10px",borderRadius:4,border:`1px solid ${C.bd}`}}>pip install nativ3[qiskit]</code>
          <span style={{fontSize:10,color:C.txd}}>← Qiskit transpiler plugin</span>
        </div>
      </div>

      {/* ─── Tab Bar ─── */}
      <div style={{borderBottom:`1px solid ${C.bd}`,padding:"8px 20px",display:"flex",gap:6}}>
        <Tab active={tab==="scanner"} onClick={()=>setTab("scanner")}>Circuit Scanner</Tab>
        <Tab active={tab==="benchmarks"} onClick={()=>setTab("benchmarks")}>Algorithm Benchmarks</Tab>
        <Tab active={tab==="nrelay"} onClick={()=>setTab("nrelay")}>N-Relay Calculator</Tab>
        <Tab active={tab==="general"} onClick={()=>setTab("general")}>General C-U</Tab>
      </div>

      {/* ─── Scanner Tab ─── */}
      {tab === "scanner" && (
        <div style={{display:"flex",flexWrap:"wrap"}}>
          <div style={{width:320,borderRight:`1px solid ${C.bd}`,padding:14,flexShrink:0}}>
            <div style={{fontSize:9,color:C.txm,textTransform:"uppercase",letterSpacing:1.5,marginBottom:6}}>Presets</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:3,marginBottom:10}}>
              {Object.keys(PRESETS).map(n=>(
                <button key={n} onClick={()=>{setInput(PRESETS[n]);setActivePreset(n);}} style={{
                  background:activePreset===n?C.sfh:"transparent",border:`1px solid ${activePreset===n?C.bda:C.bd}`,
                  borderRadius:5,padding:"3px 7px",cursor:"pointer",fontSize:10,color:activePreset===n?C.tx:C.txm,fontFamily:font}}>
                  {n}
                </button>
              ))}
            </div>
            <div style={{fontSize:9,color:C.txm,textTransform:"uppercase",letterSpacing:1.5,marginBottom:4}}>Circuit <span style={{textTransform:"none",letterSpacing:0,color:C.txd}}>(gates: "0→1" / QASM / "h 0")</span></div>
            <textarea value={input} onChange={e=>{setInput(e.target.value);setActivePreset("");}} spellCheck={false}
              style={{width:"100%",height:180,background:C.sf,border:`1px solid ${C.bd}`,borderRadius:8,padding:10,color:C.tx,fontSize:12,fontFamily:font,resize:"vertical",lineHeight:1.6,outline:"none"}}
              placeholder={"h 0\n0→1\n0→2\n0→3"}/>
            <div style={{marginTop:10,padding:10,background:C.sf,borderRadius:8,border:`1px solid ${C.bd}`}}>
              {[["Qubits",parsed.nQubits],["CNOTs",parsed.gates.length],["Relays",analysis.nRelays],["Hubs",analysis.nodes.filter(n=>n.type==="hub").length],["Spokes",analysis.nodes.filter(n=>n.type==="spoke").length]].map(([k,v])=>(
                <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"2px 0",fontSize:11}}>
                  <span style={{color:C.txm}}>{k}</span><span style={{color:k==="Relays"&&v>0?C.danger:C.tx,fontWeight:600}}>{v}</span>
                </div>
              ))}
            </div>
            {analysis.nRelays>0&&<div style={{marginTop:10}}>
              <div style={{fontSize:9,color:C.danger,textTransform:"uppercase",letterSpacing:1.5,marginBottom:4}}>Relays</div>
              {analysis.nodes.filter(n=>n.type==="relay").map(n=>(
                <div key={n.index} style={{display:"flex",gap:5,padding:"5px 8px",marginBottom:3,background:"rgba(239,68,68,0.08)",borderRadius:5,border:"1px solid rgba(239,68,68,0.2)",fontSize:11,color:C.danger,lineHeight:1.4}}>
                  <span>q{n.index} {loads[n.index]?`α=${loads[n.index].alpha.toFixed(3)} F=${loads[n.index].fidelity.toFixed(4)}${loads[n.index].free?" FREE":""}`:"RELAY"}</span>
                </div>
              ))}
            </div>}
            {alts.length>0&&<div style={{marginTop:8}}>
              <div style={{fontSize:9,color:C.safe,textTransform:"uppercase",letterSpacing:1.5,marginBottom:4}}>Fixes</div>
              {alts.map((a,i)=>(
                <div key={i} style={{display:"flex",gap:5,padding:"5px 8px",marginBottom:3,background:a.free?"rgba(16,185,129,0.1)":"rgba(245,158,11,0.08)",borderRadius:5,border:`1px solid ${a.free?"rgba(16,185,129,0.25)":"rgba(245,158,11,0.2)"}`,fontSize:11,color:a.free?C.safe:C.hub,lineHeight:1.4}}>
                  <span>{a.free?"✦":"→"}</span><span>{a.desc}</span>
                </div>
              ))}
            </div>}
          </div>
          <div style={{flex:1,padding:14,minWidth:300}}>
            <div style={{background:C.sf,borderRadius:10,border:`1px solid ${C.bd}`,padding:12,marginBottom:10}}>
              <div style={{fontSize:9,color:C.txm,textTransform:"uppercase",letterSpacing:1.5,marginBottom:4}}>Gate Graph</div>
              {parsed.nQubits>0?<Graph gates={parsed.gates} analysis={analysis} nQubits={parsed.nQubits} chains={chains}/>
                :<div style={{padding:40,textAlign:"center",color:C.txd,fontSize:12}}>Enter a circuit to scan</div>}
            </div>
            {analysis.nodes.length>0&&<div style={{background:C.sf,borderRadius:10,border:`1px solid ${C.bd}`,padding:12,marginBottom:10}}>
              <div style={{fontSize:9,color:C.txm,textTransform:"uppercase",letterSpacing:1.5,marginBottom:4}}>Nodes</div>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:11,fontFamily:font}}>
                <thead><tr style={{borderBottom:`1px solid ${C.bd}`}}>
                  {["Q","Type","r","α","F","Status"].map(h=><th key={h} style={{padding:"5px 6px",textAlign:"left",color:C.txm,fontWeight:500,fontSize:9,textTransform:"uppercase"}}>{h}</th>)}
                </tr></thead>
                <tbody>{analysis.nodes.map((n,i)=>{const ld=loads[i];return(
                  <tr key={i} style={{borderBottom:`1px solid ${C.bd}`}}>
                    <td style={{padding:"4px 6px"}}>q{i}</td>
                    <td style={{padding:"4px 6px"}}><span style={{color:NC[n.type],fontWeight:600}}>{n.type.toUpperCase()}</span></td>
                    <td style={{padding:"4px 6px",color:n.relay?C.danger:C.safe,fontWeight:700}}>{n.relay}</td>
                    <td style={{padding:"4px 6px",color:C.txm}}>{ld?ld.alpha.toFixed(3):"-"}</td>
                    <td style={{padding:"4px 6px",color:ld?.free?C.safe:n.relay?C.danger:C.txm,fontWeight:n.relay?600:400}}>{ld&&n.relay?(ld.free?"FREE":ld.fidelity.toFixed(4)):"-"}</td>
                    <td style={{padding:"4px 6px",color:n.isolated?C.safe:C.danger,fontSize:10}}>{n.isolated?"SAFE":"PROPAGATES"}</td>
                  </tr>);})}</tbody>
              </table>
            </div>}
            {chains.length>0&&<div style={{background:C.sf,borderRadius:10,border:`1px solid ${C.bd}`,padding:12,marginBottom:10}}>
              <div style={{fontSize:9,color:C.danger,textTransform:"uppercase",letterSpacing:1.5,marginBottom:4}}>Error Paths</div>
              {chains.map((ch,i)=><div key={i} style={{padding:"5px 8px",marginBottom:3,background:"rgba(239,68,68,0.06)",borderRadius:5,fontSize:11}}>
                <span style={{color:C.danger,fontWeight:600}}>{ch.map(q=>`q${q}`).join(" → ")}</span>
                <span style={{color:C.txd,marginLeft:6}}>({ch.length-1} hops)</span>
              </div>)}
            </div>}
            <div style={{padding:12,borderRadius:10,background:"linear-gradient(135deg,rgba(129,140,248,0.06),rgba(16,185,129,0.06))",border:`1px solid ${C.bd}`}}>
              <div style={{fontSize:10,fontWeight:600,color:C.accent,marginBottom:3}}>RELAY-BIT PRINCIPLE</div>
              <div style={{fontSize:11,color:C.txm,lineHeight:1.5}}>
                r=1 iff target then control. <span style={{color:C.tx}}>Zero relays = total fault isolation.</span> No error correction needed for this class of errors. Topology provides the protection.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Benchmarks Tab ─── */}
      {tab === "benchmarks" && (
        <div style={{padding:20,maxWidth:1000,margin:"0 auto"}}>
          {/* Summary cards */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:12,marginBottom:20}}>
            {[
              {label:"Algorithms Scanned",value:BENCHMARKS.length,color:C.accent},
              {label:"Total CNOTs",value:totalCNOTs,color:C.tx},
              {label:"Total Relays Found",value:totalRelays,color:totalRelays>0?C.danger:C.safe},
              {label:"Relay-Free",value:`${relayFreeCount}/${BENCHMARKS.length}`,color:C.safe},
            ].map(c=>(
              <div key={c.label} style={{background:C.sf,borderRadius:10,border:`1px solid ${C.bd}`,padding:"14px 16px"}}>
                <div style={{fontSize:9,color:C.txm,textTransform:"uppercase",letterSpacing:1.5,marginBottom:4}}>{c.label}</div>
                <div style={{fontSize:24,fontWeight:700,color:c.color}}>{c.value}</div>
              </div>
            ))}
          </div>

          {/* Chart */}
          <div style={{background:C.sf,borderRadius:10,border:`1px solid ${C.bd}`,padding:16,marginBottom:20}}>
            <div style={{fontSize:9,color:C.txm,textTransform:"uppercase",letterSpacing:1.5,marginBottom:8}}>
              Relay Analysis Across Quantum Algorithms
              <span style={{float:"right",textTransform:"none",letterSpacing:0}}>
                <span style={{color:C.safe,marginRight:12}}>■ safe gates</span>
                <span style={{color:C.danger}}>■ relay gates</span>
              </span>
            </div>
            <BenchmarkChart benchmarks={benchmarkResults} />
          </div>

          {/* Detail table */}
          <div style={{background:C.sf,borderRadius:10,border:`1px solid ${C.bd}`,padding:16,marginBottom:20}}>
            <div style={{fontSize:9,color:C.txm,textTransform:"uppercase",letterSpacing:1.5,marginBottom:8}}>Detailed Results</div>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11,fontFamily:font}}>
              <thead><tr style={{borderBottom:`1px solid ${C.bd}`}}>
                {["Algorithm","Category","Qubits","CNOTs","Relays","Status","Action"].map(h=>(
                  <th key={h} style={{padding:"6px 8px",textAlign:"left",color:C.txm,fontWeight:500,fontSize:9,textTransform:"uppercase"}}>{h}</th>
                ))}
              </tr></thead>
              <tbody>{benchmarkResults.map((b,i)=>(
                <tr key={i} style={{borderBottom:`1px solid ${C.bd}`,cursor:"pointer"}} onClick={()=>{setInput(b.gates);setActivePreset("");setTab("scanner");}}>
                  <td style={{padding:"6px 8px",fontWeight:600}}>{b.name}</td>
                  <td style={{padding:"6px 8px",color:C.txm}}>{b.category}</td>
                  <td style={{padding:"6px 8px"}}>{b.nQubits}</td>
                  <td style={{padding:"6px 8px"}}>{b.nCNOTs}</td>
                  <td style={{padding:"6px 8px",color:b.analysis.nRelays>0?C.danger:C.safe,fontWeight:700}}>{b.analysis.nRelays}</td>
                  <td style={{padding:"6px 8px"}}>
                    <span style={{padding:"2px 8px",borderRadius:12,fontSize:10,fontWeight:600,
                      background:b.analysis.fullyIsolated?"rgba(16,185,129,0.12)":"rgba(239,68,68,0.12)",
                      color:b.analysis.fullyIsolated?C.safe:C.danger,
                      border:`1px solid ${b.analysis.fullyIsolated?"rgba(16,185,129,0.3)":"rgba(239,68,68,0.3)"}`}}>
                      {b.analysis.fullyIsolated?"ISOLATED":`${b.analysis.nRelays}R`}
                    </span>
                  </td>
                  <td style={{padding:"6px 8px",color:C.bda,fontSize:10}}>Scan →</td>
                </tr>
              ))}</tbody>
            </table>
          </div>

          {/* Key insight */}
          <div style={{padding:16,borderRadius:10,background:"linear-gradient(135deg,rgba(129,140,248,0.08),rgba(239,68,68,0.05))",border:`1px solid ${C.bd}`}}>
            <div style={{fontSize:11,fontWeight:600,color:C.accent,marginBottom:6}}>KEY FINDING</div>
            <div style={{fontSize:12,color:C.tx,lineHeight:1.6,marginBottom:8}}>
              Across {BENCHMARKS.length} standard quantum algorithms, <span style={{color:C.danger,fontWeight:700}}>{totalRelays} relay qubits</span> were identified — each one an uncontrolled error propagation path invisible to standard compilers.
            </div>
            <div style={{fontSize:11,color:C.txm,lineHeight:1.5}}>
              Standard GHZ preparation (chain topology) contains {benchmarkResults.find(b=>b.name==="GHZ-5 (chain)")?.analysis.nRelays || 0} relays.
              The star-topology alternative achieves the same entanglement with zero relays and complete fault isolation.
              The fidelity cost F=cos⁴(α) is computable before execution.
            </div>
            <div style={{marginTop:10,padding:10,background:"rgba(129,140,248,0.06)",borderRadius:6,border:"1px solid rgba(129,140,248,0.15)"}}>
              <div style={{fontSize:10,color:C.accent,fontWeight:600,marginBottom:4}}>QISKIT TRANSPILER PLUGIN</div>
              <div style={{fontSize:11,color:C.txm,lineHeight:1.5}}>
                Install <code style={{color:C.accent,background:"rgba(129,140,248,0.1)",padding:"1px 5px",borderRadius:3}}>pip install nativ3[qiskit]</code> to automatically scan and optimize circuits during Qiskit transpilation.
                Two passes integrate into any PassManager: <code style={{color:C.tx}}>RelayAnalysisPass</code> (detect) and <code style={{color:C.tx}}>RelayEliminationPass</code> (fix).
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── N-Relay Calculator Tab ─── */}
      {tab === "nrelay" && <NRelayCalculator />}

      {/* ─── General C-U Tab ─── */}
      {tab === "general" && <GeneralCUCalculator />}

      {/* ─── Footer ─── */}
      <div style={{borderTop:`1px solid ${C.bd}`,padding:"10px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
        <div style={{fontSize:9,color:C.txd}}>
          Twenty-Four Theorems · Non-transitivity · General fidelity · CZ duality · Fault isolation · Container · Builder memory · N-relay · Transfer matrix · Projector · Disorder decay · CZ polynomial · Universal linearity · General formula · Universal 4×4 transfer matrix
        </div>
        <div style={{fontSize:9,color:C.txd}}>
          DOI: 10.5281/zenodo.19319040
        </div>
      </div>
    </div>
  );
}
