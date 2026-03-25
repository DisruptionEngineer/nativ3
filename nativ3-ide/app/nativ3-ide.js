"use client";
import { useState, useMemo, useCallback } from "react";

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

const PRESETS = {
  "Star":           "h 0\n0→1\n0→2\n0→3",
  "Chain":          "h 0\n0→1\n1→2\n2→3",
  "Dual Hub":       "h 0\nh 4\n0→1\n0→2\n0→3\n4→1\n4→2\n4→3",
  "IBM GHZ":        "h 2\n2→1\n2→3\n1→0\n3→4",
  "Star GHZ":       "h 2\n2→0\n2→1\n2→3\n2→4",
  "Konami":         "h 0\nh 1\n0→2\n0→3\n1→2\n1→3\n0→4\n1→5",
  "Syndrome":       "0→4\n1→4\n2→5\n3→5\n4→6\n5→6",
  "QASM":           'OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[5];\nh q[0];\ncx q[0], q[1];\ncx q[1], q[2];\ncx q[0], q[3];\ncx q[3], q[4];',
};

const C = {
  bg:"#0a0e17",sf:"#111827",sfh:"#1a2236",bd:"#1e293b",bda:"#3b82f6",
  hub:"#f59e0b",hubG:"rgba(245,158,11,0.3)",spoke:"#10b981",spokeG:"rgba(16,185,129,0.3)",
  relay:"#ef4444",relayG:"rgba(239,68,68,0.4)",virgin:"#475569",
  tx:"#e2e8f0",txm:"#64748b",txd:"#334155",link:"#3b82f6",safe:"#10b981",danger:"#ef4444",accent:"#818cf8",
};
const NC = {hub:C.hub,spoke:C.spoke,relay:C.relay,virgin:C.virgin};

function Graph({gates,analysis,nQubits,chains}) {
  const W=520,H=340,cx=W/2,cy=H/2,r=Math.min(W,H)*0.33;
  const pos = useMemo(()=>{
    const p=[]; for(let i=0;i<nQubits;i++){
      const a=-Math.PI/2+(2*Math.PI*i)/nQubits;
      p.push({x:cx+r*Math.cos(a),y:cy+r*Math.sin(a)});
    } return p;
  },[nQubits]);
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
        return <line key={i} x1={p1.x+nx*22} y1={p1.y+ny*22} x2={p2.x-nx*22} y2={p2.y-ny*22}
          stroke={isChain?C.danger:isDanger?"rgba(239,68,68,0.5)":C.link}
          strokeWidth={isChain?3:isDanger?2:1.8} opacity={isChain?1:isDanger?0.7:0.5}
          markerEnd={isChain||isDanger?"url(#a2)":"url(#a1)"} strokeDasharray={isDanger&&!isChain?"6 3":"none"}/>;
      })}
      {analysis.nodes.map((n,i)=>{
        const p=pos[i]; if(!p)return null; const color=NC[n.type]||C.virgin;
        return(<g key={i}>
          <circle cx={p.x} cy={p.y} r={30} fill={`url(#g${n.type})`}/>
          <circle cx={p.x} cy={p.y} r={18} fill={C.sf} stroke={color} strokeWidth={2.5} style={{filter:n.type==="relay"?"drop-shadow(0 0 8px rgba(239,68,68,0.7))":"none"}}/>
          <text x={p.x} y={p.y+1} textAnchor="middle" dominantBaseline="central" fill={color} fontSize="11" fontWeight="700" fontFamily="'JetBrains Mono',monospace">q{i}</text>
          <text x={p.x} y={p.y+32} textAnchor="middle" fill={C.txm} fontSize="9" fontFamily="'JetBrains Mono',monospace">{n.type}</text>
          {n.relay===1&&<text x={p.x} y={p.y-26} textAnchor="middle" fill={C.danger} fontSize="10" fontWeight="700">⚠ r=1</text>}
        </g>);
      })}
    </svg>
  );
}

export default function Nativ3IDE() {
  const [input, setInput] = useState(PRESETS["IBM GHZ"]);
  const [activePreset, setActivePreset] = useState("IBM GHZ");

  const parsed = useMemo(()=> input.includes("OPENQASM")||input.includes("qreg") ? parseQASM(input) : parseGateList(input), [input]);
  const analysis = useMemo(()=> parsed.nQubits>0 ? classifyNodes(parsed.gates,parsed.nQubits) : {nodes:[],nRelays:0,fullyIsolated:true}, [parsed]);
  const loads = useMemo(()=> parsed.nQubits>0 ? estimateLoads(parsed.gates,parsed.nQubits,parsed.shifts) : {}, [parsed]);
  const chains = useMemo(()=> parsed.gates.length>0 ? findChains(parsed.gates,analysis) : [], [parsed,analysis]);
  const alts = useMemo(()=> parsed.gates.length>0 ? findAlts(parsed.gates,analysis,loads) : [], [parsed,analysis,loads]);

  const font="'JetBrains Mono','Fira Code',monospace";
  const iso = analysis.fullyIsolated;

  return(
    <div style={{background:C.bg,color:C.tx,minHeight:"100vh",fontFamily:font}}>
      <div style={{borderBottom:`1px solid ${C.bd}`,padding:"14px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
        <div>
          <div style={{fontSize:20,fontWeight:700}}><span style={{color:C.accent}}>nativ3</span><span style={{color:C.txd,fontWeight:400,fontSize:13,marginLeft:8}}>circuit scanner</span></div>
          <div style={{fontSize:9,color:C.txd,marginTop:2,letterSpacing:1}}>PASTE → SCAN → CLASSIFY → FIX</div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <div style={{padding:"4px 12px",borderRadius:20,fontSize:11,fontWeight:600,background:iso?"rgba(16,185,129,0.12)":"rgba(239,68,68,0.12)",color:iso?C.safe:C.danger,border:`1px solid ${iso?"rgba(16,185,129,0.3)":"rgba(239,68,68,0.3)"}`}}>
            {iso?"✓ ISOLATED":`✗ ${analysis.nRelays} RELAY${analysis.nRelays!==1?"S":""}`}
          </div>
          <a href="https://doi.org/10.5281/zenodo.19210676" target="_blank" rel="noopener" style={{fontSize:9,color:C.txd,textDecoration:"none",padding:"3px 6px",border:`1px solid ${C.bd}`,borderRadius:4}}>DOI</a>
        </div>
      </div>
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
                <span>⚠</span><span>q{n.index} {loads[n.index]?`α=${loads[n.index].alpha.toFixed(3)} F=${loads[n.index].fidelity.toFixed(4)}${loads[n.index].free?" FREE":""}`:"RELAY"}</span>
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
              r=1 iff target then control. <span style={{color:C.tx}}>Zero relays = total fault isolation.</span> No error correction needed. Topology provides the protection.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
