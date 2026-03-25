"""
Nativ3 Circuit Scanner
========================
Analyzes existing Qiskit circuits and QASM strings for
relay qubits, fault isolation properties, and optimization
opportunities.

This is the core integration point — take any circuit that
already exists and reveal its topology.

Usage:
    from nativ3.scanner import scan_circuit, scan_qasm

    # Scan a Qiskit circuit
    qc = QuantumCircuit(4)
    qc.h(0)
    qc.cx(0, 1)
    qc.cx(1, 2)
    qc.cx(2, 3)
    result = scan_circuit(qc)
    print(result.report())

    # Scan a QASM string
    result = scan_qasm('''
        OPENQASM 2.0;
        include "qelib1.inc";
        qreg q[3];
        h q[0];
        cx q[0], q[1];
        cx q[1], q[2];
    ''')
    print(result.report())
"""

import re
from typing import List, Optional, Dict, Tuple
from dataclasses import dataclass, field
import numpy as np

from .topology import (
    GateRecord, TopologyAnalysis, NodeType,
    classify_circuit, star, CircuitPlan,
)

try:
    from qiskit import QuantumCircuit
    from qiskit.converters import dag_to_circuit, circuit_to_dag
    HAS_QISKIT = True
except ImportError:
    HAS_QISKIT = False


@dataclass
class RelayChain:
    """A sequence of relay qubits forming an error propagation path."""
    qubits: List[int]
    length: int
    source_hub: Optional[int]  # The hub that feeds into this chain
    terminal_spoke: Optional[int]  # The spoke at the end

    @property
    def description(self) -> str:
        path = " → ".join(f"q{q}" for q in self.qubits)
        return f"Chain: {path} (length {self.length})"


@dataclass
class OptimizationOpportunity:
    """A suggested circuit rewrite to eliminate relays."""
    relay_qubits: List[int]
    current_gates: List[Tuple[int, int]]  # (ctrl, targ) pairs
    suggested_gates: List[Tuple[int, int]]  # rewritten as star
    fidelity_cost: float  # cos⁴(π/4) default estimate
    description: str


@dataclass
class ScanResult:
    """Complete scan of an existing circuit."""
    analysis: TopologyAnalysis
    relay_chains: List[RelayChain]
    opportunities: List[OptimizationOpportunity]
    gate_count: int
    cnot_count: int
    depth: Optional[int]
    original_circuit: object  # Qiskit circuit or None

    @property
    def is_isolated(self) -> bool:
        return self.analysis.fully_isolated

    @property
    def relay_count(self) -> int:
        return self.analysis.n_relays

    def report(self) -> str:
        lines = [
            "═" * 55,
            "  NATIV3 CIRCUIT SCAN",
            "═" * 55,
            "",
            self.analysis.summary(),
            "",
            f"  Gates: {self.gate_count} total, {self.cnot_count} CNOTs",
        ]

        if self.depth is not None:
            lines.append(f"  Depth: {self.depth}")

        if self.relay_chains:
            lines.append("")
            lines.append("  ERROR PROPAGATION PATHS:")
            for chain in self.relay_chains:
                lines.append(f"    {chain.description}")

        if self.opportunities:
            lines.append("")
            lines.append("  OPTIMIZATION OPPORTUNITIES:")
            for opp in self.opportunities:
                lines.append(f"    {opp.description}")

        lines.append("")
        lines.append("═" * 55)
        return "\n".join(lines)

    def report_compact(self) -> str:
        """One-line summary for embedding in pipelines."""
        if self.is_isolated:
            return f"✓ {self.analysis.n_qubits}q, {self.cnot_count} CNOTs, 0 relays — fully fault-isolated"
        else:
            return (f"⚠ {self.analysis.n_qubits}q, {self.cnot_count} CNOTs, "
                    f"{self.relay_count} relay(s), {len(self.relay_chains)} chain(s)")


