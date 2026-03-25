"""
Nativ3 Compiler
================
Compiles topology descriptions into Qiskit circuits.
Provides relay detection, fault isolation analysis,
and topology tradeoff recommendations.
"""

from typing import List, Optional, Dict, Tuple, Union
import numpy as np

from .topology import (
    CircuitPlan, TopologyAnalysis, NodeType, GateRecord,
    star, chain, dual_hub, classify_circuit,
)

# Optional Qiskit import — compiler works without it for analysis
try:
    from qiskit import QuantumCircuit
    from qiskit.quantum_info import Statevector
    HAS_QISKIT = True
except ImportError:
    HAS_QISKIT = False


class CompileResult:
    """Result of compiling a Nativ3 topology to a Qiskit circuit."""

    def __init__(self, circuit, analysis: TopologyAnalysis, plan: CircuitPlan):
        self.circuit = circuit          # Qiskit QuantumCircuit (or None)
        self.analysis = analysis        # Node classification
        self.plan = plan                # Original topology plan
        self.alternatives = []          # Suggested alternative topologies

    @property
    def is_isolated(self) -> bool:
        return self.analysis.fully_isolated

    @property
    def relay_count(self) -> int:
        return self.analysis.n_relays

    def report(self) -> str:
        """Generate a human-readable compilation report."""
        lines = [
            "═" * 55,
            f"  NATIV3 COMPILE REPORT",
            "═" * 55,
            "",
            self.analysis.summary(),
            "",
        ]

        if self.alternatives:
            lines.append("  ALTERNATIVES:")
            for alt in self.alternatives:
                lines.append(f"    {alt}")
            lines.append("")

        if self.circuit is not None:
            lines.append(f"  Qiskit circuit: {self.circuit.num_qubits} qubits, "
                         f"{self.circuit.size()} gates, depth {self.circuit.depth()}")

        lines.append("═" * 55)
        return "\n".join(lines)


def compile(plan: CircuitPlan, measure: bool = True) -> CompileResult:
    """Compile a Nativ3 topology plan into a Qiskit circuit.

    Args:
        plan: A CircuitPlan from star(), chain(), or dual_hub().
        measure: Whether to add measurement gates at the end.

    Returns:
        CompileResult with Qiskit circuit, analysis, and recommendations.
    """
    analysis = plan.analyze()

    # Build Qiskit circuit if available
    circuit = None
    if HAS_QISKIT:
        circuit = _build_qiskit(plan, measure)

    result = CompileResult(circuit, analysis, plan)

    # Generate alternatives if relays detected
    if analysis.n_relays > 0:
        result.alternatives = _suggest_alternatives(plan, analysis)

    return result


def _build_qiskit(plan: CircuitPlan, measure: bool) -> 'QuantumCircuit':
    """Build the actual Qiskit QuantumCircuit from a plan."""
    n = plan.n_qubits
    qc = QuantumCircuit(n, n) if measure else QuantumCircuit(n)

    # Apply shifts (Hadamard)
    if plan.topology_type == 'star' and plan.shift_hub:
        qc.h(plan.hub)
    elif plan.topology_type == 'chain' and plan.shift_first:
        qc.h(plan.chain_qubits[0])
    elif plan.topology_type == 'dual_hub' and plan.shift_hubs:
        for hub in plan.hubs:
            qc.h(hub)

    # Apply CNOT gates
    for gate in plan.gates():
        qc.cx(gate.control, gate.target)

    # Add measurements
    if measure:
        qc.measure(range(n), range(n))

    return qc


def _suggest_alternatives(plan: CircuitPlan, analysis: TopologyAnalysis) -> List[str]:
    """Suggest relay-free alternatives for a circuit with relays."""
    suggestions = []

    if plan.topology_type == 'chain':
        qubits = plan.chain_qubits
        hub = qubits[0]
        spokes = qubits[1:]

        # Suggest star alternative
        alpha_default = np.pi / 4
        fid_cost = np.cos(alpha_default) ** 4
        suggestions.append(
            f"star(hub=q{hub}, spokes={['q'+str(s) for s in spokes]}) → "
            f"eliminates {analysis.n_relays} relay(s). "
            f"Fidelity cost at α=π/4: F={fid_cost:.4f}"
        )

        # Suggest dual-hub if enough qubits
        if len(qubits) >= 4:
            suggestions.append(
                f"dual_hub(hubs=[q{hub}, q_new], spokes={['q'+str(s) for s in spokes]}) → "
                f"total fault isolation with hub redundancy"
            )

    elif plan.topology_type == 'star':
        # Star shouldn't have relays, but just in case
        for q, info in analysis.qubits.items():
            if info.node_type == NodeType.RELAY:
                suggestions.append(
                    f"q{q} is relay — ensure it is not reused as control after targeting"
                )

    return suggestions


def analyze_tradeoff(chain_plan: CircuitPlan,
                     alpha: float = np.pi / 4) -> Dict:
    """Analyze the fidelity-vs-isolation tradeoff for a chain circuit.

    Returns a dict with:
        - chain_analysis: node classification of the chain
        - star_analysis: node classification of the star alternative
        - fidelity_cost: F = cos⁴(α)
        - relay_count: number of relays eliminated
        - recommendation: human-readable recommendation
    """
    chain_analysis = chain_plan.analyze()

    # Build star alternative
    qubits = chain_plan.chain_qubits
    star_plan = star(hub=qubits[0], spokes=qubits[1:],
                     shift_hub=chain_plan.shift_first)
    star_analysis = star_plan.analyze()

    fid = float(np.cos(alpha) ** 4)
    n_relays = chain_analysis.n_relays

    if fid > 0.9:
        rec = f"RECOMMEND STAR: low fidelity cost ({1-fid:.1%}), eliminates {n_relays} relay(s)"
    elif fid > 0.5:
        rec = f"CONSIDER STAR: moderate fidelity cost ({1-fid:.1%}), eliminates {n_relays} relay(s)"
    else:
        rec = f"KEEP CHAIN: high fidelity cost ({1-fid:.1%}), but chain has {n_relays} relay(s)"

    return {
        'chain_analysis': chain_analysis,
        'star_analysis': star_analysis,
        'fidelity_cost': fid,
        'fidelity_loss': 1 - fid,
        'relay_count': n_relays,
        'relays_eliminated': n_relays,
        'recommendation': rec,
    }


def scan_relays(gates: List[GateRecord], n_qubits: int) -> TopologyAnalysis:
    """Scan an arbitrary gate sequence for relay qubits.

    This is the compiler's core optimization pass:
    given any circuit, find the qubits that propagate errors.
    """
    return classify_circuit(gates, n_qubits)


def simulate(plan: CircuitPlan) -> Optional[np.ndarray]:
    """Simulate a topology plan and return the statevector."""
    if not HAS_QISKIT:
        return None

    qc = _build_qiskit(plan, measure=False)
    sv = Statevector.from_instruction(qc)
    return np.array(sv)