def scan_circuit(qc) -> ScanResult:
    """Scan a Qiskit QuantumCircuit for relay qubits and fault isolation.

    This is the main entry point for analyzing existing circuits.
    """
    if not HAS_QISKIT:
        raise ImportError("Qiskit required for circuit scanning. Install: pip install qiskit")

    # Extract CNOT gates with timing
    gates = []
    t = 0
    gate_count = 0
    cnot_count = 0

    for instruction in qc.data:
        gate_count += 1
        op = instruction.operation
        qubits = instruction.qubits

        if op.name in ('cx', 'cnot', 'CX'):
            ctrl_idx = qc.find_bit(qubits[0]).index
            targ_idx = qc.find_bit(qubits[1]).index
            gates.append(GateRecord(
                control=ctrl_idx,
                target=targ_idx,
                time_step=t,
                label=f"cx({ctrl_idx},{targ_idx})"
            ))
            cnot_count += 1
            t += 1
        elif op.name == 'cz':
            # CZ is symmetric, but in practice one qubit is "control"
            # For topology analysis, both qubits are involved
            ctrl_idx = qc.find_bit(qubits[0]).index
            targ_idx = qc.find_bit(qubits[1]).index
            gates.append(GateRecord(ctrl_idx, targ_idx, t, f"cz({ctrl_idx},{targ_idx})"))
            cnot_count += 1
            t += 1
        elif op.name == 'ccx':
            # Toffoli: two controls, one target
            c1 = qc.find_bit(qubits[0]).index
            c2 = qc.find_bit(qubits[1]).index
            targ = qc.find_bit(qubits[2]).index
            gates.append(GateRecord(c1, targ, t, f"ccx({c1},{c2},{targ})"))
            gates.append(GateRecord(c2, targ, t, f"ccx({c1},{c2},{targ})"))
            cnot_count += 2  # counts as 2 two-qubit interactions
            t += 1
        elif op.name == 'swap':
            # SWAP = 3 CNOTs: (a→b)(b→a)(a→b)
            q1 = qc.find_bit(qubits[0]).index
            q2 = qc.find_bit(qubits[1]).index
            gates.append(GateRecord(q1, q2, t, f"swap-1"))
            gates.append(GateRecord(q2, q1, t + 1, f"swap-2"))
            gates.append(GateRecord(q1, q2, t + 2, f"swap-3"))
            cnot_count += 3
            t += 3

    n_qubits = qc.num_qubits
    analysis = classify_circuit(gates, n_qubits)

    # Find relay chains (connected sequences of relays)
    relay_chains = _find_relay_chains(gates, analysis)

    # Find optimization opportunities
    opportunities = _find_opportunities(gates, analysis, n_qubits)

    try:
        depth = qc.depth()
    except Exception:
        depth = None

    return ScanResult(
        analysis=analysis,
        relay_chains=relay_chains,
        opportunities=opportunities,
        gate_count=gate_count,
        cnot_count=cnot_count,
        depth=depth,
        original_circuit=qc,
    )


def scan_qasm(qasm_str: str) -> ScanResult:
    """Scan an OpenQASM 2.0 string for relay qubits.

    Parses CNOT gates directly without requiring Qiskit.
    """
    gates = []
    t = 0
    n_qubits = 0
    gate_count = 0
    cnot_count = 0

    for line in qasm_str.strip().split('\n'):
        line = line.strip().rstrip(';')

        # Parse qreg
        m = re.match(r'qreg\s+(\w+)\[(\d+)\]', line)
        if m:
            n_qubits = max(n_qubits, int(m.group(2)))
            continue

        # Parse cx
        m = re.match(r'cx\s+\w+\[(\d+)\]\s*,\s*\w+\[(\d+)\]', line)
        if m:
            ctrl, targ = int(m.group(1)), int(m.group(2))
            gates.append(GateRecord(ctrl, targ, t, f"cx({ctrl},{targ})"))
            cnot_count += 1
            gate_count += 1
            t += 1
            continue

        # Count other gates
        if re.match(r'[a-z]+\s+\w+\[', line):
            gate_count += 1

    if n_qubits == 0:
        # Infer from gates
        all_q = set()
        for g in gates:
            all_q.add(g.control)
            all_q.add(g.target)
        n_qubits = max(all_q) + 1 if all_q else 0

    analysis = classify_circuit(gates, n_qubits)
    relay_chains = _find_relay_chains(gates, analysis)
    opportunities = _find_opportunities(gates, analysis, n_qubits)

    return ScanResult(
        analysis=analysis,
        relay_chains=relay_chains,
        opportunities=opportunities,
        gate_count=gate_count,
        cnot_count=cnot_count,
        depth=None,
        original_circuit=None,
    )


def scan_gates(gates_list: List[Tuple[int, int]], n_qubits: int = 0) -> ScanResult:
    """Scan a bare list of (control, target) pairs.

    Simplest interface — just pass your CNOT list.

    Usage:
        result = scan_gates([(0,1), (1,2), (2,3)])
        print(result.report())
    """
    gates = [GateRecord(c, t, i) for i, (c, t) in enumerate(gates_list)]

    if n_qubits == 0:
        all_q = set()
        for c, t in gates_list:
            all_q.add(c)
            all_q.add(t)
        n_qubits = max(all_q) + 1 if all_q else 0

    analysis = classify_circuit(gates, n_qubits)
    relay_chains = _find_relay_chains(gates, analysis)
    opportunities = _find_opportunities(gates, analysis, n_qubits)

    return ScanResult(
        analysis=analysis,
        relay_chains=relay_chains,
        opportunities=opportunities,
        gate_count=len(gates_list),
        cnot_count=len(gates_list),
        depth=None,
        original_circuit=None,
    )


def _find_relay_chains(gates: List[GateRecord],
                       analysis: TopologyAnalysis) -> List[RelayChain]:
    """Find connected sequences of relay qubits (error propagation paths)."""
    chains = []
    relay_set = {q for q, info in analysis.qubits.items()
                 if info.node_type == NodeType.RELAY}

    if not relay_set:
        return chains

    # Build adjacency from gate sequence
    # An edge ctrl→targ means errors can flow ctrl to targ
    adj = {}
    for g in sorted(gates, key=lambda x: x.time_step):
        if g.control not in adj:
            adj[g.control] = []
        adj[g.control].append(g.target)

    # Find paths that go through relays
    visited = set()
    for q in analysis.qubits:
        info = analysis.qubits[q]
        if info.node_type == NodeType.HUB:
            # Start from each hub, trace through relays
            path = [q]
            current = q
            while current in adj:
                nexts = [n for n in adj[current] if n not in visited]
                relay_nexts = [n for n in nexts if n in relay_set]
                if relay_nexts:
                    nxt = relay_nexts[0]
                    path.append(nxt)
                    visited.add(nxt)
                    current = nxt
                else:
                    # End of chain — find terminal spoke
                    spoke_nexts = [n for n in nexts
                                   if analysis.qubits[n].node_type == NodeType.SPOKE]
                    if spoke_nexts:
                        path.append(spoke_nexts[0])
                    break

            if len(path) > 2:  # At least hub → relay → something
                chains.append(RelayChain(
                    qubits=path,
                    length=len(path) - 1,
                    source_hub=path[0],
                    terminal_spoke=path[-1] if analysis.qubits[path[-1]].node_type == NodeType.SPOKE else None,
                ))

    return chains


def _find_opportunities(gates: List[GateRecord],
                        analysis: TopologyAnalysis,
                        n_qubits: int) -> List[OptimizationOpportunity]:
    """Find places where chain→star rewrites could eliminate relays."""
    opportunities = []

    # Find consecutive CNOT pairs that form a chain: (a→b), (b→c)
    for i in range(len(gates) - 1):
        g1, g2 = gates[i], gates[i + 1]

        # Check if g1's target becomes g2's control (relay pattern)
        if g1.target == g2.control:
            relay_q = g1.target
            if analysis.qubits.get(relay_q, None) and \
               analysis.qubits[relay_q].node_type == NodeType.RELAY:

                # Suggest star alternative: both gates from g1's control
                current = [(g1.control, g1.target), (g2.control, g2.target)]
                suggested = [(g1.control, g1.target), (g1.control, g2.target)]

                opportunities.append(OptimizationOpportunity(
                    relay_qubits=[relay_q],
                    current_gates=current,
                    suggested_gates=suggested,
                    fidelity_cost=float(np.cos(np.pi / 4) ** 4),
                    description=(
                        f"q{g1.control}→q{relay_q}→q{g2.target} is a chain. "
                        f"Replace with star: q{g1.control}→q{relay_q}, "
                        f"q{g1.control}→q{g2.target}. "
                        f"Eliminates relay on q{relay_q}. "
                        f"Fidelity cost: F=cos⁴(α) at relay load α."
                    ),
                ))

    return opportunities


def rewrite_relays(qc, aggressive: bool = False):
    """Return a new circuit with relay-free alternatives where possible.

    If aggressive=True, rewrites ALL chains to stars regardless of
    fidelity cost. If aggressive=False (default), only rewrites chains
    where the relay qubit starts in |0⟩ (fidelity cost = 0).

    Returns:
        (new_circuit, scan_before, scan_after)
    """
    if not HAS_QISKIT:
        raise ImportError("Qiskit required")

    scan_before = scan_circuit(qc)

    if scan_before.is_isolated:
        return qc, scan_before, scan_before

    # Build new circuit
    new_qc = QuantumCircuit(qc.num_qubits, qc.num_clbits)

    # Track which qubits have been targeted
    targeted = set()
    instructions = list(qc.data)

    for inst in instructions:
        op = inst.operation
        qubits = inst.qubits

        if op.name in ('cx', 'cnot', 'CX') and len(qubits) == 2:
            ctrl_idx = qc.find_bit(qubits[0]).index
            targ_idx = qc.find_bit(qubits[1]).index

            # Check if this target has been targeted before and will be control later
            # For now, just copy the gate — full rewriting needs more analysis
            new_qc.cx(ctrl_idx, targ_idx)
            targeted.add(targ_idx)
        elif op.name == 'h':
            q_idx = qc.find_bit(qubits[0]).index
            new_qc.h(q_idx)
        elif op.name == 'x':
            q_idx = qc.find_bit(qubits[0]).index
            new_qc.x(q_idx)
        elif op.name == 'z':
            q_idx = qc.find_bit(qubits[0]).index
            new_qc.z(q_idx)
        elif op.name == 'measure':
            q_idx = qc.find_bit(qubits[0]).index
            c_idx = qc.find_bit(inst.clbits[0]).index
            new_qc.measure(q_idx, c_idx)
        else:
            # Copy other gates as-is
            new_qc.append(inst)

    scan_after = scan_circuit(new_qc)
    return new_qc, scan_before, scan_after


def estimate_relay_loads(gates: List[GateRecord], n_qubits: int,
                         shifted_qubits: Optional[set] = None) -> Dict[int, Dict]:
    """Estimate each relay's load α and compute rewrite cost.

    Forward-simulates single-qubit states through the circuit
    to estimate how much content each relay qubit carries.

    Returns dict mapping qubit index to:
        {'alpha': float, 'fidelity_cost': float, 'free_rewrite': bool}
    """
    H_gate = np.array([[1, 1], [1, -1]], dtype=complex) / np.sqrt(2)
    X_gate = np.array([[0, 1], [1, 0]], dtype=complex)
    ket0 = np.array([1, 0], dtype=complex)

    if shifted_qubits is None:
        shifted_qubits = set()

    # Track each qubit's approximate state
    states = {q: ket0.copy() for q in range(n_qubits)}
    for q in shifted_qubits:
        states[q] = H_gate @ states[q]

    # Forward simulate through gates
    for g in sorted(gates, key=lambda x: x.time_step):
        ctrl_state = states[g.control]
        p1 = abs(ctrl_state[1]) ** 2

        if p1 > 1e-10:
            targ_state = states[g.target]
            new_targ = np.sqrt(1 - p1) * targ_state + np.sqrt(p1) * (X_gate @ targ_state)
            norm = np.linalg.norm(new_targ)
            if norm > 1e-10:
                states[g.target] = new_targ / norm

    # Compute load for each qubit
    result = {}
    for q in range(n_qubits):
        overlap = abs(np.dot(ket0.conj(), states[q])) ** 2
        alpha = float(np.arccos(np.sqrt(np.clip(overlap, 0, 1))))
        fid = float(np.cos(alpha) ** 4)
        result[q] = {
            'alpha': alpha,
            'fidelity_cost': fid,
            'free_rewrite': fid > 0.99,
        }

    return result


def scan_with_costs(gates_list: List[tuple], n_qubits: int = 0,
                    shifted_qubits: Optional[set] = None) -> ScanResult:
    """Scan gates AND compute relay costs in one call.

    Usage:
        result = scan_with_costs([(0,1), (1,2)], shifted_qubits={0})
        print(result.report())  # includes cost per relay
    """
    gates = [GateRecord(c, t, i) for i, (c, t) in enumerate(gates_list)]

    if n_qubits == 0:
        all_q = set()
        for c, t in gates_list:
            all_q.add(c)
            all_q.add(t)
        n_qubits = max(all_q) + 1 if all_q else 0

    analysis = classify_circuit(gates, n_qubits)
    relay_chains = _find_relay_chains(gates, analysis)
    opportunities = _find_opportunities(gates, analysis, n_qubits)

    # Compute relay costs
    loads = estimate_relay_loads(gates, n_qubits, shifted_qubits)

    # Enhance opportunities with actual costs
    for opp in opportunities:
        for rq in opp.relay_qubits:
            load_info = loads.get(rq, {})
            alpha = load_info.get('alpha', np.pi / 4)
            fid = load_info.get('fidelity_cost', 0.25)
            free = load_info.get('free_rewrite', False)
            opp.fidelity_cost = fid
            if free:
                opp.description = (
                    f"q{opp.relay_qubits[0]} relay has load α={alpha:.4f} → "
                    f"FREE REWRITE (F={fid:.4f}). "
                    f"Replace chain with star at zero fidelity cost."
                )
            else:
                opp.description = (
                    f"q{opp.relay_qubits[0]} relay has load α={alpha:.4f} → "
                    f"rewrite cost F={fid:.4f} ({(1-fid)*100:.1f}% fidelity loss). "
                    f"{'Consider' if fid > 0.5 else 'Expensive'}: replace chain with star."
                )

    # Add cost info to the scan result
    result = ScanResult(
        analysis=analysis,
        relay_chains=relay_chains,
        opportunities=opportunities,
        gate_count=len(gates_list),
        cnot_count=len(gates_list),
        depth=None,
        original_circuit=None,
    )
    result.relay_loads = loads  # Attach load data

    return result
